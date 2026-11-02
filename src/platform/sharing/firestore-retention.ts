import { collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, orderBy, query, runTransaction, where } from 'firebase/firestore';
import type { DocumentReference } from 'firebase/firestore';
import type { SharingCloudContext } from './firestore-context';
import { parseSharedCloudGroup, SharingCloudChangedError } from '../../features/sharing/cloud-contract.ts';
import type { V2RetentionBody } from '../../features/sharing/v2/history-retention-schema';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';

/** A certified new-key snapshot makes every older ciphertext recoverable without its original archive. */
export function createSharingHistoryRetention({ firestore, userId, checkAccount, reference, readGroup }: SharingCloudContext) {
  const receiptPositions = new Map<string, { digest: string; sequence: number }>();
  return { async compactCertifiedHistory(groupId: string, checkpoint: V2RetentionBody, retainedOperationIds: ReadonlySet<string>, checkBudget: () => void = () => {}) {
    const guard = () => { checkAccount(); checkBudget(); }; guard();
    const { group } = await readGroup(groupId); guard();
    if (group.ownerUserId !== userId || group.rotationRequired || !group.snapshotId || group.retentionCutoff !== checkpoint.cutoff
      || group.retentionThroughSequence !== checkpoint.throughSequence || group.retentionKeyVersion !== checkpoint.keyVersion
      || group.keyVersion <= checkpoint.keyVersion) throw new SharingCloudChangedError('履歴整理の共有状態を確認してください。');
    const ref = reference(groupId); const lock = doc(ref, 'recoveryLocks', 'current');
    if ((await getDocFromServer(lock)).data()?.keyVersion === group.keyVersion) throw new SharingCloudChangedError('復旧の確認を終えてから履歴を整理します。');
    guard(); const removals: DocumentReference[] = []; let pending = false;
    // Current chunks and prepared future epochs can never match these source-key ranges.
    for (const name of ['events', 'snapshots', 'snapshotChunks', 'quarantines', 'recoveries', 'receipts'] as const) {
      guard(); const room = 100 - removals.length; if (!room) { pending = true; break; }
      const isSequence = ['events', 'quarantines', 'receipts'].includes(name);
      const field = isSequence ? 'uploadSequence' : 'keyVersion'; const boundary = isSequence ? checkpoint.throughSequence : checkpoint.keyVersion;
      const digest = sharedDocumentDigest(checkpoint); const cursor = name === 'receipts' ? receiptPositions.get(groupId) : undefined;
      const after = cursor?.digest === digest ? cursor.sequence : undefined;
      const page = await getDocsFromServer(query(collection(ref, name), where(field, '<=', boundary), orderBy(field), orderBy(documentId()),
        ...(after === undefined ? [] : [where(field, '>', after)]), limit(room))); guard();
      pending ||= page.size === room;
      for (const item of page.docs) if (name !== 'receipts' || !retainedOperationIds.has(item.id)) removals.push(item.ref);
      if (name === 'receipts') {
        if (page.size === room && page.docs.length) receiptPositions.set(groupId, { digest, sequence: page.docs.at(-1)!.data().uploadSequence });
        else receiptPositions.delete(groupId);
      }
    }
    // Each transaction rechecks the exact root. A concurrent rotation/publication leaves the new snapshot intact.
    let deleted = 0;
    for (let offset = 0; offset < removals.length; offset += 10) {
      guard(); const count = await runTransaction(firestore, async transaction => {
        guard(); const current = parseSharedCloudGroup((await transaction.get(ref)).data(), groupId).group;
        const recovery = await transaction.get(lock);
        if (current.snapshotId !== group.snapshotId || current.keyVersion !== group.keyVersion || current.retentionThroughSequence !== checkpoint.throughSequence
          || recovery.data()?.keyVersion === current.keyVersion) throw new SharingCloudChangedError('履歴整理中に共有状態が更新されました。');
        for (const item of removals.slice(offset, offset + 10)) transaction.delete(doc(firestore, item.path));
        return Math.min(10, removals.length - offset);
      }); guard(); deleted += count;
    }
    return { deleted, pending };
  } };
}
