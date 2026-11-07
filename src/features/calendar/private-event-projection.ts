import { projectCalendarEvents } from '../../domain/calendar/events.ts';
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

export function projectPrivateCalendarEvents(events: readonly CalendarEvent[], exceptions: readonly PrivateCalendarException[], from: LocalDate, through: LocalDate): CalendarOccurrence[] {
  const rows = projectCalendarEvents(events, exceptions, from, through);
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
