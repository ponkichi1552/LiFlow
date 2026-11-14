import { addDays, daysBetween } from '../scheduling/local-date.ts';
import type { LocalDate } from '../shared/types';
import { calendarEventAnchors, isCalendarAnchor, type CalendarEvent, type CalendarException } from './events.ts';

const lastDate = '9999-12-31' as LocalDate;

/** Carry the occurrence slot with a moved series; its explicit body stays untouched. */
export function rebasedCalendarExceptionDate(previous: CalendarEvent, next: CalendarEvent, anchor: LocalDate): LocalDate {
  if (previous.startDate === next.startDate || !isCalendarAnchor(previous, anchor)) return anchor;
  const step = (event: CalendarEvent) => event.recurrence === 'daily' ? 1 : event.recurrence === 'weekly' ? 7 : event.recurrence === 'biweekly' ? 14
    : event.recurrence === 'custom' && event.customRecurrence?.unit === 'day' ? event.customRecurrence.interval : 0;
  const ordinal = (event: CalendarEvent, through: LocalDate) => {
    let count = 0;
    for (let from = event.startDate; from <= through;) {
      const end = daysBetween(from, through) > 365 ? addDays(from, 365) : through;
      count += calendarEventAnchors(event, from, end).length;
      if (end === through) break;
      from = addDays(end, 1);
    }
    return count - 1;
  };
  let remaining = step(previous) ? daysBetween(previous.startDate, anchor) / step(previous) : ordinal(previous, anchor);
  if (step(next)) {
    if (remaining * step(next) > daysBetween(next.startDate, lastDate)) return anchor;
    const date = addDays(next.startDate, remaining * step(next));
    return next.untilDate && date > next.untilDate ? anchor : date;
  }
  const limit = next.untilDate ?? lastDate;
  for (let from = next.startDate; from <= limit;) {
    const end = daysBetween(from, limit) > 365 ? addDays(from, 365) : limit;
    const dates = calendarEventAnchors(next, from, end);
    if (remaining < dates.length) return dates[remaining];
    remaining -= dates.length;
    if (end === limit || next.recurrence === 'none') break;
    from = addDays(end, 1);
  }
  // A shortened series keeps the edited occurrence as a detached explicit date.
  return anchor;
}

/** The optimistic projection uses the same slots as storage, without changing edited bodies. */
export function rebasedCalendarExceptions(previous: CalendarEvent, next: CalendarEvent, exceptions: readonly CalendarException[]): CalendarException[] {
  return exceptions.map(row => {
    if (row.eventId !== previous.id) return row;
    const anchorDate = rebasedCalendarExceptionDate(previous, next, row.anchorDate);
    return { ...row, anchorDate, detached: !isCalendarAnchor(next, anchorDate) };
  });
}
