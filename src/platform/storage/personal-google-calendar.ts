import type { SQLiteDatabase } from 'expo-sqlite';
import type { GoogleCalendarListEntry } from '../google-calendar/calendar-api';
import { canReadGoogleCalendar, canWriteGoogleCalendar } from '../google-calendar/calendar-api.ts';
import { sharedRepositoryAdapter } from './shared-repository-adapter.ts';
import { withPlannerDatabaseOperation } from './repository.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { notifyCalendarSyncStatusChanged } from './calendar-events.ts';

export interface PersonalGoogleCalendarControl {
  subject: string; generation: number; enabled: boolean; calendars: GoogleCalendarListEntry[];
  targetCalendarId: string | null; lastSyncAt: string | null; error: string | null; retryAt: number; retryCount: number;
}
export const EMPTY_PERSONAL_GOOGLE_CALENDAR: PersonalGoogleCalendarControl = {
  subject: '', generation: 0, enabled: false, calendars: [], targetCalendarId: null, lastSyncAt: null, error: null, retryAt: 0, retryCount: 0,
};
const initializing = new WeakMap<SQLiteDatabase, Promise<void>>();
async function assertPersonal(database: SQLiteDatabase) {
  if (sharedRepositoryAdapter(database) || !await database.getFirstAsync("SELECT id FROM households WHERE id='local-household'")) throw new Error('個人予定の保存先を確認してください。');
}
export function initializePersonalGoogleCalendar(database: SQLiteDatabase): Promise<void> {
  const pending = initializing.get(database); if (pending) return pending;
  const work = withPlannerDatabaseOperation(database, async () => {
    await assertPersonal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      await tx.execAsync(`
        CREATE TABLE IF NOT EXISTS calendar_google_control (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), control_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calendar_google_links (
          subject TEXT NOT NULL, calendar_id TEXT NOT NULL, google_id TEXT NOT NULL,
          event_id TEXT NOT NULL, anchor_date TEXT NOT NULL DEFAULT '', etag TEXT,
          base_json TEXT, local_base_json TEXT, local_revision INTEGER NOT NULL DEFAULT 0,
          remote_json TEXT, conflict_json TEXT, pending_json TEXT, read_only INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(subject,calendar_id,google_id), UNIQUE(subject,event_id,anchor_date)
        );
        CREATE INDEX IF NOT EXISTS calendar_google_links_local ON calendar_google_links(event_id,anchor_date);
        CREATE TABLE IF NOT EXISTS calendar_google_cursors (
          subject TEXT NOT NULL, calendar_id TEXT NOT NULL,
          sync_token TEXT, page_token TEXT, scan_id TEXT,
          PRIMARY KEY(subject,calendar_id)
        );
        CREATE TABLE IF NOT EXISTS calendar_google_inbox (
          subject TEXT NOT NULL, calendar_id TEXT NOT NULL, google_id TEXT NOT NULL,
          event_json TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1,
          scan_id TEXT, PRIMARY KEY(subject,calendar_id,google_id)
        );
        CREATE INDEX IF NOT EXISTS calendar_google_inbox_pending ON calendar_google_inbox(
          subject,calendar_id,dirty,CASE WHEN json_extract(event_json,'$.recurringEventId') IS NULL THEN 0 ELSE 1 END,google_id
        );
        CREATE TABLE IF NOT EXISTS calendar_google_expansion (
          subject TEXT NOT NULL, calendar_id TEXT NOT NULL, parent_id TEXT NOT NULL,
          page_token TEXT, range_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(subject,calendar_id,parent_id)
        );
        CREATE TABLE IF NOT EXISTS calendar_google_expanded (
          subject TEXT NOT NULL, calendar_id TEXT NOT NULL, parent_id TEXT NOT NULL, google_id TEXT NOT NULL,
          seen INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(subject,calendar_id,parent_id,google_id)
        );
        CREATE TABLE IF NOT EXISTS calendar_google_requested_ranges (
          subject TEXT PRIMARY KEY, range_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calendar_google_progress (
          subject TEXT PRIMARY KEY, remaining_json TEXT NOT NULL
        );
      `);
      const columns = await tx.getAllAsync<{ name: string }>('PRAGMA table_info(calendar_google_links)');
      if (!columns.some(column => column.name === 'local_base_json')) await tx.execAsync('ALTER TABLE calendar_google_links ADD COLUMN local_base_json TEXT');
      if (!columns.some(column => column.name === 'pending_json')) await tx.execAsync('ALTER TABLE calendar_google_links ADD COLUMN pending_json TEXT');
      const inboxColumns = await tx.getAllAsync<{ name: string }>('PRAGMA table_info(calendar_google_inbox)');
      if (!inboxColumns.some(column => column.name === 'attempt_order')) await tx.execAsync('ALTER TABLE calendar_google_inbox ADD COLUMN attempt_order INTEGER NOT NULL DEFAULT 0');
      await tx.execAsync(`CREATE INDEX IF NOT EXISTS calendar_google_inbox_attempts ON calendar_google_inbox(
        subject,calendar_id,dirty,CASE WHEN json_extract(event_json,'$.recurringEventId') IS NULL THEN 0 ELSE 1 END,attempt_order,google_id
      )`);
      if (await tx.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_event_exceptions'")) {
        // Repair an earlier import that acknowledged an instance without keeping
        // its independent availability. A negative revision is an inherited
        // projection; changed series and intentional local resets are excluded.
        await tx.runAsync(`UPDATE calendar_google_inbox AS i SET dirty=1 WHERE dirty=0 AND EXISTS (
          SELECT 1 FROM calendar_google_links l JOIN calendar_events e ON e.id=l.event_id
          WHERE l.subject=i.subject AND l.calendar_id=i.calendar_id AND l.google_id=i.google_id
            AND l.active=1 AND l.anchor_date<>'' AND l.local_revision=-e.revision AND e.deleted=0
            AND NOT EXISTS (SELECT 1 FROM calendar_event_exceptions x WHERE x.event_id=l.event_id AND x.anchor_date=l.anchor_date)
            AND json_extract(i.event_json,'$.status') IS NOT 'cancelled')`);
      }
    });
  });
  initializing.set(database, work);
  void work.catch(() => { if (initializing.get(database) === work) initializing.delete(database); });
  return work;
}
function parseControl(json?: string): PersonalGoogleCalendarControl {
  if (!json) return { ...EMPTY_PERSONAL_GOOGLE_CALENDAR, calendars: [] };
  const value = JSON.parse(json) as PersonalGoogleCalendarControl;
  if (typeof value.subject !== 'string' || !Number.isSafeInteger(value.generation) || value.generation < 0 || typeof value.enabled !== 'boolean'
    || value.subject.length > 256 || !Array.isArray(value.calendars) || value.calendars.length > 1000
    || !Number.isFinite(value.retryAt) || value.retryAt < 0 || !Number.isSafeInteger(value.retryCount) || value.retryCount < 0
    || !(value.lastSyncAt === null || typeof value.lastSyncAt === 'string' && Number.isFinite(Date.parse(value.lastSyncAt)))
    || !(value.error === null || typeof value.error === 'string' && value.error.length <= 1000)) throw new Error('Googleカレンダーの接続設定を確認してください。');
  for (const calendar of value.calendars) if (typeof calendar.id !== 'string' || !calendar.id || calendar.id.length > 1024
    || typeof calendar.summary !== 'string' || calendar.summary.length > 1024 || !canReadGoogleCalendar(calendar)) throw new Error('Googleのカレンダー情報を再取得してください。');
  if (value.targetCalendarId !== null && !value.calendars.some(calendar => calendar.id === value.targetCalendarId && canWriteGoogleCalendar(calendar))) throw new Error('Googleのメインカレンダーを確認してください。');
  return value;
}
async function readInside(tx: SQLiteDatabase) {
  const row = await tx.getFirstAsync<{ control_json: string }>('SELECT control_json FROM calendar_google_control WHERE singleton=1');
  return parseControl(row?.control_json);
}
async function writeInside(tx: SQLiteDatabase, value: PersonalGoogleCalendarControl) {
  const json = JSON.stringify(parseControl(JSON.stringify(value)));
  await tx.runAsync('INSERT INTO calendar_google_control VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET control_json=excluded.control_json WHERE control_json != excluded.control_json', json);
}
async function archiveControlInside(tx: SQLiteDatabase, value: PersonalGoogleCalendarControl) {
  if (!value.subject) return;
  await tx.execAsync('CREATE TABLE IF NOT EXISTS calendar_google_account_controls(subject TEXT PRIMARY KEY NOT NULL,control_json TEXT NOT NULL)');
  await tx.runAsync('INSERT INTO calendar_google_account_controls VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET control_json=excluded.control_json', value.subject, JSON.stringify(value));
}
/** Caller owns the account-change transaction; cursors, pending writes and imported events stay in their original subject. */
export async function activatePersonalGoogleCalendarAccountInside(tx: SQLiteDatabase, subject: string) {
  if (!await tx.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_google_control'")) return false;
  const previous = await readInside(tx);
  if (previous.subject === subject || !previous.subject && !previous.enabled) return false;
  await archiveControlInside(tx, previous);
  const archived = await tx.getFirstAsync<{ control_json: string }>('SELECT control_json FROM calendar_google_account_controls WHERE subject=?', subject);
  const saved = archived ? parseControl(archived.control_json) : { ...EMPTY_PERSONAL_GOOGLE_CALENDAR, subject, calendars: [] };
  if (saved.subject !== subject || !Number.isSafeInteger(previous.generation + 1)) throw new Error('保存済みのGoogleカレンダーの接続先を確認してください。');
  await writeInside(tx, { ...saved, generation: previous.generation + 1 }); return true;
}
export async function readPersonalGoogleCalendarControl(database: SQLiteDatabase) {
  await initializePersonalGoogleCalendar(database);
  return withPlannerDatabaseOperation(database, async () => { await assertPersonal(database); return readInside(database); });
}
/** All network responses enter through a fresh SQLite generation check; no transaction spans HTTP. */
export async function withPersonalGoogleCalendar<T>(database: SQLiteDatabase, expected: Pick<PersonalGoogleCalendarControl, 'subject' | 'generation'>,
  work: (tx: SQLiteDatabase, control: PersonalGoogleCalendarControl) => Promise<T>, allowDisabled = false): Promise<T> {
  await initializePersonalGoogleCalendar(database);
  return withPlannerDatabaseOperation(database, async () => {
    await assertPersonal(database);
    return withIsolatedSqliteTransaction(database, async tx => {
      const control = await readInside(tx);
      if (control.subject !== expected.subject || control.generation !== expected.generation || !allowDisabled && !control.enabled) throw new Error('Googleカレンダーの接続先が変わりました。変更は保持しています。');
      return work(tx, control);
    });
  });
}
export async function connectPersonalGoogleCalendar(database: SQLiteDatabase, expectedGeneration: number, subject: string,
  calendars: readonly GoogleCalendarListEntry[], targetCalendarId: string | null) {
  if (!subject || subject.length > 256 || new Set(calendars.map(row => row.id)).size !== calendars.length || !calendars.length) throw new Error('Googleアカウントと同期先を確認してください。');
  await initializePersonalGoogleCalendar(database);
  return withPlannerDatabaseOperation(database, async () => {
    await assertPersonal(database);
    return withIsolatedSqliteTransaction(database, async tx => {
      const previous = await readInside(tx); if (previous.generation !== expectedGeneration) throw new Error('接続設定が変更されています。選び直してください。');
      if (previous.subject !== subject) await archiveControlInside(tx, previous);
      const value: PersonalGoogleCalendarControl = { ...EMPTY_PERSONAL_GOOGLE_CALENDAR, subject, generation: previous.generation + 1, enabled: true,
        calendars: calendars.map(row => ({ id: row.id, summary: row.summary, accessRole: row.accessRole,
          ...(row.primary ? { primary: true } : {}),
          ...(row.timeZone ? { timeZone: row.timeZone } : {}), ...(row.backgroundColor ? { backgroundColor: row.backgroundColor } : {}) })), targetCalendarId };
      await writeInside(tx, value); return value;
    });
  });
}
export async function updatePersonalGoogleCalendarStatus(database: SQLiteDatabase, expected: PersonalGoogleCalendarControl,
  patch: Partial<Pick<PersonalGoogleCalendarControl, 'lastSyncAt' | 'error' | 'retryAt' | 'retryCount'>>) {
  let changed = false;
  const value = await withPersonalGoogleCalendar(database, expected, async (tx, control) => {
    const next = { ...control, ...patch }; changed = JSON.stringify(next) !== JSON.stringify(control);
    if (changed) await writeInside(tx, next); return next;
  });
  if (changed) notifyCalendarSyncStatusChanged(database); return value;
}
/** The user authorizes all accessible calendars once; subsequent changes need no picker. */
export async function refreshPersonalGoogleCalendars(database: SQLiteDatabase, expected: PersonalGoogleCalendarControl, calendars: readonly GoogleCalendarListEntry[]) {
  let projectionChanged = false;
  const control = await withPersonalGoogleCalendar(database, expected, async (tx, current) => {
    const primary = calendars.find(row => row.primary && canWriteGoogleCalendar(row));
    if (!primary) throw new Error('Googleのメインカレンダーを確認できません。');
    const next = { ...current, calendars: calendars.map(row => ({ ...row })), targetCalendarId: primary.id };
    if (JSON.stringify(current.calendars) === JSON.stringify(next.calendars) && current.targetCalendarId === primary.id) return current;
    await writeInside(tx, next);
    const placeholders = calendars.map(() => '?').join(',');
    const removed = await tx.runAsync(`UPDATE calendar_google_links SET active=0 WHERE subject=? AND active<>0 AND calendar_id NOT IN (${placeholders})`, current.subject, ...calendars.map(row => row.id));
    const restored = await tx.runAsync(`UPDATE calendar_google_links SET active=1 WHERE subject=? AND active<>1 AND calendar_id IN (${placeholders})`, current.subject, ...calendars.map(row => row.id));
    projectionChanged = removed.changes > 0 || restored.changes > 0;
    for (const calendar of calendars) if (current.calendars.find(row => row.id === calendar.id)?.accessRole !== calendar.accessRole) {
      await tx.runAsync('UPDATE calendar_google_inbox SET dirty=1 WHERE subject=? AND calendar_id=? AND dirty<>1', current.subject, calendar.id);
    }
    return next;
  });
  return { control, projectionChanged };
}
export async function disablePersonalGoogleCalendar(database: SQLiteDatabase, expected: PersonalGoogleCalendarControl) {
  return withPersonalGoogleCalendar(database, expected, async (tx, control) => {
    const next = { ...control, enabled: false, generation: control.generation + 1, error: null };
    await writeInside(tx, next); return next;
  }, true);
}
