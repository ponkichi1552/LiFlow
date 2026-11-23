import { sharedDocumentDigest, signSharedDocument, validateDevicePublicIdentity, verifyAuthenticatedSharedOperation, verifySharedDocument } from '../crypto.ts';
import type { AuthenticatedSharedOperation, DevicePublicIdentity, DeviceSecretIdentity } from '../crypto.ts';
import { canonicalJson } from '../operations.ts';
import { buildSharedReplica } from '../replica.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifyPinnedSharedRoster, verifySharedRosterTransition } from '../roster.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from '../roster.ts';
import { assessV2BusinessHistory } from './receiver-authority.ts';
import { bindV2ServerReceipt, validateV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import { assertWorkspaceCopyScopes, maxCopyRosterRevisions, workspaceCopyPin, type WorkspaceCopyDestination, type WorkspaceCopyOrigin, type WorkspaceCopyPosition } from './workspace-copy-origin.ts';

export interface WorkspaceCopyData {
  rosters: SignedSharedRoster[];
  facts: AuthenticatedSharedOperation[];
  receipts: V2ServerReceipt[];
}

export interface SignedWorkspaceCopy {
  body: {
    schemaVersion: 1;
    source: WorkspaceCopyPosition;
    destination: WorkspaceCopyDestination;
    exporterUserId: string;
    contentDigest: string;
  };
  data: WorkspaceCopyData;
  signer: DevicePublicIdentity;
  signature: string;
}

export function verifyCopyOrigin(copy: SignedWorkspaceCopy, origin: WorkspaceCopyOrigin, destinationId: string) {
  const verified = verifyWorkspaceCopy(copy, workspaceCopyPin(origin), { groupId: destinationId, userIds: origin.userIds });
  if (verified.archive.at(-1)?.body.revision !== origin.revision) throw new Error('元グループの承認履歴の版が一致しません。');
  return verified;
}

function checkedSource(source: WorkspaceCopyPosition, data: WorkspaceCopyData) {
  const { rosters, facts, receipts } = data;
  if (!Array.isArray(rosters) || !rosters.length || rosters.length > maxCopyRosterRevisions
    || !Array.isArray(facts) || facts.length !== source.sequence
    || !Array.isArray(receipts) || receipts.length !== source.sequence) {
    throw new Error('元グループの署名付きデータをすべて照合できません。');
  }
  const root = rosters[0];
  if (root.body.revision !== 1 || root.body.schemaVersion !== 2) {
    throw new Error('旧形式から移行済みの履歴には元グループの保存データが必要です。');
  }
  const archive: VerifiedSharedRoster[] = [verifyPinnedSharedRoster(root, {
    groupId: source.groupId, digest: sharedRosterDigest(root), ownerUserId: root.body.ownerUserId, ownerIdentity: root.signer,
  })];
  for (const revision of rosters.slice(1)) archive.push(verifySharedRosterTransition(archive.at(-1)!, revision));
  const tip = archive.at(-1)!;
  if (tip.body.closed || sharedRosterDigest(tip) !== source.rosterDigest) throw new Error('元グループの承認状態が変わりました。');

  const signed = new Map<string, AuthenticatedSharedOperation>();
  for (const fact of facts) {
    const operation = fact.operation;
    const epoch = archive[operation.keyVersion - 1];
    if (operation.schemaVersion !== 2 || !epoch || epoch.body.keyVersion !== operation.keyVersion || signed.has(operation.operationId)) {
      throw new Error('元グループの変更履歴と署名を照合できません。');
    }
    const author = sharedAuthorIdentity(epoch, operation.authorUserId, operation.authorDeviceId, operation.keyVersion);
    signed.set(operation.operationId, verifyAuthenticatedSharedOperation(fact, author, source.groupId));
  }
  const sequences = new Set<number>();
  const evidence = new Map<string, V2ServerReceipt>();
  for (const raw of receipts) {
    const receipt = validateV2ServerReceipt(raw);
    const original = signed.get(receipt.operationId);
    if (!original || evidence.has(receipt.operationId) || sequences.has(receipt.uploadSequence) || receipt.uploadSequence > source.sequence) {
      throw new Error('受信位置までの受付記録が揃っていません。');
    }
    bindV2ServerReceipt(receipt, original, archive);
    sequences.add(receipt.uploadSequence);
    evidence.set(receipt.operationId, receipt);
  }
  const replica = buildSharedReplica(source.groupId, [...signed.values()].map(fact => fact.operation));
  const assessment = assessV2BusinessHistory(replica, archive, undefined, { receipts: evidence, facts: signed, pendingLocalIds: new Set() });
  if (replica.pendingOperationIds.length || assessment.rejected.length || assessment.provisionalOperationIds.length
    || assessment.view.ready.length !== signed.size) {
    throw new Error('照合できない共有変更があります。元グループで確認してください。');
  }
  return { archive, replica, assessment, receipts: evidence };
}

const signatureInput = (body: SignedWorkspaceCopy['body']) => ({ domain: 'liflow-shared-workspace-copy-v1', body });

/** The source roster itself remains unchanged. A current source device certifies the export for approved users only. */
export function signWorkspaceCopy(source: WorkspaceCopyPosition, destination: WorkspaceCopyDestination, data: WorkspaceCopyData,
  exporterUserId: string, identity: DeviceSecretIdentity): SignedWorkspaceCopy {
  assertWorkspaceCopyScopes(source, destination);
  const { archive } = checkedSource(source, data);
  const tip = archive.at(-1)!;
  assertDestinationMembers(destination, exporterUserId, tip);
  const signer = sharedAuthorIdentity(tip, exporterUserId, identity.deviceId, tip.body.keyVersion);
  const body = { schemaVersion: 1 as const, source: { ...source }, destination: { groupId: destination.groupId, userIds: [...destination.userIds].sort() },
    exporterUserId, contentDigest: sharedDocumentDigest(data) };
  return { body, data, signer, signature: signSharedDocument(signatureInput(body), identity) };
}

function assertDestinationMembers(destination: WorkspaceCopyDestination, exporterUserId: string, tip: VerifiedSharedRoster) {
  if (!destination.userIds.includes(exporterUserId) || destination.userIds.some(uid => !tip.body.members.some(member => member.userId === uid))) {
    throw new Error('引き継ぐ利用者は元グループの承認済みメンバーから選んでください。');
  }
}

/** The caller pins the source head from its authenticated source scope and the intended destination from its own approval. */
export function verifyWorkspaceCopy(copy: SignedWorkspaceCopy, source: WorkspaceCopyPosition, destination: WorkspaceCopyDestination) {
  assertWorkspaceCopyScopes(source, destination);
  const { body, data } = copy;
  if (body.schemaVersion !== 1 || canonicalJson(body.source) !== canonicalJson(source)
    || canonicalJson(body.destination) !== canonicalJson({ groupId: destination.groupId, userIds: [...destination.userIds].sort() })) {
    throw new Error('保存した引き継ぎデータの対象または受信位置が違います。');
  }
  const state = checkedSource(source, data);
  const tip = state.archive.at(-1)!;
  assertDestinationMembers(destination, body.exporterUserId, tip);
  const signer = sharedAuthorIdentity(tip, body.exporterUserId, validateDevicePublicIdentity(copy.signer).deviceId, tip.body.keyVersion);
  if (canonicalJson(signer) !== canonicalJson(copy.signer) || body.contentDigest !== sharedDocumentDigest(data)) {
    throw new Error('引き継ぎデータが元の署名と一致しません。');
  }
  verifySharedDocument(signatureInput(body), copy.signature, signer);
  return state;
}
