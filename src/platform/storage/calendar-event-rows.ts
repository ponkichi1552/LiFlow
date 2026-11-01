import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types.ts';
import { validateEventDraft } from '../../features/calendar/events.ts';
import type { CalendarEvent, CalendarException, EventDraft } from '../../features/calendar/events.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';

type ValidatedRow = { json: string | null; revision: number; value: EventDraft | null };
const validated = new WeakMap<SQLiteDatabase, { events: Map<string, ValidatedRow>; exceptions: Map<string, ValidatedRow> }>();
// Never hand a cached object (including custom weekdays) to an editable caller.
const copy = (value: EventDraft): EventDraft => ({ ...value, ...(value.customRecurrence ? { customRecurrence: {
  ...value.customRecurrence, ...(value.customRecurrence.unit === 'week' ? { weekdays: [...value.customRecurrence.weekdays] } : {}),
} } : {}) });

/** Caller supplies a verified personal DB/serialized transaction; no cloud or UI imports. */
export async function readCalendarEventRows(database: SQLiteDatabase): Promise<{ events: CalendarEvent[]; exceptions: CalendarException[] }> {
  const rows = await database.getAllAsync<{ id: string; definition_json: string; revision: number }>('SELECT * FROM calendar_events WHERE deleted = 0 ORDER BY id LIMIT 10001');
  const exceptions = await database.getAllAsync<{ event_id: string; anchor_date: LocalDate; override_json: string | null; revision: number }>(
    'SELECT x.* FROM calendar_event_exceptions x JOIN calendar_events e ON e.id=x.event_id WHERE e.deleted=0 LIMIT 20001');
  if (rows.length > 10000 || exceptions.length > 20000) throw new Error('保存された予定が多すぎます。表示期間を整理してください。');
  const previous = validated.get(database); const next = { events: new Map<string, ValidatedRow>(), exceptions: new Map<string, ValidatedRow>() };
  const read = (json: string | null, revision: number, prior?: ValidatedRow): ValidatedRow => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('保存された予定の更新番号を確認してください。');
    if (prior?.json === json && prior.revision === revision) return prior;
    return { json, revision, value: json === null ? null : validateEventDraft(JSON.parse(json)) };
  };
  const events = rows.map(row => {
    const value = read(row.definition_json, row.revision, previous?.events.get(row.id)); next.events.set(row.id, value);
    return { ...copy(value.value!), id: row.id, revision: row.revision };
  });
  const projectedExceptions = exceptions.map(row => {
    const key = `${row.event_id}:${row.anchor_date}`; parseLocalDate(row.anchor_date);
    const value = read(row.override_json, row.revision, previous?.exceptions.get(key)); next.exceptions.set(key, value);
    return { eventId: row.event_id, anchorDate: row.anchor_date, override: value.value ? copy(value.value) : null, revision: row.revision };
  });
  // Publish only after the entire read validates. Removed rows are evicted; no DB writes or migrations are skipped.
  validated.set(database, next);
  return { events, exceptions: projectedExceptions };
}
