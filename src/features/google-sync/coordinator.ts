import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { GoogleTasksApiError, createGoogleTasksApi } from '@/platform/google-tasks/google-tasks-api';
import type { GoogleTasksApi } from '@/platform/google-tasks/google-tasks-api';
import {
  deleteGoogleTaskLink,
  importGoogleTaskChanges,
  acknowledgeGoogleTaskStatus,
  listEntriesForGoogleSync,
  listGoogleTaskLinks,
  loadGoogleSyncState,
  hasPendingGoogleTaskChanges,
  saveGoogleSyncState,
  upsertGoogleTaskLink,
  personalGoogleTaskCreateJournal,
  personalGoogleTaskReadCache,
  readPersonalGoogleStatusSnapshot,
} from '@/platform/storage/repository';
import type { SQLiteDatabase } from 'expo-sqlite';
import { classifyGoogleSyncFailure } from './error-classification';
import type { GoogleSyncFailureDetails } from './error-classification';
import { GoogleTaskFullSyncRequiredError } from './task-read-cache.ts';
import { GOOGLE_SYNC_INTERVAL_MS, googleSyncRunOptions, isGoogleSyncAttemptStale, shouldSyncGoogleTasks } from './sync-policy';
import type { GoogleSyncTriggerOptions } from './sync-policy';
import type { GoogleSyncState } from './contracts';
import { reconcileGoogleTasks, reconcileLocalGoogleTaskStatuses } from './reconcile-google-tasks';
import type { GoogleSyncRepositoryPort } from './reconcile-google-tasks';
import { notifyGooglePlannerChanges } from './planner-change-events';
import { withGoogleSyncOperation } from './operation-lock';
import { sharedRepositoryAdapter } from '@/platform/storage/shared-repository-adapter';
import { sharedGoogleNamespace, sharedPlannerChangeScope } from './workspace-policy';
import { createGoogleOperationBudget, withinGoogleOperationBudget } from './operation-budget.ts';
import type { GoogleOperationBudget } from './operation-budget';

export type GoogleSyncRunResult =
  | { kind: 'success'; skipped?: boolean; skipReason?: 'notDue' | 'foregroundRequired'; foregroundRequired?: true; localStatusesOnly?: true; created?: number; updated?: number; removed?: number; imported?: number; remoteTasksRead?: number; hiddenCompletionsRead?: number; invalidCompletions?: number }
  | { kind: 'retry'; code: string }
  | { kind: 'authRequired'; code: string }
  | { kind: 'error'; code: string };

export interface GoogleSyncCoordinatorDependencies extends GoogleSyncRepositoryPort {
  /** The actual SQLite connection/workspace for native calls; injected ports use their own identity. */
  syncScope?: object;
  budget?: GoogleOperationBudget;
  today?: LocalDate;
  loadState(): Promise<GoogleSyncState | null>;
  saveState(state: GoogleSyncState): Promise<void>;
  getAccessToken(): Promise<string>;
  preparePlan?(): Promise<void>;
  hasPendingLocalChanges?(lastSuccessfulSyncAt?: string): Promise<boolean>;
  api: GoogleTasksApi;
  refreshCalendar?(options: { now: Date; today: LocalDate; force: boolean }): Promise<{ plannerChanged: boolean }>;
}

const runningSync = new WeakMap<object, Promise<GoogleSyncRunResult>>();
const runningBudgets = new WeakMap<object, GoogleOperationBudget>();
const executingSync = new WeakSet<object>();
const pendingCompletionSyncDatabases = new Set<SQLiteDatabase>();

/** A settings change settles behind the interrupted attempt, so its late status
 * cannot re-enable a connection the user just paused. Existing facts stay saved. */
export function configurePersonalGoogleTaskSync(database: SQLiteDatabase, enabled: boolean): Promise<GoogleSyncState> {
  if (sharedRepositoryAdapter(database)) throw new Error('共有家事の同期設定を使用してください。');
  if (!enabled) {
    runningBudgets.get(database)?.cancel();
    pendingCompletionSyncDatabases.delete(database);
  }
  return withGoogleSyncOperation(async () => {
    const previous = await loadGoogleSyncState(database, 'local-household');
    const next: GoogleSyncState = { ...(previous ?? { householdId: 'local-household', retryCount: 0 }), enabled, status: 'idle',
      retryCount: enabled ? previous?.retryCount ?? 0 : 0, nextRetryAt: undefined, lastErrorCode: undefined,
      lastErrorAt: undefined, updatedAt: new Date().toISOString() };
    await saveGoogleSyncState(database, next); return next;
  }, 'googleTasks.configure');
}

export async function syncGoogleTasks(
  database: SQLiteDatabase,
  options: GoogleSyncTriggerOptions & { now?: Date } = {},
): Promise<GoogleSyncRunResult> {
  const now = options.now ?? new Date();
  const householdId = 'local-household';
  const shared = sharedRepositoryAdapter(database);
  const startedAt = Date.now();
  let readRequests = 0;
  let writeRequests = 0;
  let writeOperations = 0;
  const budget = createGoogleOperationBudget(options.budgetMs ?? (options.force && options.trigger !== 'completion' ? 100_000 : 15_000));
  try {
    const sharedSnapshot = shared ? await withinGoogleOperationBudget(budget, () => shared.readSnapshot(now)) : null;
    if (sharedSnapshot?.sharing?.issues.some((issue) => issue.kind === 'conflict' || issue.kind === 'dependencyCycle')) return { kind: 'success', skipped: true };
    const sharedToday = sharedSnapshot?.today;
    const result = await syncGoogleTasksWithDependencies({
      syncScope: database, budget,
      ...(shared ? { taskNamespace: sharedGoogleNamespace(shared.userId, shared.groupId), today: sharedToday } : {}),
      loadState: () => loadGoogleSyncState(database, householdId),
      hasPendingLocalChanges: (lastSuccess) => hasPendingGoogleTaskChanges(database, lastSuccess, householdId),
      ...(!shared ? { verifyTaskListForLocalChanges: async (value: GoogleSyncState) => Boolean(value.accountSubject && value.taskListId) } : {}),
      saveState: (state) => saveGoogleSyncState(database, state),
      getAccessToken: async () => {
        const { getBoundGoogleAccessToken } = await import('@/platform/google-tasks/bound-session');
        return withinGoogleOperationBudget(budget, () => getBoundGoogleAccessToken(database, 'tasks'));
      },
      refreshCalendar: shared ? undefined : async (calendarOptions) => {
        const { refreshGoogleCalendarAvailability } = await import('./calendar-coordinator');
        return refreshGoogleCalendarAvailability(database, { ...calendarOptions, budget });
      },
      api: createGoogleTasksApi(fetch, (method, operationCount = 1) => {
        if (method === 'GET') readRequests += 1;
        else {
          writeRequests += 1;
          writeOperations += operationCount;
        }
      }, { budget }),
      importGoogleTaskChanges: async (changes, today) => {
        const imported = await importGoogleTaskChanges(database, changes, today as LocalDate, now);
        if (imported > 0) {
          const handled = notifyGooglePlannerChanges(shared ? sharedPlannerChangeScope(shared.userId, shared.groupId) : 'personal');
          if (!handled) try {
            const { refreshPlannerAfterGoogleImport } = await import('@/platform/google-tasks/refresh-planner-after-google-import');
            await refreshPlannerAfterGoogleImport(database, today as LocalDate);
          } catch { /* Saved planner data remains valid if a native widget/digest is unavailable. */ }
        }
        return imported;
      },
      listEntriesForGoogleSync: (today, id) => listEntriesForGoogleSync(database, today as LocalDate, id),
      listGoogleTaskLinks: (id) => listGoogleTaskLinks(database, id),
      ...(!shared ? { readLocalStatusSnapshot: (today: string, id: string) => readPersonalGoogleStatusSnapshot(database, today as LocalDate, id) } : {}),
      upsertGoogleTaskLink: (link) => upsertGoogleTaskLink(database, link),
      acknowledgeGoogleTaskStatus: (link, status) => acknowledgeGoogleTaskStatus(database, link, status),
      deleteGoogleTaskLink: (id) => deleteGoogleTaskLink(database, id),
      taskReadCache: personalGoogleTaskReadCache(database),
      taskCreateJournal: personalGoogleTaskCreateJournal(database),
    }, {
      ...googleSyncRunOptions(options),
      now,
    });
    if (readRequests + writeRequests > 0 && typeof __DEV__ !== 'undefined' && __DEV__) {
      console.info('[google-sync]', {
        result: result.kind,
        durationMs: Date.now() - startedAt,
        readRequests,
        writeRequests,
        writeOperations,
        ...(result.kind === 'success' ? { created: result.created, updated: result.updated, removed: result.removed,
          remoteTasksRead: result.remoteTasksRead, hiddenCompletionsRead: result.hiddenCompletionsRead, imported: result.imported }
          : { code: result.code }),
      });
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { kind: 'retry', code: 'timeout' };
    throw error;
  } finally { budget.close(); }
}

/** Best-effort immediate propagation for in-app and widget completion actions. */
export function syncGoogleTasksAfterLocalCompletion(database: SQLiteDatabase): void {
  if (runningSync.has(database)) {
    // A queued run has not read yet and will see this committed change already.
    if (executingSync.has(database)) pendingCompletionSyncDatabases.add(database);
    return;
  }
  void syncGoogleTasks(database, { trigger: 'completion' }).catch(() => undefined);
}

export async function syncGoogleTasksWithDependencies(
  dependencies: GoogleSyncCoordinatorDependencies,
  options: { force?: boolean; forceCalendar?: boolean; now: Date; recoverInterruptedAttempt?: boolean; deltaOnly?: boolean },
): Promise<GoogleSyncRunResult> {
  const scope = dependencies.syncScope ?? dependencies;
  const existing = runningSync.get(scope);
  if (existing) {
    const activeBudget = runningBudgets.get(scope);
    if (dependencies.budget && activeBudget && dependencies.budget !== activeBudget) {
      try { activeBudget.shrink(dependencies.budget.remaining()); }
      catch (error) { if (error instanceof Error && error.name === 'AbortError') return { kind: 'retry', code: 'timeout' }; throw error; }
    }
    return waitForSync(existing, dependencies.budget);
  }
  const run = withGoogleSyncOperation(async () => {
    dependencies.budget?.assert();
    executingSync.add(scope);
    try { return await runSync(dependencies, {
      force: options.force ?? false,
      forceCalendar: options.forceCalendar ?? options.force ?? false,
      now: options.now,
      recoverInterruptedAttempt: options.recoverInterruptedAttempt ?? false,
      deltaOnly: options.deltaOnly ?? false,
    }); } finally { executingSync.delete(scope); }
  });
  runningSync.set(scope, run);
  if (dependencies.budget) runningBudgets.set(scope, dependencies.budget);
  // Keep the actual run registered until its cleanup finishes, even if its caller times out.
  void run.finally(() => {
    if (runningSync.get(scope) === run) {
      runningSync.delete(scope); runningBudgets.delete(scope);
      const database = scope as SQLiteDatabase;
      if (pendingCompletionSyncDatabases.delete(database)) {
        void Promise.resolve().then(() => syncGoogleTasks(database, { trigger: 'completion' })).catch(() => undefined);
      }
    }
  }).catch(() => undefined);
  return waitForSync(run, dependencies.budget);
}

async function waitForSync(run: Promise<GoogleSyncRunResult>, budget?: GoogleOperationBudget): Promise<GoogleSyncRunResult> {
  try {
    return await (budget ? withinGoogleOperationBudget(budget, () => run) : run);
  } catch (error) {
    if (budget && error instanceof Error && error.name === 'AbortError') return { kind: 'retry', code: 'timeout' };
    throw error;
  }
}

/** A public timeout may precede HTTP/SQLite cleanup. This barrier never cancels
 * that work or releases its serialization lock before it actually settles. */
export async function waitForGoogleSyncAttemptSettlement(scope: object): Promise<void> {
  const attempt = runningSync.get(scope);
  if (attempt) await attempt.then(() => undefined, () => undefined);
}

async function runSync(
  dependencies: GoogleSyncCoordinatorDependencies,
  options: { force: boolean; forceCalendar: boolean; now: Date; recoverInterruptedAttempt: boolean; deltaOnly?: boolean },
): Promise<GoogleSyncRunResult> {
  const { now } = options;
  let state = await dependencies.loadState();
  dependencies.budget?.assert();
  if (!state?.enabled) return { kind: 'success', skipped: true };
  if (options.force || state.status !== 'authRequired' && state.status !== 'error'
    && (state.status !== 'retryPending' || shouldSyncGoogleTasks(state, now))) await dependencies.preparePlan?.();
  // Native Android widget actions can commit while JS is stopped. Recover their
  // durable changes on startup/resume without changing Calendar cadence or
  // bypassing an existing retry/auth/permission failure on every foreground.
  const pendingLocalChanges = (state.status === 'idle' || state.status === 'syncing'
    || state.status === 'retryPending' && shouldSyncGoogleTasks(state, now))
    && await dependencies.hasPendingLocalChanges?.(state.lastSuccessfulSyncAt) === true;
  // A recovered process may have stopped before creating its first mapping, so
  // there is no link-level pending flag yet. The in-memory scope above already
  // joins any live attempt; an explicitly recovered persisted marker must run.
  const foregroundRequired = state.status === 'idle' && state.lastErrorCode === 'task_foreground_scan_required';
  const force = options.force || pendingLocalChanges || state.status === 'syncing' && options.recoverInterruptedAttempt === true
    || foregroundRequired && !options.deltaOnly;
  const staleAttempt = isGoogleSyncAttemptStale(state, now);
  if (state.status === 'syncing' && !staleAttempt && !options.recoverInterruptedAttempt && !pendingLocalChanges) {
    return { kind: 'success', skipped: true };
  }
  let calendarChanged = false;
  try {
    calendarChanged = (await dependencies.refreshCalendar?.({ now, today: localDateFromDate(now), force: options.forceCalendar }))?.plannerChanged ?? false;
  } catch (error) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[google-calendar]', {
        result: 'coordinator_error',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    // Calendar failure is isolated; Tasks completion and retry policy continue.
  }
  if (!force && (state.status === 'authRequired' || state.status === 'error'
    || state.status === 'retryPending' && !shouldSyncGoogleTasks(state, now))) {
    return { kind: 'success', skipped: true };
  }
  if (!force && !calendarChanged && !staleAttempt && !shouldSyncGoogleTasks(state, now)) {
    if (foregroundRequired) return { kind: 'success', skipped: true, skipReason: 'foregroundRequired', foregroundRequired: true };
    const lastSuccess = Date.parse(state.lastSuccessfulSyncAt ?? '');
    // An idle connection whose next scheduled check is not due has no retry to
    // defer. Keep authentication, retry, interrupted-attempt and clock anomalies
    // distinct; a skipped promise alone never proves those have been resolved.
    return { kind: 'success', skipped: true,
      ...(state.status === 'idle' && !state.lastErrorCode && Number.isFinite(lastSuccess) && lastSuccess <= now.getTime() ? { skipReason: 'notDue' as const } : {}) };
  }

  const attemptAt = now.toISOString();
  state = {
    ...state,
    status: 'syncing',
    lastAttemptAt: attemptAt,
    nextRetryAt: undefined,
    updatedAt: attemptAt,
  };

  try {
    dependencies.budget?.assert();
    await dependencies.saveState(state);
    const accessToken = await dependencies.getAccessToken();
    dependencies.budget?.assert();
    const lastReconciledAt = Date.parse(state.lastSuccessfulSyncAt ?? '');
    const localResult = !options.force && (!foregroundRequired || options.deltaOnly) && pendingLocalChanges && Number.isFinite(lastReconciledAt)
      && lastReconciledAt <= now.getTime() && lastReconciledAt + GOOGLE_SYNC_INTERVAL_MS > now.getTime()
      ? await reconcileLocalGoogleTaskStatuses({ accessToken, state, repository: dependencies, api: dependencies.api,
        today: dependencies.today ?? localDateFromDate(now) }) : null;
    const result = localResult ?? await reconcileGoogleTasks({
      accessToken,
      state,
      repository: dependencies,
      api: dependencies.api,
      now,
      today: dependencies.today ?? localDateFromDate(now),
      deltaOnly: options.deltaOnly,
    });
    dependencies.budget?.assert();
    if (result.invalidCompletions > 0) {
      console.warn('[google-sync]', { code: 'invalid_remote_completion_timestamp', count: result.invalidCompletions });
    }
    await dependencies.saveState({
      ...state,
      taskListId: result.taskListId,
      status: 'idle',
      retryCount: 0,
      lastSuccessfulSyncAt: localResult ? state.lastSuccessfulSyncAt : now.toISOString(),
      nextRetryAt: undefined,
      lastErrorCode: localResult && foregroundRequired ? state.lastErrorCode : undefined,
      lastErrorAt: localResult && foregroundRequired ? state.lastErrorAt : undefined,
      updatedAt: now.toISOString(),
    });
    return { kind: 'success', ...result, ...(localResult ? { localStatusesOnly: true as const } : {}),
      ...(localResult && foregroundRequired ? { foregroundRequired: true as const } : {}) };
  } catch (error) {
    if (error instanceof GoogleTaskFullSyncRequiredError) {
      try { await dependencies.saveState({ ...state, status: 'idle', nextRetryAt: undefined,
        lastErrorCode: 'task_foreground_scan_required', lastErrorAt: now.toISOString(), updatedAt: now.toISOString() }); }
      catch { return { kind: 'error', code: 'sync_state_persist_failed' }; }
      return { kind: 'success', skipped: true, skipReason: 'foregroundRequired', foregroundRequired: true };
    }
    const failure = toFailureDetails(error);
    const classification = classifyGoogleSyncFailure(failure, now);
    const updatedAt = now.toISOString();
    const failedState: GoogleSyncState = {
      ...state,
      status: classification.kind === 'retry' ? 'retryPending' : classification.kind,
      retryCount: classification.kind === 'retry' ? state.retryCount + 1 : state.retryCount,
      ...(classification.nextRetryAt ? { nextRetryAt: classification.nextRetryAt.toISOString() } : { nextRetryAt: undefined }),
      lastErrorCode: classification.code,
      lastErrorAt: updatedAt,
      updatedAt,
    };
    try {
      await dependencies.saveState(failedState);
    } catch {
      return { kind: 'error', code: 'sync_state_persist_failed' };
    }
    return { kind: classification.kind, code: classification.code };
  }
}

function toFailureDetails(error: unknown): GoogleSyncFailureDetails {
  if (error instanceof GoogleTasksApiError) {
    return { status: error.status, code: error.code, retryAfter: error.retryAfter };
  }
  if (error instanceof Error) {
    if (error.name === 'GoogleOAuthConfigurationError') return { code: 'oauth_not_configured' };
    if (error.name === 'GoogleSignInRequiredError') return { code: 'sign_in_required' };
    const nativeCode = (error as Error & { code?: unknown }).code;
    if (typeof nativeCode === 'string') return { code: nativeCode };
    return { code: error.name === 'AbortError' ? 'timeout' : error.name === 'TypeError' ? 'network_error' : error.name };
  }
  return { code: 'unknown_error' };
}
