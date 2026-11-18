import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types.ts';
import { validateEventDraft } from '../../features/calendar/events.ts';
import type { CalendarEvent, CalendarException, EventDraft } from '../../features/calendar/events.ts';
import { canWriteGoogleCalendar } from '../google-calendar/calendar-api.ts';
import type { GoogleCalendarListEntry } from '../google-calendar/calendar-api';
import { addDays, daysBetween, parseLocalDate } from '../../domain/scheduling/local-date.ts';

type ValidatedRow = { json: string | null; revision: number; value: EventDraft | null; retained?: boolean };
type ValidatedProjection = { events: Map<string, ValidatedRow>; exceptions: Map<string, ValidatedRow> };
export interface CalendarEventReadRange { from: LocalDate; through: LocalDate }
export interface CalendarEventReadTarget { eventId: string; anchorDate?: LocalDate }
export interface CalendarEventReadPage { afterId?: string; limit: number }
export class CalendarHistoryLimitError extends Error {
  readonly code = 'calendar/history-limit';
  constructor() { super('保存された予定が多すぎます。表示期間を整理してください。'); }
}
export async function readCalendarEventRowsPage(database: SQLiteDatabase, afterId?: string, limit = 500) {
  return readCalendarEventRows(database, undefined, undefined, { ...(afterId ? { afterId } : {}), limit });
}
const validated = new WeakMap<SQLiteDatabase, { full?: ValidatedProjection; ranges: Map<string, ValidatedProjection> }>();
const MAX_CACHED_RANGES = 4;
// Never hand a cached object (including custom weekdays) to an editable caller.
const copy = (value: EventDraft): EventDraft => ({ ...value, ...(value.customRecurrence ? { customRecurrence: {
  ...value.customRecurrence, ...(value.customRecurrence.unit === 'week' ? { weekdays: [...value.customRecurrence.weekdays] } : {}),
  ...(value.customRecurrence.unit === 'month' && value.customRecurrence.on === 'dates' ? { days: [...value.customRecurrence.days] } : {}),
} } : {}) });

/** Caller supplies a verified personal DB/serialized transaction; no cloud or UI imports. */
export async function readCalendarEventRows(database: SQLiteDatabase, range?: CalendarEventReadRange, target?: CalendarEventReadTarget, page?: CalendarEventReadPage): Promise<{ events: CalendarEvent[]; exceptions: CalendarException[]; nextAfterId?: string }> {
  if (page && (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 500 || page.afterId !== undefined && !page.afterId)) throw new Error('予定の検索範囲を確認してください。');
  if (page && target) throw new Error('予定の検索範囲を確認してください。');
  if (target) {
    if (!target.eventId || target.eventId.length > 1024) throw new Error('予定の識別子を確認してください。');
    if (target.anchorDate) parseLocalDate(target.anchorDate);
  }
  if (range) {
    parseLocalDate(range.from); parseLocalDate(range.through);
    if (range.from > range.through || daysBetween(range.from, range.through) > 370) throw new Error('表示期間は1年以内にしてください。');
  }
  const projectionRange = range ? { from: addDays(range.from, -2), through: addDays(range.through, 2) } : undefined;
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
  const longGoogleSpanSql = hasGoogle ? `EXISTS(SELECT 1 FROM calendar_google_links gl WHERE gl.event_id=e.id
        AND gl.anchor_date='' AND gl.active=1 AND json_valid(gl.remote_json)
        AND json_extract(gl.remote_json,'$.start.date')<=? AND json_extract(gl.remote_json,'$.end.date')>?)` : '0';
  const rangeSql = range ? ` AND (
    (json_extract(e.definition_json,'$.recurrence')='none' AND json_extract(e.definition_json,'$.startDate')<=?
      AND (json_extract(e.definition_json,'$.endDate')>=? OR ${longGoogleSpanSql}))
    OR (json_extract(e.definition_json,'$.recurrence')<>'none' AND json_extract(e.definition_json,'$.startDate')<=?
      AND (json_extract(e.definition_json,'$.untilDate') IS NULL OR json_extract(e.definition_json,'$.untilDate')>=?))
    OR EXISTS(SELECT 1 FROM calendar_event_exceptions xr WHERE xr.event_id=e.id
      AND (xr.anchor_date BETWEEN ? AND ? OR (xr.override_json IS NOT NULL
        AND json_extract(xr.override_json,'$.startDate')<=? AND json_extract(xr.override_json,'$.endDate')>=?)))
  )` : '';
  const rangeValues = projectionRange ? [projectionRange.through, projectionRange.from, ...(hasGoogle ? [projectionRange.through, projectionRange.from] : []),
    projectionRange.through, addDays(projectionRange.from, -366), projectionRange.from, projectionRange.through, projectionRange.through, projectionRange.from] : [];
  const eventScopeSql = target ? ' AND e.id=?' : `${rangeSql}${page?.afterId ? ' AND e.id>?' : ''}`;
  const eventScopeValues = target ? [target.eventId] : [...rangeValues, ...(page?.afterId ? [page.afterId] : [])];
  const rawRows = await database.getAllAsync<{ id: string; definition_json: string; revision: number }>(
    `SELECT e.* FROM calendar_events e WHERE e.deleted=0${visibleSql}${eventScopeSql} ORDER BY e.id LIMIT ${page ? '?' : '10001'}`,
    ...parameters, ...eventScopeValues, ...(page ? [page.limit + 1] : []));
  const hasMoreRows = Boolean(page && rawRows.length > page.limit);
  const rows = hasMoreRows ? rawRows.slice(0, page!.limit) : rawRows;
  const exceptionRangeSql = range ? ` AND (x.anchor_date BETWEEN ? AND ? OR (x.override_json IS NOT NULL
    AND json_extract(x.override_json,'$.startDate')<=? AND json_extract(x.override_json,'$.endDate')>=?))` : '';
  const exceptionRangeValues = projectionRange ? [projectionRange.from, projectionRange.through, projectionRange.through, projectionRange.from] : [];
  const exceptionTargetSql = target ? ` AND x.event_id=?${target.anchorDate ? ' AND x.anchor_date=?' : ' AND 1=0'}` : exceptionRangeSql;
  const exceptionTargetValues = target ? target.anchorDate ? [target.eventId, target.anchorDate] : [target.eventId]
    : page ? [JSON.stringify(rows.map(row => row.id))] : exceptionRangeValues;
  const exceptionPageSql = page ? ' AND x.event_id IN (SELECT value FROM json_each(?))' : '';
  const exceptions = await database.getAllAsync<{ event_id: string; anchor_date: LocalDate; override_json: string | null; revision: number }>(
    `SELECT x.* FROM calendar_event_exceptions x JOIN calendar_events e ON e.id=x.event_id WHERE e.deleted=0${visibleSql}${exceptionTargetSql}${exceptionPageSql} LIMIT 20001`, ...parameters, ...exceptionTargetValues);
  if (!page && rows.length > 10000 || exceptions.length > 20000) throw new CalendarHistoryLimitError();
  const cache = validated.get(database);
  const rangeKey = range ? `${range.from}:${range.through}` : null;
  const previous = target || page ? undefined : rangeKey ? cache?.ranges.get(rangeKey) : cache?.full;
  if (rangeKey && previous && cache) { cache.ranges.delete(rangeKey); cache.ranges.set(rangeKey, previous); }
  const next = { events: new Map<string, ValidatedRow>(), exceptions: new Map<string, ValidatedRow>() };
  const hasCurrentGoogle = currentSubject !== null && currentCalendars.size > 0;
  const scoped = hasCurrentGoogle && Boolean(range || target || page);
  const metadataParameters = scoped ? [JSON.stringify([...rows.map(row => [row.id, '']), ...exceptions.map(row => [row.event_id, row.anchor_date])]), ...parameters] : parameters;
  // Iterate scoped keys once and probe each link's index. A correlated lookup
  // across the whole key array would become quadratic after a large import.
  const metadataSource = scoped ? `json_each(?) k CROSS JOIN calendar_google_links l
    ON l.event_id=json_extract(k.value,'$[0]') AND l.anchor_date=json_extract(k.value,'$[1]')` : 'calendar_google_links l';
  const googleMetadata = hasCurrentGoogle && (rows.length || exceptions.length) ? await database.getAllAsync<{
    calendar_id: string; event_id: string; anchor_date: string; read_only: number; transparency: unknown; html_link: unknown;
    event_type: unknown; active: number; remote_start_date: unknown; remote_end_date: unknown;
  }>(`SELECT l.calendar_id,l.event_id,l.anchor_date,l.read_only,l.active,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.transparency') END AS transparency,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.htmlLink') END AS html_link,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.eventType') END AS event_type,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.start.date') END AS remote_start_date,
    CASE WHEN json_valid(l.remote_json) THEN json_extract(l.remote_json,'$.end.date') END AS remote_end_date FROM ${metadataSource}
    JOIN calendar_events e ON e.id=l.event_id WHERE e.deleted=0 AND l.active=1 AND l.subject=? AND l.calendar_id IN (SELECT value FROM json_each(?))`,
    ...metadataParameters) : [];
  const metadata = new Map(googleMetadata.map(row => {
    let externalUrl: string | undefined;
    try { const url = new URL(typeof row.html_link === 'string' ? row.html_link : ''); if (url.protocol === 'https:' && ['calendar.google.com', 'www.google.com'].includes(url.hostname)) externalUrl = url.href; } catch { /* No external action for an invalid URL. */ }
    const holiday = row.calendar_id.endsWith('#holiday@group.v.calendar.google.com');
    let allDayRange: { startDate: LocalDate; endDate: LocalDate } | undefined;
    try {
      const startDate = row.remote_start_date, endExclusive = row.remote_end_date;
      if (typeof startDate === 'string' && typeof endExclusive === 'string' && daysBetween(startDate as LocalDate, endExclusive as LocalDate) > 367)
        allDayRange = { startDate: startDate as LocalDate, endDate: addDays(endExclusive as LocalDate, -1) };
    } catch { /* The validated stored projection remains available if private source JSON is damaged. */ }
    return [JSON.stringify([row.event_id, row.anchor_date]), { readOnly: Boolean(row.read_only) || !canWriteGoogleCalendar(currentCalendars.get(row.calendar_id)!), active: row.active, blocksTime: !holiday && row.transparency !== 'transparent' && row.event_type !== 'birthday', ...(allDayRange ? { allDayRange } : {}), ...(holiday ? { holiday: true } : {}), ...(externalUrl ? { externalUrl } : {}) }];
  }));
  const read = (json: string | null, revision: number, prior?: ValidatedRow): ValidatedRow => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('保存された予定の更新番号を確認してください。');
    if (prior?.json === json && prior.revision === revision) return prior;
    const parsed = json === null ? null : JSON.parse(json);
    return { json, revision, value: parsed === null ? null : validateEventDraft(parsed), retained: parsed?._retainedOccurrence === true };
  };
  const events = rows.map(row => {
    const value = read(row.definition_json, row.revision, previous?.events.get(row.id)); next.events.set(row.id, value);
    const { allDayRange, ...source } = metadata.get(JSON.stringify([row.id, ''])) ?? {};
    return { ...copy(value.value!), ...(allDayRange ? { ...allDayRange, allDay: true } : {}), ...source, id: row.id, revision: row.revision };
  });
  const projectedExceptions = exceptions.map(row => {
    const key = `${row.event_id}:${row.anchor_date}`; parseLocalDate(row.anchor_date);
    const value = read(row.override_json, row.revision, previous?.exceptions.get(key)); next.exceptions.set(key, value);
    const source = metadata.get(JSON.stringify([row.event_id, row.anchor_date]));
    return { eventId: row.event_id, anchorDate: row.anchor_date, override: value.value ? copy(value.value) : null, revision: row.revision,
      ...(value.retained ? { detached: true } : {}),
      ...(source ? { blocksTime: source.blocksTime, readOnly: source.readOnly, ...(source.externalUrl ? { externalUrl: source.externalUrl } : {}) } : {}) };
  });
  // Publish only after the entire read validates. Removed rows are evicted; no DB writes or migrations are skipped.
  if (!target && !page) {
    const nextCache = cache ?? { ranges: new Map<string, ValidatedProjection>() };
    if (rangeKey) {
      nextCache.ranges.delete(rangeKey); nextCache.ranges.set(rangeKey, next);
      while (nextCache.ranges.size > MAX_CACHED_RANGES) nextCache.ranges.delete(nextCache.ranges.keys().next().value!);
    } else nextCache.full = next;
    validated.set(database, nextCache);
  }
  return { events, exceptions: projectedExceptions, ...(hasMoreRows && rows.length ? { nextAfterId: rows.at(-1)!.id } : {}) };
}
