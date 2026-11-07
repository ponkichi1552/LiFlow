import type { SQLiteDatabase } from 'expo-sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { INITIAL_CATEGORIES, isCalendarAnchor, validateEventDraft } from '../../features/calendar/events.ts';
import type { CalendarEvent, CalendarCategory, CalendarException, EventDraft } from '../../features/calendar/events.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { migrateLocalDatabase } from './migrations.ts';
import { sharedRepositoryAdapter } from './shared-repository-adapter.ts';
import { invalidateLocalCalendarPlan, withPlannerDatabaseOperation } from './repository.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { canWriteGoogleCalendar } from '../google-calendar/calendar-api.ts';
import type { GoogleCalendarListEntry } from '../google-calendar/calendar-api';
import { readCalendarEventRows } from './calendar-event-rows.ts';

export interface CalendarEditorDraft { audience?: 'personal' | 'group'; groupId?: string; basisRevision?: string; editorCategory?: CalendarCategory; submission?: { id: string; digest: string }; eventId: string | null; anchorDate: LocalDate | null; revision: number; exceptionRevision: number; scope: 'one' | 'series'; value: EventDraft }
export function calendarDraftKey(draft: Pick<CalendarEditorDraft, 'audience' | 'groupId' | 'eventId' | 'scope' | 'anchorDate'> & { value: Pick<EventDraft, 'birthday'> }) { const prefix = draft.audience === 'group' ? `group:${draft.groupId}:` : ''; return prefix + (draft.eventId ? `event:${draft.eventId}:${draft.scope}:${draft.scope === 'one' ? draft.anchorDate : ''}` : draft.value.birthday ? 'birthday:new' : 'new'); }
/** A return route carries this digest, never the private input text. */
export function calendarDraftVersion(draft: CalendarEditorDraft) { return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(parseEditorDraft(draft))))); }
export interface LocalCalendarSnapshot { events: CalendarEvent[]; categories: CalendarCategory[]; exceptions: CalendarException[]; draft: CalendarEditorDraft | null; drafts?: CalendarEditorDraft[]; draftError?: string }
export const EMPTY_LOCAL_CALENDAR: LocalCalendarSnapshot = { events: [], categories: [...INITIAL_CATEGORIES], exceptions: [], draft: null };
export type LocalCalendarChange = 'events' | 'categories' | 'drafts' | 'sync' | 'syncStatus';
const listeners = new Map<string | SQLiteDatabase, Map<SQLiteDatabase, Set<(change: LocalCalendarChange) => void>>>();
function storageKey(database: SQLiteDatabase): string | SQLiteDatabase {
  // Expo's absolute databasePath is shared by foreground and exclusive/worker
  // connections. Anonymous in-memory databases must retain object identity.
  const path = database.databasePath;
  return typeof path === 'string' && path.startsWith('/') && !path.includes(':memory:') && !sharedRepositoryAdapter(database) ? path : database;
}
let idSequence = 0;
function newId(prefix: string) { return `${prefix}.${Date.now().toString(36)}.${(++idSequence).toString(36)}.${Math.random().toString(36).slice(2, 12)}`; }
export function newCalendarSubmissionId() { return newId('calendar-intent'); }
const conflict = () => new Error('予定が別の画面で変更されました。再読込してから編集してください。');
function identifier(id: string) { if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error('予定・分類の識別子が無効です。'); }
async function personal(database: SQLiteDatabase) {
  if (sharedRepositoryAdapter(database)) throw new Error('個人のカレンダーは個人の保存先で開いてください。');
  if (!await database.getFirstAsync("SELECT id FROM households WHERE id = 'local-household'")) throw new Error('個人の保存先を確認できません。');
}
async function assertEditableGoogleEvent(database: SQLiteDatabase, id: string, anchorDate?: LocalDate, includeAllExceptions = false) {
  if (!await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_google_links'")) return;
  const links = await database.getAllAsync<{ subject: string; calendar_id: string; read_only: number; active: number }>(
    `SELECT subject,calendar_id,read_only,active FROM calendar_google_links WHERE event_id=?
      AND (anchor_date='' OR ?=1 OR anchor_date=?)`, id, includeAllExceptions ? 1 : 0, anchorDate ?? '');
  if (!links.length) return;
  const control = await database.getFirstAsync<{ control_json: string }>('SELECT control_json FROM calendar_google_control WHERE singleton=1');
  let writable = false;
  try {
    const value = JSON.parse(control?.control_json ?? '{}');
    writable = Array.isArray(value.calendars) && links.every(link => !link.read_only && link.active === 1 && link.subject === value.subject
      && value.calendars.some((calendar: GoogleCalendarListEntry) => calendar.id === link.calendar_id && canWriteGoogleCalendar(calendar)));
  } catch { /* Missing or invalid current permissions never authorize an edit. */ }
  if (!writable) throw new Error('この予定はGoogleカレンダーで編集してください。');
}

function changed(database: SQLiteDatabase, change: LocalCalendarChange = 'events') {
  for (const [connection, callbacks] of listeners.get(storageKey(database)) ?? []) {
    if (connection !== database && change !== 'drafts' && change !== 'syncStatus') invalidateLocalCalendarPlan(connection);
    for (const fn of callbacks) try { fn(change); } catch { /* A view failure cannot change a committed SQLite result. */ }
  }
}
/** A committed personal Google transaction uses the same local subscription as an editor. */
export function notifyCalendarSyncChanged(database: SQLiteDatabase) { invalidateLocalCalendarPlan(database); changed(database, 'sync'); }
/** Connection/error timestamps update Settings without invalidating any event or schedule. */
export function notifyCalendarSyncStatusChanged(database: SQLiteDatabase) { changed(database, 'syncStatus'); }
export function subscribeLocalCalendar(database: SQLiteDatabase, callback: (change: LocalCalendarChange) => void) {
  const key = storageKey(database); let connections = listeners.get(key);
  if (!connections) { connections = new Map(); listeners.set(key, connections); }
  let set = connections.get(database); if (!set) { set = new Set(); connections.set(database, set); } set.add(callback);
  return () => { set!.delete(callback); if (!set!.size) connections!.delete(database); if (!connections!.size) listeners.delete(key); };
}
export type LocalCalendarDrafts = Pick<LocalCalendarSnapshot, 'draft' | 'drafts' | 'draftError'>;
async function readDrafts(database: SQLiteDatabase): Promise<LocalCalendarDrafts> {
  const rows = await database.getAllAsync<{ draft_json: string }>('SELECT draft_json FROM calendar_drafts ORDER BY rowid DESC LIMIT 51');
  const drafts: CalendarEditorDraft[] = []; let draftError: string | undefined;
  for (const raw of rows) try { drafts.push(parseEditorDraft(JSON.parse(raw.draft_json))); } catch { draftError = '入力途中の予定を読み込めません。保存済みの予定は表示しています。'; }
  return { draft: drafts[0] ?? null, drafts, draftError };
}
/** A keystroke only changes drafts, never the saved recurrence, category or availability inputs. */
export function readLocalCalendarDrafts(database: SQLiteDatabase): Promise<LocalCalendarDrafts> {
  return withPlannerDatabaseOperation(database, async () => { await personal(database); await migrateLocalDatabase(database); return readDrafts(database); });
}
export async function readLocalCalendar(database: SQLiteDatabase): Promise<LocalCalendarSnapshot> {
  return withPlannerDatabaseOperation(database, async () => {
    await personal(database); await migrateLocalDatabase(database);
    const { events, exceptions } = await readCalendarEventRows(database);
    let categories = await database.getAllAsync<CalendarCategory>('SELECT * FROM calendar_categories ORDER BY rowid');
    const missing = INITIAL_CATEGORIES.filter(category => !categories.some(existing => existing.id === category.id));
    for (const category of missing) await insertInitialCalendarCategory(database, category);
    if (missing.length) categories = await database.getAllAsync<CalendarCategory>('SELECT * FROM calendar_categories ORDER BY rowid');
    return { events, exceptions, categories, ...await readDrafts(database) };
  });
}
function insertInitialCalendarCategory(database: SQLiteDatabase, category: CalendarCategory) {
  return database.runAsync('INSERT OR IGNORE INTO calendar_categories(id,name,color,revision) VALUES (?,?,?,1)', category.id, category.name, category.color);
}
function parseEditorDraft(draft: CalendarEditorDraft): CalendarEditorDraft {
  if (!draft || typeof draft !== 'object' || !['one', 'series'].includes(draft.scope) || !Number.isInteger(draft.revision) || draft.revision < 0
    || !Number.isInteger(draft.exceptionRevision) || draft.exceptionRevision < 0) throw new Error('入力途中の予定を確認してください。');
  if (draft.eventId !== null) identifier(draft.eventId); if (draft.anchorDate !== null) parseLocalDate(draft.anchorDate);
  if (draft.scope === 'one' && (!draft.eventId || !draft.anchorDate)) throw new Error('今回だけ変更する予定と基準日を確認してください。');
  // Empty titles are valid in a draft; saved events require a title.
  parseLocalDate(draft.value.endDate); if (draft.value.untilDate !== null) parseLocalDate(draft.value.untilDate);
  if (typeof draft.value.allDay !== 'boolean' || typeof draft.value.birthday !== 'boolean') throw new Error('入力途中の予定を確認してください。');
  if (typeof draft.value.title !== 'string' || draft.value.title.length > 160) throw new Error('入力途中の予定名を確認してください。');
  const value = validateEventDraft({ ...draft.value, title: draft.value.title.trim() ? draft.value.title : '入力中', allDay: true, birthday: false, endDate: draft.value.startDate, untilDate: null });
  if (draft.audience !== undefined && !['personal', 'group'].includes(draft.audience)) throw new Error('予定の保存先を確認してください。');
  if (draft.audience === 'group' && (typeof draft.groupId !== 'string' || !/^[A-Za-z0-9._-]{1,192}$/.test(draft.groupId))) throw new Error('共有予定のグループを確認してください。');
  if (draft.basisRevision !== undefined && (typeof draft.basisRevision !== 'string' || draft.basisRevision.length > 50000)) throw new Error('共有予定の編集元を確認してください。');
  if (draft.submission && (!/^calendar-intent\.[A-Za-z0-9._-]{1,100}$/u.test(draft.submission.id) || !/^[a-f0-9]{64}$/u.test(draft.submission.digest))) throw new Error('予定の保存待ちを確認してください。');
  const category = draft.editorCategory;
  if (category && (!/^[A-Za-z0-9._-]{1,100}$/.test(category.id) || typeof category.name !== 'string' || category.name.length > 40 || !Number.isSafeInteger(category.revision) || category.revision < 0 || !/^#[0-9a-f]{6}$/i.test(category.color))) throw new Error('分類を確認してください。');
  return { ...(draft.audience ? { audience: draft.audience } : {}), ...(draft.audience === 'group' ? { groupId: draft.groupId } : {}),
    ...(draft.basisRevision ? { basisRevision: draft.basisRevision } : {}), ...(draft.audience === 'group' && draft.submission ? { submission: { ...draft.submission } } : {}), ...(category ? { editorCategory: { id: category.id, name: category.name, color: category.color, revision: category.revision } } : {}), eventId: draft.eventId, anchorDate: draft.anchorDate, revision: draft.revision, exceptionRevision: draft.exceptionRevision, scope: draft.scope,
    value: { ...value, title: draft.value.title, allDay: draft.value.allDay, birthday: draft.value.birthday, endDate: draft.value.endDate, untilDate: draft.value.untilDate } };
}
async function clearRelatedDrafts(database: SQLiteDatabase, id: string | null, scope?: 'one' | 'series', anchorDate?: LocalDate | null, birthday = false, audience: Pick<CalendarEditorDraft, 'audience' | 'groupId'> = {}, submitted?: CalendarEditorDraft) {
  const exactSlot = scope || id === null ? calendarDraftKey({ ...audience, eventId: id, scope: scope ?? 'series', anchorDate: anchorDate ?? null, value: { birthday } }) : null;
  const rows = await database.getAllAsync<{ slot: string; draft_json: string }>(exactSlot === null
    ? 'SELECT slot,draft_json FROM calendar_drafts LIMIT 51'
    : "SELECT slot,draft_json FROM calendar_drafts WHERE slot IN (?,'editor')", ...(exactSlot === null ? [] : [exactSlot]));
  for (const row of rows) {
    let draft: CalendarEditorDraft;
    try { draft = parseEditorDraft(JSON.parse(row.draft_json)); } catch { continue; }
    if (submitted && (draft.revision !== submitted.revision || scope === 'one' && draft.exceptionRevision !== submitted.exceptionRevision
      || JSON.stringify(draft.value) !== JSON.stringify(submitted.value))) continue;
    if ((draft.audience ?? 'personal') === (audience.audience ?? 'personal') && draft.groupId === audience.groupId && draft.eventId === id && (id !== null || draft.value.birthday === birthday) && (!scope || draft.scope === scope && (scope === 'series' || draft.anchorDate === anchorDate))) {
      await database.runAsync('DELETE FROM calendar_drafts WHERE slot=?', row.slot);
    }
  }
}
export async function saveCalendarDraft(database: SQLiteDatabase, input: CalendarEditorDraft | null, birthday = false) {
  const draft = input ? parseEditorDraft(input) : null;
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      await clearRelatedDrafts(tx, draft?.eventId ?? null, draft?.scope, draft?.anchorDate, draft?.value.birthday ?? birthday, draft ?? {});
      if (!draft) return;
      const count = await tx.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM calendar_drafts');
      if ((count?.count ?? 0) >= 50) throw new Error('入力途中の予定が多くなっています。下書きを保存・整理してから閉じてください。');
      const slot = calendarDraftKey(draft);
      await tx.runAsync('INSERT INTO calendar_drafts(slot,draft_json) VALUES(?,?)', slot, JSON.stringify(draft));
    });
  }); changed(database, 'drafts');
}
export async function saveCalendarEvent(database: SQLiteDatabase, input: {
  id?: string; expectedRevision: number; value: EventDraft; anchorDate?: LocalDate; expectedExceptionRevision?: number; scope?: 'one' | 'series'; resetExceptions?: boolean;
}) {
  const body = validateEventDraft(input.value); const id = input.id ?? newId('event'); identifier(id);
  if (input.anchorDate !== undefined) parseLocalDate(input.anchorDate);
  const submitted = parseEditorDraft({ eventId: input.id ?? null, revision: input.expectedRevision, scope: input.scope ?? 'series',
    anchorDate: input.anchorDate ?? null, exceptionRevision: input.expectedExceptionRevision ?? 0, value: input.value });
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      await assertEditableGoogleEvent(tx, id, input.scope === 'one' ? input.anchorDate : undefined, input.resetExceptions === true);
      if (!await tx.getFirstAsync('SELECT id FROM calendar_categories WHERE id=?', body.categoryId)) {
        // Creation remains usable before the first calendar read finishes. Only a
        // built-in initial category can be seeded; unknown/deleted custom IDs stay invalid.
        const initial = INITIAL_CATEGORIES.find(category => category.id === body.categoryId);
        if (!initial) throw new Error('分類を選び直してください。');
        await insertInitialCalendarCategory(tx, initial);
      }
      const prior = await tx.getFirstAsync<{ revision: number; deleted: number; definition_json: string }>('SELECT * FROM calendar_events WHERE id=?', id);
      if (prior ? prior.deleted || prior.revision !== input.expectedRevision : input.expectedRevision !== 0) throw conflict();
      if (input.scope === 'one') {
        if (!prior || !input.anchorDate) throw conflict();
        if (!isCalendarAnchor({ ...validateEventDraft(JSON.parse(prior.definition_json)), id, revision: prior.revision }, input.anchorDate)) throw conflict();
        const previous = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', id, input.anchorDate);
        if ((previous?.revision ?? 0) !== (input.expectedExceptionRevision ?? 0)) throw conflict();
        await tx.runAsync('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,?) ON CONFLICT(event_id,anchor_date) DO UPDATE SET override_json=excluded.override_json,revision=excluded.revision',
          id, input.anchorDate, JSON.stringify(body), (previous?.revision ?? 0) + 1);
      } else {
        const structural = prior && (() => { const old = JSON.parse(prior.definition_json); return old.startDate !== body.startDate || old.recurrence !== body.recurrence || old.untilDate !== body.untilDate || JSON.stringify(old.customRecurrence) !== JSON.stringify(body.customRecurrence); })();
        if (structural && await tx.getFirstAsync('SELECT event_id FROM calendar_event_exceptions WHERE event_id=? LIMIT 1', id)) {
          if (!input.resetExceptions) throw new Error('この繰り返しには個別に変更した回があります。リセットを確認してください。');
          await tx.runAsync('DELETE FROM calendar_event_exceptions WHERE event_id=?', id);
        }
        await tx.runAsync('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,?,0) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json,revision=excluded.revision', id, JSON.stringify(body), input.expectedRevision + 1);
      }
      await clearRelatedDrafts(tx, input.id ?? null, input.scope ?? 'series', input.anchorDate, body.birthday, {}, submitted);
    });
  }); invalidateLocalCalendarPlan(database); changed(database); return id;
}
export async function deleteCalendarEvent(database: SQLiteDatabase, input: { id: string; expectedRevision: number; anchorDate?: LocalDate; expectedExceptionRevision?: number }) {
  identifier(input.id); if (input.anchorDate !== undefined) parseLocalDate(input.anchorDate);
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      await assertEditableGoogleEvent(tx, input.id, input.anchorDate, input.anchorDate === undefined);
      const row = await tx.getFirstAsync<{ revision: number; deleted: number; definition_json: string }>('SELECT revision,deleted,definition_json FROM calendar_events WHERE id=?', input.id);
      if (!row || row.deleted || row.revision !== input.expectedRevision) throw conflict();
      if (input.anchorDate) {
        if (!isCalendarAnchor({ ...validateEventDraft(JSON.parse(row.definition_json)), id: input.id, revision: row.revision }, input.anchorDate)) throw conflict();
        const prior = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', input.id, input.anchorDate);
        if ((prior?.revision ?? 0) !== (input.expectedExceptionRevision ?? 0)) throw conflict();
        await tx.runAsync('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,NULL,?) ON CONFLICT(event_id,anchor_date) DO UPDATE SET override_json=NULL,revision=excluded.revision', input.id, input.anchorDate, (prior?.revision ?? 0) + 1);
      } else await tx.runAsync('UPDATE calendar_events SET deleted=1,revision=revision+1 WHERE id=?', input.id);
      await clearRelatedDrafts(tx, input.id, input.anchorDate ? 'one' : undefined, input.anchorDate);
    });
  }); invalidateLocalCalendarPlan(database); changed(database);
}
export async function saveCalendarCategory(database: SQLiteDatabase, value: { id?: string; expectedRevision: number; name: string; color: string }) {
  const id = value.id ?? newId('category'); identifier(id);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 40 || !/^#[0-9a-f]{6}$/i.test(value.color)) throw new Error('分類名と色を確認してください。');
  await withPlannerDatabaseOperation(database, async () => { await personal(database); await withIsolatedSqliteTransaction(database, async tx => {
    const before = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM calendar_categories WHERE id=?', id);
    if ((before?.revision ?? 0) !== value.expectedRevision) throw conflict();
    if (await tx.getFirstAsync('SELECT id FROM calendar_categories WHERE name=? COLLATE NOCASE AND id<>?', value.name.trim(), id)) throw new Error('同じ名前の分類があります。既存の分類を選んでください。');
    await tx.runAsync('INSERT INTO calendar_categories(id,name,color,revision) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,revision=excluded.revision', id, value.name.trim(), value.color.toUpperCase(), value.expectedRevision + 1);
  }); }); changed(database, 'categories'); return id;
}

/** Clear only the submitted scope; a group draft can never clear a private one. */
export async function clearCalendarEditorDraft(database: SQLiteDatabase, draft: CalendarEditorDraft) {
  await discardCalendarDraftIfUnchanged(database, draft);
}

/** Post-commit cleanup must not remove an editor that has since saved newer input. */
export async function clearSubmittedCalendarDraft(database: SQLiteDatabase, input: CalendarEditorDraft) {
  const draft = parseEditorDraft(input);
  const removed = await withPlannerDatabaseOperation(database, async () => {
    await personal(database);
    return database.runAsync('DELETE FROM calendar_drafts WHERE slot=? AND draft_json=?', calendarDraftKey(draft), JSON.stringify(draft));
  }); if (removed.changes) changed(database, 'drafts');
}

/** Explicit recovery discards only the exact draft opened by this editor. */
export async function discardCalendarDraftIfUnchanged(database: SQLiteDatabase, input: CalendarEditorDraft) {
  const draft = parseEditorDraft(input); let removed = false;
  await withPlannerDatabaseOperation(database, async () => {
    await personal(database); await withIsolatedSqliteTransaction(database, async tx => {
      const row = await tx.getFirstAsync<{ draft_json: string }>('SELECT draft_json FROM calendar_drafts WHERE slot=?', calendarDraftKey(draft));
      if (!row) return;
      if (row.draft_json !== JSON.stringify(draft)) throw new Error('別の画面で入力が更新されています。閉じてから最新の下書きを開いてください。');
      const result = await tx.runAsync('DELETE FROM calendar_drafts WHERE slot=? AND draft_json=?', calendarDraftKey(draft), row.draft_json); removed = Boolean(result.changes);
    });
  });
  if (removed) changed(database, 'drafts');
}
