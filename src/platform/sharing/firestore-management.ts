import { collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, orderBy, query, runTransaction, serverTimestamp,
  setDoc, startAfter, Timestamp, updateDoc, where, writeBatch } from 'firebase/firestore';
import type { DocumentData, DocumentReference, QueryDocumentSnapshot } from 'firebase/firestore';
import { assertSharedIdentifier, canonicalJson } from '../../features/sharing/operations.ts';
import { boundedSharingCloudBatches, parseSharedCloudGroup, rosterCloudFields, SharingCloudChangedError } from '../../features/sharing/cloud-contract.ts';
import { sharedRosterDigest, validateSharedRoster, verifySharedRosterTransition } from '../../features/sharing/roster.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { validateSharedInvitation, verifySharedJoinRequest } from '../../features/sharing/invitations.ts';
import type { SharedJoinRequest, SignedSharedInvitation } from '../../features/sharing/invitations.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import type { EncryptedSharedSnapshotChunk, WrappedGroupKey } from '../../features/sharing/crypto.ts';
import { verifySharedSnapshotManifest } from '../../features/sharing/snapshots.ts';
import type { EncryptedSharedSnapshot, SignedSharedSnapshotManifest } from '../../features/sharing/snapshots.ts';

import type { SharingCloudContext } from './firestore-context';
import { parseFirestoreRecoveryLock, parseFirestoreRecoveryRecord } from './firestore-recovery.ts';
import { V2RecoveryInProgressError, verifyV2RecoveryLock } from '../../features/sharing/v2/recovery-lock.ts';
import type { SignedV2RecoveryLock } from '../../features/sharing/v2/recovery-lock.ts';
import { recoveryRecordMatchesLock } from '../../features/sharing/v2/recovery-cloud-contract.ts';
import type { V2RecoveryCloudRecord } from '../../features/sharing/v2/recovery-cloud-contract.ts';
import { sharingSequenceGuard } from './network-deadline.ts';

async function boundedReads<T, R>(values: readonly T[], read: (value: T) => Promise<R>, guard: () => void): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < values.length; offset += 4) {
    guard(); result.push(...await Promise.all(values.slice(offset, offset + 4).map(async value => { guard(); const result = await read(value); guard(); return result; })));
  }
  return result;
}
function invitationData(raw: Record<string, unknown> | undefined) {
  if (!raw || typeof raw.pinJson !== 'string' || raw.pinJson.length > 60_000 || !(raw.expiresAt instanceof Timestamp)
    || !['open', 'used', 'revoked'].includes(String(raw.status))) throw new Error('招待情報が見つかりません。');
  const invitation = validateSharedInvitation(JSON.parse(raw.pinJson));
  if (raw.groupId !== invitation.body.groupId || raw.ownerUserId !== invitation.body.pin.ownerUserId
    || raw.invitationPublicKey !== invitation.body.invitationPublicKey || raw.expiresAt.toMillis() !== invitation.body.expiresAt) throw new Error('招待情報が変更されています。');
  return { invitation, status: raw.status as 'open' | 'used' | 'revoked', usedBy: raw.usedBy as string | null };
}
function snapshotFields(manifest: SignedSharedSnapshotManifest) {
  return { keyVersion: manifest.body.keyVersion, throughSequence: manifest.body.throughSequence,
    ...retentionFields(manifest),
    manifestJson: canonicalJson(manifest), createdAt: serverTimestamp() };
}
function retentionFields(manifest: SignedSharedSnapshotManifest) {
  const body = manifest.body; return body.retentionCutoff === undefined ? {} : { retentionCutoff: body.retentionCutoff,
    retentionThroughSequence: body.retentionThroughSequence!, retentionKeyVersion: body.retentionKeyVersion! };
}
function assertRetentionAdvance(current: ReturnType<typeof parseSharedCloudGroup>['group'], manifest: SignedSharedSnapshotManifest) {
  const body = manifest.body;
  if (current.retentionCutoff && (!body.retentionCutoff || body.retentionCutoff < current.retentionCutoff
    || body.retentionThroughSequence! < current.retentionThroughSequence! || body.retentionKeyVersion! < current.retentionKeyVersion!)) throw new Error('Snapshot cannot restore deleted shared history');
  if (body.retentionCutoff && body.retentionKeyVersion! >= body.keyVersion) throw new Error('History deletion must retire its original encryption epoch');
}

export function createSharingManagement({ firestore, userId, checkAccount, reference, readGroup, recoveryEnabled = false }: SharingCloudContext) {
  const cleanupPositions = new Map<string, { createdAt: Timestamp; id: string }>();
  const eventCleanupPositions = new Map<string, number>();
  const inviteRef = (id: string) => { assertSharedIdentifier(id); return doc(firestore, 'sharingInvites', id); };
  const readInvitation = async (inviteId: string) => {
    checkAccount(); const result = await getDocFromServer(inviteRef(inviteId)); checkAccount();
    return invitationData(result.data());
  };
  const readSnapshotManifest = async (groupId: string, snapshotId: string, trustedArchive: readonly VerifiedSharedRoster[]): Promise<SignedSharedSnapshotManifest> => {
    const guard = sharingSequenceGuard(checkAccount);
      assertSharedIdentifier(snapshotId); guard();
      const response = await getDocFromServer(doc(reference(groupId), 'snapshots', snapshotId)); guard();
      const raw = response.data();
      if (typeof raw?.manifestJson !== 'string' || raw.manifestJson.length > 100_000) throw new Error('Snapshot manifest is missing');
      const manifest = JSON.parse(raw.manifestJson) as SignedSharedSnapshotManifest;
      if (manifest.body.snapshotId !== snapshotId || manifest.body.groupId !== groupId || manifest.body.keyVersion !== raw.keyVersion
        || manifest.body.throughSequence !== raw.throughSequence || manifest.body.retentionCutoff !== raw.retentionCutoff
        || manifest.body.retentionThroughSequence !== raw.retentionThroughSequence || manifest.body.retentionKeyVersion !== raw.retentionKeyVersion
        || !Array.isArray(manifest.body.chunks) || manifest.body.chunks.length > 512) throw new Error('Invalid snapshot metadata');
      // Cloud membership alone is not a trust anchor. Require the caller's verified chain.
      const roster = trustedArchive?.find(epoch => sharedRosterDigest(epoch) === manifest.body.rosterDigest);
      if (!roster) throw new Error('Snapshot membership is not trusted');
      verifySharedSnapshotManifest(manifest, roster);
      return manifest;
  };
  return {
    readInvitation,
    async createInvitation(input: SignedSharedInvitation): Promise<void> {
      checkAccount(); const invitation = validateSharedInvitation(input);
      const { group, roster } = await readGroup(invitation.body.groupId);
      if (group.ownerUserId !== userId || group.ownerDeviceId !== invitation.body.pin.ownerIdentity.deviceId
        || invitation.body.pin.digest !== sharedRosterDigest(roster) || group.rotationRequired) throw new SharingCloudChangedError('招待を作る前に共有状態を更新してください。');
      const ref = inviteRef(invitation.body.inviteId); const existing = await getDocFromServer(ref);
      if (existing.exists()) {
        if (canonicalJson(invitationData(existing.data()).invitation) !== canonicalJson(invitation)) throw new Error('Invitation ID collision');
        return;
      }
      checkAccount();
      await setDoc(ref, { groupId: invitation.body.groupId, ownerUserId: userId, invitationPublicKey: invitation.body.invitationPublicKey,
        pinJson: canonicalJson(invitation), expiresAt: Timestamp.fromMillis(invitation.body.expiresAt), status: 'open', usedBy: null, createdAt: serverTimestamp() });
      checkAccount();
    },
    async submitJoinRequest(invitation: SignedSharedInvitation, request: SharedJoinRequest): Promise<void> {
      checkAccount(); const actual = await readInvitation(invitation.body.inviteId);
      if (canonicalJson(actual.invitation) !== canonicalJson(invitation) || actual.status !== 'open') throw new Error('この招待リンクは使用済み、または取り消されています。');
      verifySharedJoinRequest(request, invitation, userId, Date.now());
      await runTransaction(firestore, async transaction => {
        checkAccount();
        const ref = doc(inviteRef(invitation.body.inviteId), 'requests', userId);
        const membershipRef = doc(firestore, 'sharingUsers', userId, 'memberships', 'current');
        const membership = await transaction.get(membershipRef); const old = await transaction.get(ref);
        if (old.exists()) {
          if (old.data().requestJson !== canonicalJson(request)) throw new Error('このアカウントには別の端末の参加要求があります。');
          return;
        }
        if (!membership.exists() || membership.data().groupId !== invitation.body.groupId) transaction.set(membershipRef, { groupId: invitation.body.groupId, invitationId: invitation.body.inviteId, createdAt: serverTimestamp() });
        transaction.set(ref, { userId, deviceId: request.body.identity.deviceId, requestJson: canonicalJson(request), createdAt: serverTimestamp() });
      }); checkAccount();
    },
    async listInvitations(groupId: string, options: { activeAtMs?: number } = {}) {
      const activeAt = options.activeAtMs;
      if (activeAt !== undefined && (!Number.isSafeInteger(activeAt) || activeAt < 0 || activeAt > 253402300799999)) throw new Error('Invalid invitation query time');
      const guard = sharingSequenceGuard(checkAccount); const invitations = []; let after: QueryDocumentSnapshot<DocumentData> | undefined;
      for (;;) {
        guard(); const result = await getDocsFromServer(query(collection(firestore, 'sharingInvites'), where('groupId', '==', groupId),
          ...(activeAt === undefined ? [] : [where('status', '==', 'open'), where('expiresAt', '>', Timestamp.fromMillis(activeAt)), orderBy('expiresAt')]),
          orderBy(documentId()), ...(after ? [startAfter(after)] : []), limit(100))); guard();
        invitations.push(...result.docs.map(item => ({ id: item.id, ...invitationData(item.data()) })));
        if (result.docs.length < 100) return invitations;
        after = result.docs.at(-1)!;
      }
    },
    async listJoinRequests(invitation: SignedSharedInvitation, after?: string) {
      if (after !== undefined) assertSharedIdentifier(after);
      checkAccount(); const result = await getDocsFromServer(query(collection(inviteRef(invitation.body.inviteId), 'requests'),
        orderBy(documentId()), ...(after ? [startAfter(after)] : []), limit(100)));
      checkAccount(); const requests: SharedJoinRequest[] = []; const invalidUserIds: string[] = [];
      for (const item of result.docs) {
        try {
          const raw = item.data();
          if (raw.userId !== item.id || typeof raw.requestJson !== 'string' || raw.requestJson.length > 15000) throw new Error('Invalid join request document');
          const request = verifySharedJoinRequest(JSON.parse(raw.requestJson), invitation, item.id, Date.now());
          if (raw.deviceId !== request.body.identity.deviceId) throw new Error('Join request device mismatch');
          requests.push(request);
        } catch { invalidUserIds.push(item.id); }
      }
      return { requests, invalidUserIds, nextCursor: result.docs.length === 100 ? result.docs.at(-1)!.id : null };
    },
    async withdrawOrRejectJoinRequest(inviteId: string, requestUserId: string): Promise<void> {
      assertSharedIdentifier(requestUserId); checkAccount();
      // Owners can delete this invitation's request, but must never inspect
      // a former applicant's current membership in an unrelated household.
      if (requestUserId !== userId) {
        await runTransaction(firestore, async transaction => {
          checkAccount(); const ref = doc(inviteRef(inviteId), 'requests', requestUserId);
          await transaction.get(ref); checkAccount(); transaction.delete(ref);
        }); checkAccount(); return;
      }
      await runTransaction(firestore, async transaction => {
        checkAccount(); const membershipRef = doc(firestore, 'sharingUsers', requestUserId, 'memberships', 'current');
        const membership = await transaction.get(membershipRef);
        transaction.delete(doc(inviteRef(inviteId), 'requests', requestUserId));
        if (membership.data()?.invitationId === inviteId) transaction.delete(membershipRef);
      }); checkAccount();
    },
    async cancelOwnJoinRequest(invitation: SignedSharedInvitation, request: SharedJoinRequest): Promise<boolean> {
      if (request.body.userId !== userId || request.body.inviteId !== invitation.body.inviteId) throw new Error('Invalid request cancellation');
      checkAccount();
      const cancelled = await runTransaction(firestore, async (transaction) => {
        checkAccount(); const ref = inviteRef(invitation.body.inviteId);
        const actual = invitationData((await transaction.get(ref)).data());
        const requestRef = doc(ref, 'requests', userId); const stored = await transaction.get(requestRef);
        if (actual.status === 'used' && actual.usedBy === userId) return false;
        if (stored.exists() && stored.data().requestJson !== canonicalJson(request)) throw new Error('Join request changed during cancellation');
        const membershipRef = doc(firestore, 'sharingUsers', userId, 'memberships', 'current');
        const membership = await transaction.get(membershipRef);
        if (stored.exists()) transaction.delete(requestRef);
        if (membership.data()?.invitationId === invitation.body.inviteId) transaction.delete(membershipRef);
        return true;
      }); checkAccount(); return cancelled;
    },
    async revokeInvitation(inviteId: string): Promise<void> {
      checkAccount(); await updateDoc(inviteRef(inviteId), { status: 'revoked', usedBy: null }); checkAccount();
    },
    /** Pre-upload encrypted future-epoch chunks. Only the final transaction makes them authoritative. */
    async prepareSnapshot(input: EncryptedSharedSnapshot, roster: VerifiedSharedRoster, checkBudget: () => void = () => {}): Promise<void> {
      const guard = sharingSequenceGuard(() => { checkAccount(); checkBudget(); });
      verifySharedSnapshotManifest(input.manifest, roster); const { body } = input.manifest;
      if (input.chunks.length !== body.chunks.length) throw new Error('Snapshot chunk count mismatch');
      const pages = boundedSharingCloudBatches(input.chunks.map((chunk, index) => ({ chunk, index })),
        ({ chunk }) => new TextEncoder().encode(canonicalJson(chunk)).length + 2048);
      for (const page of pages) {
        guard(); const batch = writeBatch(firestore); let count = 0;
        const checked = await boundedReads(page, async ({ chunk, index }) => {
          if (sharedDocumentDigest(chunk) !== body.chunks[index].digest) throw new Error('Snapshot chunk hash mismatch');
          const ref = doc(reference(body.groupId), 'snapshotChunks', body.chunks[index].id);
          return { ref, existing: await getDocFromServer(ref), envelopeJson: canonicalJson(chunk) };
        }, guard);
        for (const { ref, existing, envelopeJson } of checked) {
          if (existing.exists()) {
            if (existing.data().envelopeJson !== envelopeJson) throw new Error('Immutable snapshot chunk collision');
          } else {
            batch.set(ref, { snapshotId: body.snapshotId, keyVersion: body.keyVersion, envelopeJson, createdAt: serverTimestamp() }); count++;
          }
        }
        guard(); if (count) await batch.commit(); guard();
      }
    },
    async publishSnapshot(manifest: SignedSharedSnapshotManifest, roster: VerifiedSharedRoster, checkBudget: () => void = () => {}): Promise<void> {
      const guard = () => { checkAccount(); checkBudget(); };
      verifySharedSnapshotManifest(manifest, roster); const { body } = manifest; guard();
      await runTransaction(firestore, async (transaction) => {
        guard(); const ref = reference(body.groupId); const current = parseSharedCloudGroup((await transaction.get(ref)).data(), body.groupId); guard();
        if (current.group.snapshotId === body.snapshotId) return;
        if (current.group.rosterJson !== canonicalJson(roster) || current.group.headSequence !== body.throughSequence
          || current.group.rotationRequired) throw new SharingCloudChangedError('共有状態が更新されたためSnapshotを作り直します。');
        assertRetentionAdvance(current.group, manifest);
        transaction.set(doc(ref, 'snapshots', body.snapshotId), snapshotFields(manifest));
        transaction.update(ref, { snapshotId: body.snapshotId, snapshotThroughSequence: body.throughSequence, ...retentionFields(manifest), updatedAt: serverTimestamp() });
      }); guard();
    },
    async commitMembership(previous: VerifiedSharedRoster, next: VerifiedSharedRoster, keys: readonly WrappedGroupKey[],
      expectedHead: number, manifest?: SignedSharedSnapshotManifest,
      approval?: { invitation: SignedSharedInvitation; request: SharedJoinRequest },
      recovery?: { lock: SignedV2RecoveryLock; record: V2RecoveryCloudRecord }): Promise<void> {
      verifySharedRosterTransition(previous, next); checkAccount(); const groupId = previous.body.groupId;
      if (recovery) {
        if (!recoveryEnabled) throw new Error('Owner recovery is not enabled for this deployment');
        verifyV2RecoveryLock(recovery.lock, previous); recoveryRecordMatchesLock(recovery.record, recovery.lock);
        if (previous.body.schemaVersion !== 2 || approval || manifest?.body.snapshotId !== recovery.record.snapshotId
          || manifest.body.keyVersion !== recovery.record.keyVersion || expectedHead !== recovery.record.throughSequence) throw new Error('Recovery membership commit context differs');
      }
      const fields = rosterCloudFields(next);
      const expectedDevices = Object.keys(fields.deviceOwners).sort();
      if (canonicalJson(keys.map((key) => key.recipientDeviceId).sort()) !== canonicalJson(expectedDevices)
        || keys.some((key) => key.groupId !== groupId || key.keyVersion !== next.body.keyVersion
          || key.recipientUserId !== fields.deviceOwners[key.recipientDeviceId] || key.senderDeviceId !== previous.body.ownerDeviceId)) throw new Error('Every retained device needs its own next-epoch key envelope');
      if (manifest) {
        verifySharedSnapshotManifest(manifest, next);
        if (manifest.body.throughSequence !== expectedHead) throw new Error('Membership snapshot delivery position mismatch');
      }
      await runTransaction(firestore, async (transaction) => {
        checkAccount(); const ref = reference(groupId); const current = parseSharedCloudGroup((await transaction.get(ref)).data(), groupId);
        if (current.group.rosterJson === canonicalJson(next)) {
          // The signed roster does not commit to a randomly generated group key.
          // A timed-out earlier attempt may have committed the same roster using
          // another key. Only this exact preparation is an acknowledged retry.
          if (!next.body.closed) {
            const own = keys.find(key => key.recipientUserId === userId);
            if (!own || !manifest || current.group.snapshotId !== manifest.body.snapshotId) throw new SharingCloudChangedError('共有鍵の更新結果を受信してから再試行してください。');
            const savedKey = await transaction.get(doc(ref, 'keyEnvelopes', `${own.keyVersion}_${own.recipientDeviceId}`));
            const savedSnapshot = await transaction.get(doc(ref, 'snapshots', manifest.body.snapshotId)); checkAccount();
            if (savedKey.data()?.wrappedKeyJson !== canonicalJson(own) || savedSnapshot.data()?.manifestJson !== canonicalJson(manifest)) {
              throw new SharingCloudChangedError('別の試行で共有鍵が更新されています。最新の共有状態を受信してください。');
            }
          }
          return;
        }
        if (current.group.rosterJson !== canonicalJson(previous) || current.group.headSequence !== expectedHead
          || current.group.ownerUserId !== userId) throw new SharingCloudChangedError('メンバー情報を更新してから再試行してください。');
        if (manifest) assertRetentionAdvance(current.group, manifest);
        if (current.group.revokedUserIds.some((uid) => fields.memberIds.includes(uid))) throw new Error('A departed member cannot retain the next group key');
        const lockRef = doc(ref, 'recoveryLocks', 'current');
        if (previous.body.schemaVersion === 2 && recoveryEnabled) {
          const locked = await transaction.get(lockRef); checkAccount();
          if (recovery) {
            const prepared = await transaction.get(doc(ref, 'recoveries', recovery.record.snapshotId));
            const cancelled = await transaction.get(doc(ref, 'recoveryCancellations', recovery.lock.body.id)); checkAccount();
            if (!locked.exists() || cancelled.exists() || canonicalJson(parseFirestoreRecoveryLock(locked.data())) !== canonicalJson(recovery.lock)
              || !prepared.exists() || canonicalJson(parseFirestoreRecoveryRecord(prepared.data(), groupId)) !== canonicalJson(recovery.record)) {
              throw new SharingCloudChangedError('復旧確認が中断または変更されています。');
            }
          } else if (locked.exists() && locked.data().keyVersion === previous.body.keyVersion) throw new V2RecoveryInProgressError();
        }
        if (approval) {
          const invitation = invitationData((await transaction.get(inviteRef(approval.invitation.body.inviteId))).data());
          const request = (await transaction.get(doc(inviteRef(approval.invitation.body.inviteId), 'requests', approval.request.body.userId))).data();
          if (invitation.status !== 'open' || canonicalJson(invitation.invitation) !== canonicalJson(approval.invitation)
            || request?.requestJson !== canonicalJson(approval.request)) throw new Error('参加要求が変更されています。');
          verifySharedJoinRequest(approval.request, approval.invitation, approval.request.body.userId, Date.now());
        }
        checkAccount();
        transaction.set(doc(ref, 'rosters', String(next.body.revision)), { rosterJson: canonicalJson(next), createdAt: serverTimestamp() });
        for (const key of keys) transaction.set(doc(ref, 'keyEnvelopes', `${key.keyVersion}_${key.recipientDeviceId}`), {
          userId: key.recipientUserId, deviceId: key.recipientDeviceId, keyVersion: key.keyVersion, wrappedKeyJson: canonicalJson(key), createdAt: serverTimestamp(),
        });
        for (const uid of fields.memberIds.filter((uid) => !current.group.memberIds.includes(uid))) transaction.set(doc(firestore, 'sharingUsers', uid, 'memberships', 'current'), { groupId, invitationId: null, createdAt: serverTimestamp() });
        if (manifest) transaction.set(doc(ref, 'snapshots', manifest.body.snapshotId), snapshotFields(manifest));
        transaction.update(ref, { ...fields, ...(manifest ? { snapshotId: manifest.body.snapshotId, snapshotThroughSequence: manifest.body.throughSequence, ...retentionFields(manifest) } : {}), updatedAt: serverTimestamp() });
        if (recovery) transaction.delete(lockRef);
        if (approval) {
          transaction.update(inviteRef(approval.invitation.body.inviteId), { status: 'used', usedBy: approval.request.body.userId });
          transaction.delete(doc(inviteRef(approval.invitation.body.inviteId), 'requests', approval.request.body.userId));
        }
      }); checkAccount();
    },
    async leaveGroup(groupId: string): Promise<void> {
      checkAccount();
      await runTransaction(firestore, async (transaction) => {
        checkAccount(); const ref = reference(groupId); const { group } = parseSharedCloudGroup((await transaction.get(ref)).data(), groupId);
        if (group.ownerUserId === userId) throw new Error('退出する前に所有者を引き継いでください。');
        const membershipRef = doc(firestore, 'sharingUsers', userId, 'memberships', 'current'); const membership = await transaction.get(membershipRef);
        transaction.update(ref, { revokedUserIds: [...new Set([...group.revokedUserIds, userId])], rotationRequired: true, updatedAt: serverTimestamp() });
        if (membership.data()?.groupId === groupId) transaction.delete(membershipRef);
      }); checkAccount();
    },
    async acknowledge(groupId: string, deviceId: string, sequence: number): Promise<void> {
      assertSharedIdentifier(deviceId); checkAccount();
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid acknowledgement position');
      await runTransaction(firestore, async (transaction) => {
        checkAccount(); const ref = doc(reference(groupId), 'acknowledgements', deviceId); const old = (await transaction.get(ref)).data();
        if (old && old.sequence >= sequence && old.updatedAt instanceof Timestamp && Date.now() - old.updatedAt.toMillis() < 24 * 60 * 60_000) return;
        transaction.set(ref, { userId, sequence: Math.max(sequence, old?.sequence ?? 0), updatedAt: serverTimestamp() });
      }); checkAccount();
    },
    readSnapshotManifest,
    async readSnapshot(groupId: string, snapshotId: string, trustedArchive: readonly VerifiedSharedRoster[]): Promise<EncryptedSharedSnapshot> {
      const guard = sharingSequenceGuard(checkAccount); guard();
      const manifest = await readSnapshotManifest(groupId, snapshotId, trustedArchive); guard();
      const chunks: EncryptedSharedSnapshotChunk[] = await boundedReads(manifest.body.chunks, async descriptor => {
        assertSharedIdentifier(descriptor.id); const result = await getDocFromServer(doc(reference(groupId), 'snapshotChunks', descriptor.id)); guard();
        const data = result.data();
        if (typeof data?.envelopeJson !== 'string' || data.envelopeJson.length > 800_000 || new TextEncoder().encode(data.envelopeJson).length !== descriptor.bytes
          || data.snapshotId !== snapshotId || data.keyVersion !== manifest.body.keyVersion) throw new Error('Snapshot chunk is missing');
        const chunk = JSON.parse(data.envelopeJson) as EncryptedSharedSnapshotChunk;
        if (sharedDocumentDigest(chunk) !== descriptor.digest) throw new Error('Snapshot chunk hash mismatch'); return chunk;
      }, guard);
      return { manifest, chunks };
    },
    /** Bounded retention: offline devices recover from the current snapshot after a seven-day grace period. */
    async compactHistory(groupId: string, now = Date.now(), checkBudget: () => void = () => {}): Promise<{ deleted: number; waitingForDevices: boolean }> {
      const guard = sharingSequenceGuard(() => { checkAccount(); checkBudget(); });
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid compaction clock');
      guard(); const { group } = await readGroup(groupId); guard();
      if (group.ownerUserId !== userId || group.rotationRequired || !group.snapshotId) return { deleted: 0, waitingForDevices: false };
      const ref = reference(groupId);
      const current = (await getDocFromServer(doc(ref, 'snapshots', group.snapshotId))).data(); guard();
      if (current?.keyVersion !== group.keyVersion || current.throughSequence !== group.snapshotThroughSequence || !(current.createdAt instanceof Timestamp)) throw new Error('Compaction requires a current-epoch snapshot');
      const acknowledgements = await getDocsFromServer(collection(ref, 'acknowledgements')); guard();
      const received = new Map(acknowledgements.docs.map((item) => [item.id, item.data()]));
      const acknowledged = Object.keys(group.deviceOwners).every((device) => received.get(device)?.sequence >= group.snapshotThroughSequence);
      const grace = 7 * 24 * 60 * 60_000;
      const oldEnough = (data: Record<string, unknown>) => data.createdAt instanceof Timestamp && now - data.createdAt.toMillis() >= grace;
      const snapshots = await getDocsFromServer(query(collection(ref, 'snapshots'), orderBy('createdAt', 'desc'), limit(100))); guard();
      const keepIds = new Set([group.snapshotId]);
      const fallback = snapshots.docs.find((item) => item.id !== group.snapshotId);
      if (fallback) keepIds.add(fallback.id);
      const keepKeyVersions = new Set([group.keyVersion, ...(fallback ? [fallback.data().keyVersion] : [])]);
      const removals: DocumentReference[] = [];
      const maintenanceRef = doc(ref, 'maintenance', 'keyCleanup'); let nextKeyProgress: number | undefined;
      const eventPosition = eventCleanupPositions.get(groupId) ?? 0;
      // V2 receipts and post-retention events remain until the next certified cut.
      // Normal maintenance may still trim covered ciphertext, snapshots and old keys.
      const removableThrough = group.schemaVersion === 2 && group.retentionThroughSequence !== undefined
        ? Math.min(group.snapshotThroughSequence, group.retentionThroughSequence) : group.snapshotThroughSequence;
      const covered = await getDocsFromServer(query(collection(ref, 'events'), where('uploadSequence', '<=', removableThrough),
        ...(eventPosition ? [where('uploadSequence', '>', eventPosition)] : []), orderBy('uploadSequence'), limit(100))); guard();
      const lastEvent = covered.docs.at(-1);
      if (covered.size === 100 && lastEvent) eventCleanupPositions.set(groupId, lastEvent.data().uploadSequence); else eventCleanupPositions.delete(groupId);
      for (const item of covered.docs) {
        if (!(acknowledged || oldEnough(item.data()))) continue;
        if (group.schemaVersion === 2 && recoveryEnabled) {
          const protectedEvent = await getDocFromServer(doc(ref, 'quarantines', item.id)); guard();
          if (protectedEvent.exists()) continue;
        }
        removals.push(item.ref);
      }
      if (removals.length < 100 && group.keyVersion > 1) {
        const progress = (await getDocFromServer(maintenanceRef)).data()?.throughKeyVersion ?? 0; guard();
        if (!Number.isSafeInteger(progress) || progress < 0 || progress >= group.keyVersion) throw new Error('Invalid key cleanup position');
        const version = progress + 1;
        if (version < Math.min(...keepKeyVersions)) {
          const stored = (await getDocFromServer(doc(ref, 'rosters', String(version)))).data(); guard();
          if (!stored || typeof stored.rosterJson !== 'string') throw new Error('Missing key cleanup membership');
          const epoch = validateSharedRoster(JSON.parse(stored.rosterJson));
          if (epoch.body.groupId !== groupId || epoch.body.keyVersion !== version) throw new Error('Invalid key cleanup membership');
          // Derive IDs from public signed membership; the owner never lists another recipient's key ciphertexts.
          const keyRefs = epoch.body.members.flatMap((member) => member.devices.map((device) => doc(ref, 'keyEnvelopes', `${version}_${device.identity.deviceId}`)));
          if ((acknowledged || oldEnough(stored)) && keyRefs.length + removals.length + 1 <= 100) { removals.push(...keyRefs); nextKeyProgress = version; }
        }
      }
      const deleteLimit = nextKeyProgress === undefined ? 100 : 99;
      removals.push(...snapshots.docs.filter((item) => !keepIds.has(item.id)).slice(0, deleteLimit - removals.length).map((item) => item.ref));
      if (removals.length < deleteLimit) {
        const position = cleanupPositions.get(groupId);
        const chunks = await getDocsFromServer(query(collection(ref, 'snapshotChunks'), where('createdAt', '<=', Timestamp.fromMillis(now - grace)),
          orderBy('createdAt'), orderBy(documentId()), ...(position ? [startAfter(position.createdAt, position.id)] : []), limit(25))); guard();
        const last = chunks.docs.at(-1);
        if (chunks.size === 25 && last?.data().createdAt instanceof Timestamp) cleanupPositions.set(groupId, { createdAt: last.data().createdAt, id: last.id });
        else cleanupPositions.delete(groupId);
        removals.push(...chunks.docs.filter((item) => !keepIds.has(item.data().snapshotId)).slice(0, deleteLimit - removals.length).map((item) => item.ref));
      }
      if (removals.length) {
        guard(); const actual = await readGroup(groupId); guard();
        if (actual.group.snapshotId !== group.snapshotId || actual.group.keyVersion !== group.keyVersion) return { deleted: 0, waitingForDevices: false };
        const pageSize = group.schemaVersion === 2 ? 10 : 100;
        for (let offset = 0; offset < removals.length; offset += pageSize) {
          const batch = writeBatch(firestore); for (const item of removals.slice(offset, offset + pageSize)) batch.delete(item);
          if (nextKeyProgress !== undefined && offset + pageSize >= removals.length) batch.set(maintenanceRef, { throughKeyVersion: nextKeyProgress });
          guard(); await batch.commit(); guard();
        }
      }
      return { deleted: removals.length, waitingForDevices: !acknowledged };
    },
  };
}
