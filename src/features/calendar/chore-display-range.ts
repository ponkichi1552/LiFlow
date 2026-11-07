import type { LocalDate } from '../../domain/shared/types.ts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { calendarMonth } from '../../domain/calendar/events.ts';

/** Browsing dates does not extend the Scheduler; appointments have their own range. */
export function calendarChoreDisplayThrough(today: LocalDate): LocalDate {
  return addDays(calendarMonth(today, 3), -1);
}
