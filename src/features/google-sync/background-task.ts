import * as BackgroundTask from 'expo-background-task';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

export const GOOGLE_SYNC_BACKGROUND_TASK = 'housework-planner-google-tasks-sync';
const MINIMUM_INTERVAL_MINUTES = 60;

TaskManager.defineTask(GOOGLE_SYNC_BACKGROUND_TASK, async ({ error }) => {
  // Register at module scope, but load synchronization code only when the OS runs it.
  const { subscriptionRequired, subscriptionAccessDeadline } = await import('@/platform/subscription/runtime');
  if (subscriptionRequired && await subscriptionAccessDeadline() <= Date.now()) return BackgroundTask.BackgroundTaskResult.Failed;
  let auditDatabase: SQLite.SQLiteDatabase | null = null;
  let audit: ReturnType<typeof import('./background-audit').createBackgroundAudit> | undefined; let runId: number | undefined;
  try {
    const { createBackgroundAudit } = await import('./background-audit');
    auditDatabase = await SQLite.openDatabaseAsync('background-sync-audit.db', { useNewConnection: true });
    audit = createBackgroundAudit(auditDatabase); runId = await audit.begin(Date.now(), !__DEV__);
  } catch { /* Diagnostics must not prevent pending user changes from synchronizing. */ }
  const record = (domain: 'personal' | 'privateCalendar' | 'sharing', failed: boolean) =>
    runId === undefined ? Promise.resolve() : audit!.domain(runId, domain, failed ? 'failed' : 'success').catch(() => undefined);
  if (error) {
    if (runId !== undefined) await audit!.finish(runId, Date.now(), true).catch(() => undefined);
    await auditDatabase?.closeAsync().catch(() => undefined);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
  let database: SQLite.SQLiteDatabase | null = null;
  let failed = false; let domainFailed = false;
  try {
    database = await SQLite.openDatabaseAsync('housework.db', { useNewConnection: true });
    const { initializeLocalDatabase, loadGoogleSyncState, LOCAL_HOUSEHOLD_ID } = await import('@/platform/storage/repository');
    await initializeLocalDatabase(database);
    const state = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
    if (state?.enabled) {
      const { syncGoogleTasks } = await import('./coordinator');
      const result = await syncGoogleTasks(database);
      // The coordinator persists transport/auth failures and resolves with their classification.
      // A resolved promise is therefore not proof of a successful synchronization.
      if (result.kind !== 'success') { failed = true; domainFailed = true; }
    }
  } catch {
    failed = true; domainFailed = true;
  } finally {
    await record('personal', domainFailed); domainFailed = false;
    let calendarOutcome: 'success' | 'failed' | 'skipped' | 'pending' = 'skipped';
    if (database) try {
      const { nativePersonalGoogleCalendar } = await import('@/platform/google-calendar/personal-runtime');
      const result = await nativePersonalGoogleCalendar(database).sync({ budgetMs: 15_000 });
      calendarOutcome = result.kind === 'error' ? 'failed' : result.kind;
      if (calendarOutcome === 'failed') failed = true;
    } catch { failed = true; calendarOutcome = 'failed'; }
    if (runId !== undefined) await audit!.domain(runId, 'personalGoogleCalendar', calendarOutcome).catch(() => undefined);
    await database?.closeAsync().catch(() => undefined);
  }
  try {
    const { syncKnownPrivateCalendar } = await import('@/platform/sharing/private-calendar-sync');
    await syncKnownPrivateCalendar(15_000);
  } catch { failed = true; domainFailed = true; }
  await record('privateCalendar', domainFailed); domainFailed = false;
  try {
    const { syncSharingWorkspace } = await import('@/platform/sharing/workspaces');
    await syncSharingWorkspace(30_000);
  } catch { failed = true; domainFailed = true; }
  await record('sharing', domainFailed);
  if (runId !== undefined) await audit!.finish(runId, Date.now(), failed).catch(() => undefined);
  await auditDatabase?.closeAsync().catch(() => undefined);
  // Each domain keeps its own retries. One storage failure cannot prevent the other domain from running.
  return failed ? BackgroundTask.BackgroundTaskResult.Failed : BackgroundTask.BackgroundTaskResult.Success;
});

let registrationTail: Promise<unknown> = Promise.resolve();
function serializeRegistration<T>(work: () => Promise<T>): Promise<T> {
  const next = registrationTail.then(work, work); registrationTail = next.catch(() => undefined); return next;
}
export function registerGoogleSyncBackgroundTask(): Promise<boolean> {
  return serializeRegistration(registerWorker);
}
async function registerWorker(): Promise<boolean> {
  if (!(await TaskManager.isAvailableAsync())) return false;
  if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) return false;
  const registered = await TaskManager.getRegisteredTasksAsync();
  if (!registered.some((task) => task.taskName === GOOGLE_SYNC_BACKGROUND_TASK)) {
    await BackgroundTask.registerTaskAsync(GOOGLE_SYNC_BACKGROUND_TASK, { minimumInterval: MINIMUM_INTERVAL_MINUTES });
  }
  return true;
}

export function unregisterGoogleSyncBackgroundTask(): Promise<void> {
  return serializeRegistration(async () => {
    const { isSharedWorkerNeeded } = await import('@/platform/sharing/workspaces');
    if (await isSharedWorkerNeeded()) { await registerWorker(); return; }
    const database = await SQLite.openDatabaseAsync('housework.db', { useNewConnection: true });
    try {
      const { readPersonalGoogleCalendarControl } = await import('@/platform/storage/personal-google-calendar');
      if ((await readPersonalGoogleCalendarControl(database)).enabled) { await registerWorker(); return; }
    } finally { await database.closeAsync(); }
    await unregisterWorker();
  });
}
async function unregisterWorker(): Promise<void> {
  if (!(await TaskManager.isAvailableAsync())) return;
  const registered = await TaskManager.getRegisteredTasksAsync();
  if (registered.some((task) => task.taskName === GOOGLE_SYNC_BACKGROUND_TASK)) {
    await BackgroundTask.unregisterTaskAsync(GOOGLE_SYNC_BACKGROUND_TASK);
  }
}
