import type { LocalDate } from '../shared/types';
import { monthDates, parseLocalDate } from '../scheduling/local-date.ts';

/** One calendar month, clamping e.g. March 31 to February's final day. */
export function choreHistoryCutoff(today: LocalDate): LocalDate {
  const date = parseLocalDate(today); const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const days = monthDates(previous.getUTCFullYear(), previous.getUTCMonth());
  return days[Math.min(date.getUTCDate(), days.length) - 1];
}
export function personalChoreHistoryCutoffInstant(today: LocalDate): string {
  const date = parseLocalDate(choreHistoryCutoff(today));
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).toISOString();
}
