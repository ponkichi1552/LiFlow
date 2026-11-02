import type { DateTask } from './date-tasks';
import type { LocalDate } from '../shared/types';

/** A displayed selection, rather than an entry supplied by another workspace. */
export interface PersonalDateTaskCommand {
  date: LocalDate;
  graceDays: 0 | 3;
  choreId: string;
  revision: string;
  completed: boolean;
}

/** Changing the selected occurrence or completion invalidates an old checkbox. */
export function dateTaskRevision(task: DateTask): string {
  return JSON.stringify([task.id, task.choreId, task.suggestedDate, task.completed,
    task.entry?.householdId, task.entry?.cycleBaseDate, task.entry?.windowStart, task.entry?.windowEnd,
    task.completion?.id, task.completion?.completedAt, task.completion?.completedLocalDate,
    task.completion?.scheduleEntryId, task.completion?.scheduledDate,
    task.completion?.scheduledWindowStart, task.completion?.scheduledWindowEnd]);
}

/** Never attach Undo to a different cycle selected by a later recalculation. */
export function sameOccurrenceAfterCompletion(before: string, after: string): boolean {
  try {
    const a = JSON.parse(before); const b = JSON.parse(after);
    return Array.isArray(a) && Array.isArray(b) && a.length === 15 && b.length === 15
      && a[3] === false && b[3] === true && a[1] === b[1] && a[0] === b[11]
      && a[2] === b[12] && typeof b[8] === 'string';
  } catch { return false; }
}

/** A queued gesture follows the same cycle through completion/undo, never a
 * different overlapping cycle selected by a later refresh or edited window.
 * The recommended day may move inside that unchanged cycle.
 */
export function dateTaskOccurrenceReference(revision: string): string | null {
  try {
    const value = JSON.parse(revision);
    if (!Array.isArray(value) || value.length !== 15 || typeof value[1] !== 'string' || typeof value[3] !== 'boolean') return null;
    const id = value[3] ? value[11] ?? value[0] : value[0];
    const start = value[3] ? value[13] : value[6], end = value[3] ? value[14] : value[7];
    if (typeof id !== 'string' || !id || start != null && typeof start !== 'string' || end != null && typeof end !== 'string') return null;
    return JSON.stringify([value[1], id, start ?? null, end ?? null]);
  } catch { return null; }
}
export function sameDateTaskOccurrence(before: string, after: string): boolean {
  const expected = dateTaskOccurrenceReference(before);
  return expected !== null && expected === dateTaskOccurrenceReference(after);
}
