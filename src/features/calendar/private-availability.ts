import { addDays } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { sharedLocalDate } from '../sharing/group-clock.ts';
import { fixedInterval } from '../sharing/v2/date-target.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import { createIntervalCalendarAvailability } from '../sharing/v2/private-availability.ts';
import type { PrivateCalendarAvailability } from '../sharing/v2/private-availability.ts';
import { projectPrivateCalendarEvents } from './private-event-projection.ts';
import type { CalendarEvent, CalendarException } from './events.ts';
import { localDayBoundary } from './local-day-boundary.ts';

/** App events stay in personal SQLite. Only a local availability reader reaches shared-plan UI. */
export function createLocalCalendarAvailability(events: readonly CalendarEvent[], exceptions: readonly CalendarException[], range: { from: LocalDate; through: LocalDate }, timeZone: string): PrivateCalendarAvailability {
  const coverage = { start: localDayBoundary(range.from, timeZone), end: localDayBoundary(addDays(range.through, 1), timeZone) };
  const intervals: { start: number; end: number }[] = [];
  const uncertain: { from: LocalDate; through: LocalDate }[] = [];
  for (const row of projectPrivateCalendarEvents(events, exceptions, addDays(range.from, -2), addDays(range.through, 2))) {
    if (row.birthday || row.blocksTime === false) continue;
    if (row.allDay) {
      const start = localDayBoundary(row.startDate, timeZone); const end = localDayBoundary(addDays(row.endDate, 1), timeZone);
      if (start < end) intervals.push({ start, end });
      continue;
    }
    if (row.timeIssue) { uncertain.push({ from: addDays(row.startDate, -2), through: addDays(row.endDate, 2) }); continue; }
    // All-day dates retain their civil date in the displayed workspace, as in the calendar UI.
    const clock = (date: LocalDate, minute: number) => v2WallTimeCandidates({ date, hour: Math.floor(minute / 60), minute: minute % 60, timeZone: row.timeZone });
    const start = clock(row.startDate, row.startMinute);
    const end = clock(row.endDate, row.endMinute);
    if (!start.length || !end.length) { uncertain.push({ from: row.startDate, through: row.endDate }); continue; }
    intervals.push({ start: start[0], end: end.at(-1)! });
  }
  const read = createIntervalCalendarAvailability(intervals, coverage);
  const availability: PrivateCalendarAvailability = target => {
    const value = read(target);
    if (value.conflict.kind !== 'clear' || !uncertain.length) return value;
    const interval = fixedInterval(target)!;
    const from = sharedLocalDate(new Date(interval.start), timeZone); const through = sharedLocalDate(new Date(interval.end - 1), timeZone);
    return uncertain.some(row => row.from <= through && row.through >= from) ? { conflict: { kind: 'unknown', reason: 'invalid' }, busyMinutes: null } : value;
  };
  availability.ranges = read.ranges; return availability;
}

/** A form check reads its exact range rather than reusing a stale month projection. */
export function localCalendarTargetRange(target: Parameters<PrivateCalendarAvailability>[0], timeZone: string) {
  const interval = fixedInterval(target);
  return interval ? { from: sharedLocalDate(new Date(interval.start), timeZone), through: sharedLocalDate(new Date(interval.end - 1), timeZone) } : null;
}

/** Same account guard and projection for foreground UI and background native integrations. */
export function createLocalCalendarPlanSource(input: { ownerUserId: string; assertAccess: () => void | Promise<void>;
  read: () => Promise<{ events: CalendarEvent[]; exceptions: CalendarException[] }> }) {
  const readForPlan = async (range: { from: LocalDate; through: LocalDate }, timeZone: string) => {
    await input.assertAccess(); const value = await input.read(); await input.assertAccess();
    return { ownerUserId: input.ownerUserId, availability: createLocalCalendarAvailability(value.events, value.exceptions, range, timeZone) };
  };
  return { readForPlan, async readOwnCalendar(target: Parameters<PrivateCalendarAvailability>[0], timeZone?: string) {
    await input.assertAccess(); if (target.precision !== 'interval') return { kind: 'unknown' as const, reason: 'timeNotSpecified' as const };
    if (!timeZone) throw new Error('共有予定の地域を読み直してください。');
    const range = localCalendarTargetRange(target, timeZone)!;
    return (await readForPlan(range, timeZone)).availability(target).conflict;
  } };
}
