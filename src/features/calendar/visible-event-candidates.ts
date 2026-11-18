import type { CalendarEvent } from './events';
import type { PrivateCalendarException } from './private-event-projection';
import type { LocalDate } from '../../domain/shared/types';

/**
 * Narrows a confirmed snapshot to the inputs that can affect one buffered
 * display projection. Recurring series stay eligible for anchor calculation;
 * an override can also move an occurrence into the window from any date.
 */
export function visibleEventProjectionCandidates(
  events: readonly CalendarEvent[],
  exceptions: readonly PrivateCalendarException[],
  from: LocalDate,
  through: LocalDate,
) {
  const eventIds = new Set<string>();
  for (const event of events) {
    if (event.recurrence !== 'none' || (event.startDate <= through && event.endDate >= from)) eventIds.add(event.id);
  }
  for (const exception of exceptions) {
    const override = exception.override;
    if (override && override.startDate <= through && override.endDate >= from) eventIds.add(exception.eventId);
  }
  return {
    events: events.filter(event => eventIds.has(event.id)),
    exceptions: exceptions.filter(exception => eventIds.has(exception.eventId)),
  };
}
