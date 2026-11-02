import { addDays } from '../../domain/scheduling/local-date.ts';
import type { ExternalAvailabilityByDate } from '../../domain/scheduling/contracts.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { projectPrivateCalendarEvents } from './private-event-projection.ts';
import type { CalendarEvent, CalendarException } from './events.ts';
import { aggregateBusyMinutes, createCalendarQueryRange } from '../google-sync/calendar-availability.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';

/** Union absolute intervals; wall clocks alone lose the repeated hour at a DST transition. */
export function localCalendarAvailability(events: readonly CalendarEvent[], exceptions: readonly CalendarException[], from: LocalDate, through: LocalDate, timeZone: string): ExternalAvailabilityByDate | undefined {
  const rows = projectPrivateCalendarEvents(events, exceptions, addDays(from, -2), addDays(through, 2));
  const intervals: { start: string; end: string }[] = [];
  for (const row of rows) {
    if (row.birthday || row.blocksTime === false || row.timeIssue) continue;
    if (row.allDay) {
      // All-day dates retain their original civil dates in the viewer's region.
      const range = createCalendarQueryRange(row.startDate, row.endDate, timeZone);
      intervals.push({ start: range.timeMin, end: range.timeMax });
    } else {
      const instant = (date: LocalDate, minute: number) => v2WallTimeCandidates({ date, hour: Math.floor(minute / 60), minute: minute % 60, timeZone: row.timeZone })[0];
      intervals.push({ start: new Date(instant(row.startDate, row.startMinute)).toISOString(), end: new Date(instant(row.endDate, row.endMinute)).toISOString() });
    }
  }
  if (!intervals.length) return undefined;
  const result = aggregateBusyMinutes(intervals, createCalendarQueryRange(from, through, timeZone), '1970-01-01T00:00:00Z')
    .filter(day => day.busyMinutes > 0).map(day => [day.localDate, { busyMinutes: day.busyMinutes }]);
  return result.length ? Object.fromEntries(result) : undefined;
}
export function combineCalendarAvailability(google: ExternalAvailabilityByDate | undefined, local: ExternalAvailabilityByDate | undefined): ExternalAvailabilityByDate | undefined {
  if (!local) return google; if (!google) return local;
  return Object.fromEntries([...new Set([...Object.keys(google), ...Object.keys(local)])].map(date => [date, { busyMinutes: Math.max(google[date as LocalDate]?.busyMinutes ?? 0, local[date as LocalDate]?.busyMinutes ?? 0) }]));
}
