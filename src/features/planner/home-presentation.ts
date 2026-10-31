import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import type { DateTask } from '../../domain/scheduling/date-tasks';
import { completionMatchesEntry } from '../../domain/scheduling/completion-matching.ts';
import { addDays, localDateFromISODateTime, weekdayOf } from '../../domain/scheduling/local-date.ts';
import { scopedDateTaskKey } from './task-mutations.ts';
import { orderTaskRows } from '../../domain/scheduling/task-row-order.ts';
import type { LoadOrder } from '../../domain/scheduling/task-priority';

export interface HomeTaskRow {
  key: string; source: 'personal' | 'shared'; task: DateTask; chore: ChoreDefinition; today: LocalDate;
}
export type HomeWeekScope = 'current' | 'next';
export function homeUpcomingRange(today: LocalDate, scope: HomeWeekScope) {
  const end = addDays(today, 7 - weekdayOf(today));
  return scope === 'current' ? { from: addDays(today, 1), through: end }
    : { from: addDays(end, 1), through: addDays(end, 7) };
}

/** Never merge definitions by chore ID: built-in IDs can be equal in separate databases. */
export function homeTaskRows(tasks: readonly DateTask[], chores: readonly ChoreDefinition[], source: HomeTaskRow['source'], today: LocalDate): HomeTaskRow[] {
  const byId = new Map(chores.map(chore => [chore.id, chore]));
  return tasks.flatMap(task => {
    const chore = byId.get(task.choreId);
    const householdId = task.entry?.householdId ?? task.completion?.householdId;
    const scoped = { ...task, completionScope: source };
    return chore && chore.householdId === householdId ? [{ key: scopedDateTaskKey(scoped), source, task: scoped, chore, today }] : [];
  });
}

export function orderHomeTaskRows(rows: readonly HomeTaskRow[], today: LocalDate, order: LoadOrder) {
  return orderTaskRows(rows, today, row => ({ completed: row.task.completed, load: row.chore.load, estimatedMinutes: row.chore.estimatedMinutes,
    recommendedDate: row.task.suggestedDate, windowEnd: row.task.entry?.windowEnd ?? row.task.completion?.scheduledWindowEnd, asOfDate: row.today }), order);
}

/** A window describes one occurrence, not one new chore on every available day. */
export function homeUpcomingTasks(entries: readonly ChoreScheduleEntry[], completions: readonly ChoreCompletion[],
  from: LocalDate, through: LocalDate, chores: readonly ChoreDefinition[]): DateTask[] {
  const active = new Map(chores.filter(chore => chore.enabled && !chore.archived).map(chore => [chore.id, chore.householdId]));
  const occurrences = new Map<string, DateTask>();
  for (const entry of entries) {
    if (active.get(entry.choreId) !== entry.householdId || entry.suggestedDate < from || entry.suggestedDate > through) continue;
    const completion = completions.find(record => completionMatchesEntry(record, entry));
    occurrences.set(entry.id, { id: entry.id, choreId: entry.choreId, suggestedDate: entry.suggestedDate, entry, completion, completed: Boolean(completion) });
  }
  const recorded = new Set([...occurrences.values()].map(task => task.completion?.id));
  for (const completion of completions) {
    if (completion.outcome !== 'completed' || active.get(completion.choreId) !== completion.householdId || recorded.has(completion.id)) continue;
    const date = completion.scheduledDate ?? localDateFromISODateTime(completion.completedAt);
    const key = completion.scheduleEntryId ?? `completed:${completion.id}`;
    if (date < from || date > through || occurrences.has(key)) continue;
    occurrences.set(key, { id: `completed:${completion.id}`, choreId: completion.choreId, suggestedDate: date, completed: true, completion });
  }
  return [...occurrences.values()];
}
