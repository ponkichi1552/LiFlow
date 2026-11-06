import type { SharedSyncDependencies } from '../synchronizer.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from '../roster.ts';
import { recoverSharedRoster, sharedAuthorIdentity, sharedRosterDigest } from '../roster.ts';
import { canonicalJson } from '../operations.ts';
import { recoveryArrayContent, recoveryArrayDigest } from './recovery-content.ts';
import { sharedDocumentDigest, unwrapGroupKey, wrapGroupKey } from '../crypto.ts';
import { buildSharedReplica, compactSharedReplica } from '../replica.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../snapshots.ts';
import { loadPublishedSharedReplica, loadSharedFacts, readSharingCheckpoint } from '../../../platform/storage/sharing-ledger.ts';
import { createV2RecoveryStore } from '../../../platform/storage/sharing-v2-recovery.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { SharingAccessError } from '../cloud-contract.ts';
import { analyzeV2Recovery } from './recovery-analysis.ts';
import { signV2RecoveryWitness, verifyV2RecoveryWitnesses } from './recovery-witness.ts';
import { sealV2RecoveryHeader, v2RecoveryReviewDigest } from './recovery-encryption.ts';
import { signV2RecoveryLock } from './recovery-lock.ts';
import type { SignedV2RecoveryWitness } from './recovery-witness.ts';
import type { V2RecoveryCloudRecord } from './recovery-cloud-contract.ts';
import { MAX_V2_RECOVERY_SCAN_BYTES, MAX_V2_RECOVERY_SCAN_EVENTS, V2RecoveryLimitError, V2RecoveryStaleError } from './recovery-contract.ts';
import type { RawV2RecoveryEvent, V2RecoveryDraft, V2RecoveryReview } from './recovery-contract.ts';

type Analysis = Awaited<ReturnType<typeof analyzeV2Recovery>>;
/** Recovery is a distinct, explicitly confirmed control operation. It never manufactures a business event. */
export function createV2OwnerRecovery(deps: Omit<SharedSyncDependencies, 'v2' | 'project'> & {
  repository: ReturnType<typeof createV2EventRepository>;
  verifyMembership: (current: SignedSharedRoster) => Promise<VerifiedSharedRoster[]>;
  withMaintenance: <T>(work: () => Promise<T>) => Promise<T>;
  sync: (options?: { force?: boolean; budgetMs?: number }) => Promise<unknown>;
  assertCurrentAccount: () => void; makeId: () => string;
}) {
  const store = createV2RecoveryStore(deps.repository); const now = deps.now ?? Date.now;
  const guard = () => {
    deps.assertCurrentAccount();
    if (!deps.cloud.ownerRecoveryEnabled) throw new Error('この接続先では復旧機能の準備が完了していません。');
  };
  async function current() {
    guard(); const metadata = await deps.cloud.readGroup(deps.groupId); guard();
    const archive = await deps.verifyMembership(metadata.roster); guard(); const roster = archive.at(-1)!;
    if (roster.body.schemaVersion !== 2 || roster.body.ownerUserId !== deps.userId || roster.body.ownerDeviceId !== deps.identity.deviceId) {
      throw new SharingAccessError('復旧の確認は所有者の端末で行ってください。');
    }
    return { ...metadata, archive, roster };
  }
  type Current = Awaited<ReturnType<typeof current>>;
  async function freshKey(roster: VerifiedSharedRoster) {
    // Do not classify a valid server event as corrupt because a local key cache is damaged.
    const wrapped = await deps.cloud.readGroupKey(deps.groupId, roster.body.keyVersion, deps.identity.deviceId); guard();
    const sender = wrapped.senderDeviceId === roster.signer.deviceId ? roster.signer
      : sharedAuthorIdentity(roster, roster.body.ownerUserId, roster.body.ownerDeviceId, roster.body.keyVersion);
    return unwrapGroupKey(deps.crypto, wrapped, deps.identity, deps.userId, sender, deps.groupId, roster.body.keyVersion);
  }
  async function readPrefix(after: number, through: number) {
    if (through - after > MAX_V2_RECOVERY_SCAN_EVENTS) throw new V2RecoveryLimitError('復旧の検査対象が一度の上限を超えています。元のデータは保持されています。');
    const events: RawV2RecoveryEvent[] = []; let bytes = 0; let position = after;
    while (position < through) {
      const page = await deps.cloud.readRawRecoveryPage(deps.groupId, position, through, 20); guard();
      if (!page.length || page.some((item, index) => item.uploadSequence !== position + index + 1)) throw new V2RecoveryStaleError('復旧に必要な元の変更を取得できません。');
      for (const raw of page) {
        bytes += new TextEncoder().encode(raw.envelopeJson).length;
        if (bytes > MAX_V2_RECOVERY_SCAN_BYTES) throw new V2RecoveryLimitError('元の暗号文を安全に確認できる一度の容量を超えています。');
        events.push(raw);
      }
      position = events.at(-1)!.uploadSequence;
    }
    const receipts = [];
    for (let offset = 0; offset < events.length; offset += 1000) {
      receipts.push(...await deps.cloud.readReceipts(deps.groupId, events.slice(offset, offset + 1000).map(raw => raw.operationId))); guard();
    }
    return { events, receipts };
  }
  function reviewFor(id: string, metadata: Current, baselineSequence: number, analysis: Analysis, raw: readonly RawV2RecoveryEvent[]): V2RecoveryReview {
    const removed = new Set(analysis.removeDeviceIds);
    const removeUserIds = [...new Set([...metadata.group.revokedUserIds, ...metadata.roster.body.members
      .filter(member => member.devices.every(device => removed.has(device.identity.deviceId))).map(member => member.userId)])].sort();
    const body = { id, groupId: deps.groupId, previousRosterDigest: sharedRosterDigest(metadata.roster), baselineSequence,
      throughSequence: metadata.group.headSequence, retainedChanges: analysis.readyFacts.length, unreadableChanges: analysis.unreadableChanges,
      heldChanges: analysis.heldChanges, restoredOriginals: analysis.restoredOriginals, removeDeviceIds: analysis.removeDeviceIds, removeUserIds, entries: analysis.entries };
    const reviewDigest = v2RecoveryReviewDigest({ ...body, baselineIndexDigest: analysis.baselineIndexDigest,
      retainedIndexDigest: analysis.retainedIndexDigest, rawDigests: recoveryArrayContent(raw.map(sharedDocumentDigest)) }, deps.identity);
    return { ...body, reviewDigest };
  }
  async function readConfirmed(id: string, expectedDigest: string) {
    guard(); const saved = await store.read(); guard();
    if (!saved || saved.draft.review.id !== id || saved.draft.review.reviewDigest !== expectedDigest || saved.status === 'cancelled') {
      throw new V2RecoveryStaleError('確認した復旧内容が変わっています。元のデータを確認し直してください。');
    }
    return saved;
  }
  function matchesWitness(witness: SignedV2RecoveryWitness, draft: V2RecoveryDraft) {
    const { review } = draft; const { body } = witness;
    return body.reviewDigest === review.reviewDigest && body.previousRosterDigest === review.previousRosterDigest
      && body.baselineSequence === review.baselineSequence && body.throughSequence === review.throughSequence
      && body.baselineIndexDigest === draft.baselineIndexDigest && body.retainedIndexDigest === recoveryArrayDigest(draft.retainedBase.operationIndex)
      && canonicalJson(body.entries) === canonicalJson(review.entries);
  }
  async function recoverCommitted(metadata: Current, draft: V2RecoveryDraft, allowDifferentReview = false): Promise<string | null> {
    if (sharedRosterDigest(metadata.roster) === draft.review.previousRosterDigest) return null;
    if (!metadata.group.snapshotId) throw new V2RecoveryStaleError('共有の状態が変わりました。復旧内容を確認してください。');
    const encrypted = await deps.cloud.readSnapshot(deps.groupId, metadata.group.snapshotId, metadata.archive); guard();
    const epoch = metadata.archive.find(item => sharedRosterDigest(item) === encrypted.manifest.body.rosterDigest);
    if (!epoch || epoch.body.keyVersion !== metadata.group.keyVersion) throw new V2RecoveryStaleError('復旧後の共有鍵を確認できません。');
    const key = await freshKey(epoch);
    try {
      const snapshot = await openEncryptedSharedSnapshot(deps.crypto, encrypted, key, epoch,
        (uid, device, version) => sharedAuthorIdentity(metadata.archive[version - 1], uid, device, version), metadata.archive); guard();
      const witnesses = verifyV2RecoveryWitnesses(snapshot.base.recoveryWitnesses ?? [], metadata.archive, deps.groupId);
      const own = witnesses.find(witness => matchesWitness(witness, draft));
      if (!own) {
        // Cancellation may retire an obsolete LOCAL review only after the
        // current signed snapshot, key and witness set have all been verified.
        if (allowDifferentReview) return null;
        throw new V2RecoveryStaleError('共有は別の操作で更新されています。確認した復旧の完了とは扱いません。');
      }
      // A lost commit response must recover the actual committed key, never a regenerated next-epoch key.
      await deps.saveKey(epoch.body.keyVersion, key); guard();
      await store.markApplied(draft.review.id, draft.review.reviewDigest, own.body.snapshotId); guard();
      return own.body.snapshotId;
    } finally { key.fill(0); }
  }
  async function confirmInside(id: string, expectedDigest: string) {
    const saved = await readConfirmed(id, expectedDigest);
    const { draft } = saved; const metadata = await current();
    const committed = await recoverCommitted(metadata, draft); if (committed) return committed;
    const baseline = buildSharedReplica(deps.groupId, [], draft.baselineBase);
    const key = await freshKey(metadata.roster);
    let analysis: Analysis; let prefix: Awaited<ReturnType<typeof readPrefix>>;
    try {
      prefix = await readPrefix(draft.review.baselineSequence, metadata.group.headSequence);
      analysis = await analyzeV2Recovery({ crypto: deps.crypto, key, archive: metadata.archive, baseline,
        baselineSequence: draft.review.baselineSequence, throughSequence: metadata.group.headSequence,
        originals: await loadSharedFacts(deps.database, deps.groupId), events: prefix.events,
        receipts: new Map(prefix.receipts.map(receipt => [receipt.operationId, receipt])) }); guard();
    } finally { key.fill(0); }
    const reviewed = reviewFor(id, metadata, draft.review.baselineSequence, analysis, prefix.events);
    if (canonicalJson(reviewed) !== canonicalJson(draft.review)) throw new V2RecoveryStaleError('共有の内容が変わりました。復旧の影響を確認し直してください。');
    if (saved.status === 'review') await store.markConfirming(id, expectedDigest);
    const lock = signV2RecoveryLock(metadata.roster, deps.identity, { id, throughSequence: reviewed.throughSequence, reviewDigest: expectedDigest });
    await deps.cloud.startRecoveryLock(lock); guard();
    const next = recoverSharedRoster(metadata.roster, deps.identity, reviewed.removeDeviceIds, reviewed.removeUserIds);
    const archive = [...metadata.archive, next]; const snapshotId = `recovery.${deps.makeId()}`;
    const witness = signV2RecoveryWitness({ schemaVersion: 1, groupId: deps.groupId, snapshotId, ownerUserId: deps.userId,
      ownerDeviceId: deps.identity.deviceId, previousRosterDigest: reviewed.previousRosterDigest, nextRosterDigest: sharedRosterDigest(next),
      previousKeyVersion: metadata.roster.body.keyVersion, keyVersion: next.body.keyVersion, baselineSequence: reviewed.baselineSequence,
      throughSequence: reviewed.throughSequence, baselineIndexDigest: analysis.baselineIndexDigest, retainedIndexDigest: analysis.retainedIndexDigest,
      reviewDigest: expectedDigest, entries: reviewed.entries }, analysis.preservedFacts, deps.identity);
    verifyV2RecoveryWitnesses([...(analysis.retainedBase.recoveryWitnesses ?? []), witness], archive, deps.groupId);
    const proposed = await deps.crypto.randomBytes(32);
    try {
      const replica = buildSharedReplica(deps.groupId, [], { ...analysis.retainedBase,
        recoveryWitnesses: [...(analysis.retainedBase.recoveryWitnesses ?? []), witness] });
      const facts = [...await loadSharedFacts(deps.database, deps.groupId), ...analysis.readyFacts]; guard();
      const snapshot = await createEncryptedSharedSnapshot(deps.crypto, replica, facts, next, deps.identity, proposed, snapshotId,
        reviewed.throughSequence, (uid, device, version) => sharedAuthorIdentity(archive[version - 1], uid, device, version), archive);
      const encrypted = await sealV2RecoveryHeader(deps.crypto, { body: witness.body, signature: witness.signature }, proposed, deps.identity); guard();
      const record: V2RecoveryCloudRecord = { schemaVersion: 1, snapshotId, previousKeyVersion: metadata.roster.body.keyVersion,
        keyVersion: next.body.keyVersion, throughSequence: reviewed.throughSequence, lockId: id, reviewDigest: expectedDigest,
        encryptedHeaderJson: canonicalJson(encrypted) };
      await deps.cloud.prepareRecovery(record, lock, reviewed.entries.map(entry => ({ schemaVersion: 1, operationId: entry.operationId,
        recoveryId: snapshotId, uploadSequence: entry.uploadSequence, keyVersion: entry.keyVersion, rawDigest: entry.rawDigest }))); guard();
      await deps.cloud.prepareSnapshot(snapshot, next); guard();
      const keys = await Promise.all(next.body.members.flatMap(member => member.devices.map(device =>
        wrapGroupKey(deps.crypto, deps.groupId, next.body.keyVersion, proposed, deps.identity, device.identity, member.userId)))); guard();
      try { await deps.cloud.commitMembership(metadata.roster, next, keys, reviewed.throughSequence, snapshot.manifest, undefined, { lock, record }); }
      catch (error) {
        guard(); const actual = await current(); const recovered = await recoverCommitted(actual, draft);
        if (recovered) return recovered; throw error;
      }
      const recovered = await recoverCommitted(await current(), draft);
      if (!recovered) throw new Error('復旧の受付を確認できません。未送信変更と元の証拠は保持しています。');
      return recovered;
    } finally { proposed.fill(0); }
  }
  return {
    enabled: deps.cloud.ownerRecoveryEnabled,
    read: () => { deps.assertCurrentAccount(); return store.read(); },
    readSummary: () => { deps.assertCurrentAccount(); return store.readSummary(); },
    prepare: () => deps.withMaintenance(async () => {
      const metadata = await current(); const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId); guard();
      if (checkpoint.sequence < metadata.group.snapshotThroughSequence) throw new V2RecoveryStaleError('先に最新の共有Snapshotを受信してください。');
      const baseline = await loadPublishedSharedReplica(deps.database, deps.groupId);
      const prefix = await readPrefix(checkpoint.sequence, metadata.group.headSequence); const key = await freshKey(metadata.roster);
      try {
        const analysis = await analyzeV2Recovery({ crypto: deps.crypto, key, archive: metadata.archive, baseline, baselineSequence: checkpoint.sequence,
          throughSequence: metadata.group.headSequence, originals: await loadSharedFacts(deps.database, deps.groupId), events: prefix.events,
          receipts: new Map(prefix.receipts.map(receipt => [receipt.operationId, receipt])) }); guard();
        if (!analysis.entries.length) throw new Error('隔離・復旧が必要な変更は見つかりませんでした。通常の同期をお試しください。');
        const review = reviewFor(`review.${deps.makeId()}`, metadata, checkpoint.sequence, analysis, prefix.events);
        const draft: V2RecoveryDraft = { review, baselineIndexDigest: analysis.baselineIndexDigest, baselineBase: compactSharedReplica(baseline),
          rawEvents: prefix.events, receipts: prefix.receipts, preservedFacts: analysis.preservedFacts, readyFacts: analysis.readyFacts,
          retainedBase: analysis.retainedBase, createdAtMs: now() };
        await store.save(draft); guard(); deps.changed(); return review;
      } finally { key.fill(0); }
    }),
    async confirm(id: string, expectedDigest: string) {
      const snapshotId = await deps.withMaintenance(() => confirmInside(id, expectedDigest));
      // Adoption runs after the exclusive network maintenance section; local outbox edits merge normally.
      await deps.sync({ force: true, budgetMs: 120_000 }); deps.changed(); return snapshotId;
    },
    async cancel(id: string, expectedDigest: string) {
      const saved = await readConfirmed(id, expectedDigest);
      if (saved.status === 'applied') throw new V2RecoveryStaleError('この復旧は既に完了しています。');
      const metadata = await current();
      const previous = metadata.archive.find(epoch => sharedRosterDigest(epoch) === saved.draft.review.previousRosterDigest);
      if (!previous) throw new V2RecoveryStaleError('元の共有権限を確認できません。');
      if (sharedRosterDigest(metadata.roster) !== saved.draft.review.previousRosterDigest) {
        if (await recoverCommitted(metadata, saved.draft, true)) throw new V2RecoveryStaleError('この復旧は既に完了しています。');
        // A forward-only roster change makes a late start under the previous
        // signed epoch impossible. Do not cancel another recovery's cloud lock.
        await store.markCancelled(id, expectedDigest); guard(); deps.changed(); return;
      }
      await deps.cloud.cancelRecoveryLock(signV2RecoveryLock(previous, deps.identity, { id,
        throughSequence: saved.draft.review.throughSequence, reviewDigest: expectedDigest })); guard();
      await store.markCancelled(id, expectedDigest); guard(); deps.changed();
    },
  };
}
