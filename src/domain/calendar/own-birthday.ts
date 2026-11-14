import { projectCalendarEvents } from './events.ts';
import type { CalendarEvent, CalendarException } from './events.ts';
import type { LocalDate } from '../shared/types.ts';

export const OWN_BIRTHDAY_EVENT_ID = 'self-birthday';

/** A display-only selector: reuse recurrence/exception rules without creating another event. */
export function isOwnBirthdayOn(date: LocalDate, events: readonly CalendarEvent[], exceptions: readonly CalendarException[] = []) {
  const own = events.find(event => event.id === OWN_BIRTHDAY_EVENT_ID && event.birthday);
  return Boolean(own && projectCalendarEvents([own], exceptions.filter(row => row.eventId === own.id), date, date).length);
}
