import type { V2GoogleTaskStore } from '../../../platform/storage/sharing-v2-google-tasks';
import type { GoogleTaskList, GoogleTasksApi } from '../../../platform/google-tasks/google-tasks-api';
import type { GoogleSyncState } from '../../google-sync/contracts';
import { withGoogleSyncOperation } from '../../google-sync/operation-lock.ts';
import { syncGoogleTasksWithDependencies, waitForGoogleSyncAttemptSettlement } from '../../google-sync/coordinator';
import type { GoogleSyncCoordinatorDependencies, GoogleSyncRunResult } from '../../google-sync/coordinator';
import { createGoogleOperationBudget, withinGoogleOperationBudget } from '../../google-sync/operation-budget.ts';
import type { GoogleOperationBudget } from '../../google-sync/operation-budget';
import { GoogleAccountMismatchError } from '../../google-sync/account-binding.ts';
import { googleTaskRequestNotSent } from '../../google-sync/task-create-intent.ts';
import type { GoogleTaskCreateJournal } from '../../google-sync/task-create-intent';
import type { GoogleTaskListResolution } from '../../google-sync/reconcile-google-tasks';
import { traceStartup } from '../../../platform/diagnostics/startup-timing.ts';

export interface V2GoogleConnectionReview { subject: string; label: string; connectionRevision: number }
export function createV2GoogleTaskRuntime(input: { store: V2GoogleTaskStore; assertAccess(): void | Promise<void>;
  restoreAccount(): Promise<{ subject: string; label: string }>; currentSubject(): Promise<string | null>; authorizeTasks(): Promise<void>; token(subject: string): Promise<string>;
  createApi(context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> }): GoogleTasksApi;
  wrapCreateJournal?(journal: GoogleTaskCreateJournal, context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> }): GoogleTaskCreateJournal;
  resolveTaskList?(request: GoogleTaskListResolution, context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> }): Promise<GoogleTaskList>;
  verifyTaskListForLocalChanges?(state: GoogleSyncState, context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> }): Promise<boolean>;
  preparePlan?(): Promise<void>; assertPlanningCurrent?(): Promise<void>; finishPlan?(): void; now?: () => Date; budgetNow?: () => number; defaultBudgetMs?(): number; defaultDeltaOnly?(): boolean; onImported?(): void | Promise<void> }) {
  const now = input.now ?? (() => new Date()); const scope = {}; let action: Promise<unknown> | null = null;
  let running: { promise: Promise<GoogleSyncRunResult>; operation: Promise<GoogleSyncRunResult>; budget: GoogleOperationBudget; force: boolean } | null = null;
  let manualRecovery: { promise: Promise<GoogleSyncRunResult>; budget: GoogleOperationBudget } | null = null;
  let requested = false; let forceRequested = false;
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    if (action) return Promise.reject(new Error('Google家事の接続操作が終わるまでお待ちください。'));
    const pending = withGoogleSyncOperation(async () => { await input.assertAccess(); const value = await work(); await input.assertAccess(); return value; }); action = pending;
    void pending.finally(() => { if (action === pending) action = null; }).catch(() => undefined); return pending;
  }
  async function run(force: boolean, budget: GoogleOperationBudget, deltaOnly: boolean): Promise<GoogleSyncRunResult> {
    let revision: number | undefined; let boundSubject: string | undefined;
    // Native identity reads can outlive the OS budget. They are read-only, so
    // ignore a late reply and let the serialized coordinator finish cleanup.
    const currentSubject = () => withinGoogleOperationBudget(budget, () => traceStartup('sharedTasks.identity', input.currentSubject));
    const assertBinding = async (checkTime = true) => {
      if (checkTime) budget.assert(); await input.assertAccess(); const control = await input.store.readControl();
      if (control.revision !== revision || !control.state?.enabled || control.state.disconnected || control.state.accountSubject !== boundSubject) throw new GoogleAccountMismatchError();
      await input.assertAccess(); if (checkTime) budget.assert();
    };
    const assertSession = async () => { await assertBinding(); if (await currentSubject() !== boundSubject) throw new GoogleAccountMismatchError(); budget.assert(); };
    const context = { budget, assertCurrent: assertSession }; const api = input.createApi(context);
    const guarded = Object.fromEntries(Object.entries(api).filter(([, method]) => typeof method === 'function').map(([key, method]) => [key, async (...args: unknown[]) => {
      try { await assertSession(); await input.assertPlanningCurrent?.(); } catch (error) { throw googleTaskRequestNotSent(error); }
      const result = await Reflect.apply(method, api, args); await assertSession(); return result;
    }])) as unknown as GoogleTasksApi;
    const port = { ...input.store.port,
      ...(input.resolveTaskList ? { resolveTaskList: (request: GoogleTaskListResolution) => input.resolveTaskList!(request, context) } : {}),
      ...(input.verifyTaskListForLocalChanges ? { verifyTaskListForLocalChanges: (state: GoogleSyncState) => input.verifyTaskListForLocalChanges!(state, context) } : {}),
      ...(input.wrapCreateJournal && input.store.port.taskCreateJournal
        ? { taskCreateJournal: input.wrapCreateJournal(input.store.port.taskCreateJournal, context) } : {}) };
    const dependencies: GoogleSyncCoordinatorDependencies = {
      ...port, syncScope: scope, budget,
      loadState: async () => {
        await input.assertAccess(); const value = await traceStartup('sharedTasks.control', input.store.readControl); revision = value.revision; boundSubject = value.state?.accountSubject;
        return value.state;
      },
      preparePlan: async () => {
        budget.assert(); await traceStartup('sharedTasks.preparePlan', async () => input.preparePlan?.()); await assertBinding();
        dependencies.today = await traceStartup('sharedTasks.today', input.store.readToday); await assertBinding();
      },
      saveState: async (state: GoogleSyncState) => { await input.assertAccess(); if (revision === undefined) throw new Error('Google家事の接続を読み直してください。'); await input.store.saveSyncState(state, revision); },
      hasPendingLocalChanges: () => traceStartup('sharedTasks.pendingChanges', input.store.hasPendingLocalChanges),
      getAccessToken: async () => {
        await assertBinding(); if (await currentSubject() !== boundSubject) throw new GoogleAccountMismatchError();
        await assertBinding(); const token = await withinGoogleOperationBudget(budget, () => input.token(boundSubject!));
        await assertBinding(); if (await currentSubject() !== boundSubject) throw new GoogleAccountMismatchError(); return token;
      },
      importGoogleTaskChanges: async (...args: Parameters<typeof port.importGoogleTaskChanges>) => {
        await assertSession(); const count = await port.importGoogleTaskChanges(...args);
        if (count) try { await input.onImported?.(); } catch { /* Signed facts and private mapping have already committed together. */ }
        return count;
      },
      api: guarded,
    };
    let result: GoogleSyncRunResult = { kind: 'success', skipped: true };
    try {
      for (let pass = 0; pass < 3; pass++) {
        requested = false; const nextForce = force || forceRequested; forceRequested = false;
        result = await syncGoogleTasksWithDependencies(dependencies, { now: now(), force: nextForce, forceCalendar: false, recoverInterruptedAttempt: true, deltaOnly });
        if (deltaOnly && result.kind === 'success' && result.foregroundRequired) return result;
        if (!requested || result.kind !== 'success') return result;
        budget.assert();
      }
      return result;
    } finally { await waitForGoogleSyncAttemptSettlement(scope); input.finishPlan?.(); }
  }
  function synchronize(options: { force?: boolean; budgetMs?: number; localChange?: boolean; deltaOnly?: boolean } = {}): Promise<GoogleSyncRunResult> {
    // Foreground automatic work can wait behind Calendar preparation. An
    // explicit OS worker deadline always takes precedence over this default.
    const milliseconds = options.budgetMs ?? (options.force ? 100_000 : input.defaultBudgetMs?.() ?? 15_000);
    if (options.force && manualRecovery) {
      if (options.budgetMs !== undefined) { manualRecovery.budget.shrink(options.budgetMs); running?.budget.shrink(options.budgetMs); }
      return manualRecovery.promise;
    }
    if (running) {
      // Only an explicit worker/caller deadline constrains an existing run.
      // An ordinary refresh's default must not shorten a manual operation.
      if (options.budgetMs !== undefined) running.budget.shrink(options.budgetMs);
      if (options.localChange || options.force && !running.force) { requested = true; forceRequested ||= options.force === true; }
      if (options.force && (!running.force || running.budget.signal.aborted)) {
        const active = running; const budget = createGoogleOperationBudget(milliseconds, input.budgetNow);
        const promise = (async (): Promise<GoogleSyncRunResult> => {
          try {
            const result = await withinGoogleOperationBudget(budget, () => active.promise);
            if (!(result.kind === 'retry' && result.code === 'timeout')
              && !(result.kind === 'success' && result.foregroundRequired)) return result;
            // The public timeout can precede an outstanding SQLite/HTTP cleanup.
            // Do not start beside it or revive the request after its own deadline.
            await withinGoogleOperationBudget(budget, () => active.operation.then(() => undefined, () => undefined));
            budget.assert();
            if (manualRecovery?.budget === budget) manualRecovery = null;
            return await withinGoogleOperationBudget(budget, () => synchronize({ ...options, budgetMs: Math.floor(budget.remaining()) }));
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return { kind: 'retry', code: 'timeout' };
            throw error;
          } finally { budget.close(); }
        })();
        manualRecovery = { promise, budget };
        void promise.finally(() => { if (manualRecovery?.promise === promise) manualRecovery = null; }).catch(() => undefined);
        return promise;
      }
      return running.promise;
    }
    const budget = createGoogleOperationBudget(milliseconds, input.budgetNow);
    const operation = run(options.force === true, budget, options.deltaOnly ?? (!options.force && input.defaultDeltaOnly?.() === true));
    const promise = Promise.race([operation, budget.expiration.then((): GoogleSyncRunResult => ({ kind: 'retry', code: 'timeout' }))]);
    running = { promise, operation, budget, force: options.force === true };
    void operation.finally(() => { budget.close(); if (running?.promise === promise) running = null; }).catch(() => undefined);
    return promise;
  }
  return { store: input.store,
    readControl: () => input.store.readControl(),
    reviewConnection: () => mutate(async (): Promise<V2GoogleConnectionReview> => {
      const before = await input.store.readControl(); const account = await input.restoreAccount(); await input.assertAccess();
      if (before.state?.accountSubject && before.state.accountSubject !== account.subject) throw new GoogleAccountMismatchError();
      const after = await input.store.readControl(); if (after.revision !== before.revision) throw new Error('Google家事の接続が変わりました。もう一度確認してください。');
      return { ...account, connectionRevision: before.revision };
    }),
    connect: (review: V2GoogleConnectionReview) => {
      const expected = { ...review };
      return mutate(async () => {
        if (await input.currentSubject() !== expected.subject) throw new GoogleAccountMismatchError();
        const before = await input.store.readControl(); if (before.revision !== expected.connectionRevision) throw new Error('Google家事の接続が変わりました。もう一度確認してください。');
        await input.authorizeTasks(); await input.assertAccess();
        if (await input.currentSubject() !== expected.subject) throw new GoogleAccountMismatchError();
        return input.store.configure(expected.connectionRevision, expected, true);
      });
    },
    pause: (expectedRevision: number, disconnect = false) => {
      running?.budget.cancel();
      manualRecovery?.budget.cancel();
      return mutate(async () => {
        const control = await input.store.readControl(); if (!control.state?.accountSubject || control.revision !== expectedRevision) throw new Error('Google家事の接続を読み直してください。');
        return input.store.configure(expectedRevision, { subject: control.state.accountSubject, label: control.label! }, false, disconnect);
      });
    },
    synchronize,
  };
}
export type V2GoogleTaskRuntime = ReturnType<typeof createV2GoogleTaskRuntime>;
