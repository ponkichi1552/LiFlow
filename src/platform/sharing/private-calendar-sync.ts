import { hasSharingSessionEnabled, sharingSessionUser } from './workspaces';
import { openPrivateCalendarRuntime } from './private-calendar-runtime';
import { PRIVATE_CALENDAR_AUTOMATIC_BUDGET_MS } from '../../features/sharing/private-calendar/sync-deadline';

/** No task registration, Firebase initialization or key generation occurs on import. */
export async function syncKnownPrivateCalendar(budgetMs = PRIVATE_CALENDAR_AUTOMATIC_BUDGET_MS) {
  if (!await hasSharingSessionEnabled()) return { kind: 'skipped' as const };
  const user = await sharingSessionUser(); if (!user) return { kind: 'skipped' as const };
  return openPrivateCalendarRuntime(user.uid).synchronizeAutomatically({ budgetMs });
}
export async function isPrivateCalendarWorkerNeeded(): Promise<boolean> {
  if (!await hasSharingSessionEnabled()) return false;
  const user = await sharingSessionUser(); if (!user) return false;
  const { device } = await openPrivateCalendarRuntime(user.uid).readSettings();
  return device.phase === 'approved' || device.phase === 'firstPending';
}
export function startPrivateCalendarForeground(userId: string): () => void {
  return openPrivateCalendarRuntime(userId).observeRemote(async () => {
    const { registerGoogleSyncBackgroundTask } = await import('../../features/google-sync/background-task');
    await registerGoogleSyncBackgroundTask();
  });
}
