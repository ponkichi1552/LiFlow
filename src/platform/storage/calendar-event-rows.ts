import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types.ts';
import { validateEventDraft } from '../../features/calendar/events.ts';
import type { CalendarEvent, CalendarException, EventDraft } from '../../features/calendar/events.ts';
import { canWriteGoogleCalendar } from '../google-calendar/calendar-api.ts';
import type { GoogleCalendarListEntry } from '../google-calendar/calendar-api';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';

type ValidatedRow = { json: string | null; revision: number; value: EventDraft | null };
const validated = new WeakMap<SQLiteDatabase, { events: Map<string, ValidatedRow>; exceptions: Map<string, ValidatedRow> }>();
// Never hand a cached object (including custom weekdays) to an editable caller.
const copy = (value: EventDraft): EventDraft => ({ ...value, ...(value.customRecurrence ? { customRecurrence: {
  ...value.customRecurrence, ...(value.customRecurrence.unit === 'week' ? { weekdays: [...value.customRecurrence.weekdays] } : {}),
} } : {}) });

/** Caller supplies a verified personal DB/serialized transaction; no cloud or UI imports. */
export async function readCalendarEventRows(database: SQLiteDatabase): Promise<{ events: CalendarEvent[]; exceptions: CalendarException[] }> {
  const hasGoogle = Boolean(await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_google_links'"));
  const control = hasGoogle && await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_google_control'")
    ? await database.getFirstAsync<{ control_json: string }>('SELECT control_json FROM calendar_google_control WHERE singleton=1') : null;
  let currentSubject: string | null = null;
  let currentCalendars = new Map<string, GoogleCalendarListEntry>();
  try { const value = JSON.parse(control?.control_json ?? '{}'); if (typeof value.subject === 'string' && value.subject && Array.isArray(value.calendars)) {
    currentSubject = value.subject; currentCalendars = new Map(value.calendars.filter((row: GoogleCalendarListEntry) => typeof row?.id === 'string').map((row: GoogleCalendarListEntry) => [row.id, row]));
  } } catch { /* An invalid account cannot expose archived imports. */ }
  // Bound the active projection, not the retained archives of other accounts.
  // Filtering in SQLite also avoids parsing those old definitions on every read.
  const visibleSql = hasGoogle ? ` AND (NOT EXISTS(SELECT 1 FROM calendar_google_links l WHERE l.event_id=e.id)
    OR EXISTS(SELECT 1 FROM calendar_google_links l WHERE l.event_id=e.id AND l.anchor_date='' AND l.active=1
      AND l.subject=? AND l.calendar_id IN (SELECT value FROM json_each(?))))` : '';
  const parameters = hasGoogle ? [currentSubject ?? '', JSON.stringify([...currentCalendars.keys()])] : [];
  const rows = await database.getAllAsync<{ id: string; definition_json: string; revision: number }>(`SELECT e.* FROM calendar_events e WHERE e.deleted=0${visibleSql} ORDER BY e.id LIMIT 10001`, ...parameters);
  const exceptions = await database.getAllAsync<{ event_id: string; anchor_date: LocalDate; override_json: string | null; revision: number }>(
    `SELECT x.* FROM calendar_event_exceptions x JOIN calendar_events e ON e.id=x.event_id WHERE e.deleted=0${visibleSql} LIMIT 20001`, ...parameters);
  if (rows.length > 10000 || exceptions.length > 20000) throw new Error('保存された予定が多すぎます。表示期間を整理してください。');
  const previous = validated.get(database); const next = { events: new Map<string, ValidatedRow>(), exceptions: new Map<string, ValidatedRow>() };
  const googleMetadata = hasGoogle ? await database.getAllAsync<{ subject: string; calendar_id: string; event_id: string; anchor_date: string; read_only: number; transparency: unknown; html_link: unknown; event_type: unknown; active: number }>(`SELECT l.subject,l.calendar_id,l.event_id,l.anchor_date,l.read_only,l.active,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.transparency') END AS transparency,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.htmlLink') END AS html_link,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.eventType') END AS event_type FROM calendar_google_links l
    JOIN calendar_events e ON e.id=l.event_id WHERE e.deleted=0 AND l.subject=? AND l.calendar_id IN (SELECT value FROM json_each(?))`, ...parameters) : [];
  const metadata = new Map(googleMetadata.filter(row => row.subject === currentSubject && currentCalendars.has(row.calendar_id)).map(row => {
    let externalUrl: string | undefined;
    try { const url = new URL(typeof row.html_link === 'string' ? row.html_link : ''); if (url.protocol === 'https:' && ['calendar.google.com', 'www.google.com'].includes(url.hostname)) externalUrl = url.href; } catch { /* No external action for an invalid URL. */ }
    const holiday = row.calendar_id.endsWith('#holiday@group.v.calendar.google.com');
    return [JSON.stringify([row.event_id, row.anchor_date]), { readOnly: Boolean(row.read_only) || !canWriteGoogleCalendar(currentCalendars.get(row.calendar_id)!), active: row.active, blocksTime: !holiday && row.transparency !== 'transparent' && row.event_type !== 'birthday', ...(holiday ? { holiday: true } : {}), ...(externalUrl ? { externalUrl } : {}) }];
  }));
  const read = (json: string | null, revision: number, prior?: ValidatedRow): ValidatedRow => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('保存された予定の更新番号を確認してください。');
    if (prior?.json === json && prior.revision === revision) return prior;
    return { json, revision, value: json === null ? null : validateEventDraft(JSON.parse(json)) };
  };
  const events = rows.map(row => {
    const value = read(row.definition_json, row.revision, previous?.events.get(row.id)); next.events.set(row.id, value);
    return { ...copy(value.value!), ...metadata.get(JSON.stringify([row.id, ''])), id: row.id, revision: row.revision };
  });
  const projectedExceptions = exceptions.map(row => {
    const key = `${row.event_id}:${row.anchor_date}`; parseLocalDate(row.anchor_date);
    const value = read(row.override_json, row.revision, previous?.exceptions.get(key)); next.exceptions.set(key, value);
    const source = metadata.get(JSON.stringify([row.event_id, row.anchor_date]));
    return { eventId: row.event_id, anchorDate: row.anchor_date, override: value.value ? copy(value.value) : null, revision: row.revision,
      ...(source ? { blocksTime: source.blocksTime } : {}) };
  });
  // Publish only after the entire read validates. Removed rows are evicted; no DB writes or migrations are skipped.
  validated.set(database, next);
  return { events, exceptions: projectedExceptions };
}
