import type { LocalDate } from '../../domain/shared/types';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { calendarMonth } from './events.ts';

export interface CalendarMonthCache<T> {
  forDate(date: LocalDate): T;
  cachedMonthCount(): number;
}

/** Memoizes bounded month projections so repeated cells reuse one result. */
export function createCalendarMonthCache<T>(
  project: (from: LocalDate, through: LocalDate) => T,
  maximumCachedMonths = 12,
): CalendarMonthCache<T> {
  const cache = new Map<LocalDate, T>();
  const limit = Number.isFinite(maximumCachedMonths) ? Math.max(1, Math.floor(maximumCachedMonths)) : 12;

  return {
    forDate(date) {
      const key = calendarMonth(date);
      const cached = cache.get(key);
      if (cached !== undefined) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const through = addDays(calendarMonth(key, 1), -1);
      const value = project(key, through);
      cache.set(key, value);
      if (cache.size > limit) cache.delete(cache.keys().next().value!);
      return value;
    },
    cachedMonthCount() { return cache.size; },
  };
}
