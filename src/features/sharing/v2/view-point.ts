import type { SharedOperation } from '../operations.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { V2HistoryView } from './history-view.ts';

/** A local read boundary, never a signed fact, never written into the ledger or cloud. */
export function v2ReadPoint(view: V2HistoryView, roster: VerifiedSharedRoster): SharedOperation {
  if (roster.body.groupId !== view.groupId || roster.body.schemaVersion !== 2) throw new Error('Invalid common read scope');
  const context: Record<string, number> = { ...view.retainedFrontier() }; let clock = 0;
  for (const op of view.ready) { context[op.authorDeviceId] = Math.max(context[op.authorDeviceId] ?? 0, op.deviceSequence); clock = Math.max(clock, op.logicalClock); }
  return { schemaVersion: 2, groupId: view.groupId, operationId: 'local-read-point', authorUserId: roster.body.ownerUserId,
    authorDeviceId: roster.body.ownerDeviceId, keyVersion: roster.body.keyVersion, context, logicalClock: clock + 1,
    deviceSequence: (context[roster.body.ownerDeviceId] ?? 0) + 1, recordedAt: '1970-01-01T00:00:00Z', receiptContext: view.confirmedReceiptContext() ?? context,
    entityType: 'member', entityId: roster.body.ownerUserId, operationType: 'patch', payload: {} };
}
