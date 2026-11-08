import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import { compareDateOccurrence, type DateTask } from '../../domain/scheduling/date-tasks.ts';
import { completionCycleDate, completionMatchesEntry, completionRecordedDate, completionPeriod } from '../../domain/scheduling/completion-matching.ts';
import { addDays, weekdayOf } from '../../domain/scheduling/local-date.ts';
import { scopedDateTaskKey } from './task-mutations.ts';
import { orderTaskRows } from '../../domain/scheduling/task-row-order.ts';
import type { LoadOrder } from '../../domain/scheduling/task-priority';

export interface HomeTaskRow {
  key: string; source: 'personal' | 'shared'; task: DateTask; chore: ChoreDefinition; today: LocalDate;
}
export type HomeWeekScope = 'current' | 'next';
/** Today includes the final execution day. Undo uses the original window even before the refreshed plan arrives. */
export function isHomeTaskExpired(completed: boolean, windowEnd: LocalDate | undefined, today: LocalDate): boolean {
  return !completed && windowEnd !== undefined && windowEnd < today;
}
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
    recommendedDate: row.task.suggestedDate, windowStart: row.task.entry?.windowStart ?? row.task.completion?.scheduledWindowStart, windowEnd: row.task.entry?.windowEnd ?? row.task.completion?.scheduledWindowEnd, asOfDate: row.today }), order);
}

/** A window describes one occurrence, not one new chore on every available day. */
export function homeUpcomingTasks(entries: readonly ChoreScheduleEntry[], completions: readonly ChoreCompletion[],
  from: LocalDate, through: LocalDate, chores: readonly ChoreDefinition[]): DateTask[] {
  const active = new Map(chores.filter(chore => chore.enabled && !chore.archived).map(chore => [chore.id, chore.householdId]));
  type IndexedCompletion = { record: ChoreCompletion; index: number };
  const exact = new Map<string, IndexedCompletion>(); const legacy = new Map<string, IndexedCompletion[]>();
  completions.forEach((record, index) => {
    if (record.outcome !== 'completed') return;
    if (record.scheduleEntryId) {
      const key = JSON.stringify([record.choreId, record.scheduleEntryId]); if (!exact.has(key)) exact.set(key, { record, index });
    } else {
      const rows = legacy.get(record.choreId) ?? []; rows.push({ record, index }); legacy.set(record.choreId, rows);
    }
  });
  const occurrences = new Map<string, DateTask>();
  for (const entry of entries) {
    if (active.get(entry.choreId) !== entry.householdId) continue;
    const candidate = exact.get(JSON.stringify([entry.choreId, entry.id]));
    const older = legacy.get(entry.choreId)?.find(row => (!candidate || row.index < candidate.index) && completionMatchesEntry(row.record, entry));
    const completion = (older ?? candidate)?.record;
    // A later recommendation must not move an already recorded occurrence or
    // display it again beside the completion's original day in the group Home.
    const suggestedDate = completion?.scheduledDate ?? entry.suggestedDate;
    if (suggestedDate < from || suggestedDate > through) continue;
    occurrences.set(entry.id, { id: entry.id, choreId: entry.choreId, suggestedDate, entry, completion, completed: Boolean(completion) });
  }
  const recorded = new Set([...occurrences.values()].map(task => task.completion?.id));
  for (const completion of completions) {
    if (completion.outcome !== 'completed' || active.get(completion.choreId) !== completion.householdId || recorded.has(completion.id)) continue;
    const date = completion.scheduledDate ?? completionRecordedDate(completion);
    const key = completion.scheduleEntryId ?? `completed:${completion.id}`;
    if (date < from || date > through || occurrences.has(key)) continue;
    occurrences.set(key, { id: `completed:${completion.id}`, choreId: completion.choreId, suggestedDate: date, completed: true, completion });
  }
  // Like the day selector, Home shows one occurrence per chore/meaning/day.
  // A precompleted round and the real next round may share a recommendation;
  // retain both in storage, but never show two adjacent copies of that chore.
  const selected = new Map<string, DateTask>();
  const choice = (task: DateTask) => {
    const date = task.suggestedDate;
    const period = task.completion ? completionPeriod(task.completion) : task.entry ? { start: task.entry.windowStart, end: task.entry.windowEnd } : undefined;
    return { id: task.id, suggestedDate: date, completed: task.completed,
      completedOnDate: Boolean(task.completion && completionCycleDate(task.completion) === date),
      inWindow: Boolean(period && period.start <= date && date <= period.end) };
  };
  for (const task of occurrences.values()) {
    const key = JSON.stringify([task.choreId, task.suggestedDate, task.entry?.seasonalWork ?? task.completion?.seasonalWork ?? null]);
    const prior = selected.get(key);
    if (!prior || compareDateOccurrence(choice(task), choice(prior), task.suggestedDate) < 0) selected.set(key, task);
  }
  return [...selected.values()];
}
