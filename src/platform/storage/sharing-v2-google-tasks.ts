import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from './sharing-v2-events';
import type { GoogleSyncState, GoogleTaskLink, GoogleTaskStatus, GoogleTaskStatusChange, GoogleSyncEntry } from '../../features/google-sync/contracts';
import type { GoogleSyncRepositoryPort } from '../../features/google-sync/reconcile-google-tasks';
import { createV2PlannerActions } from '../../features/sharing/v2/actions.ts';
import { buildV2CommonPlan } from '../../features/sharing/v2/common-plan.ts';
import type { V2CommonPlan } from '../../features/sharing/v2/common-plan';
import type { V2PersonalPlan } from '../../features/sharing/v2/personal-plan';
import { v2ReadPoint } from '../../features/sharing/v2/view-point.ts';
import { readSharedCalendar } from '../../features/sharing/v2/calendar-state.ts';
import type { SharedCalendarRecord } from '../../features/sharing/v2/calendar-state';
import { v2NativeWorkspaceNamespace } from '../../features/sharing/v2/native-identity.ts';
import { v2GoogleTaskItems, validateV2GoogleTaskTarget, v2GoogleRevisionAfterImport } from '../../features/sharing/v2/google-tasks-projection.ts';
import type { V2GoogleTaskItem, V2GoogleTaskTarget } from '../../features/sharing/v2/google-tasks-projection';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';
import { addDays, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { googleTaskImportAction, parseGoogleCompletedAt } from '../../features/google-sync/google-completion-policy.ts';

type Repository = ReturnType<typeof createV2EventRepository>;
type State = Awaited<ReturnType<Repository['readState']>>;
interface LinkRecord { link: GoogleTaskLink; target: V2GoogleTaskTarget; baselineRevision: string | null; acknowledgedCompletionIds: string[] }
export interface V2GoogleControl { revision: number; label: string | null; state: GoogleSyncState | null }
const boundedText = (value: unknown, maximum = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const validRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const status = (item: GoogleSyncEntry): GoogleTaskStatus => item.completedAt ? 'completed' : 'needsAction';
// These contracts contain only JSON data; do not require a runtime-specific structuredClone global.
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stateFields = new Set(['householdId', 'enabled', 'disconnected', 'taskListId', 'accountSubject', 'lastAttemptAt',
  'lastSuccessfulSyncAt', 'status', 'retryCount', 'nextRetryAt', 'lastErrorCode', 'lastErrorAt', 'updatedAt']);
const linkFields = new Set(['scheduleEntryId', 'householdId', 'choreId', 'googleTaskListId', 'googleTaskId',
  'lastSyncedTitle', 'lastSyncedDueDate', 'lastSyncedStatus', 'pendingStatus', 'pendingStatusRevision', 'observedLocalRevision', 'createdAt', 'updatedAt']);
function fieldsOnly(value: unknown, fields: Set<string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) {
    throw new Error('Google家事の保存形式を確認してください。');
  }
}

/** Private bindings live in the already isolated v2 DB. No Google identifiers enter the signed ledger or group snapshot. */
export function createV2GoogleTaskStore(input: { repository: Repository; userId: string; groupId: string; assertAccess(): void | Promise<void>;
  makeId(): string; now(): Date; personalize?(plan: V2CommonPlan, calendar?: readonly SharedCalendarRecord[]): V2PersonalPlan; planningRevision?(): string }) {
  const { repository, userId, groupId } = input; const namespace = v2NativeWorkspaceNamespace(userId, groupId);
  if (repository.scope.userId !== userId || repository.scope.groupId !== groupId) throw new Error('Google家事の保存先を確認してください。');
  let issuedItems = new Map<string, V2GoogleTaskItem>();
  let cached: { key: string; items: Map<string, V2GoogleTaskItem>; plans: V2CommonPlan[] } | undefined;
  async function check(transaction: SQLiteDatabase) {
    await input.assertAccess(); const binding = await transaction.getFirstAsync<{ user_id: string; group_id: string; schema_version: number }>('SELECT user_id,group_id,schema_version FROM sharing_v2_binding WHERE singleton=1');
    if (binding?.user_id !== userId || binding.group_id !== groupId || binding.schema_version !== 2) throw new Error('Google家事のアカウント・グループが変わりました。');
    await input.assertAccess();
  }
  async function initialize(transaction: SQLiteDatabase) {
    await check(transaction);
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_private_google_control (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>0), label TEXT, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sharing_v2_private_google_links (
        schedule_entry_id TEXT PRIMARY KEY, link_json TEXT NOT NULL, target_json TEXT NOT NULL,
        baseline_revision TEXT, acknowledged_ids_json TEXT NOT NULL);`);
  }
  function validateState(state: GoogleSyncState): GoogleSyncState {
    fieldsOnly(state, stateFields);
    if (!state || state.householdId !== namespace || typeof state.enabled !== 'boolean' || typeof state.disconnected !== 'boolean' || state.enabled && state.disconnected
      || !boundedText(state.accountSubject, 512) || !Number.isSafeInteger(state.retryCount) || state.retryCount < 0
      || !['idle', 'syncing', 'retryPending', 'authRequired', 'error'].includes(state.status)
      || state.taskListId !== undefined && !boundedText(state.taskListId)) throw new Error('Google家事の接続設定を確認してください。');
    if (typeof state.updatedAt !== 'string' || state.lastErrorCode !== undefined && !/^[a-z0-9_-]{1,128}$/u.test(state.lastErrorCode)) throw new Error('Google家事の保存形式を確認してください。');
    for (const value of [state.updatedAt, state.lastAttemptAt, state.lastSuccessfulSyncAt, state.nextRetryAt, state.lastErrorAt]) {
      if (value !== undefined && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new Error('Google家事の同期時刻を確認してください。');
    }
    return snapshot(state);
  }
  async function controlInside(transaction: SQLiteDatabase): Promise<V2GoogleControl> {
    await initialize(transaction); const row = await transaction.getFirstAsync<{ revision: number; label: string | null; state_json: string }>('SELECT * FROM sharing_v2_private_google_control WHERE singleton=1');
    if (!row) return { revision: 0, label: null, state: null };
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.label !== null && !boundedText(row.label, 320)) throw new Error('Google家事の接続版を確認してください。');
    return { revision: row.revision, label: row.label, state: validateState(JSON.parse(row.state_json)) };
  }
  async function rowsInside(transaction: SQLiteDatabase): Promise<LinkRecord[]> {
    await initialize(transaction);
    return (await transaction.getAllAsync<{ schedule_entry_id: string; link_json: string; target_json: string; baseline_revision: string | null; acknowledged_ids_json: string }>('SELECT * FROM sharing_v2_private_google_links ORDER BY schedule_entry_id')).map(row => {
      const link = JSON.parse(row.link_json) as GoogleTaskLink; const target = validateV2GoogleTaskTarget(JSON.parse(row.target_json), userId, groupId);
      fieldsOnly(link, linkFields);
      const ids: unknown = JSON.parse(row.acknowledged_ids_json);
      if (row.schedule_entry_id !== target.subjectOccurrenceId || link.scheduleEntryId !== row.schedule_entry_id || link.householdId !== namespace
        || link.choreId !== target.choreId || !boundedText(link.googleTaskId) || !boundedText(link.googleTaskListId)
        || row.baseline_revision !== null && !validRevision(row.baseline_revision) || link.observedLocalRevision !== undefined && !validRevision(link.observedLocalRevision)
        || link.pendingStatus !== undefined && !['completed', 'needsAction'].includes(link.pendingStatus)
        || link.pendingStatusRevision !== undefined && !validRevision(link.pendingStatusRevision)
        || Boolean(link.pendingStatus) !== Boolean(link.pendingStatusRevision)
        || link.lastSyncedStatus !== undefined && !['completed', 'needsAction'].includes(link.lastSyncedStatus)
        || !Array.isArray(ids) || ids.some(id => !boundedText(id, 512)) || new Set(ids).size !== ids.length) throw new Error('Google家事の対応記録を確認してください。');
      if (link.lastSyncedDueDate !== undefined) parseLocalDate(link.lastSyncedDueDate);
      return { link, target, baselineRevision: row.baseline_revision, acknowledgedCompletionIds: ids as string[] };
    });
  }
  async function writeRow(transaction: SQLiteDatabase, row: LinkRecord) {
    fieldsOnly(row.link, linkFields);
    await check(transaction);
    await transaction.runAsync(`INSERT INTO sharing_v2_private_google_links VALUES(?,?,?,?,?) ON CONFLICT(schedule_entry_id) DO UPDATE SET
      link_json=excluded.link_json,target_json=excluded.target_json,baseline_revision=excluded.baseline_revision,acknowledged_ids_json=excluded.acknowledged_ids_json`,
    row.link.scheduleEntryId, JSON.stringify(row.link), JSON.stringify(row.target), row.baselineRevision, JSON.stringify(row.acknowledgedCompletionIds));
    await check(transaction);
  }
  function localToday(state: State) {
    const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
    const zone = state.assessment.view.field('settings', 'settings', 'timeZone', at)?.value;
    if (typeof zone !== 'string') throw new Error('Google家事の地域を確認してください。');
    return sharedLocalDate(input.now(), zone);
  }
  async function catalog(state: State, transaction: SQLiteDatabase, rows: LinkRecord[]) {
    const today = localToday(state); const anchors = [...new Set(rows.map(row => row.target.anchorDate))].sort();
    const projection = await transaction.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
    const key = sharedDocumentDigest(JSON.stringify([projection?.fact_hash, today, anchors, input.planningRevision?.() ?? 'common']));
    if (cached?.key === key) return cached;
    const main = buildV2CommonPlan(state, { from: addDays(today, -5), through: addDays(today, 14), asOfDate: today });
    const plans = [main]; const visibleAnchors = new Set(main.occurrences.map(row => row.anchorDate));
    for (const anchor of anchors) if (!visibleAnchors.has(anchor) && (anchor < main.range.from || anchor > main.range.through)) {
      plans.push(buildV2CommonPlan(state, { from: anchor, through: anchor, asOfDate: today }));
    }
    const calendar = readSharedCalendar(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)!));
    const items = new Map(plans.flatMap(plan => v2GoogleTaskItems(plan, userId, input.personalize?.(plan, calendar))).map(item => [item.entry.id, item]));
    cached = { key, items, plans }; return cached;
  }
  function retainedEntry(row: LinkRecord, plans: V2CommonPlan[]): GoogleSyncEntry | null {
    const plan = plans.find(plan => plan.occurrences.some(round => round.id === row.target.occurrenceId)) ?? plans[0];
    const chore = plan.chores.find(chore => chore.id === row.target.choreId); const round = plan.occurrences.find(round => round.id === row.target.occurrenceId);
    const subject = round?.subjects.find(subject => subject.id === row.target.subjectOccurrenceId);
    const uncertain = plan.issues.some(issue => issue.choreId === null || issue.choreId === row.target.choreId || issue.occurrenceId === row.target.occurrenceId);
    const owns = subject && (subject.subjectUserId === userId || subject.subjectUserId === null && (!round!.assigneeIds.length || round!.assigneeIds.includes(userId)));
    if (!uncertain && (chore?.archived || chore && !chore.enabled || subject && (!owns || !subject.required || subject.cooldownSuppressed || subject.virtuallyConsumed))) return null;
    return { choreName: row.link.lastSyncedTitle ?? chore?.name ?? '共有家事', synchronizationBlocked: true,
      entry: { id: row.link.scheduleEntryId, householdId: namespace, choreId: row.target.choreId, cycleBaseDate: row.target.anchorDate,
        windowStart: row.target.anchorDate, windowEnd: row.target.anchorDate, suggestedDate: row.link.lastSyncedDueDate ?? row.target.anchorDate, status: 'scheduled', assignedMemberIds: [] } };
  }
  async function stageRows(state: State, transaction: SQLiteDatabase) {
    const rows = await rowsInside(transaction); const projected = await catalog(state, transaction, rows);
    for (const row of rows) {
      const item = projected.items.get(row.link.scheduleEntryId); if (!item || item.synchronizationBlocked) continue;
      const link = { ...row.link, observedLocalRevision: item.localRevision };
      if (row.baselineRevision !== item.localRevision && (row.baselineRevision !== null || item.completedAt || item.locallyIncomplete)) {
        link.pendingStatus = status(item); link.pendingStatusRevision = item.localRevision;
      }
      if (JSON.stringify(link) !== JSON.stringify(row.link) || JSON.stringify(row.target) !== JSON.stringify(item.target)) {
        row.link = link; row.target = item.target; await writeRow(transaction, row);
      }
    }
    return { rows, projected };
  }
  const readControl = () => repository.readCurrent((_state, transaction) => controlInside(transaction));
  const port: GoogleSyncRepositoryPort = {
    taskNamespace: namespace,
    async listEntriesForGoogleSync(_today, householdId) {
      if (householdId !== namespace) throw new Error('Google家事の作業領域を確認してください。');
      return repository.readCurrent(async (state, transaction) => {
        const { rows, projected } = await stageRows(state, transaction); issuedItems = new Map([...projected.items].map(([id, item]) => [id, snapshot(item)]));
        return snapshot([...projected.items.values(), ...rows.filter(row => !projected.items.has(row.link.scheduleEntryId)).flatMap(row => {
          const item = retainedEntry(row, projected.plans); return item ? [item] : [];
        })]);
      });
    },
    listGoogleTaskLinks: householdId => {
      if (householdId !== namespace) return Promise.reject(new Error('Google家事の作業領域を確認してください。'));
      return repository.readCurrent(async (state, transaction) => (await stageRows(state, transaction)).rows.map(row => ({ ...row.link })));
    },
    async upsertGoogleTaskLink(value) {
      const link = snapshot(value);
      await repository.readCurrent(async (_state, transaction) => {
        const rows = await rowsInside(transaction); const previous = rows.find(row => row.link.scheduleEntryId === link.scheduleEntryId);
        const item = issuedItems.get(link.scheduleEntryId); const target = item?.target ?? previous?.target;
        if (!target || link.choreId !== target.choreId || link.householdId !== namespace || !boundedText(link.googleTaskListId) || !boundedText(link.googleTaskId)
          || !validRevision(link.observedLocalRevision) || rows.some(row => row.link.scheduleEntryId !== link.scheduleEntryId && row.link.googleTaskListId === link.googleTaskListId && row.link.googleTaskId === link.googleTaskId)) throw new Error('Google家事の対応先を確認してください。');
        if (previous) await writeRow(transaction, { ...previous, target, link: { ...previous.link, ...link,
          pendingStatus: previous.link.pendingStatus, pendingStatusRevision: previous.link.pendingStatusRevision,
          ...(previous.link.googleTaskId === link.googleTaskId && previous.link.googleTaskListId === link.googleTaskListId ? { lastSyncedStatus: previous.link.lastSyncedStatus } : { lastSyncedStatus: undefined }) } });
        else await writeRow(transaction, { link, target, baselineRevision: item && !item.completedAt && !item.locallyIncomplete ? item.localRevision : null, acknowledgedCompletionIds: [] });
      });
    },
    deleteGoogleTaskLink: id => repository.readCurrent(async (_state, transaction) => {
      const row = (await rowsInside(transaction)).find(row => row.link.scheduleEntryId === id); if (row) { await check(transaction); await transaction.runAsync('DELETE FROM sharing_v2_private_google_links WHERE schedule_entry_id=?', id); await check(transaction); }
    }),
    async acknowledgeGoogleTaskStatus(sent, remoteStatus) {
      await repository.readCurrent(async (state, transaction) => {
        const { rows, projected } = await stageRows(state, transaction); const row = rows.find(row => row.link.scheduleEntryId === sent.scheduleEntryId);
        if (!row || row.link.googleTaskId !== sent.googleTaskId || row.link.googleTaskListId !== sent.googleTaskListId || !validRevision(sent.observedLocalRevision)) return;
        const current = projected.items.get(sent.scheduleEntryId); const observed = issuedItems.get(sent.scheduleEntryId);
        row.link.lastSyncedStatus = remoteStatus; row.baselineRevision = sent.observedLocalRevision;
        if (observed?.localRevision === sent.observedLocalRevision) row.acknowledgedCompletionIds = [...observed.undoCompletionIds];
        if (current?.localRevision === sent.observedLocalRevision && status(current) === remoteStatus) {
          row.acknowledgedCompletionIds = [...current.undoCompletionIds]; row.link.pendingStatus = undefined; row.link.pendingStatusRevision = undefined;
        }
        await writeRow(transaction, row);
      });
    },
    async importGoogleTaskChanges(changes: readonly GoogleTaskStatusChange[]) {
      let imported = 0;
      for (const change of snapshot(changes)) {
        if (change.status === 'completed' && !parseGoogleCompletedAt(change.completedAt)) continue;
        // These objects are private to this single command; the normal action fills its reference from the transaction's current plan.
        const ref = {} as V2GoogleTaskTarget; const targets: string[] = [];
        const actions = createV2PlannerActions({ ...repository, commitCurrent: build => repository.commitCurrent(async (state, transaction) => {
          const { rows, projected } = await stageRows(state, transaction);
          const row = rows.find(row => row.link.scheduleEntryId === change.scheduleEntryId && row.link.googleTaskId === change.googleTaskId && row.link.googleTaskListId === change.googleTaskListId);
          const item = projected.items.get(change.scheduleEntryId); if (!row || !item || item.synchronizationBlocked) return [];
          const action = googleTaskImportAction(row.link, item.completedAt ? 'completed' : item.locallyIncomplete ? 'incomplete' : undefined, change.status);
          if (action === 'ignore') return [];
          Object.assign(ref, item.target); targets.push(...row.acknowledgedCompletionIds.filter(id => item.undoCompletionIds.includes(id)));
          if (action === 'undo' && !targets.length) return [];
          const drafts = await build(state, transaction); if (!drafts.length) return [];
          const after = v2GoogleRevisionAfterImport(item, drafts);
          row.baselineRevision = after.revision; row.acknowledgedCompletionIds = after.undoCompletionIds;
          row.link = { ...row.link, lastSyncedStatus: change.status, observedLocalRevision: after.revision, pendingStatus: undefined, pendingStatusRevision: undefined };
          await writeRow(transaction, row); return drafts;
        }) }, { makeId: input.makeId, now: input.now });
        const operations = change.status === 'completed' ? await actions.complete(ref, { performedAt: change.completedAt }) : await actions.undoMany(targets);
        imported += operations.length ? 1 : 0;
      }
      return imported;
    },
  };
  return { port, readControl,
    readToday: () => repository.readCurrent(async state => localToday(state)),
    readSavedLinks: () => repository.readCurrent(async (_state, transaction) => (await rowsInside(transaction)).map(row => snapshot(row.link))),
    async configure(expectedRevision: number, account: { subject: string; label: string }, enabled: boolean, disconnected = false) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !boundedText(account.subject, 512) || !boundedText(account.label, 320)
        || typeof enabled !== 'boolean' || typeof disconnected !== 'boolean' || enabled && disconnected) throw new Error('Google家事の接続操作を確認してください。');
      return repository.readCurrent(async (_state, transaction) => {
        const before = await controlInside(transaction);
        if (before.revision !== expectedRevision) throw new Error('別の操作でGoogle家事の接続が変わりました。再読込してください。');
        if (before.state?.accountSubject && before.state.accountSubject !== account.subject) throw Object.assign(new Error('以前連携したGoogleアカウントを選択してください。'), { code: 'google_account_mismatch' });
        const next = validateState({ ...(before.state ?? { householdId: namespace, status: 'idle', retryCount: 0 }), accountSubject: account.subject, enabled, disconnected, updatedAt: input.now().toISOString() });
        if (before.label === account.label && before.state?.enabled === enabled && before.state.disconnected === disconnected) return before;
        if (!Number.isSafeInteger(before.revision + 1)) throw new Error('Google家事の接続版を確認してください。');
        await transaction.runAsync(`INSERT INTO sharing_v2_private_google_control VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,label=excluded.label,state_json=excluded.state_json`,
          before.revision + 1, account.label, JSON.stringify(next)); await check(transaction);
        return { revision: before.revision + 1, label: account.label, state: next };
      });
    },
    async saveSyncState(value: GoogleSyncState, expectedRevision: number) {
      const state = validateState(value);
      return repository.readCurrent(async (_current, transaction) => {
        const before = await controlInside(transaction);
        if (!before.state || before.revision !== expectedRevision || before.state.accountSubject !== state.accountSubject
          || before.state.enabled !== state.enabled || before.state.disconnected !== state.disconnected) throw new Error('Google家事の接続が変わりました。古い同期結果は保存しません。');
        await transaction.runAsync('UPDATE sharing_v2_private_google_control SET state_json=? WHERE singleton=1 AND revision=?', JSON.stringify(state), expectedRevision); await check(transaction);
      });
    },
    hasPendingLocalChanges: () => repository.readCurrent(async (state, transaction) => (await stageRows(state, transaction)).rows.some(row => Boolean(row.link.pendingStatus))),
  };
}
export type V2GoogleTaskStore = ReturnType<typeof createV2GoogleTaskStore>;
