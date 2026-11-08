import type { SharedWorkspace } from '../../platform/sharing/workspace-types';

export const SOLO_SHARED_POLL_INTERVAL_MS = 60 * 60_000;

/** This only gates fallback polling. Startup, remote signals and explicit/local changes still synchronize. */
export async function sharedPeriodicSyncDue(workspace: SharedWorkspace, now = Date.now()): Promise<boolean> {
  if (workspace.protocol !== 2) return true;
  try {
    const [record, checkpoint] = await Promise.all([workspace.record(), workspace.checkpoint()]);
    const roster = workspace.roster()?.body;
    if (!roster || roster.closed || roster.groupId !== workspace.groupId || roster.members.length !== 1) return true;
    const member = roster.members[0];
    if (member.userId !== workspace.userId || member.devices.length !== 1 || member.devices[0].identity.deviceId !== workspace.identity.deviceId
      || record.userId !== workspace.userId || record.groupId !== workspace.groupId || record.status !== 'active'
      || record.lastErrorCode || checkpoint.pendingCount !== 0) return true;
    const lastSuccess = record.lastSuccessfulSyncAt;
    if (typeof lastSuccess !== 'number' || !Number.isFinite(lastSuccess) || lastSuccess <= 0 || !Number.isFinite(now) || now < lastSuccess) return true;
    if (now - lastSuccess >= SOLO_SHARED_POLL_INTERVAL_MS) return true;
    // These controls are local SQLite reads, not Google requests. Remote Google
    // edits do not appear in the group outbox until fetched; keep their cadence.
    const [tasks, calendar] = await Promise.all([
      workspace.googleTasks().then(runtime => runtime.readControl()),
      workspace.googleCalendar().then(runtime => runtime.readControl()),
    ]);
    return Boolean(tasks.state?.enabled && !tasks.state.disconnected || calendar.enabled);
  } catch { return true; }
}
