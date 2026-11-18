import { calendarEventsInTimeZone, projectCalendarEvents } from '../../domain/calendar/events.ts';
import type { CalendarWallTimeResolver } from '../../domain/calendar/events.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import type { CalendarEvent, CalendarException, CalendarOccurrence } from './events';
import type { LocalDate } from '../../domain/shared/types';

/** Private Google transport metadata is kept outside the shared EventDraft contract. */
export interface PrivateCalendarException extends CalendarException { blocksTime?: boolean; readOnly?: boolean; externalUrl?: string }
export function privateCalendarReadOnlySource(snapshot: { events: readonly CalendarEvent[]; exceptions: readonly PrivateCalendarException[] }, id: string, anchorDate?: LocalDate | null) {
  const event = snapshot.events.find(row => row.id === id);
  if (event?.readOnly) return event;
  const exception = anchorDate ? snapshot.exceptions.find(row => row.eventId === id && row.anchorDate === anchorDate) : undefined;
  return exception?.readOnly ? exception : undefined;
}
export function canEditPrivateCalendarEvent(snapshot: { events: readonly CalendarEvent[]; exceptions: readonly PrivateCalendarException[] }, id: string, anchorDate?: LocalDate | null) {
  return !privateCalendarReadOnlySource(snapshot, id, anchorDate);
}

export function projectPrivateCalendarEvents(events: readonly CalendarEvent[], exceptions: readonly PrivateCalendarException[], from: LocalDate, through: LocalDate,
  resolveWallTime: CalendarWallTimeResolver = v2WallTimeCandidates): CalendarOccurrence[] {
  const rows = projectCalendarEvents(events, exceptions, from, through, resolveWallTime);
  const holidays = new Set(events.filter(event => event.holiday).map(event => event.id));
  const metadata = new Map(exceptions.filter(row => typeof row.blocksTime === 'boolean' || row.readOnly !== undefined || row.externalUrl)
    .map(row => [JSON.stringify([row.eventId, row.anchorDate]), row]));
  return metadata.size || holidays.size ? rows.map(row => {
    const source = metadata.get(JSON.stringify([row.eventId, row.anchorDate]));
    const value = { ...row, ...(source?.readOnly ? { readOnly: true } : {}), ...(source?.externalUrl ? { externalUrl: source.externalUrl } : {}) };
    const blocksTime = source?.blocksTime;
    if (holidays.has(row.eventId)) return { ...value, holiday: true, blocksTime: false };
    return blocksTime === undefined ? value : { ...value, blocksTime };
  }) : rows;
}

function cachedDisplayWallTimeResolver(resolve: CalendarWallTimeResolver, displayTimeZone: string): CalendarWallTimeResolver {
  const candidatesByZone = new Map<string, Map<LocalDate, Map<number, number[]>>>();
  return input => {
    if (input.timeZone === displayTimeZone) return resolve(input);
    const timeOfDay = (((input.hour * 60 + input.minute) * 60 + (input.second ?? 0)) * 1000) + (input.millisecond ?? 0);
    const byDate = candidatesByZone.get(input.timeZone);
    const byTime = byDate?.get(input.date);
    const cached = byTime?.get(timeOfDay);
    if (cached !== undefined) return cached;
    const candidates = resolve(input);
    if (candidates.length === 1) {
      const dateCache = byDate ?? new Map<LocalDate, Map<number, number[]>>();
      if (!byDate) candidatesByZone.set(input.timeZone, dateCache);
      const timeCache = byTime ?? new Map<number, number[]>();
      if (!byTime) dateCache.set(input.date, timeCache);
      timeCache.set(timeOfDay, candidates);
    }
    return candidates;
  };
}

/** Shares exact wall-time candidates only across one synchronous display projection. */
export function projectPrivateCalendarDisplayEvents(events: readonly CalendarEvent[], exceptions: readonly PrivateCalendarException[],
  from: LocalDate, through: LocalDate, timeZone: string, resolve: CalendarWallTimeResolver = v2WallTimeCandidates): CalendarOccurrence[] {
  const resolveOnce = cachedDisplayWallTimeResolver(resolve, timeZone);
  const projected = projectPrivateCalendarEvents(events, exceptions, from, through, resolveOnce);
  return calendarEventsInTimeZone(projected, timeZone, resolveOnce);
}
