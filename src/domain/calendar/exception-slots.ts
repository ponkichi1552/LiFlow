import { addDays, daysBetween } from '../scheduling/local-date.ts';
import type { LocalDate } from '../shared/types';
import { calendarEventAnchors, isCalendarAnchor, type CalendarEvent, type CalendarException } from './events.ts';

const lastDate = '9999-12-31' as LocalDate;
const step = (event: CalendarEvent) => event.recurrence === 'daily' ? 1 : event.recurrence === 'weekly' ? 7 : event.recurrence === 'biweekly' ? 14
  : event.recurrence === 'custom' && event.customRecurrence?.unit === 'day' ? event.customRecurrence.interval : 0;

/** Visit recurrence anchors in bounded windows so custom recurrence expansion stays capped. */
function walkAnchors(event: CalendarEvent, through: LocalDate, visit: (date: LocalDate, ordinal: number) => boolean) {
  const limit = event.untilDate && event.untilDate < through ? event.untilDate : through;
  let ordinal = 0;
  for (let from = event.startDate; from <= limit;) {
    const end = daysBetween(from, limit) > 365 ? addDays(from, 365) : limit;
    for (const date of calendarEventAnchors(event, from, end)) {
      if (visit(date, ordinal++)) return;
    }
    if (end === limit || event.recurrence === 'none') return;
    from = addDays(end, 1);
  }
}

/** Carry occurrence slots through a moved series, preserving input order and duplicates. */
export function rebasedCalendarExceptionDates(previous: CalendarEvent, next: CalendarEvent, anchors: readonly LocalDate[]): LocalDate[] {
  if (!anchors.length) return [];
  if (previous.startDate === next.startDate) return [...anchors];

  const ordered = [...new Set(anchors)].sort();
  const ordinals = new Map<LocalDate, number>();
  const previousStep = step(previous);
  if (previousStep) {
    for (const anchor of ordered) if (isCalendarAnchor(previous, anchor)) {
      ordinals.set(anchor, daysBetween(previous.startDate, anchor) / previousStep);
    }
  } else {
    const sourceAnchors = ordered.filter(anchor => isCalendarAnchor(previous, anchor));
    let target = 0;
    if (sourceAnchors.length) {
      const finalSource = sourceAnchors.at(-1)!;
      walkAnchors(previous, finalSource, (date, ordinal) => {
        while (target < sourceAnchors.length && sourceAnchors[target] < date) target++;
        if (sourceAnchors[target] === date) { ordinals.set(date, ordinal); target++; }
        return target >= sourceAnchors.length;
      });
    }
  }

  const resultByAnchor = new Map<LocalDate, LocalDate>();
  const nextStep = step(next);
  if (nextStep) {
    const availableDays = daysBetween(next.startDate, next.untilDate ?? lastDate);
    for (const [anchor, ordinal] of ordinals) {
      if (ordinal * nextStep > availableDays) continue;
      resultByAnchor.set(anchor, addDays(next.startDate, ordinal * nextStep));
    }
  } else if (ordinals.size) {
    const pending = new Map<number, LocalDate>();
    for (const [anchor, ordinal] of ordinals) pending.set(ordinal, anchor);
    walkAnchors(next, next.untilDate ?? lastDate, (date, ordinal) => {
      const anchor = pending.get(ordinal);
      if (anchor) { resultByAnchor.set(anchor, date); pending.delete(ordinal); }
      return pending.size === 0;
    });
  }

  return anchors.map(anchor => resultByAnchor.get(anchor) ?? anchor);
}

/** Carry one occurrence slot with a moved series; its explicit body stays untouched. */
export function rebasedCalendarExceptionDate(previous: CalendarEvent, next: CalendarEvent, anchor: LocalDate): LocalDate {
  return rebasedCalendarExceptionDates(previous, next, [anchor])[0];
}

/** The optimistic projection uses the same slots as storage, without changing edited bodies. */
export function rebasedCalendarExceptions(previous: CalendarEvent, next: CalendarEvent, exceptions: readonly CalendarException[]): CalendarException[] {
  const anchors = exceptions.filter(row => row.eventId === previous.id).map(row => row.anchorDate);
  const dates = rebasedCalendarExceptionDates(previous, next, anchors);
  let matched = 0;
  return exceptions.map(row => {
    if (row.eventId !== previous.id) return row;
    const anchorDate = dates[matched++];
    return { ...row, anchorDate, detached: !isCalendarAnchor(next, anchorDate) };
  });
}
