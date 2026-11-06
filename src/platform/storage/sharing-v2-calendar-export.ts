import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from './sharing-v2-events';
import { readSharedCalendar, sharedCalendarPayload } from '../../features/sharing/v2/calendar-state.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { v2ReadPoint } from '../../features/sharing/v2/view-point.ts';
import type { LocalDate } from '../../domain/shared/types';
import type { EventDraft } from '../../domain/calendar/events';
import { googleOwnedFields } from '../../features/calendar/google-owned-fields.ts';
import { googleEventBody } from '../../features/calendar/google-event-mapping.ts';

export interface SharedCalendarExportControl {
  enabled: boolean; revision: number; subject: string | null; accountLabel: string | null; calendarId: string | null; calendarLabel: string | null;
  lastSyncAt: number | null; error: string | null; retryAt: number | null; retryCount: number;
  pending?: boolean;
}
export interface SharedCalendarExportIntent {
  method: 'insert' | 'patch' | 'delete'; googleId: string; etag: string; revision: string; payload: Record<string, unknown> | null;
}
export interface SharedCalendarExportLink { sourceId: string; googleId: string; etag: string; revision: string; deleted: boolean; pending?: SharedCalendarExportIntent }
export interface SharedCalendarExportItem { sourceId: string; parentId?: string; anchorDate?: LocalDate; value: EventDraft | null; revision: string; reset?: boolean;
  /** No content is exportable yet; this is not a remote deletion instruction. */
  blocked?: 'conflict' | 'receipt'; }
const initial: SharedCalendarExportControl = { enabled: false, revision: 0, subject: null, accountLabel: null, calendarId: null, calendarLabel: null, lastSyncAt: null, error: null, retryAt: null, retryCount: 0 };
const text = (value: unknown, limit = 1024) => typeof value === 'string' && value.length > 0 && value.length <= limit;

/** These private tables never enter the encrypted group Outbox or snapshots. */
export function createSharedCalendarExportStore(repository: ReturnType<typeof createV2EventRepository>) {
  async function initialize(tx: SQLiteDatabase) {
    await tx.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_calendar_export_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1), value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sharing_v2_calendar_export_links(subject TEXT NOT NULL, calendar_id TEXT NOT NULL, source_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(subject,calendar_id,source_id));`);
  }
  async function control(tx: SQLiteDatabase): Promise<SharedCalendarExportControl> {
    await initialize(tx); const row = await tx.getFirstAsync<{ value_json: string }>('SELECT value_json FROM sharing_v2_calendar_export_control WHERE singleton=1');
    if (!row) return { ...initial };
    const value = JSON.parse(row.value_json) as SharedCalendarExportControl;
    if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 1
      || value.enabled && (!text(value.subject) || !text(value.calendarId))) throw new Error('共有予定のGoogle接続設定を確認してください。');
    return value;
  }
  const write = (tx: SQLiteDatabase, value: SharedCalendarExportControl) => tx.runAsync('INSERT INTO sharing_v2_calendar_export_control VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value_json=excluded.value_json', JSON.stringify(value));
  return {
    readControl: () => repository.withPrivateStorage(tx => control(tx)),
    configure: (patch: Pick<SharedCalendarExportControl, 'enabled'> & Partial<Pick<SharedCalendarExportControl, 'subject' | 'accountLabel' | 'calendarId' | 'calendarLabel'>>, revision: number) => repository.withPrivateStorage(async tx => {
      if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !['enabled', 'subject', 'accountLabel', 'calendarId', 'calendarLabel'].includes(key))) throw new Error('Google接続の保存項目が無効です。');
      const old = await control(tx); if (old.revision !== revision) throw new Error('接続設定が変わりました。読み直してください。');
      const value = { ...old, ...patch, revision: old.revision + 1, error: null, retryAt: null, retryCount: 0 };
      if (typeof value.enabled !== 'boolean' || [value.subject, value.calendarId].some(id => id !== null && !text(id)) || value.enabled && (!text(value.subject) || !text(value.calendarId))
        || [value.accountLabel, value.calendarLabel].some(label => label !== null && !text(label, 320))) throw new Error('Googleアカウントと追加先カレンダーを選んでください。');
      await write(tx, value); return value;
    }),
    saveStatus: (revision: number, patch: Pick<SharedCalendarExportControl, 'error' | 'retryAt' | 'retryCount'> & { lastSyncAt?: number; pending?: boolean }) => repository.withPrivateStorage(async tx => {
      if (Object.keys(patch).some(key => !['error', 'retryAt', 'retryCount', 'lastSyncAt', 'pending'].includes(key)) || patch.error !== null && !text(patch.error, 1000)
        || patch.pending !== undefined && typeof patch.pending !== 'boolean'
        || !Number.isSafeInteger(patch.retryCount) || patch.retryCount < 0 || [patch.retryAt, patch.lastSyncAt].some(value => value != null && (!Number.isSafeInteger(value) || value < 0))) throw new Error('Google同期状態が無効です。');
      const old = await control(tx); if (old.revision === revision) await write(tx, { ...old, ...patch });
    }),
    readLinks: (subject: string, calendarId: string) => repository.withPrivateStorage(async tx => {
      await initialize(tx); const rows = await tx.getAllAsync<{ value_json: string }>('SELECT value_json FROM sharing_v2_calendar_export_links WHERE subject=? AND calendar_id=?', subject, calendarId);
      return rows.map(row => JSON.parse(row.value_json) as SharedCalendarExportLink);
    }),
    knownSeriesRevision: (sourceId: string, revision: string) => repository.readCurrent(async state => {
      if (!text(sourceId, 512) || !text(revision, 128)) return null;
      const view = state.assessment.view; const at = v2ReadPoint(view, state.archive.at(-1)!);
      const current = readSharedCalendar(view, at).find(row => row.id === sourceId);
      if (!current || current.heads.length !== 1 || !state.receipts.has(current.heads[0].operationId)) return null;
      const currentRevision = sharedDocumentDigest([current.heads[0].operationId, sharedCalendarPayload(current.heads[0])]);
      // A marker alone is not proof. Match actual owned fields to a receipted,
      // authority-validated historical series operation in this same group.
      for (const operation of view.observed(view.ofType('calendarEvent'), at)) {
        if (!state.receipts.has(operation.operationId)) continue;
        const payload = sharedCalendarPayload(operation);
        if (payload.eventId === sourceId && payload.scope === 'series' && payload.value
          && sharedDocumentDigest([operation.operationId, payload]) === revision) {
          const body = googleEventBody(payload.value);
          return body ? { currentRevision, fields: googleOwnedFields(body) } : null;
        }
      }
      // An instance also depends on its series and reset history. No series-only
      // proof may silently adopt a different instance's ETag.
      return null;
    }),
    // Retain a just-finished HTTP receipt even if OFF was tapped in flight. It
    // belongs to the captured account/target, never the replacement connection.
    saveLink: (subject: string, calendarId: string, link: SharedCalendarExportLink) => repository.withPrivateStorage(async tx => {
      if (!text(subject) || !text(calendarId) || Object.keys(link).some(key => !['deleted', 'etag', 'googleId', 'revision', 'sourceId', 'pending'].includes(key)) || !text(link.sourceId, 512)
        || typeof link.deleted !== 'boolean' || typeof link.googleId !== 'string' || link.googleId.length > 1024 || typeof link.etag !== 'string' || link.etag.length > 1024
        || !(text(link.revision, 128) || link.revision === '' && link.pending) || !link.deleted && !link.pending && (!link.etag || !link.googleId)) throw new Error('Google予定の紐付けが無効です。');
      if (link.pending) {
        const pending = link.pending;
        if (Object.keys(pending).sort().join(',') !== 'etag,googleId,method,payload,revision' || !['insert', 'patch', 'delete'].includes(pending.method)
          || !text(pending.googleId) || !text(pending.revision, 128) || typeof pending.etag !== 'string' || pending.etag.length > 1024
          || pending.method !== 'insert' && !pending.etag || (pending.method === 'delete' ? pending.payload !== null
            : !pending.payload || typeof pending.payload !== 'object' || Array.isArray(pending.payload) || JSON.stringify(pending.payload).length > 500_000)) throw new Error('Google予定の送信記録が無効です。');
      }
      await initialize(tx); await tx.runAsync('INSERT INTO sharing_v2_calendar_export_links VALUES(?,?,?,?) ON CONFLICT(subject,calendar_id,source_id) DO UPDATE SET value_json=excluded.value_json', subject, calendarId, link.sourceId, JSON.stringify(link));
    }),
    readItems: () => repository.readCurrent(async state => {
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!); const result: SharedCalendarExportItem[] = [];
      const resetByEvent = new Map<string, Set<string>>();
      for (const operation of state.assessment.view.observed(state.assessment.view.ofType('calendarEvent'), at)) {
        if (!state.receipts.has(operation.operationId)) continue;
        const data = sharedCalendarPayload(operation); const ids = resetByEvent.get(data.eventId) ?? new Set<string>();
        data.resetExceptionIds.forEach(id => ids.add(id)); resetByEvent.set(data.eventId, ids);
      }
      for (const record of readSharedCalendar(state.assessment.view, at)) {
        if (record.heads.length !== 1 || !state.receipts.has(record.heads[0].operationId)) {
          result.push({ sourceId: record.id, value: null, revision: sharedDocumentDigest(record.heads.map(head => head.operationId).sort()),
            blocked: record.heads.length !== 1 ? 'conflict' : 'receipt' });
          continue;
        }
        const head = record.heads[0]; const data = sharedCalendarPayload(head);
        result.push({ sourceId: record.id, value: data.value, revision: sharedDocumentDigest([head.operationId, data]) });
        if (!data.value) continue;
        for (const instance of record.exceptions) {
          if (instance.heads.length !== 1 || !state.receipts.has(instance.heads[0].operationId)) {
            result.push({ sourceId: `${record.id}:${instance.anchorDate}`, parentId: record.id, anchorDate: instance.anchorDate,
              value: null, revision: sharedDocumentDigest(instance.heads.map(head => head.operationId).sort()),
              blocked: instance.heads.length !== 1 ? 'conflict' : 'receipt' });
            continue;
          }
          const operation = instance.heads[0]; const payload = sharedCalendarPayload(operation);
          result.push({ sourceId: `${record.id}:${instance.anchorDate}`, parentId: record.id, anchorDate: instance.anchorDate,
            value: payload.value, revision: sharedDocumentDigest([head.operationId, operation.operationId, payload]) });
        }
        // An exception reset remains meaningful after further series edits. The
        // head's reset list alone is not a complete history of external copies.
        for (const id of resetByEvent.get(record.id) ?? []) {
          const old = state.assessment.view.byId(id); if (!old || old.entityType !== 'calendarEvent') continue;
          const anchorDate = sharedCalendarPayload(old).anchorDate!;
          if (record.exceptions.some(row => row.anchorDate === anchorDate)) continue;
          result.push({ sourceId: `${record.id}:${anchorDate}`, parentId: record.id, anchorDate, value: data.value,
            reset: true, revision: sharedDocumentDigest([head.operationId, anchorDate, 'reset']) });
        }
      }
      return result;
    }),
  };
}
export type SharedCalendarExportStore = ReturnType<typeof createSharedCalendarExportStore>;
