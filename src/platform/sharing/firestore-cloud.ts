import { collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query,
  runTransaction, serverTimestamp, startAfter, where, writeBatch } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import { assertSharedIdentifier, canonicalJson } from '../../features/sharing/operations.ts';
import { assertSharedCloudAccess, parseSharedCloudEvent, parseSharedCloudGroup, rosterCloudFields,
  SharingAccessError, SharingKeyVersionError, SharingSchedulerVersionError, SharingSnapshotRequiredError } from '../../features/sharing/cloud-contract.ts';
import type { EncryptedSharedOperation, WrappedGroupKey } from '../../features/sharing/crypto.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { createSharingManagement } from './firestore-management.ts';
import { createSharingRecovery, parseFirestoreRecoveryLock } from './firestore-recovery.ts';
import { V2RecoveryInProgressError, verifyV2RecoveryLock } from '../../features/sharing/v2/recovery-lock.ts';
import { sharingCloudWithDeadline } from './network-deadline.ts';
import { parseV2FirestoreReceipt } from './v2-receipts.ts';
import type { V2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';
import { createSharingHistoryRetention } from './firestore-retention.ts';
import type { SharedCloudEvent } from '../../features/sharing/cloud-contract.ts';
import { createSharingAccountDevices } from './firestore-account-devices.ts';

/** All reads use the server; Firestore's memory cache cannot acknowledge delivery. */
export function createSharingCloud(firestore: Firestore, userId: string, currentUserId: () => string | null,
  options: { ownerRecoveryEnabled?: boolean } = {}) {
  assertSharedIdentifier(userId);
  const recoveryEnabled = options.ownerRecoveryEnabled === true;
  const checkAccount = () => { if (currentUserId() !== userId) throw new SharingAccessError('共有アカウントが切り替わりました。'); };
  const reference = (groupId: string) => { assertSharedIdentifier(groupId); return doc(firestore, 'sharingGroups', groupId); };
  const readGroup = async (groupId: string) => {
    checkAccount(); const response = await getDocFromServer(reference(groupId)); checkAccount();
    const parsed = parseSharedCloudGroup(response.data(), groupId); assertSharedCloudAccess(parsed.group, userId);
    return parsed;
  };
  const confirmRemoval = async (groupId: string) => {
    const membership = await getDocFromServer(doc(firestore, 'sharingUsers', userId, 'memberships', 'current')); checkAccount();
    if (!membership.exists() || membership.data().groupId !== groupId) return;
    // A stale index can remain after a signed removal. This empty-document probe
    // is readable only when Rules confirm paid access AND this user's revocation.
    // Unknown access or subscription expiry rejects it instead of proving removal.
    await getDocFromServer(doc(firestore, 'sharingUsers', userId, 'revocations', groupId)); checkAccount();
  };
  return sharingCloudWithDeadline({
    ...createSharingAccountDevices({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled }),
    ...createSharingManagement({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled }),
    ...createSharingHistoryRetention({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled }),
    ...createSharingRecovery({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled }),
    ownerRecoveryEnabled: recoveryEnabled,
    readGroup,
    async readMembership(): Promise<string | null> {
      checkAccount(); const result = await getDocFromServer(doc(firestore, 'sharingUsers', userId, 'memberships', 'current')); checkAccount();
      if (!result.exists()) return null;
      const value = result.data(); const groupId = value.groupId; assertSharedIdentifier(groupId);
      if (value.invitationId !== null) {
        assertSharedIdentifier(value.invitationId);
        const invitation = await getDocFromServer(doc(firestore, 'sharingInvites', value.invitationId)); checkAccount();
        if (invitation.data()?.status === 'open' && invitation.data()?.expiresAt?.toMillis() > Date.now()) return groupId;
      }
      try { await readGroup(groupId); return groupId; }
      catch (error) {
        if ((error as { code?: string }).code !== 'permission-denied') throw error;
        await confirmRemoval(groupId); return null;
      }
    },
    async hasMembership(groupId: string): Promise<boolean> {
      assertSharedIdentifier(groupId); checkAccount();
      try { await readGroup(groupId); return true; }
      catch (error) {
        if ((error as { code?: string }).code !== 'permission-denied') throw error;
        await confirmRemoval(groupId); return false;
      }
    },
    /** Adopt the already displayed pre-index membership without rejoining or replacing any group data. */
    async bindMembership(groupId: string): Promise<void> {
      assertSharedIdentifier(groupId); checkAccount();
      await runTransaction(firestore, async transaction => {
        checkAccount(); const membershipRef = doc(firestore, 'sharingUsers', userId, 'memberships', 'current');
        const old = await transaction.get(membershipRef);
        if (old.exists() && old.data().groupId !== groupId) throw new SharingAccessError('別のグループへの所属が確定しています。参加状態を確認してください。');
        if (old.exists() && old.data().invitationId === null) return;
        const { group } = parseSharedCloudGroup((await transaction.get(reference(groupId))).data(), groupId); assertSharedCloudAccess(group, userId);
        transaction.set(membershipRef, { groupId, invitationId: null, createdAt: serverTimestamp() });
      }); checkAccount();
    },
    async createGroup(roster: VerifiedSharedRoster, wrapped: WrappedGroupKey): Promise<void> {
      checkAccount();
      if (roster.body.ownerUserId !== userId || roster.body.revision !== 1 || wrapped.recipientUserId !== userId
        || wrapped.groupId !== roster.body.groupId || wrapped.keyVersion !== 1 || wrapped.recipientDeviceId !== roster.body.ownerDeviceId
        || wrapped.senderDeviceId !== roster.body.ownerDeviceId) {
        throw new Error('Invalid initial group authority');
      }
      const ref = reference(roster.body.groupId); const batch = writeBatch(firestore);
      batch.set(ref, { ...rosterCloudFields(roster), headSequence: 0, lastOperationId: null, snapshotId: null,
        snapshotThroughSequence: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      batch.set(doc(ref, 'rosters', '1'), { rosterJson: canonicalJson(roster), createdAt: serverTimestamp() });
      batch.set(doc(ref, 'keyEnvelopes', `1_${wrapped.recipientDeviceId}`), { userId, deviceId: wrapped.recipientDeviceId,
        keyVersion: 1, wrappedKeyJson: canonicalJson(wrapped), createdAt: serverTimestamp() });
      batch.set(doc(firestore, 'sharingUsers', userId, 'memberships', 'current'),
        { groupId: roster.body.groupId, invitationId: null, createdAt: serverTimestamp() });
      try { await batch.commit(); }
      catch (error) {
        // Retrying an uncertain create must recover its exact prepared key, never replace it.
        try {
          checkAccount();
          const original = await getDocFromServer(doc(ref, 'rosters', '1'));
          const key = await getDocFromServer(doc(ref, 'keyEnvelopes', `1_${wrapped.recipientDeviceId}`));
          if (original.data()?.rosterJson !== canonicalJson(roster) || key.data()?.wrappedKeyJson !== canonicalJson(wrapped)) throw error;
        } catch { throw error; }
      }
      checkAccount();
    },
    async readRoster(groupId: string, revision: number) {
      checkAccount(); if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid roster revision');
      const result = await getDocFromServer(doc(reference(groupId), 'rosters', String(revision))); checkAccount();
      const encoded = result.data()?.rosterJson;
      if (typeof encoded !== 'string' || encoded.length > 60_000) throw new Error('Missing membership history');
      return JSON.parse(encoded);
    },
    async readGroupKey(groupId: string, version: number, deviceId: string): Promise<WrappedGroupKey> {
      checkAccount(); assertSharedIdentifier(deviceId);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid key epoch');
      const result = await getDocFromServer(doc(reference(groupId), 'keyEnvelopes', `${version}_${deviceId}`)); checkAccount();
      const data = result.data();
      if (data?.userId !== userId || data?.deviceId !== deviceId || data?.keyVersion !== version
        || typeof data?.wrappedKeyJson !== 'string' || data.wrappedKeyJson.length > 10_000) throw new Error('Missing device key envelope');
      return JSON.parse(data.wrappedKeyJson) as WrappedGroupKey;
    },
    async readReceipts(groupId: string, operationIds: readonly string[], options?: { deadlineAtMs: number }): Promise<V2ServerReceipt[]> {
      checkAccount(); if (operationIds.length > 1000) throw new Error('Receipt recovery page exceeds 1000 operations');
      if (options && !Number.isSafeInteger(options.deadlineAtMs)) throw new Error('Invalid receipt recovery deadline');
      const deadline = Math.min(options?.deadlineAtMs ?? Number.MAX_SAFE_INTEGER, Date.now() + 25_000);
      const ids = [...new Set(operationIds)]; ids.forEach(assertSharedIdentifier); const result: V2ServerReceipt[] = [];
      for (let offset = 0; offset < ids.length; offset += 30) {
        if (Date.now() >= deadline) return result;
        const page = await getDocsFromServer(query(collection(reference(groupId), 'receipts'), where(documentId(), 'in', ids.slice(offset, offset + 30))));
        checkAccount(); result.push(...page.docs.map((item) => parseV2FirestoreReceipt(item.data(), groupId, item.id)));
      }
      return result;
    },
    async upload(envelope: EncryptedSharedOperation, options?: { authorProofDigest: string }): Promise<SharedCloudEvent> {
      checkAccount(); assertSharedIdentifier(envelope.operationId);
      if (envelope.schemaVersion === 2 && (!options || !/^[a-f0-9]{64}$/u.test(options.authorProofDigest))
        || envelope.schemaVersion === 1 && options) throw new Error('Unsupported or missing server receipt commitment');
      const ref = reference(envelope.groupId); const event = doc(ref, 'events', envelope.operationId);
      const receiptRef = doc(ref, 'receipts', envelope.operationId);
      const envelopeJson = canonicalJson(envelope);
      if (envelopeJson.length > 800_000 || envelope.authorUserId !== userId) throw new Error('Invalid upload author or size');
      const result = await runTransaction(firestore, async (transaction) => {
        checkAccount();
        const root = await transaction.get(ref);
        const { group, roster } = parseSharedCloudGroup(root.data(), envelope.groupId);
        assertSharedCloudAccess(group, userId, envelope.authorDeviceId);
        if (envelope.schemaVersion !== group.schemaVersion) throw new SharingSchedulerVersionError();
        // A successful response may have been lost. Never create a second event or nonce.
        const old = await transaction.get(event);
        if (old.exists()) {
          const accepted = parseSharedCloudEvent(old.id, old.data(), envelope.groupId);
          if (accepted.envelope.authorUserId !== envelope.authorUserId || accepted.envelope.authorDeviceId !== envelope.authorDeviceId
            || accepted.envelope.logicalClock !== envelope.logicalClock
            || accepted.authorProofDigest !== options?.authorProofDigest) throw new Error('Shared operation ID collision');
          return accepted;
        }
        if (envelope.schemaVersion === 2) {
          if (recoveryEnabled) {
            const held = await transaction.get(doc(ref, 'recoveryLocks', 'current')); checkAccount();
            if (held.exists() && held.data().keyVersion === group.keyVersion) {
              verifyV2RecoveryLock(parseFirestoreRecoveryLock(held.data()), roster as VerifiedSharedRoster);
              throw new V2RecoveryInProgressError();
            }
          }
          const previousReceipt = await transaction.get(receiptRef);
          if (previousReceipt.exists()) {
            const receipt = parseV2FirestoreReceipt(previousReceipt.data(), envelope.groupId, envelope.operationId);
            if (receipt.authorProofDigest !== options!.authorProofDigest || receipt.authorUserId !== userId
              || receipt.authorDeviceId !== envelope.authorDeviceId) throw new Error('Compacted operation ID collision');
            throw new SharingSnapshotRequiredError('受付済みの操作をSnapshotから復元します。');
          }
        }
        if (group.rotationRequired || group.keyVersion !== envelope.keyVersion) throw new SharingKeyVersionError('共有鍵を更新してから再送します。');
        const sequence = group.headSequence + 1;
        if (!Number.isSafeInteger(sequence)) throw new Error('Shared log sequence exhausted');
        const fields = { schemaVersion: envelope.schemaVersion, authorUserId: userId, authorDeviceId: envelope.authorDeviceId,
          keyVersion: envelope.keyVersion, uploadSequence: sequence, envelopeJson,
          ...(envelope.schemaVersion === 2 ? { authorProofDigest: options!.authorProofDigest } : {}) };
        transaction.set(event, { ...fields, createdAt: serverTimestamp() });
        if (envelope.schemaVersion === 2) transaction.set(receiptRef, { schemaVersion: 2, authorUserId: userId,
          authorDeviceId: envelope.authorDeviceId, keyVersion: envelope.keyVersion, uploadSequence: sequence,
          authorProofDigest: options!.authorProofDigest, createdAt: serverTimestamp() });
        transaction.update(ref, { headSequence: sequence, lastOperationId: envelope.operationId, updatedAt: serverTimestamp() });
        return parseSharedCloudEvent(envelope.operationId, fields, envelope.groupId);
      });
      checkAccount();
      if (envelope.schemaVersion === 1) return result;
      const committed = await getDocFromServer(receiptRef); checkAccount();
      const receipt = parseV2FirestoreReceipt(committed.data(), envelope.groupId, envelope.operationId);
      if (receipt.authorProofDigest !== options!.authorProofDigest || receipt.uploadSequence !== result.uploadSequence
        || receipt.receivedKeyVersion !== result.envelope.keyVersion) throw new Error('Committed server receipt mismatch');
      return { ...result, serverReceipt: receipt };
    },
    async pull(groupId: string, afterSequence: number) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid shared receive position');
      const metadata = await readGroup(groupId); const { group } = metadata;
      if (afterSequence > group.headSequence) throw new SharingSnapshotRequiredError('共有履歴が保存位置より前に戻っています。');
      if (afterSequence < group.snapshotThroughSequence) throw new SharingSnapshotRequiredError('共有データのSnapshotを取得します。');
      const page = await getDocsFromServer(query(collection(reference(groupId), 'events'), orderBy('uploadSequence'),
        startAfter(afterSequence), where('uploadSequence', '<=', group.headSequence), limit(100)));
      checkAccount();
      const events = page.docs.map((item) => {
        const data = item.data(); const event = parseSharedCloudEvent(item.id, data, groupId);
        if (event.envelope.schemaVersion === 1) return event;
        const { envelopeJson: _encrypted, ...receiptFields } = data;
        return { ...event, serverReceipt: parseV2FirestoreReceipt(receiptFields, groupId, item.id) };
      });
      if (events.some((event, index) => event.uploadSequence !== afterSequence + index + 1)
        || (!events.length && afterSequence < group.headSequence)) throw new SharingSnapshotRequiredError('共有履歴の保存位置が更新されました。');
      return { ...metadata, events, throughSequence: events.at(-1)?.uploadSequence ?? afterSequence };
    },
    watch(groupId: string, changed: () => void, failed: (error: unknown) => void): () => void {
      checkAccount();
      return onSnapshot(reference(groupId), (snapshot) => {
        try { checkAccount(); if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) changed(); }
        catch (error) { failed(error); }
      }, failed);
    },
  });
}
