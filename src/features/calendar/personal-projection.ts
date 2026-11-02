import type { PlannerSnapshot } from '../../platform/storage/repository.ts';
import type { ChoreCompletion } from '../../domain/chores/types.ts';
import type { DateTask } from '../../domain/scheduling/date-tasks.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { orderDateTasks, selectDateTasks } from '../../domain/scheduling/date-tasks.ts';
import { completionRecordedDate } from '../../domain/scheduling/completion-matching.ts';

/** Cache only derived rows in this snapshot/optimistic revision, never mutable app state. */
export function personalCalendarTasks(snapshot: PlannerSnapshot, today: LocalDate,
  project: (tasks: readonly DateTask[], completions: readonly ChoreCompletion[]) => DateTask[]) {
  const cache = new Map<LocalDate, DateTask[]>();
  return (date: LocalDate) => {
    let tasks = cache.get(date);
    if (!tasks) { tasks = orderDateTasks(project(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, date, 0, snapshot.chores), snapshot.completions)
      .filter(task => (task.completed && task.completion ? completionRecordedDate(task.completion) : task.suggestedDate) === date), date, snapshot.chores, today); cache.set(date, tasks); }
    return tasks;
  };
}
