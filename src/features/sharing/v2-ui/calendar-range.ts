import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types';
import { v2CalendarMonth } from './calendar-projection.ts';

/** Adjacent months are prepared together. Revisiting them needs no scheduler read. */
export function v2CalendarDisplayRange(month: LocalDate, retained?: { from: LocalDate; through: LocalDate }) {
  const previous = v2CalendarMonth(month, -1); const next = v2CalendarMonth(month, 1);
  let from = addDays(previous.from, -14); let through = addDays(next.through, 14);
  if (retained) {
    const start = retained.from < from ? retained.from : from; const end = retained.through > through ? retained.through : through;
    if (end <= addDays(start, 366)) { from = start; through = end; }
  }
  return { from, through };
}
