import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import type { NextChoreWidgetSnapshot, TodayWidgetChore } from '@/features/widgets/contracts';
import { choreOccurrenceName } from '../../domain/chores/occurrence-name.ts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { sharedDateAtTime } from '../sharing/group-clock.ts';

export function createTodayWidgetSnapshot(
  entries: readonly ChoreScheduleEntry[],
  chores: readonly (Pick<ChoreDefinition, 'id' | 'name'> & Partial<Pick<ChoreDefinition, 'enabled' | 'archived'>>)[],
  completions: readonly ChoreCompletion[],
  today: LocalDate,
  updatedAt: string,
  timeZone?: string,
): NextChoreWidgetSnapshot {
  const tasks = selectDateTasks(entries, completions, today, 1, chores, true)
    .sort((left, right) => Number(left.completed) - Number(right.completed)
      || urgency(left.entry?.status ?? 'scheduled') - urgency(right.entry?.status ?? 'scheduled')
      || left.suggestedDate.localeCompare(right.suggestedDate));
  const byId = new Map(chores.map(chore => [chore.id, chore]));
  const unresolvedRows = tasks.map(task => {
    const chore = byId.get(task.choreId);
    return chore ? { id: task.id, name: choreOccurrenceName(chore.name, task.entry?.seasonalWork ?? task.completion?.seasonalWork), completed: task.completed } : null;
  });
  const rows = unresolvedRows.filter((row): row is TodayWidgetChore => row !== null);
  const visible = rows.slice(0, 3);
  const checkedRow = rows.find((row) => row.completed);
  // Keep a checkmark visible after completion even when three or more chores are still pending.
  if (checkedRow && visible.length === 3 && visible.every((row) => !row.completed)) visible[2] = checkedRow;

  return {
    chores: visible,
    remainingCount: Math.max(0, rows.length - 3),
    updatedAt: updatedAt as NextChoreWidgetSnapshot['updatedAt'],
    displayDate: today,
    ...(timeZone ? { displayTimeZone: timeZone } : {}),
    // Device-local midnight follows DST; a fixed 24-hour duration does not.
    contentUntil: timeZone ? sharedDateAtTime(addDays(today, 1), 0, 0, timeZone).getTime()
      : new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1).getTime(),
  };
}

function urgency(status: ChoreScheduleEntry['status']): number {
  if (status === 'overdue') return 0;
  if (status === 'inWindow') return 1;
  if (status === 'initialPending') return 2;
  return 3;
}
