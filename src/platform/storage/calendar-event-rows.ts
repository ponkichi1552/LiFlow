import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types.ts';
import { validateEventDraft } from '../../features/calendar/events.ts';
import type { CalendarEvent, CalendarException } from '../../features/calendar/events.ts';

/** Caller supplies a verified personal DB/serialized transaction; no cloud or UI imports. */
export async function readCalendarEventRows(database: SQLiteDatabase): Promise<{ events: CalendarEvent[]; exceptions: CalendarException[] }> {
  const rows = await database.getAllAsync<{ id: string; definition_json: string; revision: number }>('SELECT * FROM calendar_events WHERE deleted = 0 ORDER BY id LIMIT 10001');
  const exceptions = await database.getAllAsync<{ event_id: string; anchor_date: LocalDate; override_json: string | null; revision: number }>(
    'SELECT x.* FROM calendar_event_exceptions x JOIN calendar_events e ON e.id=x.event_id WHERE e.deleted=0 LIMIT 20001');
  if (rows.length > 10000 || exceptions.length > 20000) throw new Error('保存された予定が多すぎます。表示期間を整理してください。');
  return { events: rows.map(row => ({ ...validateEventDraft(JSON.parse(row.definition_json)), id: row.id, revision: row.revision })),
    exceptions: exceptions.map(row => ({ eventId: row.event_id, anchorDate: row.anchor_date, override: row.override_json ? validateEventDraft(JSON.parse(row.override_json)) : null, revision: row.revision })) };
}
