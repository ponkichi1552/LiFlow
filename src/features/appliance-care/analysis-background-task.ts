import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

const taskName = 'housework-planner-appliance-analysis-result';
let registration = Promise.resolve();

export function setAnalysisBackgroundTask(needsTask: () => Promise<boolean | undefined>): Promise<void> {
  const next = registration.then(async () => {
    if (!await TaskManager.isAvailableAsync()) return;
    const registered = await TaskManager.isTaskRegisteredAsync(taskName);
    const pending = await needsTask();
    // Expo uses one native worker for every task. Retain the existing sync interval.
    if (pending === true && !registered) await BackgroundTask.registerTaskAsync(taskName, { minimumInterval: 60 });
    else if (pending === false && registered) await BackgroundTask.unregisterTaskAsync(taskName);
  });
  registration = next.catch(() => undefined);
  return next;
}

TaskManager.defineTask(taskName, async ({ error }) => {
  if (error) return BackgroundTask.BackgroundTaskResult.Failed;
  try {
    const { subscriptionRequired, subscriptionAccessDeadline } = await import('../../platform/subscription/runtime');
    const canAnalyze = async () => !subscriptionRequired || await subscriptionAccessDeadline() > Date.now();
    const { currentAnalysisOwner, hasNativeAnalysisBackgroundWork, resumeAnalysisWork } = await import('../../platform/appliance-care/analysis-work');
    const owner = await currentAnalysisOwner();
    if (!owner) {
      await setAnalysisBackgroundTask(async () => await currentAnalysisOwner() === null ? false : undefined);
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    const { openDatabaseAsync } = await import('expo-sqlite');
    const database = await openDatabaseAsync('housework.db', { useNewConnection: true });
    try {
      let failed = false;
      if (await canAnalyze()) await resumeAnalysisWork(database, owner, { timeoutMs: 20_000 }).catch(() => { failed = true; });
      const { deviceAnalysisDeliveries } = await import('../../platform/storage/analysis-deliveries');
      const { recoverNativeAnalysisReceipts } = await import('../../platform/appliance-care/receipt-recovery');
      await recoverNativeAnalysisReceipts(deviceAnalysisDeliveries(database), { expectedOwner: owner, background: true }).catch(() => { failed = true; });
      await setAnalysisBackgroundTask(async () => {
        if (await currentAnalysisOwner() !== owner) return undefined;
        return hasNativeAnalysisBackgroundWork(database, owner, await canAnalyze());
      });
      return failed ? BackgroundTask.BackgroundTaskResult.Failed : BackgroundTask.BackgroundTaskResult.Success;
    } finally { await database.closeAsync(); }
  } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
});
