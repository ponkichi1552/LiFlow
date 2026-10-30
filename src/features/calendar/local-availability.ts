import { addDays } from '../../domain/scheduling/local-date.ts';
import type { ExternalAvailabilityByDate } from '../../domain/scheduling/contracts.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { calendarEventsInTimeZone, projectCalendarEvents } from './events.ts';
import type { CalendarEvent, CalendarException } from './events.ts';

/** Union exact local intervals first. An unknown Google aggregate must not be added a second time. */
export function localCalendarAvailability(events: readonly CalendarEvent[], exceptions: readonly CalendarException[], from: LocalDate, through: LocalDate, timeZone: string): ExternalAvailabilityByDate | undefined {
  const rows = calendarEventsInTimeZone(projectCalendarEvents(events, exceptions, addDays(from, -2), addDays(through, 2)), timeZone);
  const days = new Map<LocalDate, { start: number; end: number }[]>();
  for (const row of rows) {
    if (row.birthday || row.timeIssue) continue;
    for (let date = row.startDate < from ? from : row.startDate; date <= row.endDate && date <= through; date = addDays(date, 1)) {
      const start = row.allDay || date > row.startDate ? 0 : row.startMinute; const end = row.allDay || date < row.endDate ? 1440 : row.endMinute;
      if (end <= start) continue; const intervals = days.get(date) ?? []; intervals.push({ start, end }); days.set(date, intervals);
    }
  }
  const result: Partial<Record<LocalDate, { busyMinutes: number }>> = {};
  for (const [date, rows] of days) {
    rows.sort((a, b) => a.start - b.start); let throughMinute = -1, total = 0;
    for (const row of rows) { total += Math.max(0, row.end - Math.max(throughMinute, row.start)); throughMinute = Math.max(throughMinute, row.end); }
    result[date] = { busyMinutes: total };
  }
  return Object.keys(result).length ? result : undefined;
}
export function combineCalendarAvailability(google: ExternalAvailabilityByDate | undefined, local: ExternalAvailabilityByDate | undefined): ExternalAvailabilityByDate | undefined {
  if (!local) return google; if (!google) return local;
  return Object.fromEntries([...new Set([...Object.keys(google), ...Object.keys(local)])].map(date => [date, { busyMinutes: Math.max(google[date as LocalDate]?.busyMinutes ?? 0, local[date as LocalDate]?.busyMinutes ?? 0) }]));
}
