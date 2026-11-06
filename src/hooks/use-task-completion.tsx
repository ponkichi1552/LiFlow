import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { completeChoreWithReceipt, undoCompletionReceipt, undoCompletedChore } from '../platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '../features/google-sync/coordinator';
import { createTaskMutations, scopedDateTaskKey } from '../features/planner/task-mutations';
import type { DateTask } from '../domain/scheduling/date-tasks';
import { sharedRepositoryAdapter } from '../platform/storage/shared-repository-adapter';
import { personalCompletionIntents } from '../platform/storage/completion-intents';
import { dateTaskRevision } from '../domain/scheduling/date-task-reference';
import { personalCompletionKey } from '../features/planner/completion-command';
import type { PersonalCompletionTarget } from '../features/planner/completion-command';
import type { CompletionIntentState } from '../features/planner/completion-intents';
import type { Household } from '../domain/shared/types';

const emptyIntents: CompletionIntentState = { values: new Map(), pending: new Set(), failed: new Set(), restored: false, error: null };
const noChanges = () => () => {};
const noIntents = () => emptyIntents;

interface PersonalCompletionSource { database: SQLiteDatabase; refresh(): Promise<void>; readError?: () => string | null;
  isCurrent?: () => boolean; assertAccess?: (task?: DateTask) => void | Promise<void> }

export function useTaskCompletion(database: SQLiteDatabase, refresh: () => Promise<void>, readError?: () => string | null,
  personal?: PersonalCompletionSource, household?: Household) {
  const personalDatabase = personal?.database; const personalRefresh = personal?.refresh; const personalReadError = personal?.readError;
  const isCurrent = personal?.isCurrent; const assertPersonalAccess = personal?.assertAccess;
  const binding = useMemo(() => {
    const primary: PersonalCompletionSource = { database, refresh, readError };
    const secondary = personalDatabase && personalRefresh ? { database: personalDatabase, refresh: personalRefresh, readError: personalReadError, assertAccess: assertPersonalAccess } : undefined;
    const target = (task: DateTask) => secondary && task.completionScope === 'personal' ? secondary : primary;
    const controller = createTaskMutations({
      isCurrent: isCurrent ?? (() => true),
      key: secondary ? scopedDateTaskKey : undefined,
      write: async task => {
        const source = target(task);
        const guard = source.assertAccess ? () => source.assertAccess!(task) : undefined;
        const changed = task.completed ? await undoCompletedChore(source.database, task.completion!.id, guard) : await completeChoreWithReceipt(source.database, task.entry!, guard);
        if (changed) syncGoogleTasksAfterLocalCompletion(source.database);
        if (changed && typeof changed === 'object') return {
          undoTask: { ...task, completed: true, completion: changed },
          keepChecked: Boolean(sharedRepositoryAdapter(source.database)),
          undo: async () => { const undone = await undoCompletionReceipt(source.database, changed, guard); if (undone) syncGoogleTasksAfterLocalCompletion(source.database); return undone; },
        };
      },
      refresh: async task => {
        const sources = task ? [target(task)] : secondary ? [primary, secondary] : [primary];
        await Promise.all(sources.map(async source => { await source.refresh(); const error = source.readError?.(); if (error) throw new Error(error); }));
      },
    });
    return controller;
  }, [database, refresh, readError, personalDatabase, personalRefresh, personalReadError, isCurrent, assertPersonalAccess]);
  useEffect(() => { binding.activate(); return binding.deactivate; }, [binding]);
  useFocusEffect(useCallback(() => () => binding.dismissUndo(), [binding]));
  const state = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  // Ordinary personal mode and the personal rows inside a group share the same
  // protected queue. A view projection can change a checkbox before a receipt
  // exists; retain its original reference rather than inventing a new occurrence.
  const runtime = useMemo(() => household && !personal && !sharedRepositoryAdapter(database)
    ? personalCompletionIntents(database, household) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, personal, household?.id, household?.createdAt]);
  const intents = useSyncExternalStore(runtime?.queue.subscribe ?? noChanges, runtime?.queue.getSnapshot ?? noIntents, noIntents);
  const originals = useMemo(() => new WeakMap<DateTask, DateTask>(), []);
  const [queuedUndo, setQueuedUndo] = useState<{ key: string; target: PersonalCompletionTarget } | null>(null);
  useEffect(() => runtime?.acquire(), [runtime]);
  useEffect(() => { if (!queuedUndo) return; const timer = setTimeout(() => setQueuedUndo(null), 6500); return () => clearTimeout(timer); }, [queuedUndo]);
  useFocusEffect(useCallback(() => {
    const stop = runtime?.watchDisplay(async () => { await refresh(); const failure = readError?.(); if (failure) throw new Error(failure); });
    runtime?.queue.retryRead();
    return () => { stop?.(); setQueuedUndo(null); };
  }, [runtime, refresh, readError]));
  if (!runtime) return { ...state, ...binding, recoveryLabel: '表示を再読込' };
  const original = (task: DateTask) => originals.get(task) ?? task;
  const keyFor = (task: DateTask) => personalCompletionKey(dateTaskRevision(original(task)));
  const canToggle = (task: DateTask) => {
    try { return Boolean((original(task).entry || original(task).completion) && keyFor(task)); } catch { return false; }
  };
  return { ...state, ...binding, pending: intents.pending, reading: false, error: intents.error, requiresReload: false,
    recoveryLabel: intents.failed.size ? '保存を再試行' : '表示を再読込',
    undoAvailable: Boolean(queuedUndo), canToggle,
    project: (tasks: readonly DateTask[]) => tasks.map(task => {
      let key: string; try { key = keyFor(task); } catch { return task; }
      const completed = intents.values.get(key); if (completed === undefined || completed === task.completed) return task;
      const projected = { ...task, completed }; originals.set(projected, original(task)); return projected;
    }),
    async toggle(task: DateTask) {
      if (!canToggle(task)) return;
      const source = original(task); const revision = dateTaskRevision(source); const key = personalCompletionKey(revision);
      const target: PersonalCompletionTarget = { kind: 'personal', command: { date: source.suggestedDate, graceDays: 3, choreId: source.choreId, revision } };
      const completed = !(runtime.queue.getSnapshot().values.get(key) ?? source.completed);
      if (runtime.queue.request(key, target, completed)) setQueuedUndo(completed ? { key, target } : null);
    },
    async undoLast() { if (!queuedUndo) return; runtime.queue.request(queuedUndo.key, queuedUndo.target, false); setQueuedUndo(null); },
    async retryRead() { runtime.queue.retryFailed(); await refresh(); runtime.queue.retryRead(); },
  };
}
