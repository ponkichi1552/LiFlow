import { collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, orderBy, query, runTransaction, serverTimestamp, Timestamp, where, writeBatch } from 'firebase/firestore';
import type { DocumentData } from 'firebase/firestore';
import type { SharingCloudContext } from './firestore-context';
import { assertSharedIdentifier, canonicalJson } from '../../features/sharing/operations.ts';
import { parseSharedCloudGroup, SharingAccessError, SharingCloudChangedError } from '../../features/sharing/cloud-contract.ts';
import { sharedRosterDigest } from '../../features/sharing/roster.ts';
import { validateRawV2RecoveryEvent } from '../../features/sharing/v2/recovery-contract.ts';
import type { RawV2RecoveryEvent } from '../../features/sharing/v2/recovery-contract.ts';
import { validateV2RecoveryLock, verifyV2RecoveryLock } from '../../features/sharing/v2/recovery-lock.ts';
import type { SignedV2RecoveryLock } from '../../features/sharing/v2/recovery-lock.ts';
import { recoveryRecordMatchesLock, validateV2RecoveryCloudRecord, validateV2RecoveryQuarantine } from '../../features/sharing/v2/recovery-cloud-contract.ts';
import type { V2RecoveryCloudRecord, V2RecoveryQuarantineRecord } from '../../features/sharing/v2/recovery-cloud-contract.ts';

function withoutCommittedTime(data: DocumentData) {
  const { createdAt, ...value } = data;
  if (!(createdAt instanceof Timestamp)) throw new Error('Recovery evidence needs a committed server timestamp');
  return value;
}
export function parseFirestoreRecoveryRecord(data: DocumentData, groupId: string): V2RecoveryCloudRecord {
  return validateV2RecoveryCloudRecord(withoutCommittedTime(data) as V2RecoveryCloudRecord, groupId);
}
export function parseFirestoreRecoveryQuarantine(data: DocumentData, operationId: string): V2RecoveryQuarantineRecord {
  return validateV2RecoveryQuarantine({ ...withoutCommittedTime(data), operationId } as V2RecoveryQuarantineRecord);
}

export function rawV2RecoveryEvent(data: DocumentData, groupId: string, operationId: string): RawV2RecoveryEvent {
  if (Object.keys(data).sort().join(',') !== 'authorDeviceId,authorProofDigest,authorUserId,createdAt,envelopeJson,keyVersion,schemaVersion,uploadSequence'
    || !(data.createdAt instanceof Timestamp)) throw new Error('Recovery needs an immutable server event');
  return validateRawV2RecoveryEvent({ schemaVersion: data.schemaVersion, groupId, operationId, authorUserId: data.authorUserId,
    authorDeviceId: data.authorDeviceId, keyVersion: data.keyVersion, uploadSequence: data.uploadSequence,
    envelopeJson: data.envelopeJson, authorProofDigest: data.authorProofDigest, receivedAtMs: Math.floor(data.createdAt.toMillis()) }, groupId);
}
export function recoveryLockFields(input: SignedV2RecoveryLock) {
  const lock = validateV2RecoveryLock(input); const { body } = lock;
  return { schemaVersion: 1, lockId: body.id, ownerUserId: body.ownerUserId, ownerDeviceId: body.ownerDeviceId, keyVersion: body.keyVersion,
    throughSequence: body.throughSequence, rosterDigest: body.rosterDigest, reviewDigest: body.reviewDigest, lockJson: canonicalJson(lock) };
}
export function parseFirestoreRecoveryLock(data: DocumentData): SignedV2RecoveryLock {
  if (Object.keys(data).sort().join(',') !== 'createdAt,keyVersion,lockId,lockJson,ownerDeviceId,ownerUserId,reviewDigest,rosterDigest,schemaVersion,throughSequence'
    || !(data.createdAt instanceof Timestamp) || typeof data.lockJson !== 'string' || data.lockJson.length > 12000) throw new Error('Invalid committed recovery lock');
  const lock = validateV2RecoveryLock(JSON.parse(data.lockJson)); const { createdAt: _time, ...fields } = data;
  if (canonicalJson(fields) !== canonicalJson(recoveryLockFields(lock))) throw new Error('Recovery lock metadata differs from its signed proof');
  return lock;
}

/** Recovery queries expose raw ciphertext for review; normal pull remains strict and never skips it. */
export function createSharingRecovery({ firestore, userId, checkAccount: checkCurrentAccount, reference, readGroup, recoveryEnabled = false }: SharingCloudContext) {
  const checkAccount = () => {
    if (!recoveryEnabled) throw new Error('Owner recovery is not enabled for this deployment');
    checkCurrentAccount();
  };
  const lockRef = (groupId: string) => doc(reference(groupId), 'recoveryLocks', 'current');
  const cancelRef = (groupId: string, id: string) => { assertSharedIdentifier(id); return doc(reference(groupId), 'recoveryCancellations', id); };
  return {
    async readRawRecoveryPage(groupId: string, after: number, through: number, count = 20): Promise<RawV2RecoveryEvent[]> {
      if (![after, through, count].every(Number.isSafeInteger) || after < 0 || through < after || count < 1 || count > 100) throw new Error('Invalid recovery query window');
      checkAccount(); const { group } = await readGroup(groupId); checkAccount();
      if (group.schemaVersion !== 2 || group.ownerUserId !== userId) throw new SharingAccessError('復旧の検査は所有者の端末で行ってください。');
      const result = await getDocsFromServer(query(collection(reference(groupId), 'events'), where('uploadSequence', '>', after),
        where('uploadSequence', '<=', through), orderBy('uploadSequence'), limit(count))); checkAccount();
      return result.docs.map(item => rawV2RecoveryEvent(item.data(), groupId, item.id));
    },
    async readRecoveryOriginals(groupId: string, operationIds: readonly string[], options: { deadlineAtMs?: number } = {}): Promise<RawV2RecoveryEvent[]> {
      if (operationIds.length > 256 || new Set(operationIds).size !== operationIds.length) throw new Error('Invalid original recovery query');
      operationIds.forEach(assertSharedIdentifier); checkAccount(); const result: RawV2RecoveryEvent[] = [];
      for (let offset = 0; offset < operationIds.length; offset += 30) {
        if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) throw Object.assign(new Error('復旧証拠の取得は次の同期で続けます。'), { code: 'sharing/receipt-recovery-pending' });
        const page = await getDocsFromServer(query(collection(reference(groupId), 'events'), where(documentId(), 'in', operationIds.slice(offset, offset + 30))));
        checkAccount(); result.push(...page.docs.map(item => rawV2RecoveryEvent(item.data(), groupId, item.id)));
      }
      return result;
    },
    async readRecoveryLock(groupId: string): Promise<SignedV2RecoveryLock | null> {
      checkAccount(); const result = await getDocFromServer(lockRef(groupId)); checkAccount();
      return result.exists() ? parseFirestoreRecoveryLock(result.data()) : null;
    },
    async startRecoveryLock(input: SignedV2RecoveryLock): Promise<void> {
      const lock = validateV2RecoveryLock(input); const { body } = lock; checkAccount();
      await runTransaction(firestore, async transaction => {
        checkAccount(); const current = parseSharedCloudGroup((await transaction.get(reference(body.groupId))).data(), body.groupId); checkAccount();
        verifyV2RecoveryLock(lock, current.roster as Parameters<typeof verifyV2RecoveryLock>[1]);
        if (current.group.ownerUserId !== userId || current.group.headSequence !== body.throughSequence) throw new SharingCloudChangedError('共有の内容が変わりました。復旧内容を確認し直してください。');
        const cancelled = await transaction.get(cancelRef(body.groupId, body.id));
        const previous = await transaction.get(lockRef(body.groupId)); checkAccount();
        if (cancelled.exists()) throw new SharingCloudChangedError('この復旧操作は中断済みです。内容を再確認して新しく開始してください。');
        if (previous.exists()) {
          const old = parseFirestoreRecoveryLock(previous.data());
          if (canonicalJson(old) === canonicalJson(lock)) return;
          if (old.body.keyVersion === current.group.keyVersion) throw new SharingCloudChangedError('別の復旧確認が進行中です。先に中断か再開を選んでください。');
        }
        transaction.set(lockRef(body.groupId), { ...recoveryLockFields(lock), createdAt: serverTimestamp() });
      }); checkAccount();
    },
    async cancelRecoveryLock(input: SignedV2RecoveryLock): Promise<void> {
      const lock = validateV2RecoveryLock(input); checkAccount();
      await runTransaction(firestore, async transaction => {
        const current = parseSharedCloudGroup((await transaction.get(reference(lock.body.groupId))).data(), lock.body.groupId); checkAccount();
        if (current.group.ownerUserId !== userId) throw new SharingAccessError('復旧の中断は所有者が行ってください。');
        const stored = await transaction.get(lockRef(lock.body.groupId));
        const cancellation = await transaction.get(cancelRef(lock.body.groupId, lock.body.id)); checkAccount();
        if (sharedRosterDigest(current.roster) !== lock.body.rosterDigest) throw new SharingCloudChangedError('復旧の状態が変わりました。最新の状態を確認してください。');
        if (stored.exists() && canonicalJson(parseFirestoreRecoveryLock(stored.data())) !== canonicalJson(lock)) throw new SharingCloudChangedError('別の復旧が進行しています。');
        verifyV2RecoveryLock(lock, current.roster as Parameters<typeof verifyV2RecoveryLock>[1]);
        // Persist cancellation even if start is still in flight. A late transaction retries against this tombstone.
        if (!cancellation.exists()) transaction.set(cancelRef(lock.body.groupId, lock.body.id), { schemaVersion: 1, lockId: lock.body.id,
          keyVersion: lock.body.keyVersion, reviewDigest: lock.body.reviewDigest, ownerDeviceId: lock.body.ownerDeviceId, createdAt: serverTimestamp() });
        if (stored.exists()) transaction.delete(lockRef(lock.body.groupId));
      }); checkAccount();
    },
    async readRecoveryRecord(groupId: string, snapshotId: string): Promise<V2RecoveryCloudRecord | null> {
      assertSharedIdentifier(snapshotId); checkAccount();
      const result = await getDocFromServer(doc(reference(groupId), 'recoveries', snapshotId)); checkAccount();
      if (!result.exists()) return null;
      const record = parseFirestoreRecoveryRecord(result.data(), groupId);
      if (record.snapshotId !== snapshotId) throw new Error('Recovery record path mismatch');
      return record;
    },
    async readRecoveryQuarantines(groupId: string, operationIds: readonly string[], options: { deadlineAtMs?: number } = {}): Promise<V2RecoveryQuarantineRecord[]> {
      if (operationIds.length > 256 || new Set(operationIds).size !== operationIds.length) throw new Error('Invalid quarantine evidence query');
      operationIds.forEach(assertSharedIdentifier); checkAccount(); const result: V2RecoveryQuarantineRecord[] = [];
      for (let offset = 0; offset < operationIds.length; offset += 30) {
        if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) throw Object.assign(new Error('復旧証拠の取得は次の同期で続けます。'), { code: 'sharing/receipt-recovery-pending' });
        const page = await getDocsFromServer(query(collection(reference(groupId), 'quarantines'), where(documentId(), 'in', operationIds.slice(offset, offset + 30))));
        checkAccount(); result.push(...page.docs.map(item => parseFirestoreRecoveryQuarantine(item.data(), item.id)));
      }
      return result;
    },
    /** Immutable preparation is not authority. Only the membership + snapshot commit can advance a receiver. */
    async prepareRecovery(record: V2RecoveryCloudRecord, input: SignedV2RecoveryLock, entries: readonly V2RecoveryQuarantineRecord[]): Promise<void> {
      const lock = validateV2RecoveryLock(input); const { groupId } = lock.body;
      record = validateV2RecoveryCloudRecord(record, groupId);
      recoveryRecordMatchesLock(record, lock);
      if (entries.length < 1 || entries.length > 256 || new Set(entries.map(item => item.operationId)).size !== entries.length) throw new Error('Invalid recovery quarantine preparation');
      const captured = entries.map(validateV2RecoveryQuarantine);
      if (captured.some(entry => entry.recoveryId !== record.snapshotId || entry.keyVersion !== record.previousKeyVersion
        || entry.uploadSequence > record.throughSequence)) throw new Error('Quarantine preparation context differs');
      checkAccount(); const ref = doc(reference(groupId), 'recoveries', record.snapshotId);
      const old = await getDocFromServer(ref); checkAccount();
      if (old.exists()) {
        if (canonicalJson(parseFirestoreRecoveryRecord(old.data(), groupId)) !== canonicalJson(record)) throw new Error('Immutable recovery record collision');
      } else {
        const batch = writeBatch(firestore); batch.set(ref, { ...record, createdAt: serverTimestamp() }); await batch.commit(); checkAccount();
      }
      // Per-event Rules reads count toward Firestore's 20-access limit for a write batch.
      for (let offset = 0; offset < captured.length; offset += 10) {
        checkAccount(); const batch = writeBatch(firestore); let count = 0;
        for (const entry of captured.slice(offset, offset + 10)) {
          const target = doc(reference(groupId), 'quarantines', entry.operationId); const prior = await getDocFromServer(target); checkAccount();
          if (prior.exists()) {
            const known = parseFirestoreRecoveryQuarantine(prior.data(), entry.operationId);
            if (known.rawDigest !== entry.rawDigest || known.uploadSequence !== entry.uploadSequence || known.keyVersion !== entry.keyVersion) throw new Error('Original quarantine evidence changed');
          } else {
            const { operationId: _path, ...fields } = entry; batch.set(target, { ...fields, createdAt: serverTimestamp() }); count++;
          }
        }
        if (count) await batch.commit(); checkAccount();
      }
    },
  };
}
