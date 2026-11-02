import { projectCalendarEvents } from '../../domain/calendar/events.ts';
import type { CalendarEvent, CalendarException } from '../../domain/calendar/events';
import type { LocalDate } from '../../domain/shared/types';

/** Private Google transport metadata is kept outside the shared EventDraft contract. */
export interface PrivateCalendarException extends CalendarException { blocksTime?: boolean }

export function projectPrivateCalendarEvents(events: readonly CalendarEvent[], exceptions: readonly PrivateCalendarException[], from: LocalDate, through: LocalDate) {
  const rows = projectCalendarEvents(events, exceptions, from, through);
  const availability = new Map(exceptions.filter(row => typeof row.blocksTime === 'boolean')
    .map(row => [JSON.stringify([row.eventId, row.anchorDate]), row.blocksTime!]));
  return availability.size ? rows.map(row => {
    const blocksTime = availability.get(JSON.stringify([row.eventId, row.anchorDate]));
    return blocksTime === undefined ? row : { ...row, blocksTime };
  }) : rows;
}
