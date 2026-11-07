import type { DateTask } from '../../domain/scheduling/date-tasks';
import type { ChoreCompletion, ChoreScheduleEntry } from '../../domain/chores/types';
import { calendarPendingChoreIdsByDate, calendarPendingCountsByDate } from '../../domain/calendar/day-entries.ts';
import { completionMatchesEntry, completionPeriod } from '../../domain/scheduling/completion-matching.ts';

export const dateTaskKey = (task: DateTask) => task.completion?.scheduleEntryId ?? task.entry?.id ?? task.id;
export const scopedDateTaskKey = (task: DateTask) => JSON.stringify([task.completionScope, task.entry?.householdId ?? task.completion?.householdId, dateTaskKey(task)]);

function hasOtherCompletion(target: DateTask | undefined, completions: readonly ChoreCompletion[]) {
  const original = target?.completion; if (!target || !original) return false;
  return completions.some(record => {
    if (record.id === original.id || record.outcome !== 'completed' || record.choreId !== target.choreId || record.householdId !== original.householdId) return false;
    if (target.entry) return completionMatchesEntry(record, target.entry);
    if (record.scheduleEntryId && original.scheduleEntryId) return record.scheduleEntryId === original.scheduleEntryId;
    const period = completionPeriod(record); const expected = completionPeriod(original);
    return record.scheduledDate === original.scheduledDate && period.start === expected.start && period.end === expected.end;
  });
}

export interface TaskUndoReceipt { undoTask: DateTask; undo(): Promise<unknown>; keepChecked?: boolean }

/** An immediate view overlay, never a second source of stored completion history. */
export function createTaskMutations(dependencies: {
  write(task: DateTask): Promise<unknown>;
  refresh(task?: DateTask): Promise<void>;
  isCurrent(): boolean;
  key?(task: DateTask): string;
}) {
  const taskKey = dependencies.key ?? dateTaskKey;
  let live = true;
  const current = () => live && dependencies.isCurrent();
  let state = { overrides: new Map<string, boolean>(), pending: new Set<string>(), error: null as string | null, requiresReload: false, reading: false, undoAvailable: false };
  let undoReceipt: TaskUndoReceipt | undefined;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let command = 0;
  const clearUndo = () => { clearTimeout(undoTimer); undoTimer = undefined; undoReceipt = undefined; state = { ...state, undoAvailable: false }; };
  const targets = new Map<string, DateTask>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const fn of listeners) try { fn(); } catch { /* A failed view observer cannot prevent a stored change. */ } };
  const completionsAfterUndo = (completions: readonly ChoreCompletion[]) => {
    const undone = new Set([...targets].filter(([key]) => state.overrides.get(key) === false)
      .map(([, task]) => JSON.stringify([task.completion?.householdId, task.completion?.id])));
    return undone.size ? completions.filter(record => !undone.has(JSON.stringify([record.householdId, record.id]))) : completions;
  };
  const canToggle = (task: DateTask) => current() && !state.requiresReload && !state.reading && !state.pending.has(taskKey(task))
    && Boolean(task.completed ? task.completion : task.entry);
  async function perform(task: DateTask, write = () => dependencies.write(task), keepChecked = false) {
    const key = taskKey(task);
    if (!canToggle(task)) return;
    const token = ++command; clearUndo();
    targets.set(key, task);
    state = { ...state, overrides: new Map(state.overrides).set(key, keepChecked || !task.completed), pending: new Set(state.pending).add(key), error: null }; emit();
    let saved = false;
    try {
      const receipt = await write(); saved = true;
      if (!current()) return;
      await dependencies.refresh(task);
      if (!current()) return;
      const overrides = new Map(state.overrides); overrides.delete(key); targets.delete(key);
      state = { ...state, overrides };
      if (!task.completed && receipt && typeof receipt === 'object' && 'undo' in receipt && typeof receipt.undo === 'function'
        && 'undoTask' in receipt && receipt.undoTask && token === command) {
        undoReceipt = receipt as TaskUndoReceipt; state = { ...state, undoAvailable: true };
        undoTimer = setTimeout(() => { clearUndo(); if (current()) emit(); }, 6500);
      }
    } catch (cause) {
      const overrides = new Map(state.overrides);
      // A failed read must not undo a successful write on screen or repeat that write.
      if (!saved) { overrides.delete(key); targets.delete(key); }
      const requiresReload = state.requiresReload || saved;
      state = { ...state, overrides, requiresReload, error: requiresReload
        ? '保存済みですが、表示を更新できませんでした。再読込してください。'
        : cause instanceof Error ? cause.message : '保存できませんでした。もう一度お試しください。' };
    } finally {
      const pending = new Set(state.pending); pending.delete(key);
      state = { ...state, pending, ...(!current() && saved ? { requiresReload: true,
        error: '保存済みですが、表示を更新できませんでした。再読込してください。' } : {}) };
      if (current()) emit();
    }
  }
  async function retryRead() {
    if (!current() || state.pending.size || state.reading) return;
    state = { ...state, reading: true }; emit();
    try { await dependencies.refresh(); if (current()) { targets.clear(); state = { ...state, overrides: new Map(), error: null, requiresReload: false }; } }
    catch { /* Retain the saved overlay and its retry message. */ }
    finally { state = { ...state, reading: false }; if (current()) emit(); }
  }
  return {
    activate: () => { live = true; if (state.requiresReload) void retryRead(); else if (current()) emit(); }, deactivate: () => { live = false; command++; clearUndo(); },
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    dismissUndo() { command++; clearUndo(); emit(); },
    project(tasks: readonly DateTask[], completions: readonly ChoreCompletion[] = []) {
      const remaining = completionsAfterUndo(completions);
      return tasks.map(task => { const key = taskKey(task); const value = state.overrides.get(key);
        return value === undefined ? task : { ...task, completed: value || hasOtherCompletion(targets.get(key), remaining) }; });
    },
    canToggle,
    calendarCounts(entries: readonly ChoreScheduleEntry[], completions: readonly ChoreCompletion[]) {
      if (!state.overrides.size) return calendarPendingCountsByDate(entries, completions);
      const remaining = completionsAfterUndo(completions);
      const completedOverrides = new Map([...state.overrides].filter(([, completed]) => completed));
      const byDate = calendarPendingChoreIdsByDate(entries, remaining, completedOverrides);
      const entryIds = new Set(entries.map(entry => entry.id));
      for (const [key, task] of targets) if (state.overrides.get(key) === false && !entryIds.has(key) && !hasOtherCompletion(task, remaining)) {
        const chores = byDate.get(task.suggestedDate) ?? new Set<string>(); chores.add(task.choreId); byDate.set(task.suggestedDate, chores);
      }
      return new Map([...byDate].map(([date, chores]) => [date, chores.size]));
    },
    toggle: (task: DateTask) => perform(task),
    async undoLast() {
      if (!current() || state.pending.size || state.reading || state.requiresReload || !undoReceipt) return;
      const receipt = undoReceipt;
      await perform(receipt.undoTask, receipt.undo, receipt.keepChecked);
    },
    retryRead,
  };
}
