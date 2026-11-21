import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

const taskName = 'housework-planner-appliance-analysis-result';
let registration = Promise.resolve();

export function setAnalysisBackgroundTask(pending: boolean): Promise<void> {
  const next = registration.then(async () => {
    if (!await TaskManager.isAvailableAsync()) return;
    const registered = await TaskManager.isTaskRegisteredAsync(taskName);
    // Expo uses one native worker for every task. Retain the existing sync interval.
    if (pending && !registered) await BackgroundTask.registerTaskAsync(taskName, { minimumInterval: 60 });
    else if (!pending && registered) await BackgroundTask.unregisterTaskAsync(taskName);
  });
  registration = next.catch(() => undefined);
  return next;
}

TaskManager.defineTask(taskName, async ({ error }) => {
  if (error) return BackgroundTask.BackgroundTaskResult.Failed;
  try {
    const { subscriptionRequired, subscriptionAccessDeadline } = await import('../../platform/subscription/runtime');
    if (subscriptionRequired && await subscriptionAccessDeadline() <= Date.now()) return BackgroundTask.BackgroundTaskResult.Failed;
    const { currentAnalysisOwner, resumeAnalysisWork } = await import('../../platform/appliance-care/analysis-work');
    const owner = await currentAnalysisOwner();
    if (!owner) {
      await setAnalysisBackgroundTask(false);
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    const { openDatabaseAsync } = await import('expo-sqlite');
    const database = await openDatabaseAsync('housework.db', { useNewConnection: true });
    try {
      const pending = await resumeAnalysisWork(database, owner, { timeoutMs: 20_000 });
      const { deviceAnalysisDeliveries } = await import('../../platform/storage/analysis-deliveries');
      const { recoverNativeAnalysisReceipts } = await import('../../platform/appliance-care/receipt-recovery');
      await recoverNativeAnalysisReceipts(deviceAnalysisDeliveries(database)).catch(() => undefined);
      if (!pending) await setAnalysisBackgroundTask(false);
    } finally { await database.closeAsync(); }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
});
