import type { LocalDate } from '../../domain/shared/types';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { CalendarProjectionLimitError, compareOccurrences, indexCalendarOccurrences } from './events.ts';
import type { CalendarOccurrence } from './events.ts';
import { createCalendarMonthCache } from './month-cache.ts';

export interface CalendarMonthEventIndex {
  forDate(date: LocalDate): readonly CalendarOccurrence[];
  errorForDate(date: LocalDate): string | null;
  cachedMonthCount(): number;
}

interface Projection {
  byDate: Map<LocalDate, CalendarOccurrence[]>;
  error: string | null;
}

function failedProjection(cause: unknown): Projection {
  return { byDate: new Map(), error: cause instanceof Error ? cause.message : '予定を表示できません。' };
}

/**
 * Projects one calendar month on demand and retains only a small LRU of months.
 * The two-day projection margin preserves cross-midnight and time-zone shifts.
 */
export function createCalendarMonthEventIndex(
  project: (from: LocalDate, through: LocalDate) => readonly CalendarOccurrence[],
  maximumCachedMonths = 12,
): CalendarMonthEventIndex {
  const projectRange = (from: LocalDate, through: LocalDate): Projection => {
    const occurrences = project(addDays(from, -2), addDays(through, 2));
    return { byDate: indexCalendarOccurrences(occurrences, from, through), error: null };
  };
  type CachedMonth = { full: Projection } | { days: Map<LocalDate, Projection>; retainedCount: number };
  const cache = createCalendarMonthCache((from, through): CachedMonth => {
    try {
      return { full: projectRange(from, through) };
    } catch (cause) {
      if (cause instanceof CalendarProjectionLimitError) return { days: new Map(), retainedCount: 0 };
      return { full: failedProjection(cause) };
    }
  }, maximumCachedMonths);

  const projectDay = (day: LocalDate): Projection => {
    try {
      return projectRange(day, day);
    } catch (cause) {
      if (!(cause instanceof CalendarProjectionLimitError)) return failedProjection(cause);
    }
    // A busy neighbouring source date can overflow the timezone margin. Only
    // retain occurrences covering the requested display day, once per original slot.
    const occurrences = new Map<string, CalendarOccurrence>();
    try {
      for (let offset = -2; offset <= 2; offset++) {
        const sourceDay = addDays(day, offset);
        const rows = indexCalendarOccurrences(project(sourceDay, sourceDay), day, day).get(day) ?? [];
        for (const row of rows) occurrences.set(row.id, row);
        if (occurrences.size > CalendarProjectionLimitError.maximumOccurrences) throw new CalendarProjectionLimitError();
      }
      return { byDate: new Map([[day, [...occurrences.values()].sort(compareOccurrences)]]), error: null };
    } catch (cause) {
      return failedProjection(cause);
    }
  };
  const lookup = (day: LocalDate): Projection => {
    const month = cache.forDate(day);
    if ('full' in month) return month.full;
    const existing = month.days.get(day);
    if (existing) return existing;
    const result = projectDay(day);
    const count = result.byDate.get(day)?.length ?? 0;
    // A dense month must not retain twenty thousand occurrences for every day.
    while (month.retainedCount + count > CalendarProjectionLimitError.maximumOccurrences && month.days.size) {
      const [oldDay, old] = month.days.entries().next().value!;
      month.retainedCount -= old.byDate.get(oldDay)?.length ?? 0;
      month.days.delete(oldDay);
    }
    month.days.set(day, result);
    month.retainedCount += count;
    return result;
  };
  return {
    forDate(date) { return lookup(date).byDate.get(date) ?? []; },
    errorForDate(date) { return lookup(date).error; },
    cachedMonthCount() { return cache.cachedMonthCount(); },
  };
}
