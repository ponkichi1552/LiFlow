import { checkedReminderMinutes, saveCalendarReminderInside, notifyCalendarRemindersChanged, rebaseCalendarReminderRulesInside } from './calendar-reminders.ts';
import type { SQLiteDatabase } from 'expo-sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { INITIAL_CATEGORIES, isCalendarAnchor, newEventDraft, validateEventDraft } from '../../features/calendar/events.ts';
import type { CalendarEvent, CalendarCategory, CalendarException, EventDraft } from '../../features/calendar/events.ts';
import { OWN_BIRTHDAY_EVENT_ID } from '../../domain/calendar/own-birthday.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { migrateLocalDatabase } from './migrations.ts';
import { sharedRepositoryAdapter } from './shared-repository-adapter.ts';
import { invalidateLocalCalendarPlan, withPlannerDatabaseOperation } from './repository.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { canWriteGoogleCalendar } from '../google-calendar/calendar-api.ts';
import type { GoogleCalendarListEntry } from '../google-calendar/calendar-api';
import { readCalendarEventRows, readCalendarEventRowsPage } from './calendar-event-rows.ts';
import type { CalendarEventReadRange, CalendarEventReadTarget } from './calendar-event-rows.ts';
import { personalGoogleCategoryId } from './personal-google-store.ts';
import { splitCalendarFuture } from '../../domain/calendar/future-series.ts';
import { rebasedCalendarExceptionDates } from '../../domain/calendar/exception-slots.ts';

export interface CalendarEditorDraft { reminderMinutes?: number | null; audience?: 'personal' | 'group'; groupId?: string; ownerScope?: string; basisRevision?: string; editorCategory?: CalendarCategory; submission?: { id: string; digest: string }; eventId: string | null; anchorDate: LocalDate | null; revision: number; exceptionRevision: number; scope: 'one' | 'future' | 'series'; value: EventDraft }
export function calendarDraftKey(draft: Pick<CalendarEditorDraft, 'audience' | 'groupId' | 'ownerScope' | 'eventId' | 'scope' | 'anchorDate'> & { value: Pick<EventDraft, 'birthday'> }) {
  const prefix = draft.audience !== 'group' ? '' : draft.ownerScope ? `owned:${draft.ownerScope}:` : `group:${draft.groupId}:`;
  return prefix + (draft.eventId ? `event:${draft.eventId}:${draft.scope}:${draft.scope !== 'series' ? draft.anchorDate : ''}` : draft.value.birthday ? 'birthday:new' : 'new');
}
export type CalendarDraftAccess = (draft: CalendarEditorDraft) => void;
export interface CalendarDraftCleanup { snapshots: readonly CalendarEditorDraft[]; assertAccess?: CalendarDraftAccess }
function assertDraftWriter(draft: CalendarEditorDraft, assertAccess?: CalendarDraftAccess) {
  if (draft.audience === 'group' && (!draft.ownerScope || !assertAccess)) throw new Error('下書きを保存したアカウントを確認してください。');
  assertAccess?.(draft);
}
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
type DraftReadOwner = string | null | (() => string | null | undefined);
// The original single-slot editor may contain either audience. Unknown group authors stay archived.
const personalDraftSlots = `(slot IN ('new','birthday:new') OR slot GLOB 'event:*'
  OR (slot='editor' AND CASE WHEN json_valid(draft_json) THEN coalesce(json_extract(draft_json,'$.audience'),'personal')<>'group' ELSE 1 END))`;
async function readDrafts(database: SQLiteDatabase, owner?: DraftReadOwner): Promise<LocalCalendarDrafts> {
  const scope = typeof owner === 'function' ? owner() : owner;
  if (scope && !/^group:[a-f0-9]{64}$/u.test(scope)) throw new Error('下書きのアカウントを確認してください。');
  const rows = await database.getAllAsync<{ draft_json: string }>(
    `SELECT draft_json FROM calendar_drafts WHERE ${personalDraftSlots}${scope ? ' OR slot GLOB ?' : ''} ORDER BY rowid DESC LIMIT 100`,
    ...(scope ? [`owned:${scope}:*`] : []));
  const drafts: CalendarEditorDraft[] = []; let draftError: string | undefined;
  for (const raw of rows) try {
    const draft = parseEditorDraft(JSON.parse(raw.draft_json));
    if (draft.audience !== 'group' || scope && draft.ownerScope === scope) drafts.push(draft);
  } catch { draftError = '入力途中の予定を読み込めません。保存済みの予定は表示しています。'; }
  return { draft: drafts[0] ?? null, drafts, draftError };
}
/** A keystroke only changes drafts, never the saved recurrence, category or availability inputs. */
export function readLocalCalendarDrafts(database: SQLiteDatabase, owner?: DraftReadOwner): Promise<LocalCalendarDrafts> {
  return withPlannerDatabaseOperation(database, async () => { await personal(database); await migrateLocalDatabase(database); return readDrafts(database, owner); });
}
/** Notification lookups need the verified event source without category or draft reads. */
export function readLocalCalendarEventSource(database: SQLiteDatabase, range?: CalendarEventReadRange, target?: CalendarEventReadTarget) {
  return withPlannerDatabaseOperation(database, async () => {
    await personal(database); await migrateLocalDatabase(database);
    return readCalendarEventRows(database, range, target);
  });
}
/** Personal calendar history is paged only after an explicit search in the bounded-history fallback. */
export function readLocalCalendarHistoryPage(database: SQLiteDatabase, afterId?: string, limit = 500) {
  return withPlannerDatabaseOperation(database, async () => {
    await personal(database); await migrateLocalDatabase(database);
    return readCalendarEventRowsPage(database, afterId, limit);
  });
}
export async function readLocalCalendar(database: SQLiteDatabase, owner?: DraftReadOwner, range?: CalendarEventReadRange): Promise<LocalCalendarSnapshot> {
  return withPlannerDatabaseOperation(database, async () => {
    await personal(database); await migrateLocalDatabase(database);
    const { events, exceptions } = await readCalendarEventRows(database, range);
    let categories = await database.getAllAsync<CalendarCategory>('SELECT * FROM calendar_categories ORDER BY rowid');
    const missing = INITIAL_CATEGORIES.filter(category => !categories.some(existing => existing.id === category.id));
    for (const category of missing) await insertInitialCalendarCategory(database, category);
    if (missing.length) categories = await database.getAllAsync<CalendarCategory>('SELECT * FROM calendar_categories ORDER BY rowid');
    if (await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_google_control'")) {
      const control = await database.getFirstAsync<{ control_json: string }>('SELECT control_json FROM calendar_google_control WHERE singleton=1');
      try {
        const value = JSON.parse(control?.control_json ?? '{}') as { subject?: unknown; calendars?: unknown };
        if (typeof value.subject === 'string' && value.subject && Array.isArray(value.calendars)) {
          const calendars = value.calendars.filter((row): row is { id: string } => Boolean(row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'));
          const allowed = new Set(calendars.map(row => personalGoogleCategoryId(value.subject as string, row.id)));
          const linked = await database.getAllAsync<{ category_id: string }>(`SELECT DISTINCT json_extract(e.definition_json,'$.categoryId') AS category_id
            FROM calendar_google_links l JOIN calendar_events e ON e.id=l.event_id
            WHERE l.subject=? AND l.active=1 AND e.deleted=0 AND l.calendar_id IN (SELECT value FROM json_each(?))
              AND json_extract(e.definition_json,'$.categoryId') LIKE 'google.%'`, value.subject, JSON.stringify(calendars.map(row => row.id)));
          for (const row of linked) allowed.add(row.category_id);
          categories = categories.filter(category => !category.id.startsWith('google.') || allowed.has(category.id));
        } else categories = categories.filter(category => !category.id.startsWith('google.'));
      } catch { categories = categories.filter(category => !category.id.startsWith('google.')); }
    }
    return { events, exceptions, categories, ...await readDrafts(database, owner) };
  });
}
function insertInitialCalendarCategory(database: SQLiteDatabase, category: CalendarCategory) {
  return database.runAsync('INSERT OR IGNORE INTO calendar_categories(id,name,color,revision) VALUES (?,?,?,1)', category.id, category.name, category.color);
}
function parseEditorDraft(draft: CalendarEditorDraft): CalendarEditorDraft {
  if (!draft || typeof draft !== 'object' || !['one', 'future', 'series'].includes(draft.scope) || !Number.isInteger(draft.revision) || draft.revision < 0
    || !Number.isInteger(draft.exceptionRevision) || draft.exceptionRevision < 0) throw new Error('入力途中の予定を確認してください。');
  if (draft.eventId !== null) identifier(draft.eventId); if (draft.anchorDate !== null) parseLocalDate(draft.anchorDate);
  if (draft.scope !== 'series' && (!draft.eventId || !draft.anchorDate)) throw new Error('今回だけ変更する予定と基準日を確認してください。');
  // Empty titles are valid in a draft; saved events require a title.
  parseLocalDate(draft.value.endDate); if (draft.value.untilDate !== null) parseLocalDate(draft.value.untilDate);
  if (typeof draft.value.allDay !== 'boolean' || typeof draft.value.birthday !== 'boolean') throw new Error('入力途中の予定を確認してください。');
  if (typeof draft.value.title !== 'string' || draft.value.title.length > 160) throw new Error('入力途中の予定名を確認してください。');
  const value = validateEventDraft({ ...draft.value, title: draft.value.title.trim() ? draft.value.title : '入力中', allDay: true, birthday: false, endDate: draft.value.startDate, untilDate: null });
  if (draft.audience !== undefined && !['personal', 'group'].includes(draft.audience)) throw new Error('予定の保存先を確認してください。');
  if (draft.audience === 'group' && (typeof draft.groupId !== 'string' || !/^[A-Za-z0-9._-]{1,192}$/.test(draft.groupId))) throw new Error('共有予定のグループを確認してください。');
  if (draft.audience === 'group' && draft.ownerScope !== undefined && !/^group:[a-f0-9]{64}$/u.test(draft.ownerScope)) throw new Error('下書きのアカウントを確認してください。');
  if (draft.basisRevision !== undefined && (typeof draft.basisRevision !== 'string' || draft.basisRevision.length > 50000)) throw new Error('共有予定の編集元を確認してください。');
  if (draft.submission && (!/^calendar-intent\.[A-Za-z0-9._-]{1,100}$/u.test(draft.submission.id) || !/^[a-f0-9]{64}$/u.test(draft.submission.digest))) throw new Error('予定の保存待ちを確認してください。');
  if (draft.reminderMinutes !== undefined) checkedReminderMinutes(draft.reminderMinutes);
  const category = draft.editorCategory;
  if (category && (!/^[A-Za-z0-9._-]{1,100}$/.test(category.id) || typeof category.name !== 'string' || category.name.length > 40 || !Number.isSafeInteger(category.revision) || category.revision < 0 || !/^#[0-9a-f]{6}$/i.test(category.color))) throw new Error('分類を確認してください。');
  return { ...(draft.reminderMinutes !== undefined ? { reminderMinutes: draft.reminderMinutes } : {}), ...(draft.audience ? { audience: draft.audience } : {}), ...(draft.audience === 'group' ? { groupId: draft.groupId } : {}),
    ...(draft.audience === 'group' && draft.ownerScope ? { ownerScope: draft.ownerScope } : {}),
    ...(draft.basisRevision ? { basisRevision: draft.basisRevision } : {}), ...(draft.audience === 'group' && draft.submission ? { submission: { ...draft.submission } } : {}), ...(category ? { editorCategory: { id: category.id, name: category.name, color: category.color, revision: category.revision } } : {}), eventId: draft.eventId, anchorDate: draft.anchorDate, revision: draft.revision, exceptionRevision: draft.exceptionRevision, scope: draft.scope,
    value: { ...value, title: draft.value.title, allDay: draft.value.allDay, birthday: draft.value.birthday, endDate: draft.value.endDate, untilDate: draft.value.untilDate } };
}
async function clearRelatedDrafts(database: SQLiteDatabase, id: string | null, scope?: 'one' | 'future' | 'series', anchorDate?: LocalDate | null, birthday = false, audience: Pick<CalendarEditorDraft, 'audience' | 'groupId' | 'ownerScope'> = {}, submitted?: CalendarEditorDraft) {
  let removed = false;
  const exactSlot = scope || id === null ? calendarDraftKey({ ...audience, eventId: id, scope: scope ?? 'series', anchorDate: anchorDate ?? null, value: { birthday } }) : null;
  const where = exactSlot === null ? personalDraftSlots : audience.audience === 'group' ? 'slot=?' : `(slot=? OR (slot='editor' AND ${personalDraftSlots}))`;
  const rows = await database.getAllAsync<{ slot: string; draft_json: string }>(
    `SELECT slot,draft_json FROM calendar_drafts WHERE ${where} LIMIT 51`, ...(exactSlot === null ? [] : [exactSlot]));
  for (const row of rows) {
    let draft: CalendarEditorDraft;
    try { draft = parseEditorDraft(JSON.parse(row.draft_json)); } catch { continue; }
    if (submitted && (draft.revision !== submitted.revision || scope === 'one' && draft.exceptionRevision !== submitted.exceptionRevision
      || draft.reminderMinutes !== submitted.reminderMinutes || JSON.stringify(draft.value) !== JSON.stringify(submitted.value))) continue;
    if ((draft.audience ?? 'personal') === (audience.audience ?? 'personal') && draft.groupId === audience.groupId && draft.ownerScope === audience.ownerScope && draft.eventId === id && (id !== null || draft.value.birthday === birthday) && (!scope || draft.scope === scope && (scope === 'series' || draft.anchorDate === anchorDate))) {
      const result = await database.runAsync('DELETE FROM calendar_drafts WHERE slot=?', row.slot); removed ||= Boolean(result.changes);
    }
  }
  return removed;
}
export async function saveCalendarDraft(database: SQLiteDatabase, input: CalendarEditorDraft | null, birthday = false, assertAccess?: CalendarDraftAccess) {
  const draft = input ? parseEditorDraft(input) : null;
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      if (draft) assertDraftWriter(draft, assertAccess);
      await clearRelatedDrafts(tx, draft?.eventId ?? null, draft?.scope, draft?.anchorDate, draft?.value.birthday ?? birthday, draft ?? {});
      if (!draft) return;
      const groupSlots = draft.audience === 'group' ? `owned:${draft.ownerScope}:*` : null;
      const count = await tx.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM calendar_drafts WHERE ${groupSlots ? 'slot GLOB ?' : personalDraftSlots}`, ...(groupSlots ? [groupSlots] : []));
      if ((count?.count ?? 0) >= 50) throw new Error('入力途中の予定が多くなっています。下書きを保存・整理してから閉じてください。');
      const slot = calendarDraftKey(draft);
      await tx.runAsync('INSERT INTO calendar_drafts(slot,draft_json) VALUES(?,?)', slot, JSON.stringify(draft));
      assertDraftWriter(draft, assertAccess);
    });
  }); changed(database, 'drafts');
}
export { OWN_BIRTHDAY_EVENT_ID } from '../../domain/calendar/own-birthday.ts';
/** The settings date is one personal event; other people's birthdays keep their own identities. */
export function saveOwnBirthday(database: SQLiteDatabase, input: { date: LocalDate; timeZone: string; expectedRevision: number }) {
  return writeCalendarEvent(database, { id: OWN_BIRTHDAY_EVENT_ID, expectedRevision: input.expectedRevision,
    value: { ...newEventDraft(input.date, input.timeZone, true), title: '誕生日' } }, true);
}
type CalendarEventInput = {
  reminderMinutes?: number | null; id?: string; expectedRevision: number; value: EventDraft; anchorDate?: LocalDate; expectedExceptionRevision?: number; scope?: 'one' | 'series'; resetExceptions?: boolean;
  draftCleanup?: CalendarDraftCleanup;
};
export function saveCalendarEvent(database: SQLiteDatabase, input: CalendarEventInput) { return writeCalendarEvent(database, input); }
export interface CalendarFutureSave { undoFuture(): Promise<void> }
/** Split one civil series atomically. The short-lived undo receipt contains no server state. */
export async function saveCalendarFutureEvent(database: SQLiteDatabase, draft: CalendarEditorDraft, draftCleanup?: CalendarDraftCleanup): Promise<CalendarFutureSave> {
  if (draft.scope !== 'future' || !draft.eventId || !draft.anchorDate || draft.audience === 'group') throw conflict();
  draft = parseEditorDraft(draft);
  const submitted = draft, sourceId = draft.eventId!, nextId = newId('event');
  const readExceptions = (tx: SQLiteDatabase, id: string) => tx.getAllAsync<{ anchor_date: LocalDate; override_json: string | null; revision: number }>('SELECT anchor_date,override_json,revision FROM calendar_event_exceptions WHERE event_id=? ORDER BY anchor_date', id);
  const readRules = (tx: SQLiteDatabase) => tx.getAllAsync<{ event_id: string; anchor_date: string; minutes: number | null }>("SELECT event_id,anchor_date,minutes FROM calendar_notification_rules WHERE scope='personal' AND event_id IN (?,?) ORDER BY event_id,anchor_date", sourceId, nextId);
  const stamp = async (tx: SQLiteDatabase) => JSON.stringify([
    await tx.getAllAsync('SELECT id,definition_json,revision,deleted FROM calendar_events WHERE id IN (?,?) ORDER BY id', sourceId, nextId),
    await readExceptions(tx, sourceId), await readExceptions(tx, nextId), await readRules(tx),
  ]);
  const receipt = await withPlannerDatabaseOperation(database, async () => {
    await personal(database);
    return withIsolatedSqliteTransaction(database, async tx => {
      await assertEditableGoogleEvent(tx, sourceId, undefined, true);
      const prior = await tx.getFirstAsync<{ revision: number; deleted: number; definition_json: string }>('SELECT revision,deleted,definition_json FROM calendar_events WHERE id=?', sourceId);
      if (!prior || prior.deleted || prior.revision !== draft.revision) throw conflict();
      const exceptions = await readExceptions(tx, sourceId);
      if ((exceptions.find(row => row.anchor_date === draft.anchorDate)?.revision ?? 0) !== draft.exceptionRevision) throw conflict();
      const old = { ...validateEventDraft(JSON.parse(prior.definition_json)), id: sourceId, revision: prior.revision };
      const split = splitCalendarFuture(old, draft.anchorDate!, draft.value, exceptions.map(row => ({ eventId: sourceId, anchorDate: row.anchor_date, revision: row.revision, override: row.override_json ? validateEventDraft(JSON.parse(row.override_json)) : null })));
      if (!await tx.getFirstAsync('SELECT id FROM calendar_categories WHERE id=?', split.next.categoryId)) throw new Error('分類を選び直してください。');
      const rules = await readRules(tx);
      await tx.runAsync('UPDATE calendar_events SET definition_json=?,revision=revision+1,deleted=? WHERE id=?', split.past ? JSON.stringify(split.past) : prior.definition_json, split.past ? 0 : 1, sourceId);
      await tx.runAsync('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)', nextId, JSON.stringify(split.next));
      await tx.runAsync('DELETE FROM calendar_event_exceptions WHERE event_id=? AND anchor_date>=?', sourceId, split.past ? draft.anchorDate! : '0001-01-01');
      for (const row of split.following) await tx.runAsync('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,?)', nextId, row.anchorDate,
        row.override ? JSON.stringify({ ...row.override, ...(row.detached ? { _retainedOccurrence: true } : {}) }) : null, row.revision + 1);
      const oldSeriesRule = rules.find(rule => !rule.anchor_date);
      if (oldSeriesRule) await saveCalendarReminderInside(tx, { scope: 'personal', eventId: nextId, anchorDate: null, minutes: oldSeriesRule.minutes });
      const movedRules = rules.filter(rule => rule.anchor_date && (rule.anchor_date >= draft.anchorDate! || !split.past));
      const movedDates = rebasedCalendarExceptionDates(split.base, { ...split.next, id: nextId, revision: 1 }, movedRules.map(rule => rule.anchor_date as LocalDate));
      for (const [index, rule] of movedRules.entries()) {
        await saveCalendarReminderInside(tx, { scope: 'personal', eventId: nextId, anchorDate: movedDates[index], minutes: rule.minutes });
        await tx.runAsync("DELETE FROM calendar_notification_rules WHERE scope='personal' AND event_id=? AND anchor_date=?", sourceId, rule.anchor_date);
      }
      if (draft.reminderMinutes !== undefined) await saveCalendarReminderInside(tx, { scope: 'personal', eventId: nextId, anchorDate: null, minutes: draft.reminderMinutes });
      await clearRelatedDrafts(tx, sourceId, 'future', draft.anchorDate, false, {}, submitted);
      if (draftCleanup) await deleteSubmittedDrafts(tx, draftCleanup);
      return { prior, exceptions, rules, cutoff: split.past ? draft.anchorDate! : '0001-01-01', expected: await stamp(tx) };
    });
  });
  invalidateLocalCalendarPlan(database); changed(database); notifyCalendarRemindersChanged(database);
  let undone = false;
  return { async undoFuture() {
    if (undone) return;
    await withPlannerDatabaseOperation(database, async () => {
      await personal(database);
      await withIsolatedSqliteTransaction(database, async tx => {
        await assertEditableGoogleEvent(tx, sourceId, undefined, true); await assertEditableGoogleEvent(tx, nextId, undefined, true);
        if (await stamp(tx) !== receipt.expected) throw new Error('予定が更新されています。上書きせずに停止しました。');
        await tx.runAsync('UPDATE calendar_events SET definition_json=?,revision=revision+1,deleted=0 WHERE id=?', receipt.prior.definition_json, sourceId);
        await tx.runAsync('UPDATE calendar_events SET revision=revision+1,deleted=1 WHERE id=?', nextId);
        await tx.runAsync('DELETE FROM calendar_event_exceptions WHERE event_id=?', nextId);
        for (const row of receipt.exceptions.filter(row => row.anchor_date >= receipt.cutoff)) await tx.runAsync('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,?)', sourceId, row.anchor_date, row.override_json, row.revision + 2);
        await tx.runAsync("DELETE FROM calendar_notification_rules WHERE scope='personal' AND event_id IN (?,?)", sourceId, nextId);
        for (const rule of receipt.rules) await saveCalendarReminderInside(tx, { scope: 'personal', eventId: rule.event_id, anchorDate: rule.anchor_date as LocalDate || null, minutes: rule.minutes });
      });
    });
    undone = true; invalidateLocalCalendarPlan(database); changed(database); notifyCalendarRemindersChanged(database);
  } };
}
/** Undo a new exception without an ABA revision reset or touching other exceptions. */
export async function restoreCalendarOccurrence(database: SQLiteDatabase, draft: CalendarEditorDraft) {
  if (!draft.eventId || !draft.anchorDate || draft.scope !== 'one') throw conflict();
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      await assertEditableGoogleEvent(tx, draft.eventId!, draft.anchorDate!);
      const series = await tx.getFirstAsync<{ revision: number; deleted: number }>('SELECT revision,deleted FROM calendar_events WHERE id=?', draft.eventId!);
      const exception = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', draft.eventId!, draft.anchorDate!);
      if (!series || series.deleted || series.revision !== draft.revision || exception?.revision !== draft.exceptionRevision) throw conflict();
      await tx.runAsync('DELETE FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', draft.eventId!, draft.anchorDate!);
      await tx.runAsync('UPDATE calendar_events SET revision=revision+1 WHERE id=?', draft.eventId!);
    });
  }); invalidateLocalCalendarPlan(database); changed(database);
}
async function writeCalendarEvent(database: SQLiteDatabase, input: CalendarEventInput, ownBirthday = false) {
  const body = validateEventDraft(input.value); const id = input.id ?? newId('event'); identifier(id);
  const bodyJson = JSON.stringify(body); let eventChanged = false; let draftsChanged = false; let remindersChanged = false;
  if (input.anchorDate !== undefined) parseLocalDate(input.anchorDate);
  const submitted = parseEditorDraft({ reminderMinutes: input.reminderMinutes, eventId: input.id ?? null, revision: input.expectedRevision, scope: input.scope ?? 'series',
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
      // Registering a cleared birthday must keep its identity and revision monotonic.
      const restoreBirthday = ownBirthday && id === OWN_BIRTHDAY_EVENT_ID && prior?.deleted && input.expectedRevision === 0;
      if (!restoreBirthday && (prior ? prior.deleted || prior.revision !== input.expectedRevision : input.expectedRevision !== 0)) throw conflict();
      if (input.scope === 'one') {
        if (!prior || !input.anchorDate) throw conflict();
        const previous = await tx.getFirstAsync<{ revision: number; override_json: string | null }>('SELECT revision,override_json FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', id, input.anchorDate);
        const anchorExists = isCalendarAnchor({ ...validateEventDraft(JSON.parse(prior.definition_json)), id, revision: prior.revision }, input.anchorDate);
        if (!previous && !anchorExists) throw conflict();
        if ((previous?.revision ?? 0) !== (input.expectedExceptionRevision ?? 0)) throw conflict();
        const nextJson = anchorExists ? bodyJson : JSON.stringify({ ...body, _retainedOccurrence: true });
        const previousBody = previous?.override_json ? JSON.parse(previous.override_json) : null;
        const previousJson = previousBody ? JSON.stringify({ ...validateEventDraft(previousBody), ...(previousBody._retainedOccurrence === true ? { _retainedOccurrence: true } : {}) }) : null;
        // A first explicit override and a restored cancellation still have new meaning.
        if (previousJson !== nextJson) {
          await tx.runAsync('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,?) ON CONFLICT(event_id,anchor_date) DO UPDATE SET override_json=excluded.override_json,revision=excluded.revision',
            id, input.anchorDate, nextJson, (previous?.revision ?? 0) + 1);
          eventChanged = true;
        }
      } else if (!prior || restoreBirthday || JSON.stringify(validateEventDraft(JSON.parse(prior.definition_json))) !== bodyJson) {
        const structural = prior && (() => { const old = JSON.parse(prior.definition_json); return old.startDate !== body.startDate || old.recurrence !== body.recurrence || old.untilDate !== body.untilDate || JSON.stringify(old.customRecurrence) !== JSON.stringify(body.customRecurrence); })();
        if (structural && prior) {
          if (input.resetExceptions) await tx.runAsync('DELETE FROM calendar_event_exceptions WHERE event_id=?', id);
          else {
            const old = { ...validateEventDraft(JSON.parse(prior.definition_json)), id, revision: prior.revision };
            const next = { ...body, id, revision: prior.revision + 1 };
            const exceptions = await tx.getAllAsync<{ anchor_date: LocalDate; override_json: string | null; revision: number }>('SELECT anchor_date,override_json,revision FROM calendar_event_exceptions WHERE event_id=?', id);
            const dates = rebasedCalendarExceptionDates(old, next, exceptions.map(row => row.anchor_date));
            const moved = exceptions.map((row, index) => ({ ...row, anchor: dates[index] }));
            if (new Set(moved.map(row => row.anchor)).size !== moved.length) throw new Error('個別変更の実施日が重なります。予定を確認してください。');
            remindersChanged = await rebaseCalendarReminderRulesInside(tx, 'personal', old, next);
            if (moved.length) await tx.runAsync('DELETE FROM calendar_event_exceptions WHERE event_id=?', id);
            for (const row of moved) {
              const json = row.override_json && !isCalendarAnchor(next, row.anchor) ? JSON.stringify({ ...JSON.parse(row.override_json), _retainedOccurrence: true }) : row.override_json;
              await tx.runAsync('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,?)', id, row.anchor, json, row.revision + 1);
            }
          }
        }
        await tx.runAsync('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,?,0) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json,revision=excluded.revision,deleted=0', id, bodyJson, (restoreBirthday ? prior!.revision : input.expectedRevision) + 1);
        eventChanged = true;
      }
      if (input.reminderMinutes !== undefined) {
        const anchorDate = input.scope === 'one' ? input.anchorDate ?? null : null;
        const previous = await tx.getFirstAsync<{ minutes: number | null }>("SELECT minutes FROM calendar_notification_rules WHERE scope='personal' AND event_id=? AND anchor_date=?", id, anchorDate ?? '');
        if (!previous || previous.minutes !== input.reminderMinutes) {
          await saveCalendarReminderInside(tx, { scope: 'personal', eventId: id, anchorDate, minutes: input.reminderMinutes }); remindersChanged = true;
        }
      }
      draftsChanged = await clearRelatedDrafts(tx, input.id ?? null, input.scope ?? 'series', input.anchorDate, body.birthday, {}, submitted);
      if (input.draftCleanup) draftsChanged = await deleteSubmittedDrafts(tx, input.draftCleanup) || draftsChanged;
    });
  });
  if (eventChanged) { invalidateLocalCalendarPlan(database); changed(database); }
  else if (draftsChanged) changed(database, 'drafts');
  if (remindersChanged) notifyCalendarRemindersChanged(database);
  return id;
}
export async function deleteCalendarEvent(database: SQLiteDatabase, input: { id: string; expectedRevision: number; anchorDate?: LocalDate; expectedExceptionRevision?: number }) {
  identifier(input.id); if (input.anchorDate !== undefined) parseLocalDate(input.anchorDate);
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      await assertEditableGoogleEvent(tx, input.id, input.anchorDate, input.anchorDate === undefined);
      const row = await tx.getFirstAsync<{ revision: number; deleted: number; definition_json: string }>('SELECT revision,deleted,definition_json FROM calendar_events WHERE id=?', input.id);
      if (!row || row.deleted || row.revision !== input.expectedRevision) throw conflict();
      if (input.anchorDate) {
        const prior = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', input.id, input.anchorDate);
        if (!prior && !isCalendarAnchor({ ...validateEventDraft(JSON.parse(row.definition_json)), id: input.id, revision: row.revision }, input.anchorDate)) throw conflict();
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
export async function clearCalendarEditorDraft(database: SQLiteDatabase, draft: CalendarEditorDraft, assertAccess?: CalendarDraftAccess) {
  await discardCalendarDraftIfUnchanged(database, draft, assertAccess);
}

async function deleteSubmittedDrafts(database: SQLiteDatabase, { snapshots, assertAccess }: CalendarDraftCleanup) {
  let removed = false;
  for (const input of snapshots) {
    const draft = parseEditorDraft(input);
    assertDraftWriter(draft, assertAccess);
    const result = await database.runAsync('DELETE FROM calendar_drafts WHERE slot=? AND draft_json=?', calendarDraftKey(draft), JSON.stringify(draft));
    removed ||= Boolean(result.changes);
    assertDraftWriter(draft, assertAccess);
  }
  return removed;
}

/** Post-commit group cleanup preserves input saved by another editor in the meantime. */
export async function clearSubmittedCalendarDrafts(database: SQLiteDatabase, cleanup: CalendarDraftCleanup) {
  if (!cleanup.snapshots.length) return;
  const removed = await withPlannerDatabaseOperation(database, async () => {
    await personal(database);
    return withIsolatedSqliteTransaction(database, tx => deleteSubmittedDrafts(tx, cleanup));
  });
  if (removed) changed(database, 'drafts');
}
export function clearSubmittedCalendarDraft(database: SQLiteDatabase, input: CalendarEditorDraft, assertAccess?: CalendarDraftAccess) {
  return clearSubmittedCalendarDrafts(database, { snapshots: [input], assertAccess });
}

/** Explicit recovery discards only the exact draft opened by this editor. */
export async function discardCalendarDraftIfUnchanged(database: SQLiteDatabase, input: CalendarEditorDraft, assertAccess?: CalendarDraftAccess) {
  const draft = parseEditorDraft(input); let removed = false;
  await withPlannerDatabaseOperation(database, async () => {
    await personal(database); await withIsolatedSqliteTransaction(database, async tx => {
      assertDraftWriter(draft, assertAccess);
      const row = await tx.getFirstAsync<{ draft_json: string }>('SELECT draft_json FROM calendar_drafts WHERE slot=?', calendarDraftKey(draft));
      if (!row) return;
      if (row.draft_json !== JSON.stringify(draft)) throw new Error('別の画面で入力が更新されています。閉じてから最新の下書きを開いてください。');
      const result = await tx.runAsync('DELETE FROM calendar_drafts WHERE slot=? AND draft_json=?', calendarDraftKey(draft), row.draft_json); removed = Boolean(result.changes);
      assertDraftWriter(draft, assertAccess);
    });
  });
  if (removed) changed(database, 'drafts');
}
