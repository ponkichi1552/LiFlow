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
import { readCalendarEventRows } from './calendar-event-rows.ts';

export interface CalendarEditorDraft { eventId: string | null; anchorDate: LocalDate | null; revision: number; exceptionRevision: number; scope: 'one' | 'series'; value: EventDraft }
export function calendarDraftKey(draft: CalendarEditorDraft) { return draft.eventId ? `event:${draft.eventId}:${draft.scope}:${draft.scope === 'one' ? draft.anchorDate : ''}` : draft.value.birthday ? 'birthday:new' : 'new'; }
/** A return route carries this digest, never the private input text. */
export function calendarDraftVersion(draft: CalendarEditorDraft) { return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(parseEditorDraft(draft))))); }
export interface LocalCalendarSnapshot { events: CalendarEvent[]; categories: CalendarCategory[]; exceptions: CalendarException[]; draft: CalendarEditorDraft | null; drafts?: CalendarEditorDraft[]; draftError?: string }
export const EMPTY_LOCAL_CALENDAR: LocalCalendarSnapshot = { events: [], categories: [...INITIAL_CATEGORIES], exceptions: [], draft: null };
const listeners = new WeakMap<SQLiteDatabase, Set<() => void>>();
let idSequence = 0;
function newId(prefix: string) { return `${prefix}.${Date.now().toString(36)}.${(++idSequence).toString(36)}.${Math.random().toString(36).slice(2, 12)}`; }
const conflict = () => new Error('予定が別の画面で変更されました。再読込してから編集してください。');
function identifier(id: string) { if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error('予定・分類の識別子が無効です。'); }
async function personal(database: SQLiteDatabase) {
  if (sharedRepositoryAdapter(database)) throw new Error('個人のカレンダーは個人の保存先で開いてください。');
  if (!await database.getFirstAsync("SELECT id FROM households WHERE id = 'local-household'")) throw new Error('個人の保存先を確認できません。');
}
function changed(database: SQLiteDatabase) { for (const fn of listeners.get(database) ?? []) { try { fn(); } catch { /* A view failure cannot change a committed SQLite result. */ } } }
export function subscribeLocalCalendar(database: SQLiteDatabase, callback: () => void) {
  let set = listeners.get(database); if (!set) { set = new Set(); listeners.set(database, set); } set.add(callback);
  return () => { set!.delete(callback); };
}
async function seed(database: SQLiteDatabase) {
  for (const category of INITIAL_CATEGORIES) await database.runAsync('INSERT OR IGNORE INTO calendar_categories(id,name,color,revision) VALUES (?,?,?,1)', category.id, category.name, category.color);
}
export async function readLocalCalendar(database: SQLiteDatabase): Promise<LocalCalendarSnapshot> {
  return withPlannerDatabaseOperation(database, async () => {
    await personal(database); await migrateLocalDatabase(database); await seed(database);
    const { events, exceptions } = await readCalendarEventRows(database);
    const categories = await database.getAllAsync<CalendarCategory>('SELECT * FROM calendar_categories ORDER BY rowid');
    const rows = await database.getAllAsync<{ draft_json: string }>('SELECT draft_json FROM calendar_drafts ORDER BY rowid DESC LIMIT 51');
    const drafts: CalendarEditorDraft[] = []; let draftError: string | undefined;
    for (const raw of rows) try { drafts.push(parseEditorDraft(JSON.parse(raw.draft_json))); } catch { draftError = '入力途中の予定を読み込めません。保存済みの予定は表示しています。'; }
    return { events, exceptions, categories, draft: drafts[0] ?? null, drafts, draftError };
  });
}
function parseEditorDraft(draft: CalendarEditorDraft): CalendarEditorDraft {
  if (!draft || typeof draft !== 'object' || !['one', 'series'].includes(draft.scope) || !Number.isInteger(draft.revision) || draft.revision < 0
    || !Number.isInteger(draft.exceptionRevision) || draft.exceptionRevision < 0) throw new Error('入力途中の予定を確認してください。');
  if (draft.eventId !== null) identifier(draft.eventId); if (draft.anchorDate !== null) parseLocalDate(draft.anchorDate);
  // Empty titles are valid in a draft; saved events require a title.
  parseLocalDate(draft.value.endDate); if (draft.value.untilDate !== null) parseLocalDate(draft.value.untilDate);
  if (typeof draft.value.allDay !== 'boolean' || typeof draft.value.birthday !== 'boolean') throw new Error('入力途中の予定を確認してください。');
  const value = validateEventDraft({ ...draft.value, title: draft.value.title || '入力中', allDay: true, birthday: false, endDate: draft.value.startDate, untilDate: null });
  return { eventId: draft.eventId, anchorDate: draft.anchorDate, revision: draft.revision, exceptionRevision: draft.exceptionRevision, scope: draft.scope,
    value: { ...value, title: draft.value.title, allDay: draft.value.allDay, birthday: draft.value.birthday, endDate: draft.value.endDate, untilDate: draft.value.untilDate } };
}
async function clearRelatedDrafts(database: SQLiteDatabase, id: string | null, scope?: 'one' | 'series', anchorDate?: LocalDate | null, birthday = false) {
  const rows = await database.getAllAsync<{ slot: string; draft_json: string }>('SELECT slot,draft_json FROM calendar_drafts LIMIT 51');
  for (const row of rows) {
    let draft: CalendarEditorDraft;
    try { draft = parseEditorDraft(JSON.parse(row.draft_json)); } catch { continue; }
    if (draft.eventId === id && (id !== null || draft.value.birthday === birthday) && (!scope || draft.scope === scope && (scope === 'series' || draft.anchorDate === anchorDate))) {
      await database.runAsync('DELETE FROM calendar_drafts WHERE slot=?', row.slot);
    }
  }
}
export async function saveCalendarDraft(database: SQLiteDatabase, input: CalendarEditorDraft | null, birthday = false) {
  const draft = input ? parseEditorDraft(input) : null;
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      await clearRelatedDrafts(tx, draft?.eventId ?? null, draft?.scope, draft?.anchorDate, draft?.value.birthday ?? birthday);
      if (!draft) return;
      const count = await tx.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM calendar_drafts');
      if ((count?.count ?? 0) >= 50) throw new Error('入力途中の予定が多くなっています。下書きを保存・整理してから閉じてください。');
      const slot = calendarDraftKey(draft);
      await tx.runAsync('INSERT INTO calendar_drafts(slot,draft_json) VALUES(?,?)', slot, JSON.stringify(draft));
    });
  });
}
export async function saveCalendarEvent(database: SQLiteDatabase, input: {
  id?: string; expectedRevision: number; value: EventDraft; anchorDate?: LocalDate; expectedExceptionRevision?: number; scope?: 'one' | 'series'; resetExceptions?: boolean;
}) {
  const body = validateEventDraft(input.value); const id = input.id ?? newId('event'); identifier(id);
  if (input.anchorDate) parseLocalDate(input.anchorDate);
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
      if (!await tx.getFirstAsync('SELECT id FROM calendar_categories WHERE id=?', body.categoryId)) throw new Error('分類を選び直してください。');
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
      await clearRelatedDrafts(tx, input.id ?? null, input.scope ?? 'series', input.anchorDate, body.birthday);
    });
  }); invalidateLocalCalendarPlan(database); changed(database); return id;
}
export async function deleteCalendarEvent(database: SQLiteDatabase, input: { id: string; expectedRevision: number; anchorDate?: LocalDate; expectedExceptionRevision?: number }) {
  identifier(input.id); if (input.anchorDate) parseLocalDate(input.anchorDate);
  await withPlannerDatabaseOperation(database, async () => { await personal(database);
    await withIsolatedSqliteTransaction(database, async tx => {
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
  }); }); changed(database); return id;
}
