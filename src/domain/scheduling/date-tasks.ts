import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import { calendarPendingCountsByDate } from '../calendar/day-entries.ts';
import { completionCycleDate, completionIncludesDate, completionMatchesEntry, completionPeriod, completionRecordedDate, completionWasRecordedBeforeWindow } from './completion-matching.ts';
import { addDays, daysBetween } from './local-date.ts';
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
  includeRetainedOverdue = false,
): DateTask[] {
  return createDateTaskSelector(entries, completions, chores)(date, graceDays, includeRetainedOverdue);
}

/** One immutable snapshot/optimistic revision owns this reusable lookup. */
export function createDateTaskSelector(entries: readonly ChoreScheduleEntry[], completions: readonly ChoreCompletion[],
  chores?: readonly (Pick<ChoreDefinition, 'id'> & Partial<Pick<ChoreDefinition, 'enabled' | 'archived'>>)[]) {
  const activeIds = chores ? new Set(chores.filter((chore) => chore.enabled !== false && !chore.archived).map((chore) => chore.id)) : undefined;
  const visibleCompletions = activeIds ? completions.filter((completion) => activeIds.has(completion.choreId)) : completions;
  type IndexedCompletion = { completion: ChoreCompletion; index: number };
  const completionsByChore = new Map<string, { exact: Map<string, IndexedCompletion>; legacy: IndexedCompletion[] }>();
  for (let index = 0; index < visibleCompletions.length; index++) {
    const completion = visibleCompletions[index]; if (completion.outcome !== 'completed') continue;
    let bucket = completionsByChore.get(completion.choreId);
    if (!bucket) { bucket = { exact: new Map(), legacy: [] }; completionsByChore.set(completion.choreId, bucket); }
    const id = completion.scheduleEntryId;
    if (id) { if (!bucket.exact.has(id)) bucket.exact.set(id, { completion, index }); }
    else bucket.legacy.push({ completion, index });
  }
  // The selector belongs to one immutable revision. Freeze date geometry once;
  // asking for another calendar cell must not reparse every historical instant.
  const displayPeriods = visibleCompletions.filter(completion => completion.outcome === 'completed').map(completion => ({
    completion, ...completionPeriod(completion),
    recordedDate: completionWasRecordedBeforeWindow(completion) ? null : completionRecordedDate(completion),
  }));
  return (date: LocalDate, graceDays = 0, includeRetainedOverdue = false): DateTask[] => {
  const relevantCompletions = displayPeriods.filter(period => date >= period.start && date <= period.end || period.recordedDate === date)
    .map(period => period.completion);
  const byChore = new Map<string, DateTask>();
  const meaningKey = (choreId: string, work?: ChoreScheduleEntry['seasonalWork']) => work ? JSON.stringify([choreId, work]) : choreId;

  for (const entry of entries) {
    if (activeIds && !activeIds.has(entry.choreId)) continue;
    const retained = includeRetainedOverdue && entry.status === 'overdue' && (entry.id.startsWith('personal-round.') || entry.id.startsWith('seasonal-round.'));
    if (entry.windowStart > date || !retained && date > (graceDays === 0 ? entry.windowEnd : addDays(entry.windowEnd, graceDays))) continue;
    const bucket = completionsByChore.get(entry.choreId); const exact = bucket?.exact.get(entry.id);
    const legacy = bucket?.legacy.find(candidate => candidate.index < (exact?.index ?? Infinity) && completionMatchesEntry(candidate.completion, entry));
    const completion = legacy?.completion ?? exact?.completion;
    const task: DateTask = {
      id: entry.id, choreId: entry.choreId, suggestedDate: entry.suggestedDate,
      completed: Boolean(completion), entry, completion,
    };
    const key = meaningKey(entry.choreId, entry.seasonalWork); const previous = byChore.get(key);
    if (!previous || compareOccurrence(task, previous, date) < 0) byChore.set(key, task);
  }

  for (const completion of relevantCompletions) {
    const key = meaningKey(completion.choreId, completion.seasonalWork); const previous = byChore.get(key);
    if (previous?.completion?.id === completion.id) continue;
    const task: DateTask = {
      id: `completed:${completion.id}`, choreId: completion.choreId,
      suggestedDate: completion.scheduledDate ?? completionRecordedDate(completion),
      completed: true, completion,
    };
    // Today's real completion must remain visible even if recalculation created another overlapping cycle.
    if (!previous || compareOccurrence(task, previous, date) < 0) byChore.set(key, task);
  }
  return [...byChore.values()];
  };
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
    windowStart: task.entry?.windowStart ?? task.completion?.scheduledWindowStart, windowEnd: task.entry?.windowEnd ?? task.completion?.scheduledWindowEnd }, today, order);
  return tasks.map(task => ({ task, priority: priority(task), minutes: minutes.get(task.choreId) }))
    .sort((left, right) => left.priority - right.priority
      || (order ? compareTaskMinutes(left.minutes, right.minutes, order) : 0)
      || compareTaskKeys(left.task.choreId, right.task.choreId)).map(row => row.task);
}

export function recommendedChoreCounts(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[] = [],
): Map<LocalDate, number> {
  return calendarPendingCountsByDate(entries, completions);
}
