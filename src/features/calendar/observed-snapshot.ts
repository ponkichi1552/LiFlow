import type { LocalCalendarSnapshot } from '../../platform/storage/calendar-events';

/** Drafts and refresh status do not change saved-event recurrence or availability. */
export function retainCalendarInputs(previous: LocalCalendarSnapshot, next: LocalCalendarSnapshot): LocalCalendarSnapshot {
  const same = <T>(left: T[], right: T[]) => left === right || JSON.stringify(left) === JSON.stringify(right) ? left : right;
  return { ...next, events: same(previous.events, next.events), exceptions: same(previous.exceptions, next.exceptions),
    categories: same(previous.categories, next.categories) };
}
