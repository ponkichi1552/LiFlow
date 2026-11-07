import type { ChoreCompletion, ChoreScheduleEntry } from '@/domain/chores/types';
import { completionMatchesEntry } from '../scheduling/completion-matching.ts';
import type { LocalDate } from '@/domain/shared/types';

export function calendarEntriesOnDate(entries: readonly ChoreScheduleEntry[], date: LocalDate): ChoreScheduleEntry[] {
  return entries.filter((entry) => entry.windowStart <= date && date <= entry.windowEnd);
}

export function calendarPendingCountsByDate(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[],
): Map<LocalDate, number> {
  return new Map([...calendarPendingChoreIdsByDate(entries, completions)].map(([date, chores]) => [date, chores.size]));
}

/** Keep occurrence matching and per-chore deduplication shared with immediate UI feedback. */
export function calendarPendingChoreIdsByDate(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[],
  completedOverrides?: ReadonlyMap<string, boolean>,
): Map<LocalDate, Set<string>> {
  const choresByDate = new Map<LocalDate, Set<string>>();
  const completedEntryIds = new Set(completions
    .filter((completion) => completion.outcome === 'completed' && completion.scheduleEntryId)
    .map((completion) => completion.scheduleEntryId));
  const legacyByChore = new Map<string, ChoreCompletion[]>();
  for (const completion of completions) if (!completion.scheduleEntryId && completion.outcome === 'completed') {
    const id = completion.choreId; const rows = legacyByChore.get(id) ?? []; rows.push(completion); legacyByChore.set(id, rows);
  }
  for (const entry of entries) {
    if (completedOverrides?.get(entry.id) ?? (completedEntryIds.has(entry.id)
      || legacyByChore.get(entry.choreId)?.some((completion) => completionMatchesEntry(completion, entry)))) continue;
    const chores = choresByDate.get(entry.suggestedDate) ?? new Set<string>();
    chores.add(entry.choreId);
    choresByDate.set(entry.suggestedDate, chores);
  }
  return choresByDate;
}
