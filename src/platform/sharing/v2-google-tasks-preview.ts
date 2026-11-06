import { randomUUID } from 'expo-crypto';
import { loadOrCreateSharingDeviceIdentity } from './secure-store';
import { openSharingV2Database } from './database-location';
import { createSharedRoster } from '../../features/sharing/roster';
import { createV2EventRepository, initializeV2EventStore } from '../storage/sharing-v2-events';
import { drainSharingLedger } from '../storage/sharing-ledger';
import { V2_SCHEDULER_VERSION } from '../../features/sharing/v2/payload-schema';
import { v2GroupBootstrap } from '../../features/sharing/v2/bootstrap';
import { chorePolicyFromPreset } from '../../features/sharing/v2/model';
import { createV2GroupController } from '../../features/sharing/v2/controller';
import { createNativeV2GoogleTasks } from './v2-google-tasks';
import { buildV2PersonalPlan } from '../../features/sharing/v2/personal-plan';
import { v2NativeWorkspaceNamespace } from '../../features/sharing/v2/native-identity';
import { sharedLocalDate } from '../../features/sharing/group-clock';
import { addDays } from '../../domain/scheduling/local-date';
import { withGoogleSyncOperation } from '../../features/google-sync/operation-lock';
import { getCurrentGoogleSubject, getGoogleTasksAccessToken } from '../google-tasks/google-sign-in-gateway';
import { createGoogleTasksApi } from '../google-tasks/google-tasks-api';
import { sharedGoogleOccurrenceNote } from '../../features/google-sync/workspace-policy';
import { validateV2GoogleTaskTarget, v2GoogleTaskItems } from '../../features/sharing/v2/google-tasks-projection';
import type { V2GoogleTaskItem } from '../../features/sharing/v2/google-tasks-projection';
import { sharedDocumentDigest } from '../../features/sharing/crypto';

const fail = (code: string): never => { throw Object.assign(new Error('Google Tasksの合成検査を完了できません。'), { code: `qa/${code}` }); };
/** Local synthetic group; real Native Google OAuth/Tasks only after explicit account review. Never Firebase or personal planner data. */
export async function createV2GoogleTasksPreview() {
  if (!__DEV__) throw new Error('Google Tasksの検査は開発ビルド専用です。');
  const userId = `qa-tasks-owner-20261029.${V2_SCHEDULER_VERSION}`; const groupId = `qa-tasks-group-20261029.${V2_SCHEDULER_VERSION}`;
  const identity = await loadOrCreateSharingDeviceIdentity(userId, 'development-v2-tasks-20261029');
  if (!__DEV__) throw new Error('Google Tasksの検査は開発ビルド専用です。');
  const database = await openSharingV2Database(userId, groupId, 'development-v2-tasks-20261029'); let closed = false;
  const guard = () => { if (!__DEV__ || closed) fail('closed'); }; const close = async () => { if (closed) return; closed = true; await drainSharingLedger(database); await database.closeAsync(); };
  try {
    const roster = createSharedRoster(groupId, userId, identity, { schemaVersion: 2 });
    await initializeV2EventStore(database, { userId, groupId, householdId: 'qa-v2-tasks' });
    const repository = createV2EventRepository(database, { userId, groupId, householdId: 'qa-v2-tasks', identity,
      anchor: roster, archive: () => [roster], assertWritable: guard, now: () => new Date() });
    const state = await repository.readState(); const today = sharedLocalDate(new Date(), 'Asia/Tokyo'); const choreId = 'qa-tasks-chore';
    if (!state.replica.operations.length) await repository.commit(v2GroupBootstrap({ groupId, ownerUserId: userId, ownerDisplayName: 'Tasks検査用',
      name: '開発用・Google Tasks検査', timeZone: 'Asia/Tokyo', anchorDate: today, kind: 'family' }));
    const controller = createV2GroupController(repository, { makeId: randomUUID, now: () => new Date(), sync: async () => fail('no-cloud') });
    if (!(await controller.actions.readPlan({ from: today, through: today, asOfDate: today })).chores.some(chore => chore.id === choreId)) await repository.commit([
      { operationId: 'qa-tasks-chore-v1', entityType: 'chore', entityId: choreId, operationType: 'patch', payload: { name: 'LiFlow検査用・合成家事', enabled: false, load: 'light' } },
    ]);
    if (!(await repository.readState()).assessment.view.topic('chorePolicy', choreId).length) await controller.actions.configureChore(choreId, {
      policy: chorePolicyFromPreset('common'), anchorDate: today, intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, effectiveFrom: today, active: true });
    const settings = { frequencyMode: 'balanced' as const, restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } };
    const runtime = createNativeV2GoogleTasks({ repository, userId, groupId, assertAccess: guard, readPlanning: async instant => ({ revision: 'qa-static-owner-input',
      personalize: plan => buildV2PersonalPlan(plan, { viewerUserId: userId, now: instant.getTime(), settings }) }) });
    const namespace = v2NativeWorkspaceNamespace(userId, groupId); let firstTaskId: string | undefined;
    async function synchronized() { guard(); const result = await runtime.synchronize({ force: true }); guard(); if (result.kind !== 'success' || result.skipped) return fail('sync'); return result; }
    async function reference() {
      // A reopened QA context has not prepared the Native sync adapter's private cache yet.
      // Use the same pure projection with this fixture's explicit inputs; no extra Google fetch is needed.
      const plan = await controller.actions.readPlan({ from: today, through: addDays(today, 14), asOfDate: today }); guard();
      const entries = v2GoogleTaskItems(plan, userId, buildV2PersonalPlan(plan, { viewerUserId: userId, settings, now: Date.now() }));
      const item = entries.find(item => item.entry.choreId === choreId && item.entry.cycleBaseDate === today) as V2GoogleTaskItem | undefined;
      if (!item) return fail('reference');
      return { item, ref: validateV2GoogleTaskTarget(item.target, userId, groupId) };
    }
    async function remote<T>(work: (api: ReturnType<typeof createGoogleTasksApi>, token: string, listId: string) => Promise<T>) {
      return withGoogleSyncOperation(async () => {
        guard(); const control = await runtime.readControl(); if (!control.state?.accountSubject || !control.state.taskListId) return fail('binding');
        if (await getCurrentGoogleSubject() !== control.state.accountSubject) return fail('account');
        const token = await getGoogleTasksAccessToken(control.state.accountSubject); guard();
        const value = await work(createGoogleTasksApi(), token, control.state.taskListId); guard();
        if (await getCurrentGoogleSubject() !== control.state.accountSubject) return fail('account'); return value;
      });
    }
    async function linked() {
      const value = await reference(); const link = (await runtime.store.readSavedLinks()).find(link => link.scheduleEntryId === value.item.entry.id);
      if (!link) return fail('link'); if (firstTaskId && firstTaskId !== link.googleTaskId) return fail('changed-id'); firstTaskId ??= link.googleTaskId;
      return { ...value, link };
    }
    async function verifyStatus(want: 'completed' | 'needsAction') {
      const value = await linked(); const task = await remote((api, token, listId) => api.getTask(token, listId, value.link.googleTaskId));
      if (task.status !== want || task.notes !== sharedGoogleOccurrenceNote(namespace, value.item.entry.id) || Boolean(value.item.completedAt) !== (want === 'completed')) fail('status');
    }
    return { runtime, close,
      async verify() {
        await synchronized(); const links = await runtime.store.readSavedLinks();
        if (links.length !== 3) fail('count'); const tasks = await remote((api, token, listId) => api.listTasks(token, listId));
        for (const link of links) if (tasks.filter(task => !task.deleted && task.id === link.googleTaskId && task.notes === sharedGoogleOccurrenceNote(namespace, link.scheduleEntryId)).length !== 1) fail('mapping');
        await linked(); return 'Google Tasks予約検査 PASS：3件・本人専用・対応一致';
      },
      async localComplete() { const value = await linked(); await controller.actions.complete(value.ref); await synchronized(); await verifyStatus('completed'); return 'Tasksアプリ完了検査 PASS：同じID・Google完了'; },
      async localUndo() { const value = await linked(); await controller.actions.undoMany(value.item.undoCompletionIds); await synchronized(); await verifyStatus('needsAction'); return 'Tasksアプリ取消検査 PASS：同じID・Google未完了'; },
      async remoteComplete() {
        const value = await linked(); await remote((api, token, listId) => api.patchTask(token, listId, value.link.googleTaskId, { status: 'completed', completed: new Date(Date.now() - 1_000).toISOString() }));
        const result = await synchronized(); if (result.imported !== 1) fail('completion-import'); await verifyStatus('completed'); return 'Tasks外部完了検査 PASS：本人の署名付き履歴へ取込';
      },
      async remoteUndo() {
        const value = await linked(); await remote((api, token, listId) => api.patchTask(token, listId, value.link.googleTaskId, { status: 'needsAction', completed: null }));
        const result = await synchronized(); if (result.imported !== 1) fail('undo-import'); await verifyStatus('needsAction'); return 'Tasks外部取消検査 PASS：対象の完了だけ取消';
      },
      async changeDate() {
        const value = await linked(); await controller.actions.changeDate(value.ref, { mode: 'day', target: { precision: 'date', date: addDays(today, 1) } }); await synchronized();
        const after = await linked(); const task = await remote((api, token, listId) => api.getTask(token, listId, after.link.googleTaskId));
        if (task.due?.slice(0, 10) !== addDays(today, 1)) fail('due'); return 'Tasks期日検査 PASS：家事回とGoogle IDを保持';
      },
      async verifySaved() { const control = await runtime.readControl(); if (!control.state?.enabled || !control.state.taskListId) fail('saved'); const links = await runtime.store.readSavedLinks();
        if (links.length !== 3) fail('saved-links'); const digest = sharedDocumentDigest(JSON.stringify([control, links]));
        return `Tasks保存検査 PASS：接続・3件の対応を再取得なしで復元・照合値${digest}`; },
      async clean() {
        const control = await runtime.readControl(); await runtime.pause(control.revision, true); const links = await runtime.store.readSavedLinks();
        await remote(async (api, token, listId) => {
          const all = await api.listTasks(token, listId);
          for (const link of links) { const task = all.find(task => task.id === link.googleTaskId); if (!task || task.deleted) continue;
            if (task.notes !== sharedGoogleOccurrenceNote(namespace, link.scheduleEntryId) || !task.etag) fail('cleanup-scope'); await api.deleteTask(token, listId, task.id, task.etag!); }
        }); return 'Tasks片付け検査 PASS：合成3件だけ削除・個人データ保持';
      },
    };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
