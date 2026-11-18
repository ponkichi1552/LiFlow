import type { CalendarEvent, CalendarException, CalendarOccurrence } from './events';
import { calendarEventsInTimeZone, isCalendarAnchor } from './events.ts';
import type { LocalDate } from '../../domain/shared/types';
import { projectPrivateCalendarEvents } from './private-event-projection.ts';
import { addDays, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import type { CalendarReminderSettings } from './reminder-preferences.ts';
import type { LocalNotificationRequest } from '../notifications/contracts';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import { localDayBoundary } from './local-day-boundary.ts';

export const CALENDAR_NOTIFICATION_PREFIX = 'liflow-calendar:';
export interface CalendarNotificationSource { scope: string; events: readonly CalendarEvent[]; exceptions: readonly CalendarException[] }
const noticeLimit = 32;
const horizonDays = 62;
const dayMilliseconds = 86_400_000;

function occurrenceFireAt(row: CalendarOccurrence, minutes: number) {
  const localTime = (date: LocalDate) => v2WallTimeCandidates({ date, hour: Math.floor(row.startMinute / 60), minute: row.startMinute % 60, timeZone: row.timeZone });
  const start = row.allDay ? localDayBoundary(row.startDate, row.timeZone) : localTime(row.startDate)[0];
  if (start === undefined || row.allDay && pinnedClockAt(start, row.timeZone).date !== row.startDate) return NaN;
  if (minutes !== 1440) return start - minutes * 60_000;
  const date = addDays(row.startDate, -1);
  if (row.allDay) {
    const boundary = localDayBoundary(date, row.timeZone);
    return pinnedClockAt(boundary, row.timeZone).date === date ? boundary : NaN;
  }
  const candidates = localTime(date); const elapsed = start - dayMilliseconds;
  // Keep the prior civil date. If its clock jumps or repeats, use the
  // 24-hour offset to choose the closest available interpretation.
  if (!candidates.length) return pinnedClockAt(elapsed, row.timeZone).date === date ? elapsed : NaN;
  return candidates.reduce((nearest, candidate) => Math.abs(candidate - elapsed) < Math.abs(nearest - elapsed) ? candidate : nearest);
}

/** Explicit opt-in only. Conflicting/DST-ambiguous occurrences cannot produce a guessed reminder. */
export function calendarNotificationRequests(settings: CalendarReminderSettings, sources: readonly CalendarNotificationSource[], now = Date.now()): LocalNotificationRequest[] {
  if (!settings.enabled) return [];
  const rulesByScope = new Map<string, Map<string, Map<LocalDate | null, number | null>>>();
  for (const rule of settings.rules) {
    const events = rulesByScope.get(rule.scope) ?? new Map();
    const rules = events.get(rule.eventId) ?? new Map();
    if (!rules.has(rule.anchorDate)) rules.set(rule.anchorDate, rule.minutes);
    events.set(rule.eventId, rules);
    rulesByScope.set(rule.scope, events);
  }
  const daysByZone = new Map<string, LocalDate>();
  const work: { scope: string; event: CalendarEvent; exceptions: CalendarException[]; day: LocalDate; rules: Map<LocalDate | null, number | null> }[] = [];
  for (const source of sources) {
    const selected = rulesByScope.get(source.scope);
    if (!selected) continue;
    const exceptions = new Map<string, CalendarException[]>();
    for (const row of source.exceptions) if (selected.has(row.eventId)) {
      const existing = exceptions.get(row.eventId);
      if (existing) existing.push(row);
      else exceptions.set(row.eventId, [row]);
    }
    for (const event of source.events) {
      const rules = selected.get(event.id);
      if (!rules || ![...rules.values()].some(minutes => minutes !== null) || event.holiday || event.birthday) continue;
      const day = daysByZone.get(event.timeZone) ?? pinnedClockAt(now, event.timeZone).date;
      daysByZone.set(event.timeZone, day);
      work.push({ scope: source.scope, event, exceptions: exceptions.get(event.id) ?? [], day, rules });
    }
  }
  if (!work.length) return [];
  const earliestDay = work.reduce((earliest, entry) => entry.day < earliest ? entry.day : earliest, work[0].day);
  const result: { at: number; key: string; scope: string; row: CalendarOccurrence; minutes: number }[] = [];
  for (let offset = 0, edge = 4; offset < horizonDays; offset = edge, edge = Math.min(horizonDays, edge * 2)) {
    for (const input of work) {
      const from = addDays(input.day, offset);
      const through = addDays(input.day, edge - 1);
      if (input.event.startDate > through && !input.exceptions.length) continue;
      for (const row of projectPrivateCalendarEvents([input.event], input.exceptions, from, through)) {
        if (row.timeIssue || (offset > 0 && row.startDate < from)) continue;
        const minutes = input.rules.has(row.anchorDate) ? input.rules.get(row.anchorDate) : input.rules.get(null);
        if (minutes == null) continue;
        const at = occurrenceFireAt(row, minutes);
        const last = result.at(noticeLimit - 1);
        if (!Number.isFinite(at) || at <= now || last && at > last.at) continue;
        const key = `${CALENDAR_NOTIFICATION_PREFIX}${sharedDocumentDigest([input.scope, row.eventId, row.anchorDate])}`;
        const later = result.findIndex(previous => previous.at > at || previous.at === at && previous.key.localeCompare(key) > 0);
        result.splice(later < 0 ? result.length : later, 0, { at, key, scope: input.scope, row, minutes });
        if (result.length > noticeLimit) result.pop();
      }
    }
    // Unseen civil start dates can move earlier by a day of reminder lead plus
    // less than a day of IANA UTC offset. Keep ties until every contender is seen.
    const earliestUnseen = parseLocalDate(addDays(earliestDay, edge)).getTime() - 2 * dayMilliseconds;
    if (result.length === noticeLimit && result[noticeLimit - 1].at < earliestUnseen) break;
  }
  return result.map(({ at, key, scope, row, minutes }) => ({ key, title: row.title,
    body: minutes === 0 ? '予定の開始時刻です' : minutes === 1440 ? '明日の予定です' : `${minutes === 60 ? '1時間' : `${minutes}分`}後に始まります`,
    fireAt: new Date(at).toISOString() as LocalNotificationRequest['fireAt'],
    data: { kind: 'calendar-event', scope, eventId: row.eventId, anchorDate: row.anchorDate, date: row.startDate, minute: row.allDay ? -1 : row.startMinute } }));
}

/** A tap resolves against the current source, never an account or title supplied by notification metadata. */
export function calendarNotificationDestination(data: unknown, sources: readonly CalendarNotificationSource[], timeZone: string) {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.kind !== 'calendar-event' || typeof value.scope !== 'string' || typeof value.eventId !== 'string' || typeof value.anchorDate !== 'string') return null;
  try { parseLocalDate(value.anchorDate as LocalDate); } catch { return null; }
  const source = sources.find(source => source.scope === value.scope);
  const event = source?.events.find(event => event.id === value.eventId && !event.holiday);
  if (!source || !event) return null;
  const anchor = value.anchorDate as LocalDate;
  const exception = source.exceptions.find(row => row.eventId === event.id && row.anchorDate === anchor);
  if (exception ? !exception.override : !isCalendarAnchor(event, anchor)) return null;
  const date = exception?.override?.startDate ?? anchor;
  const row = projectPrivateCalendarEvents([event], source.exceptions, date, date).find(row => row.anchorDate === anchor);
  if (!row) return null;
  const [visible] = calendarEventsInTimeZone([row], timeZone);
  return { date: visible.startDate, minute: visible.allDay ? null : visible.startMinute };
}
