import { canonicalJson, causallyPrecedes } from '../operations.ts';
import type { SharedOperation } from '../operations';
import { sharedDocumentDigest, verifyAuthenticatedSharedOperation } from '../crypto.ts';
import type { AuthenticatedSharedOperation } from '../crypto';
import { sharedAuthorIdentity, sharedRosterDigest } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster';
import type { SharedReplica, SharedSnapshotBase } from '../replica';
import { validateV2RetentionBody, validateV2RetentionPayload } from './history-retention-schema.ts';
import type { V2RetentionBody } from './history-retention-schema';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts';
import { choreHistoryCutoff } from '../../../domain/chores/history-retention.ts';
import { sharedLocalDate } from '../group-clock.ts';

export interface V2RetentionWitness {
  proposal: AuthenticatedSharedOperation; proposalReceipt: V2ServerReceipt; approvals: AuthenticatedSharedOperation[];
}
export const retentionDigest = (values: readonly unknown[]) => sharedDocumentDigest(Array.from({ length: Math.ceil(values.length / 1000) }, (_, index) => sharedDocumentDigest(values.slice(index * 1000, (index + 1) * 1000))));
export const retentionCovered = (operation: SharedOperation, body: V2RetentionBody) => operation.deviceSequence <= (body.frontier[operation.authorDeviceId] ?? 0);
export function retentionOperationsDigest(values: readonly SharedOperation[]) { return retentionDigest([...values].sort((a, b) => a.operationId.localeCompare(b.operationId)).map(sharedDocumentDigest)); }
export function retentionIndexDigest(values: SharedSnapshotBase['operationIndex']) { return retentionDigest([...values].sort((a, b) => a.operationId.localeCompare(b.operationId))); }
function authenticate(fact: AuthenticatedSharedOperation, archive: readonly VerifiedSharedRoster[], groupId: string) {
  const op = fact.operation; const epoch = archive.find(row => row.body.keyVersion === op.keyVersion);
  if (!epoch) throw new Error('Unknown retention signing epoch');
  return verifyAuthenticatedSharedOperation(fact, sharedAuthorIdentity(epoch, op.authorUserId, op.authorDeviceId, op.keyVersion), groupId);
}
/** Collective checkpoint: the owner cannot replace another member's history with an owner-only snapshot. */
export function verifyV2RetentionWitness(witness: V2RetentionWitness, archive: readonly VerifiedSharedRoster[], groupId: string): V2RetentionBody {
  if (!witness || Object.keys(witness).sort().join(',') !== 'approvals,proposal,proposalReceipt' || !Array.isArray(witness.approvals) || witness.approvals.length > 64) throw new Error('Invalid retention certificate');
  const proposal = authenticate(witness.proposal, archive, groupId).operation;
  validateV2RetentionPayload(proposal.payload);
  if (proposal.schemaVersion !== 2 || proposal.entityType !== 'historyRetention' || proposal.payload.phase !== 'proposal') throw new Error('Invalid retention proposal');
  const body = validateV2RetentionBody(proposal.payload.checkpoint);
  const epoch = archive.find(row => row.body.keyVersion === body.keyVersion);
  if (!epoch || body.groupId !== groupId || body.rosterDigest !== sharedRosterDigest(epoch) || proposal.keyVersion !== body.keyVersion
    || proposal.authorUserId !== epoch.body.ownerUserId || proposal.deviceSequence !== (body.frontier[proposal.authorDeviceId] ?? 0) + 1) throw new Error('Retention proposal does not bind its membership');
  const frontier = Object.fromEntries(Object.entries(body.frontier).filter(([, number]) => number > 0));
  if (canonicalJson(frontier) !== canonicalJson(proposal.context)) throw new Error('Retention proposal changed its observed frontier');
  bindV2ServerReceipt(witness.proposalReceipt, witness.proposal, archive);
  if (witness.proposalReceipt.uploadSequence <= body.throughSequence || body.cutoff > choreHistoryCutoff(sharedLocalDate(new Date(witness.proposalReceipt.receivedAtMs), body.timeZone))) throw new Error('Retention cannot delete an unexpired report');
  const approved = new Set<string>();
  for (const original of witness.approvals) {
    const approval = authenticate(original, archive, groupId).operation; validateV2RetentionPayload(approval.payload);
    if (approval.schemaVersion !== 2 || approval.entityType !== 'historyRetention' || approval.payload.phase !== 'approve'
      || approval.keyVersion !== body.keyVersion || !causallyPrecedes(proposal, approval)
      || approval.payload.proposalId !== proposal.operationId || approval.payload.checkpointDigest !== sharedDocumentDigest(body)
      || approval.payload.receiptDigest !== sharedDocumentDigest(witness.proposalReceipt)
      || !epoch.body.members.some(member => member.userId === approval.authorUserId)
      || approved.has(approval.authorUserId)) throw new Error('Invalid or duplicate retention approval');
    approved.add(approval.authorUserId);
  }
  if (epoch.body.members.some(member => !approved.has(member.userId))) throw new Error('History deletion requires every current member to verify the checkpoint');
  return body;
}
export function assertV2RetentionBase(replica: Pick<SharedReplica, 'groupId' | 'operations' | 'operationIndex'>, witness: V2RetentionWitness, archive: readonly VerifiedSharedRoster[]) {
  const body = verifyV2RetentionWitness(witness, archive, replica.groupId);
  const operations = replica.operations.filter(op => retentionCovered(op, body));
  const receipts = replica.operationIndex.filter(row => row.sequence <= (body.frontier[row.deviceId] ?? 0));
  if (retentionOperationsDigest(operations) !== body.retainedFactsDigest || retentionIndexDigest(receipts) !== body.indexDigest) throw new Error('Retained state differs from the jointly verified checkpoint');
  if (body.retainedCount !== operations.length) throw new Error('Retained authority index differs from its facts');
  return body;
}
