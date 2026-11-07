import type { LocalCalendarSnapshot } from '../../platform/storage/calendar-events';

/** Saved calendar inputs are plain records. Stop at the first changed value;
 * don't allocate two complete JSON copies of every event on each refresh. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  const keys = Object.keys(a); if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** Drafts and refresh status do not change saved-event recurrence or availability. */
export function retainCalendarInputs(previous: LocalCalendarSnapshot, next: LocalCalendarSnapshot): LocalCalendarSnapshot {
  const same = <T>(left: T[], right: T[]) => sameValue(left, right) ? left : right;
  return { ...next, events: same(previous.events, next.events), exceptions: same(previous.exceptions, next.exceptions),
    categories: same(previous.categories, next.categories) };
}
