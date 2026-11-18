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
import { createSharingDeliveryRelay } from './firestore-delivery.ts';
import type { SharingDeliveryRelay } from './firestore-delivery';
import type { SharedDeliveryArchive } from '../../features/sharing/delivery-archive';

/** All reads use the server; Firestore's memory cache cannot acknowledge delivery. */
export function createSharingCloud(firestore: Firestore, userId: string, currentUserId: () => string | null,
  options: { ownerRecoveryEnabled?: boolean } = {}) {
  assertSharedIdentifier(userId);
  const recoveryEnabled = options.ownerRecoveryEnabled === true;
  let delivery: SharingDeliveryRelay | undefined;
  let deliverySeeded = false;
  let deliveryArchiveRosters: () => readonly VerifiedSharedRoster[] = () => [];
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
  const context = { firestore, userId, checkAccount, reference, readGroup, recoveryEnabled, deliveryRelay: () => delivery };
  const management = createSharingManagement(context);
  return sharingCloudWithDeadline({
    ...createSharingAccountDevices({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled }),
    ...management,
    ...createSharingHistoryRetention({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled }),
    ...createSharingRecovery({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled }),
    ownerRecoveryEnabled: recoveryEnabled,
    setDeliveryArchive(deviceId: string, archive: SharedDeliveryArchive, trustedArchive: () => readonly VerifiedSharedRoster[]) {
      delivery = createSharingDeliveryRelay(context, deviceId, archive); deliveryArchiveRosters = trustedArchive;
    },
    prepareDelivery: async (groupId: string) => { await delivery?.serve(groupId); },
    minimumStorageActive: async (groupId: string) => delivery ? delivery.active(groupId) : false,
    async acknowledge(groupId: string, deviceId: string, sequence: number): Promise<void> {
      if (delivery && !deliverySeeded) {
        const { group } = await readGroup(groupId);
        if (group.snapshotId) {
          // Seed an existing installation once before it promises it can restore other devices.
          const manifest = await management.readSnapshotManifest(groupId, group.snapshotId, deliveryArchiveRosters());
          if ((await Promise.all(manifest.body.chunks.map(part => delivery!.archive.chunk(part.id)))).some(chunk => !chunk)) {
            await management.readSnapshot(groupId, group.snapshotId, deliveryArchiveRosters());
          }
        }
        let position = await delivery.archive.seedPosition(group.snapshotThroughSequence);
        // A bounded page per sync preserves the UI budget. Pending seeding earns a demand retry.
        if (position < sequence) {
          const page = await getDocsFromServer(query(collection(reference(groupId), 'events'), where('uploadSequence', '>', position),
            where('uploadSequence', '<=', sequence), orderBy('uploadSequence'), limit(100))); checkAccount();
          const events = page.docs.map(item => {
            const data = item.data(); const event = parseSharedCloudEvent(item.id, data, groupId); const { envelopeJson: _wire, ...receipt } = data;
            return { ...event, serverReceipt: parseV2FirestoreReceipt(receipt, groupId, item.id) };
          });
          if (!events.length || events.some((event, index) => event.uploadSequence !== position + index + 1)) throw new Error('Cannot seed missing delivery history');
          await delivery.archive.saveEvents(events); position = await delivery.archive.seedPosition(group.snapshotThroughSequence);
          if (position < sequence) throw new (await import('../../features/sharing/delivery-archive.ts')).SharedDeliveryPendingError();
        }
        await delivery.ready(groupId, sequence);
        deliverySeeded = true;
      }
      await management.acknowledge(groupId, deviceId, sequence);
      await delivery?.acknowledge(groupId, sequence);
    },
    readGroup: async (groupId: string) => { const value = await readGroup(groupId); delivery?.request(groupId, value.group); return value; },
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
      const accepted = { ...result, serverReceipt: receipt };
      await delivery?.archive.saveEvents([accepted]); checkAccount(); return accepted;
    },
    async pull(groupId: string, afterSequence: number) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid shared receive position');
      const metadata = await readGroup(groupId); const { group } = metadata;
      if (afterSequence > group.headSequence) throw new SharingSnapshotRequiredError('共有履歴が保存位置より前に戻っています。');
      if (afterSequence < group.snapshotThroughSequence) throw new SharingSnapshotRequiredError('共有データのSnapshotを取得します。');
      if (group.schemaVersion === 1 && afterSequence === group.headSequence) {
        return { ...metadata, events: [], throughSequence: afterSequence };
      }
      const page = await getDocsFromServer(query(collection(reference(groupId), 'events'), orderBy('uploadSequence'),
        startAfter(afterSequence), where('uploadSequence', '<=', group.headSequence), limit(100)));
      checkAccount();
      let events = page.docs.map((item) => {
        const data = item.data(); const event = parseSharedCloudEvent(item.id, data, groupId);
        if (event.envelope.schemaVersion === 1) return event;
        const { envelopeJson: _encrypted, ...receiptFields } = data;
        return { ...event, serverReceipt: parseV2FirestoreReceipt(receiptFields, groupId, item.id) };
      });
      if (events.some((event, index) => event.uploadSequence !== afterSequence + index + 1)
        || (!events.length && afterSequence < group.headSequence)) {
        if (!delivery || group.schemaVersion !== 2) throw new SharingSnapshotRequiredError('共有履歴の保存位置が更新されました。');
        const recovered = await delivery.eventPage(groupId, afterSequence, group.headSequence); checkAccount();
        const receipts = await getDocsFromServer(query(collection(reference(groupId), 'receipts'), where(documentId(), 'in', recovered.map(event => event.operationId)))); checkAccount();
        const committed = new Map(receipts.docs.map(item => [item.id, parseV2FirestoreReceipt(item.data(), groupId, item.id)]));
        events = recovered.map(event => {
          const parsed = parseSharedCloudEvent(event.operationId, { schemaVersion: event.envelope.schemaVersion,
            authorUserId: event.envelope.authorUserId, authorDeviceId: event.envelope.authorDeviceId, keyVersion: event.envelope.keyVersion,
            uploadSequence: event.uploadSequence, envelopeJson: event.envelopeJson, authorProofDigest: event.authorProofDigest }, groupId);
          const receipt = committed.get(event.operationId);
          if (!receipt || receipt.uploadSequence !== event.uploadSequence || receipt.authorProofDigest !== event.authorProofDigest
            || receipt.receivedKeyVersion !== event.envelope.keyVersion || canonicalJson(parsed.envelope) !== canonicalJson(event.envelope)) throw new Error('Peer delivery lacks an independent committed receipt');
          return { ...parsed, serverReceipt: receipt };
        });
      }
      await delivery?.archive.saveEvents(events); checkAccount();
      return { ...metadata, events, throughSequence: events.at(-1)?.uploadSequence ?? afterSequence };
    },
    watch(groupId: string, changed: () => void, failed: (error: unknown) => void): () => void {
      checkAccount();
      let fingerprint: string | undefined;
      const unsubscribe = onSnapshot(reference(groupId), { includeMetadataChanges: true }, (snapshot) => {
        try { checkAccount(); if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
          const { createdAt: _created, updatedAt: _updated, ...data } = snapshot.data() ?? {};
          const next = canonicalJson(snapshot.exists() ? data : null);
          if (fingerprint !== next) { fingerprint = next; changed(); }
        } }
        catch (error) { failed(error); }
      }, failed);
      const stopRelay = delivery?.watch(groupId, changed, failed);
      return () => { unsubscribe(); stopRelay?.(); };
    },
  });
}
