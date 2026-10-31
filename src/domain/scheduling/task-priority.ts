import type { ChoreLoad } from '../chores/types';
import type { LocalDate } from '../shared/types';
import { daysBetween } from './local-date.ts';

export interface TaskPriority {
  completed: boolean;
  load: ChoreLoad;
  recommendedDate: LocalDate;
  windowEnd?: LocalDate;
}
export type LoadOrder = 'heavy' | 'light';

/** A tie within one load tier; an unknown duration never pretends to be zero. */
export function compareTaskMinutes(left: number | undefined, right: number | undefined, order: LoadOrder): number {
  const a = Number.isFinite(left) && left! > 0; const b = Number.isFinite(right) && right! > 0;
  if (a !== b) return a ? -1 : 1;
  return a && b ? order === 'heavy' ? right! - left! : left! - right! : 0;
}

export const compareTaskKeys = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Presentation only. The shared Scheduler's dates and occurrence identities stay unchanged. */
export function isTaskUrgent(task: TaskPriority, today: LocalDate): boolean {
  return !task.completed && task.recommendedDate < today && task.windowEnd !== undefined
    && task.windowEnd >= today
    && daysBetween(today, task.windowEnd) <= 2;
}

export function taskPriority(task: TaskPriority, today: LocalDate, order: LoadOrder = 'heavy'): number {
  // Past-due work keeps its established ordering, without receiving the still-in-window attention label.
  const pastDue = task.recommendedDate < today && task.windowEnd !== undefined && task.windowEnd < today;
  const tier = task.completed ? 2 : isTaskUrgent(task, today) || pastDue ? 0 : 1;
  const load = task.load === 'heavy' ? 0 : task.load === 'normal' ? 1 : 2;
  return tier * 3 + (order === 'light' ? 2 - load : load);
}
