import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from './sharing-v2-events';
import { assertJsonRecord, assertSharedIdentifier, canonicalJson, validateSharedOperation } from '../../features/sharing/operations.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { recoveryArrayDigest } from '../../features/sharing/v2/recovery-content.ts';
import { validateSharedSnapshotBase } from '../../features/sharing/replica.ts';
import { validateV2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';
import { MAX_V2_RECOVERY_SCAN_EVENTS, validateRawV2RecoveryEvent, V2RecoveryStaleError } from '../../features/sharing/v2/recovery-contract.ts';
import type { RawV2RecoveryEvent, V2RecoveryDraft } from '../../features/sharing/v2/recovery-contract.ts';

type Repository = ReturnType<typeof createV2EventRepository>;
function exact(value: unknown, fields: string[]) {
  assertJsonRecord(value);
  if (Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('Unknown private recovery draft field');
}
function capture(draft: V2RecoveryDraft, groupId: string): V2RecoveryDraft {
  exact(draft, ['review', 'baselineIndexDigest', 'baselineBase', 'rawEvents', 'receipts', 'preservedFacts', 'readyFacts', 'retainedBase', 'createdAtMs']);
  exact(draft.review, ['id', 'groupId', 'reviewDigest', 'previousRosterDigest', 'baselineSequence', 'throughSequence', 'retainedChanges',
    'unreadableChanges', 'heldChanges', 'restoredOriginals', 'removeDeviceIds', 'removeUserIds', 'entries']);
  assertSharedIdentifier(draft.review.id);
  if (draft.review.groupId !== groupId || !/^[a-f0-9]{64}$/u.test(draft.review.reviewDigest)
    || !/^[a-f0-9]{64}$/u.test(draft.review.previousRosterDigest) || !/^[a-f0-9]{64}$/u.test(draft.baselineIndexDigest)
    || !Number.isSafeInteger(draft.createdAtMs) || draft.createdAtMs < 0
    || !Array.isArray(draft.receipts) || !Array.isArray(draft.preservedFacts) || !Array.isArray(draft.readyFacts)
    || draft.receipts.length > MAX_V2_RECOVERY_SCAN_EVENTS || draft.readyFacts.length > MAX_V2_RECOVERY_SCAN_EVENTS || draft.preservedFacts.length > 256
    || !Array.isArray(draft.review.removeDeviceIds) || !Array.isArray(draft.review.removeUserIds) || !Array.isArray(draft.review.entries)
    || draft.review.entries.length > 256 || draft.review.removeDeviceIds.length > 64 || draft.review.removeUserIds.length > 16
    || ![draft.review.baselineSequence, draft.review.throughSequence, draft.review.retainedChanges, draft.review.unreadableChanges, draft.review.heldChanges, draft.review.restoredOriginals]
      .every(value => Number.isSafeInteger(value) && value >= 0)
    || !Array.isArray(draft.rawEvents) || draft.rawEvents.length > MAX_V2_RECOVERY_SCAN_EVENTS
    || draft.rawEvents.length !== draft.review.throughSequence - draft.review.baselineSequence) throw new Error('Invalid recovery draft scope or counts');
  for (const id of [...draft.review.removeDeviceIds, ...draft.review.removeUserIds]) assertSharedIdentifier(id);
  for (const entry of draft.review.entries) exact(entry, ['operationId', 'uploadSequence', 'authorUserId', 'authorDeviceId', 'keyVersion', 'rawDigest', 'receiptDigest', 'classification', 'preservedFactDigest']);
  const ids = new Set<string>();
  for (const raw of draft.rawEvents) {
    validateRawV2RecoveryEvent(raw, groupId);
    if (ids.has(raw.operationId)) throw new Error('Duplicate original recovery event'); ids.add(raw.operationId);
  }
  draft.receipts.forEach(validateV2ServerReceipt);
  for (const value of [...draft.readyFacts, ...draft.preservedFacts.map(item => item.fact)]) {
    exact(value, ['operation', 'authorSignature']); validateSharedOperation(value.operation, groupId);
    if (!/^[a-f0-9]{128}$/u.test(value.authorSignature)) throw new Error('Missing original recovery author proof');
  }
  draft.preservedFacts.forEach(value => { exact(value, ['fact', 'receipt']); validateV2ServerReceipt(value.receipt); });
  for (const base of [draft.retainedBase, draft.baselineBase]) {
    assertJsonRecord(base);
    if (Object.keys(base).some(key => !['groupId', 'frontier', 'logicalClock', 'operationIndex', 'operations', 'legacyMigrationWitness', 'recoveryWitnesses', 'retention'].includes(key))) {
      throw new Error('Unknown retained recovery history field');
    }
  }
  validateSharedSnapshotBase(groupId, draft.retainedBase);
  validateSharedSnapshotBase(groupId, draft.baselineBase);
  if (recoveryArrayDigest(draft.baselineBase.operationIndex) !== draft.baselineIndexDigest) throw new Error('Recovery baseline changed');
  // Every record was validated separately above. This is private storage, not a
  // signed event: its bounded history arrays may legitimately exceed 4096 items.
  const { baselineBase, retainedBase, rawEvents, receipts, preservedFacts, readyFacts, ...header } = draft;
  canonicalJson(header);
  for (const base of [baselineBase, retainedBase]) {
    const { operations, operationIndex, ...metadata } = base;
    canonicalJson(metadata); operations.forEach(value => canonicalJson(value)); operationIndex.forEach(value => canonicalJson(value));
  }
  for (const values of [rawEvents, receipts, preservedFacts, readyFacts]) values.forEach(value => canonicalJson(value));
  const json = JSON.stringify(draft);
  if (new TextEncoder().encode(json).length > 96 * 1024 * 1024) throw new Error('Private recovery draft exceeds the supported storage limit');
  return JSON.parse(json);
}
async function initialize(transaction: SQLiteDatabase) {
  await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_recovery_originals (
    operation_id TEXT PRIMARY KEY, raw_digest TEXT NOT NULL, raw_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sharing_v2_recovery_review (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), review_id TEXT NOT NULL, review_digest TEXT NOT NULL,
    draft_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('review','applied')), snapshot_id TEXT);`);
  const columns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_v2_recovery_review)');
  for (const name of ['confirmed', 'cancelled']) if (!columns.some(column => column.name === name)) {
    await transaction.execAsync(`ALTER TABLE sharing_v2_recovery_review ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
  }
}
export async function preserveV2RecoveryOriginalsInside(database: SQLiteDatabase, groupId: string, input: readonly RawV2RecoveryEvent[]) {
  await initialize(database);
  for (const value of input) {
    const raw = validateRawV2RecoveryEvent(value, groupId); const digest = sharedDocumentDigest(raw);
    const old = await database.getFirstAsync<{ raw_digest: string }>('SELECT raw_digest FROM sharing_v2_recovery_originals WHERE operation_id=?', raw.operationId);
    if (old && old.raw_digest !== digest) throw new V2RecoveryStaleError('同じ変更の元の暗号文が変わっています。以前の証拠を保持しました。');
    if (!old) await database.runAsync('INSERT INTO sharing_v2_recovery_originals VALUES (?, ?, ?)', raw.operationId, digest, canonicalJson(raw));
  }
}

/** Only one current review is retained. Immutable raw originals are deduplicated and never overwritten or deleted. */
export function createV2RecoveryStore(repository: Repository) {
  const { groupId, userId, deviceId } = repository.scope;
  async function transaction<T>(work: (database: SQLiteDatabase, state: Awaited<ReturnType<Repository['readState']>>) => Promise<T>, owner = false): Promise<T> {
    return repository.readCurrent(async (state, database) => {
      const current = state.archive.at(-1)!;
      if (owner && (current.body.ownerUserId !== userId || current.body.ownerDeviceId !== deviceId)) throw new Error('復旧の確認は所有者の端末で行ってください。');
      await initialize(database); return work(database, state);
    });
  }
  return {
    async save(draft: V2RecoveryDraft) {
      const saved = capture(draft, groupId);
      await transaction(async database => {
        const pending = await database.getFirstAsync<{ confirmed: number; cancelled: number; status: string }>('SELECT confirmed, cancelled, status FROM sharing_v2_recovery_review WHERE singleton=1');
        if (pending?.confirmed && !pending.cancelled && pending.status !== 'applied') throw new V2RecoveryStaleError('確認済みの復旧を先に再開または中断してください。');
        await preserveV2RecoveryOriginalsInside(database, groupId, saved.rawEvents);
        const { rawEvents, ...content } = saved;
        const stored = { ...content, rawReferences: rawEvents.map(raw => ({ operationId: raw.operationId, digest: sharedDocumentDigest(raw) })) };
        await database.runAsync(`INSERT INTO sharing_v2_recovery_review (singleton, review_id, review_digest, draft_json, status, snapshot_id, confirmed, cancelled) VALUES (1, ?, ?, ?, 'review', NULL, 0, 0)
          ON CONFLICT(singleton) DO UPDATE SET review_id=excluded.review_id, review_digest=excluded.review_digest,
          draft_json=excluded.draft_json, status='review', snapshot_id=NULL, confirmed=0, cancelled=0`, saved.review.id, saved.review.reviewDigest, JSON.stringify(stored));
      }, true);
    },
    async read() {
      return transaction(async (database, state) => {
        const row = await database.getFirstAsync<{ review_id: string; review_digest: string; draft_json: string; status: 'review' | 'applied'; snapshot_id: string | null; confirmed: number; cancelled: number }>('SELECT * FROM sharing_v2_recovery_review WHERE singleton=1');
        if (!row) return null;
        const { rawReferences, ...content } = JSON.parse(row.draft_json);
        if (!Array.isArray(rawReferences) || rawReferences.length > MAX_V2_RECOVERY_SCAN_EVENTS) throw new Error('Invalid recovery original references');
        const rawEvents: RawV2RecoveryEvent[] = [];
        for (const ref of rawReferences) {
          exact(ref, ['operationId', 'digest']); assertSharedIdentifier(ref.operationId);
          const raw = await database.getFirstAsync<{ raw_digest: string; raw_json: string }>('SELECT * FROM sharing_v2_recovery_originals WHERE operation_id=?', ref.operationId);
          if (!raw || raw.raw_digest !== ref.digest) throw new Error('Recovery original evidence is missing');
          const value = JSON.parse(raw.raw_json);
          if (sharedDocumentDigest(value) !== ref.digest) throw new Error('Recovery original evidence was altered');
          rawEvents.push(value);
        }
        const draft = capture({ ...content, rawEvents }, groupId);
        if (draft.review.id !== row.review_id || draft.review.reviewDigest !== row.review_digest) throw new Error('Recovery review metadata differs');
        const status = row.status === 'applied' ? 'applied' as const : row.cancelled ? 'cancelled' as const : row.confirmed ? 'confirming' as const : 'review' as const;
        return { draft, status, snapshotId: row.snapshot_id,
          locallyApplied: Boolean(state.replica.recoveryWitnesses?.some(witness => witness.body.reviewDigest === draft.review.reviewDigest)) };
      });
    },
    async markConfirming(id: string, expectedDigest: string) {
      await transaction(async database => {
        const changed = await database.runAsync(`UPDATE sharing_v2_recovery_review SET confirmed=1 WHERE singleton=1 AND review_id=? AND review_digest=? AND status='review' AND cancelled=0`, id, expectedDigest);
        if (changed.changes !== 1) throw new V2RecoveryStaleError('確認した復旧内容が変わっています。');
      }, true);
    },
    async markCancelled(id: string, expectedDigest: string) {
      await transaction(async database => {
        const changed = await database.runAsync(`UPDATE sharing_v2_recovery_review SET cancelled=1 WHERE singleton=1 AND review_id=? AND review_digest=? AND status='review'`, id, expectedDigest);
        if (changed.changes !== 1) throw new V2RecoveryStaleError('復旧の状態が変わりました。');
      }, true);
    },
    async markApplied(id: string, expectedDigest: string, snapshotId: string) {
      assertSharedIdentifier(id); assertSharedIdentifier(snapshotId);
      await transaction(async database => {
        const changed = await database.runAsync(`UPDATE sharing_v2_recovery_review SET status='applied', snapshot_id=?
          WHERE singleton=1 AND review_id=? AND review_digest=? AND confirmed=1 AND cancelled=0
          AND (status='review' OR snapshot_id=?)`, snapshotId, id, expectedDigest, snapshotId);
        if (changed.changes !== 1) throw new V2RecoveryStaleError('確認した復旧内容が変わっています。');
      }, true);
    },
  };
}
