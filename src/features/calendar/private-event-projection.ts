import { projectCalendarEvents } from '../../domain/calendar/events.ts';
import type { CalendarEvent, CalendarException, CalendarOccurrence } from './events';
import type { LocalDate } from '../../domain/shared/types';

/** Private Google transport metadata is kept outside the shared EventDraft contract. */
export interface PrivateCalendarException extends CalendarException { blocksTime?: boolean }

export function projectPrivateCalendarEvents(events: readonly CalendarEvent[], exceptions: readonly PrivateCalendarException[], from: LocalDate, through: LocalDate): CalendarOccurrence[] {
  const rows = projectCalendarEvents(events, exceptions, from, through);
  const holidays = new Set(events.filter(event => event.holiday).map(event => event.id));
  const availability = new Map(exceptions.filter(row => typeof row.blocksTime === 'boolean')
    .map(row => [JSON.stringify([row.eventId, row.anchorDate]), row.blocksTime!]));
  return availability.size || holidays.size ? rows.map(row => {
    const blocksTime = availability.get(JSON.stringify([row.eventId, row.anchorDate]));
    if (holidays.has(row.eventId)) return { ...row, holiday: true, blocksTime: false };
    return blocksTime === undefined ? row : { ...row, blocksTime };
  }) : rows;
}
