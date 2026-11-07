import type { ChoreCompletion } from '../../domain/chores/types';
import { localDateFromISODateTime } from '../../domain/scheduling/local-date.ts';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';

/** Select recent records before truncation using instants, not RFC3339 spellings. */
export const compareCompletionInstants = (a: ChoreCompletion, b: ChoreCompletion) =>
  Date.parse(b.completedAt) - Date.parse(a.completedAt) || a.id.localeCompare(b.id);

/** Frozen recording dates survive travel; old records follow the displayed owner region. */
export function completionHistoryDay(row: ChoreCompletion, timeZone?: string) {
  return row.completedLocalDate ?? (timeZone ? pinnedClockAt(Date.parse(row.completedAt), timeZone).date : localDateFromISODateTime(row.completedAt));
}
