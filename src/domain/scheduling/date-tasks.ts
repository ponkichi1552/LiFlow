import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import { calendarPendingCountsByDate } from '../calendar/day-entries.ts';
import { completionCycleDate, completionIncludesDate, completionMatchesEntry } from './completion-matching.ts';
import { addDays, daysBetween, localDateFromISODateTime } from './local-date.ts';
import { compareTaskKeys, compareTaskMinutes, taskPriority } from './task-priority.ts';
import type { LoadOrder } from './task-priority.ts';

export interface DateTask {
  /** Transient command routing for a composite home; never persisted in shared data. */
  completionScope?: 'personal' | 'shared';
  id: string;
  choreId: string;
  suggestedDate: LocalDate;
  completed: boolean;
  entry?: ChoreScheduleEntry;
  completion?: ChoreCompletion;
}

/** A recurring chore appears once per day, while its individual occurrences remain available in history. */
export function selectDateTasks(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[],
  date: LocalDate,
  graceDays = 0,
  chores?: readonly (Pick<ChoreDefinition, 'id'> & Partial<Pick<ChoreDefinition, 'enabled' | 'archived'>>)[],
): DateTask[] {
  const activeIds = chores ? new Set(chores.filter((chore) => chore.enabled !== false && !chore.archived).map((chore) => chore.id)) : undefined;
  const visibleCompletions = activeIds ? completions.filter((completion) => activeIds.has(completion.choreId)) : completions;
  const relevantCompletions = visibleCompletions.filter((completion) => completionIncludesDate(completion, date));
  const completionsByChore = new Map<string, ChoreCompletion[]>();
  for (const completion of visibleCompletions) {
    const bucket = completionsByChore.get(completion.choreId);
    if (bucket) bucket.push(completion); else completionsByChore.set(completion.choreId, [completion]);
  }
  const byChore = new Map<string, DateTask>();

  for (const entry of entries) {
    if (activeIds && !activeIds.has(entry.choreId)) continue;
    if (entry.windowStart > date || date > (graceDays === 0 ? entry.windowEnd : addDays(entry.windowEnd, graceDays))) continue;
    const completion = completionsByChore.get(entry.choreId)?.find((candidate) => completionMatchesEntry(candidate, entry));
    const task: DateTask = {
      id: entry.id, choreId: entry.choreId, suggestedDate: entry.suggestedDate,
      completed: Boolean(completion), entry, completion,
    };
    const previous = byChore.get(entry.choreId);
    if (!previous || compareOccurrence(task, previous, date) < 0) byChore.set(entry.choreId, task);
  }

  for (const completion of relevantCompletions) {
    const previous = byChore.get(completion.choreId);
    if (previous?.completion?.id === completion.id) continue;
    const task: DateTask = {
      id: `completed:${completion.id}`, choreId: completion.choreId,
      suggestedDate: completion.scheduledDate ?? localDateFromISODateTime(completion.completedAt),
      completed: true, completion,
    };
    // Today's real completion must remain visible even if recalculation created another overlapping cycle.
    if (!previous || compareOccurrence(task, previous, date) < 0) byChore.set(completion.choreId, task);
  }
  return [...byChore.values()];
}

function compareOccurrence(left: DateTask, right: DateTask, date: LocalDate): number {
  const completedOnDate = (task: DateTask) => Boolean(task.completion
    && completionCycleDate(task.completion) === date);
  const inWindow = (task: DateTask) => task.entry
    ? task.entry.windowStart <= date && date <= task.entry.windowEnd
    : Boolean(task.completion && completionIncludesDate(task.completion, date));
  return compareDateOccurrence({ ...left, completedOnDate: completedOnDate(left), inWindow: inWindow(left) },
    { ...right, completedOnDate: completedOnDate(right), inWindow: inWindow(right) }, date);
}

/** Shared and personal presentation select the same occurrence when periods overlap. */
export function compareDateOccurrence(left: { id: string; suggestedDate: LocalDate; completed: boolean; completedOnDate: boolean; inWindow: boolean },
  right: typeof left, date: LocalDate): number {
  return Number(right.completedOnDate) - Number(left.completedOnDate)
    || Number(right.suggestedDate === date) - Number(left.suggestedDate === date)
    || Number(right.inWindow) - Number(left.inWindow)
    || Math.abs(daysBetween(date, left.suggestedDate)) - Math.abs(daysBetween(date, right.suggestedDate))
    || right.suggestedDate.localeCompare(left.suggestedDate)
    || Number(right.completed) - Number(left.completed)
    || left.id.localeCompare(right.id);
}

export function orderDateTasks(
  tasks: readonly DateTask[],
  date: LocalDate,
  chores: readonly (Pick<ChoreDefinition, 'id' | 'load'> & Partial<Pick<ChoreDefinition, 'estimatedMinutes'>>)[],
  today: LocalDate = date,
  order?: LoadOrder,
): DateTask[] {
  const loadById = new Map(chores.map((chore) => [chore.id, chore.load]));
  const minutes = new Map(chores.map(chore => [chore.id, chore.estimatedMinutes]));
  const priority = (task: DateTask) => taskPriority({ completed: task.completed,
    load: loadById.get(task.choreId) ?? 'light', recommendedDate: task.suggestedDate,
    windowEnd: task.entry?.windowEnd ?? task.completion?.scheduledWindowEnd }, today, order);
  return [...tasks].sort((left, right) => priority(left) - priority(right)
    || (order ? compareTaskMinutes(minutes.get(left.choreId), minutes.get(right.choreId), order) : 0)
    || compareTaskKeys(left.choreId, right.choreId));
}

export function recommendedChoreCounts(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[] = [],
): Map<LocalDate, number> {
  return calendarPendingCountsByDate(entries, completions);
}
