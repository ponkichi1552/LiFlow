import type { SharedWorkspace } from '../../platform/sharing/workspace-types';
import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry';

export class SharingInitialSyncPendingError extends Error {
  readonly code = 'sharing/initial-sync-pending';
  constructor() { super('共有グループを復元中です。'); }
}
export function isSharingInitialSyncPending(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'sharing/initial-sync-pending');
}

const preparing = new WeakMap<SharedWorkspace, Promise<void>>();
/** Approved membership can arrive before the planner. Never publish a selection before its verified data. */
export function prepareSharedWorkspaceSelection(workspace: SharedWorkspace, record: SharingWorkspaceRecord): Promise<void> {
  const current = preparing.get(workspace); if (current) return current;
  const work = (async () => {
    try { await workspace.readOverview(); return; }
    catch (cause) {
      if (workspace.protocol !== 2 || record.status !== 'active' || record.lastSuccessfulSyncAt !== null) throw cause;
    }
    const result = await workspace.sync({ budgetMs: 20_000 });
    if (!result.complete || result.waitingForApproval) throw new SharingInitialSyncPendingError();
    await workspace.readOverview();
  })();
  preparing.set(workspace, work);
  void work.finally(() => { if (preparing.get(workspace) === work) preparing.delete(workspace); }).catch(() => undefined);
  return work;
}
