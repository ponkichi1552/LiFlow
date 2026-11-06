import type { SharingCloud } from '../synchronizer.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { SignedV2RecoveryWitness } from './recovery-witness.ts';
import { validateRawV2RecoveryEvent } from './recovery-contract.ts';
import type { RawV2RecoveryEvent } from './recovery-contract.ts';
import { validateV2RecoveryCloudRecord, validateV2RecoveryQuarantine } from './recovery-cloud-contract.ts';
import type { V2RecoveryCloudRecord, V2RecoveryQuarantineRecord } from './recovery-cloud-contract.ts';
import { validateV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import type { RecoveryEvidencePart, V2RecoveryEvidenceProgress } from '../../../platform/storage/sharing-v2-recovery-evidence.ts';

/** A signed owner decision must still match the independently retained server ciphertext and receipt. */
export async function readV2RecoveryEvidence(cloud: SharingCloud, groupId: string, witnesses: readonly SignedV2RecoveryWitness[],
  assertCurrentAccount: () => void, deadlineAtMs: number,
  options: { progress?: V2RecoveryEvidenceProgress; now?: () => number } = {}): Promise<RawV2RecoveryEvent[]> {
  const now = options.now ?? Date.now;
  const check = () => {
    assertCurrentAccount();
    if (now() >= deadlineAtMs) throw Object.assign(new Error('復旧の証拠の取得は次の同期で続けます。'), { code: 'sharing/receipt-recovery-pending' });
  };
  const originals: RawV2RecoveryEvent[] = [];
  for (const witness of witnesses) {
    check(); const { body } = witness; const digest = sharedDocumentDigest(witness);
    const entries = new Map(body.entries.map(entry => [entry.operationId, entry]));
    // Every page is independently validated before staging. A deadline never turns partial proof into accepted state.
    async function stage<T>(part: RecoveryEvidencePart, ids: readonly string[], fetch: (ids: string[]) => Promise<readonly T[]>,
      validate: (value: unknown) => T, idOf: (value: T) => string, required = true): Promise<Map<string, T>> {
      const values = new Map<string, T>();
      for (let offset = 0; offset < ids.length; offset += 30) {
        const batch = ids.slice(offset, offset + 30);
        const cached = await options.progress?.read(digest, part, batch); assertCurrentAccount();
        for (const [id, raw] of cached ?? []) {
          const value = validate(raw);
          if (!batch.includes(id) || idOf(value) !== id) throw new Error('Recovery cache contains foreign evidence');
          values.set(id, value);
        }
        const missing = batch.filter(id => !values.has(id));
        if (!missing.length) continue;
        check(); const page = await fetch(missing); assertCurrentAccount();
        const owned = page.map(validate); const seen = new Set<string>();
        for (const value of owned) {
          const id = idOf(value);
          if (!missing.includes(id) || seen.has(id)) throw new Error('Recovery original evidence is missing duplicated or foreign');
          seen.add(id); values.set(id, value);
        }
        if (required && seen.size !== missing.length) throw new Error('Recovery original evidence is missing duplicated or foreign');
        // Save a completed request even if it used the remaining budget; start no further request after the deadline.
        await options.progress?.save(digest, part, owned.map(value => ({ id: idOf(value), value }))); assertCurrentAccount();
      }
      return values;
    }
    await stage('record', [body.snapshotId], async () => {
      const value = await cloud.readRecoveryRecord(groupId, body.snapshotId); return value ? [value] : [];
    }, raw => {
      const record = validateV2RecoveryCloudRecord(raw as V2RecoveryCloudRecord, groupId);
      if (record.snapshotId !== body.snapshotId || record.previousKeyVersion !== body.previousKeyVersion || record.keyVersion !== body.keyVersion
        || record.throughSequence !== body.throughSequence || record.reviewDigest !== body.reviewDigest) throw new Error('Recovery decision lacks its immutable encrypted server preparation');
      return record;
    }, record => record.snapshotId);
    const ids = body.entries.map(entry => entry.operationId);
    const events = await stage('original', ids, ids => cloud.readRecoveryOriginals(groupId, ids, { deadlineAtMs }), raw => {
      const event = validateRawV2RecoveryEvent(raw as RawV2RecoveryEvent, groupId); const entry = entries.get(event.operationId);
      if (!entry || event.uploadSequence !== entry.uploadSequence || event.keyVersion !== entry.keyVersion || event.authorUserId !== entry.authorUserId
        || event.authorDeviceId !== entry.authorDeviceId || sharedDocumentDigest(event) !== entry.rawDigest) throw new Error('Owner recovery decision differs from the immutable original evidence');
      return event;
    }, event => event.operationId);
    await stage('quarantine', ids, ids => cloud.readRecoveryQuarantines(groupId, ids, { deadlineAtMs }), raw => {
      const value = validateV2RecoveryQuarantine(raw as V2RecoveryQuarantineRecord); const entry = entries.get(value.operationId);
      // A resumed preparation uses a fresh encrypted snapshot ID while its original immutable quarantine can remain unchanged.
      if (!entry || value.rawDigest !== entry.rawDigest || value.uploadSequence !== entry.uploadSequence
        || value.keyVersion !== entry.keyVersion) throw new Error('Owner recovery decision differs from the immutable original evidence');
      return value;
    }, value => value.operationId);
    const received = await stage('receipt', ids.filter(id => entries.get(id)!.receiptDigest !== null),
      ids => cloud.readReceipts(groupId, ids, { deadlineAtMs }), raw => {
        const receipt = validateV2ServerReceipt(raw as V2ServerReceipt); const entry = entries.get(receipt.operationId);
        if (!entry || receipt.groupId !== groupId || sharedDocumentDigest(receipt) !== entry.receiptDigest) throw new Error('Owner recovery decision differs from the immutable original evidence');
        return receipt;
      }, receipt => receipt.operationId);
    // Absence is mutable and cannot be checkpointed as positive proof. Recheck these on every attempt.
    const absent = ids.filter(id => entries.get(id)!.receiptDigest === null);
    for (let offset = 0; offset < absent.length; offset += 30) {
      check(); const page = await cloud.readReceipts(groupId, absent.slice(offset, offset + 30), { deadlineAtMs }); assertCurrentAccount();
      if (page.length) throw new Error('Owner recovery decision differs from the immutable original evidence');
    }
    for (const entry of body.entries) {
      const event = events.get(entry.operationId)!; const receipt = received.get(entry.operationId);
      if (event.groupId !== groupId || event.uploadSequence !== entry.uploadSequence || event.keyVersion !== entry.keyVersion
        || event.authorUserId !== entry.authorUserId || event.authorDeviceId !== entry.authorDeviceId || sharedDocumentDigest(event) !== entry.rawDigest
        || (receipt ? sharedDocumentDigest(receipt) : null) !== entry.receiptDigest) throw new Error('Owner recovery decision differs from the immutable original evidence');
      originals.push(event);
    }
  }
  check();
  return originals;
}
