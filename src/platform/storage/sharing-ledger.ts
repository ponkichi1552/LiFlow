import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson, validateSharedOperation } from '../../features/sharing/operations.ts';
import type { SharedOperation } from '../../features/sharing/operations.ts';
import { buildSharedReplica } from '../../features/sharing/replica.ts';
import type { SharedReplica } from '../../features/sharing/replica.ts';
import type { AuthenticatedSharedOperation } from '../../features/sharing/crypto.ts';
import type { VerifiedSharedSnapshot } from '../../features/sharing/snapshots.ts';
import { withIsolatedSqliteTransaction as atomic } from './isolated-transaction.ts';
import { validateV2RetentionBody } from '../../features/sharing/v2/history-retention-schema.ts';
import { isolatedProjectionValue } from './isolated-projection-value.ts';

export interface SharingOutboxItem {
  operation: SharedOperation;
  encryptedEnvelope: string | null;
  attempts: number;
  nextAttemptAt: number;
}
export interface SharedLocalAuthor {
  groupId: string; userId: string; deviceId: string; keyVersion: number;
  schemaVersion?: 1 | 2; recordedAt?: string; receiptContext?: SharedOperation['receiptContext'];
  now?: () => Date;
}
export interface SharedLedgerEvidence {
  record: (transaction: SQLiteDatabase) => Promise<boolean>;
  acknowledge?: (transaction: SQLiteDatabase, operation: SharedOperation) => Promise<boolean>;
}
const tails = new WeakMap<SQLiteDatabase, Promise<unknown>>();

/** Shared ledger operations serialize on their own connection; never wrap a personal repository transaction. */
function serial<T>(db: SQLiteDatabase, operation: () => Promise<T>): Promise<T> {
  const pending = (tails.get(db) ?? Promise.resolve()).then(operation, operation);
  const tail = pending.then(() => undefined, () => undefined);
  tails.set(db, tail);
  void tail.then(() => { if (tails.get(db) === tail) tails.delete(db); });
  return pending;
}

/** Reads that rebuild v2 state share the same queue as mutations and received batches. */
export function withSharingLedgerTransaction<T>(db: SQLiteDatabase, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
  return serial(db, () => atomic(db, work));
}

export function initializeSharingLedger(db: SQLiteDatabase): Promise<void> {
  return serial(db, async () => { await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sharing_operations (
      operation_id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL,
      author_device_id TEXT NOT NULL,
      device_sequence INTEGER NOT NULL,
      logical_clock INTEGER NOT NULL,
      operation_json TEXT NOT NULL,
      author_signature TEXT,
      UNIQUE(group_id, author_device_id, device_sequence)
    );
    CREATE INDEX IF NOT EXISTS sharing_operations_group ON sharing_operations(group_id);
    CREATE INDEX IF NOT EXISTS sharing_operations_entity ON sharing_operations(group_id, CASE WHEN json_valid(operation_json) THEN json_extract(operation_json, '$.entityType') ELSE NULL END, operation_id);
    CREATE TABLE IF NOT EXISTS sharing_outbox (
      operation_id TEXT PRIMARY KEY NOT NULL REFERENCES sharing_operations(operation_id),
      encrypted_envelope TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sharing_cursors (
      group_id TEXT PRIMARY KEY NOT NULL,
      cursor TEXT NOT NULL,
      last_successful_sync_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sharing_snapshot_state (
      group_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL,
      through_sequence INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL
    );
  `);
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_operations)');
    if (!columns.some((column) => column.name === 'author_signature')) {
      try { await db.execAsync('ALTER TABLE sharing_operations ADD COLUMN author_signature TEXT'); }
      catch (error) {
        if (!(await db.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_operations)')).some((column) => column.name === 'author_signature')) throw error;
      }
    }
  });
}

async function loadOperations(db: SQLiteDatabase, groupId: string): Promise<SharedOperation[]> {
  return (await db.getAllAsync<{ operation_json: string }>(
    'SELECT operation_json FROM sharing_operations WHERE group_id = ? ORDER BY operation_id', groupId,
  )).map((row) => validateSharedOperation(JSON.parse(row.operation_json), groupId));
}

export function loadSharedReplica(db: SQLiteDatabase, groupId: string): Promise<SharedReplica> {
  return serial(db, () => atomic(db, (transaction) => loadReplicaInside(transaction, groupId)));
}

async function loadSnapshotInside(db: SQLiteDatabase, groupId: string): Promise<VerifiedSharedSnapshot | null> {
  const row = await db.getFirstAsync<{ snapshot_json: string }>('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id = ?', groupId);
  return row ? JSON.parse(row.snapshot_json) as VerifiedSharedSnapshot : null;
}
async function loadReplicaInside(db: SQLiteDatabase, groupId: string): Promise<SharedReplica> {
  return buildSharedReplica(groupId, await loadOperations(db, groupId), (await loadSnapshotInside(db, groupId))?.base);
}

/** One repository lifetime, one exact SQLite input; never a membership or proof cache. */
export function createSharedReplicaReader() {
  let retained: { source: string; replica: SharedReplica } | undefined;
  return async (db: SQLiteDatabase, groupId: string): Promise<SharedReplica> => {
    // The caller holds its normal ledger transaction. Read both tables every time,
    // including edits made by another connection or a transaction that rolled back.
    const rows = await db.getAllAsync<{ operation_json: string }>(
      'SELECT operation_json FROM sharing_operations WHERE group_id = ? ORDER BY operation_id', groupId);
    const snapshot = await db.getFirstAsync<{ snapshot_json: string }>('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id = ?', groupId);
    if (rows.some(row => typeof row.operation_json !== 'string') || snapshot && typeof snapshot.snapshot_json !== 'string') throw new Error('Invalid shared ledger content');
    const source = JSON.stringify([groupId, rows.map(row => row.operation_json), snapshot?.snapshot_json ?? null]);
    if (retained?.source === source) return isolatedProjectionValue(retained.replica);
    const replica = buildSharedReplica(groupId, rows.map(row => validateSharedOperation(JSON.parse(row.operation_json), groupId)),
      snapshot ? (JSON.parse(snapshot.snapshot_json) as VerifiedSharedSnapshot).base : undefined);
    // Bound retained input as well as object count; large groups still rebuild normally.
    retained = source.length <= 4 * 1024 * 1024 ? { source, replica: isolatedProjectionValue(replica) } : undefined;
    return replica;
  };
}

async function insertOperation(db: SQLiteDatabase, op: SharedOperation, signature?: string): Promise<boolean> {
  if (signature !== undefined && !/^[a-f0-9]{128}$/u.test(signature)) throw new Error('Invalid stored author proof');
  const existing = await db.getFirstAsync<{ operation_json: string; author_signature: string | null }>(
    'SELECT operation_json, author_signature FROM sharing_operations WHERE operation_id = ?', op.operationId,
  );
  const encoded = canonicalJson(op);
  if (existing) {
    if (existing.operation_json !== encoded) throw new Error('Operation ID reused with different content');
    if (signature && existing.author_signature && existing.author_signature !== signature) throw new Error('Original author proof cannot change');
    if (signature && !existing.author_signature) await db.runAsync('UPDATE sharing_operations SET author_signature = ? WHERE operation_id = ?', signature, op.operationId);
    return false;
  }
  await db.runAsync(`INSERT INTO sharing_operations
    (operation_id, group_id, author_device_id, device_sequence, logical_clock, operation_json, author_signature) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  op.operationId, op.groupId, op.authorDeviceId, op.deviceSequence, op.logicalClock, encoded, signature ?? null);
  return true;
}

/** The UI mutation and its outbox record either both commit or both roll back. Callback must use this DB only. */
export function commitLocalSharedOperation(
  db: SQLiteDatabase, raw: SharedOperation,
  apply: (db: SQLiteDatabase, replica: SharedReplica) => Promise<void>,
): Promise<SharedReplica> {
  const op = validateSharedOperation(raw);
  return serial(db, async () => {
    let result!: SharedReplica;
    await atomic(db, async (db) => {
      const inserted = await insertOperation(db, op);
      result = await loadReplicaInside(db, op.groupId);
      if (!inserted) return;
      await apply(db, result);
      await db.runAsync('INSERT INTO sharing_outbox (operation_id) VALUES (?)', op.operationId);
    });
    return result;
  });
}

/** Allocate clocks inside the write transaction so failed edits never leave an unrecoverable sequence hole. */
export function createLocalSharedOperation(
  db: SQLiteDatabase,
  author: SharedLocalAuthor,
  draft: Pick<SharedOperation, 'operationId' | 'entityType' | 'entityId' | 'operationType' | 'payload'>,
  apply: (db: SQLiteDatabase, replica: SharedReplica) => Promise<void>,
  sign?: (operation: SharedOperation) => string,
): Promise<SharedOperation> {
  return createLocalSharedOperations(db, author, [draft], apply, sign).then((operations) => operations[0]);
}

export type SharedOperationDraft = Pick<SharedOperation, 'operationId' | 'entityType' | 'entityId' | 'operationType' | 'payload'>;

/** Caller already holds the database transaction; do not re-enter the ledger queue. */
export function readSharedReplicaInsideTransaction(db: SQLiteDatabase, groupId: string): Promise<SharedReplica> {
  return loadReplicaInside(db, groupId);
}

/** One user action can update a chore and its baseline atomically; upload pages remain capped at 100. */
export function createLocalSharedOperations(
  db: SQLiteDatabase,
  author: SharedLocalAuthor,
  input: readonly SharedOperationDraft[] | ((transaction: SQLiteDatabase, replica: SharedReplica) => Promise<readonly SharedOperationDraft[]>),
  apply: (db: SQLiteDatabase, replica: SharedReplica) => Promise<void>,
  sign?: (operation: SharedOperation) => string,
): Promise<SharedOperation[]> {
  if (Array.isArray(input) && input.length > 256) return Promise.reject(new Error('Shared local transaction exceeds 256 changes'));
  const schemaVersion = author.schemaVersion ?? 1;
  const recordedAt = schemaVersion === 2 ? author.recordedAt ?? (author.now?.() ?? new Date()).toISOString() : undefined;
  return serial(db, async () => {
    const created: SharedOperation[] = [];
    await atomic(db, async (db) => {
      const before = await loadReplicaInside(db, author.groupId);
      const drafts = typeof input === 'function' ? await input(db, before) : input;
      if (drafts.length > 256) throw new Error('Shared local transaction exceeds 256 changes');
      if (before.operations.some((op) => op.authorDeviceId === author.deviceId && before.pendingOperationIds.includes(op.operationId))) {
        throw new Error('Recover missing local history before editing on this device');
      }
      const frontier = { ...before.frontier }; let clock = before.logicalClock; let changed = false;
      const retained = new Map(before.operations.map((op) => [op.operationId, op]));
      const receipts = new Set(before.operationIndex.map((item) => item.operationId));
      for (const draft of drafts) {
        const existingRow = await db.getFirstAsync<{ operation_json: string }>('SELECT operation_json FROM sharing_operations WHERE operation_id = ?', draft.operationId);
        const existing = existingRow ? validateSharedOperation(JSON.parse(existingRow.operation_json), author.groupId) : retained.get(draft.operationId);
        if (existing) {
          if (existing.authorUserId !== author.userId || existing.authorDeviceId !== author.deviceId
            || existing.schemaVersion !== schemaVersion || (schemaVersion === 2 && author.recordedAt !== undefined && existing.recordedAt !== author.recordedAt)
            || existing.entityType !== draft.entityType || existing.entityId !== draft.entityId
            || existing.operationType !== draft.operationType || canonicalJson(existing.payload) !== canonicalJson(draft.payload)) throw new Error('Operation ID reused with different content');
          created.push(existing); continue;
        }
        if (receipts.has(draft.operationId)) throw new Error('Operation ID already belongs to compacted history');
        const op = validateSharedOperation({ ...draft, schemaVersion, ...(recordedAt ? { recordedAt } : {}),
          ...(schemaVersion === 2 ? { receiptContext: author.receiptContext ?? {} } : {}), groupId: author.groupId, authorUserId: author.userId,
          authorDeviceId: author.deviceId, keyVersion: author.keyVersion, deviceSequence: (frontier[author.deviceId] ?? 0) + 1,
          logicalClock: clock + 1, context: frontier }, author.groupId);
        await insertOperation(db, op, sign?.(op));
        await db.runAsync('INSERT INTO sharing_outbox (operation_id) VALUES (?)', op.operationId);
        frontier[author.deviceId] = op.deviceSequence; clock = op.logicalClock; changed = true; created.push(op);
      }
      if (changed) await apply(db, await loadReplicaInside(db, author.groupId));
    });
    return created;
  });
}

/** Call only after every envelope has authenticated and passed membership validation. Cursor commits last. */
export function applyReceivedSharedOperations(
  db: SQLiteDatabase, groupId: string, input: readonly SharedOperation[], cursor: string,
  apply: (db: SQLiteDatabase, replica: SharedReplica) => Promise<void>, now = Date.now(),
  proofs?: ReadonlyMap<string, string>, expectedCursor?: string | null,
  evidence?: SharedLedgerEvidence,
): Promise<SharedReplica> {
  if (input.length > 100) return Promise.reject(new Error('Shared receive batch exceeds 100'));
  const operations = input.map((op) => validateSharedOperation(op, groupId));
  return serial(db, async () => {
    let result!: SharedReplica;
    await atomic(db, async (db) => {
      if (expectedCursor !== undefined) {
        const old = await db.getFirstAsync<{ cursor: string }>('SELECT cursor FROM sharing_cursors WHERE group_id = ?', groupId);
        if ((old?.cursor ?? null) !== expectedCursor) throw new Error('Shared receive position changed concurrently');
      }
      let changed = await evidence?.record(db) ?? false;
      const base = (await loadSnapshotInside(db, groupId))?.base;
      for (const op of operations) {
        if (op.deviceSequence <= (base?.frontier[op.authorDeviceId] ?? 0)) {
          // Validates old ID/dot receipts, but never resurrects a compacted edit.
          buildSharedReplica(groupId, [op], base);
          if (proofs?.has(op.operationId) && evidence?.acknowledge && await evidence.acknowledge(db, op)) {
            await db.runAsync('DELETE FROM sharing_outbox WHERE operation_id=?', op.operationId);
            await db.runAsync('DELETE FROM sharing_operations WHERE operation_id=?', op.operationId);
          }
          continue;
        }
        changed = (await insertOperation(db, op, proofs?.get(op.operationId))) || changed;
        if (proofs?.has(op.operationId) && (!evidence?.acknowledge || await evidence.acknowledge(db, op))) await db.runAsync('DELETE FROM sharing_outbox WHERE operation_id = ?', op.operationId);
      }
      result = await loadReplicaInside(db, groupId);
      if (changed) await apply(db, result);
      await db.runAsync(`INSERT INTO sharing_cursors (group_id, cursor, last_successful_sync_at) VALUES (?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET cursor=excluded.cursor, last_successful_sync_at=excluded.last_successful_sync_at`,
      groupId, cursor, now);
    });
    return result;
  });
}

export function listSharingOutbox(db: SQLiteDatabase, groupId: string, now = Date.now()): Promise<SharingOutboxItem[]> {
  return serial(db, async () => (await db.getAllAsync<{
    operation_json: string; encrypted_envelope: string | null; attempts: number; next_attempt_at: number;
  }>(`SELECT o.operation_json, q.encrypted_envelope, q.attempts, q.next_attempt_at FROM sharing_outbox q
    JOIN sharing_operations o USING(operation_id) WHERE o.group_id = ?
    ORDER BY o.logical_clock, o.operation_id LIMIT 100`, groupId))
    .map((row) => ({ operation: validateSharedOperation(JSON.parse(row.operation_json), groupId),
      encryptedEnvelope: row.encrypted_envelope, attempts: row.attempts, nextAttemptAt: row.next_attempt_at }))
    .filter((item, index, all) => all.slice(0, index + 1).every((earlier) => earlier.nextAttemptAt <= now)));
}

export function saveSharingEnvelope(db: SQLiteDatabase, operationId: string, envelope: string): Promise<void> {
  return serial(db, async () => {
    const current = await db.getFirstAsync<{ encrypted_envelope: string | null }>(
      'SELECT encrypted_envelope FROM sharing_outbox WHERE operation_id = ?', operationId,
    );
    if (!current) throw new Error('Missing shared outbox item');
    if (current.encrypted_envelope && current.encrypted_envelope !== envelope) throw new Error('Retry cannot replace an encrypted envelope');
    await db.runAsync('UPDATE sharing_outbox SET encrypted_envelope = ? WHERE operation_id = ?', envelope, operationId);
  });
}

export function acknowledgeSharingUpload(db: SQLiteDatabase, operationId: string, expected?: { groupId: string; envelope: string }): Promise<void> {
  return serial(db, async () => {
    if (expected) await db.runAsync(`DELETE FROM sharing_outbox WHERE operation_id = ? AND encrypted_envelope = ?
      AND EXISTS(SELECT 1 FROM sharing_operations WHERE operation_id = ? AND group_id = ?)`, operationId, expected.envelope, operationId, expected.groupId);
    else await db.runAsync('DELETE FROM sharing_outbox WHERE operation_id = ?', operationId);
  });
}

export function deferSharingUpload(db: SQLiteDatabase, operationId: string, now: number, random: number): Promise<void> {
  if (!Number.isFinite(now) || random < 0 || random >= 1 || !Number.isFinite(random)) return Promise.reject(new Error('Invalid retry clock or jitter'));
  return serial(db, async () => {
    const current = await db.getFirstAsync<{ attempts: number }>('SELECT attempts FROM sharing_outbox WHERE operation_id = ?', operationId);
    if (!current) return;
    const attempts = Math.min(current.attempts + 1, 30);
    const delay = Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 10));
    await db.runAsync('UPDATE sharing_outbox SET attempts = ?, next_attempt_at = ? WHERE operation_id = ?',
      attempts, Math.min(Number.MAX_SAFE_INTEGER, now + Math.round(delay * (0.75 + random * 0.5))), operationId);
  });
}

export function applyReceivedSharedFacts(db: SQLiteDatabase, groupId: string, facts: readonly AuthenticatedSharedOperation[],
  cursor: string, apply: (transaction: SQLiteDatabase, replica: SharedReplica) => Promise<void>, expectedCursor: string | null,
  now = Date.now(), evidence?: SharedLedgerEvidence): Promise<SharedReplica> {
  return applyReceivedSharedOperations(db, groupId, facts.map((fact) => fact.operation), cursor, apply, now,
    new Map(facts.map((fact) => [fact.operation.operationId, fact.authorSignature])), expectedCursor, evidence);
}

/** Persist the original proof independently of the current transport-key envelope. */
export function saveSharedAuthorProof(db: SQLiteDatabase, fact: AuthenticatedSharedOperation): Promise<void> {
  const operation = validateSharedOperation(fact.operation);
  return serial(db, async () => {
    const existing = await db.getFirstAsync<{ operation_json: string }>('SELECT operation_json FROM sharing_operations WHERE operation_id = ?', operation.operationId);
    if (!existing) throw new Error('Missing local operation for author proof');
    await insertOperation(db, operation, fact.authorSignature);
  });
}

export function loadSharedFacts(db: SQLiteDatabase, groupId: string): Promise<AuthenticatedSharedOperation[]> {
  return serial(db, () => atomic(db, (transaction) => readSharedFactsInsideTransaction(transaction, groupId)));
}

/** Use only inside an existing ledger transaction; queueing another ledger read there would deadlock. */
export async function readSharedFactsInsideTransaction(db: SQLiteDatabase, groupId: string): Promise<AuthenticatedSharedOperation[]> {
    const snapshot = await loadSnapshotInside(db, groupId);
    const facts = new Map(snapshot?.facts.map((fact) => [fact.operation.operationId, fact]));
    const rows = await db.getAllAsync<{ operation_json: string; author_signature: string | null }>(
      'SELECT operation_json, author_signature FROM sharing_operations WHERE group_id = ? ORDER BY operation_id', groupId);
    for (const row of rows) {
      if (!row.author_signature) throw new Error('An original author proof is missing');
      const operation = validateSharedOperation(JSON.parse(row.operation_json), groupId);
      facts.set(operation.operationId, { operation, authorSignature: row.author_signature });
    }
  return [...facts.values()];
}

/** Membership snapshots include published facts only; pending offline edits stay in the outbox and merge after rekeying. */
export function loadPublishedSharedReplica(db: SQLiteDatabase, groupId: string): Promise<SharedReplica> {
  return serial(db, () => atomic(db, async (db) => {
    const rows = await db.getAllAsync<{ operation_json: string }>(`SELECT operation_json FROM sharing_operations
      WHERE group_id = ? AND operation_id NOT IN (SELECT operation_id FROM sharing_outbox) ORDER BY operation_id`, groupId);
    return buildSharedReplica(groupId, rows.map((row) => validateSharedOperation(JSON.parse(row.operation_json), groupId)),
      (await loadSnapshotInside(db, groupId))?.base);
  }));
}

export function readSharingCheckpoint(db: SQLiteDatabase, groupId: string): Promise<{
  cursor: string | null; sequence: number; snapshotId: string | null; lastSuccessfulSyncAt: number | null; pendingCount: number;
}> {
  return serial(db, async () => {
    const row = await db.getFirstAsync<{ cursor: string; last_successful_sync_at: number | null }>(
      'SELECT cursor, last_successful_sync_at FROM sharing_cursors WHERE group_id = ?', groupId);
    const sequence = row ? Number(row.cursor) : 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid saved sharing position');
    const pending = await db.getFirstAsync<{ count: number }>(`SELECT count(*) AS count FROM sharing_outbox
      JOIN sharing_operations USING(operation_id) WHERE group_id = ?`, groupId);
    const snapshot = await db.getFirstAsync<{ snapshot_id: string }>('SELECT snapshot_id FROM sharing_snapshot_state WHERE group_id=?', groupId);
    return { cursor: row?.cursor ?? null, sequence, snapshotId: snapshot?.snapshot_id ?? null, lastSuccessfulSyncAt: row?.last_successful_sync_at ?? null, pendingCount: pending?.count ?? 0 };
  });
}

/** A newer authenticated snapshot acknowledges observed dots and keeps all still-offline edits. */
export function applySharingSnapshot(db: SQLiteDatabase, groupId: string, snapshot: VerifiedSharedSnapshot,
  apply: (transaction: SQLiteDatabase, replica: SharedReplica) => Promise<void>, expectedCursor: string | null,
  now = Date.now(), evidence?: SharedLedgerEvidence): Promise<SharedReplica> {
  if (snapshot.base.groupId !== groupId || !Number.isSafeInteger(snapshot.throughSequence) || snapshot.throughSequence < 0) return Promise.reject(new Error('Invalid received snapshot'));
  return serial(db, async () => {
    let result!: SharedReplica;
    await atomic(db, async (db) => {
      const cursor = await db.getFirstAsync<{ cursor: string }>('SELECT cursor FROM sharing_cursors WHERE group_id = ?', groupId);
      if ((cursor?.cursor ?? null) !== expectedCursor) throw new Error('Shared receive position changed concurrently');
      const prior = await loadSnapshotInside(db, groupId);
      const retention = snapshot.base.retention ? validateV2RetentionBody(snapshot.base.retention.proposal.operation.payload.checkpoint) : undefined;
      if (retention) await db.execAsync('PRAGMA secure_delete=ON');
      if (prior?.base.retention) {
        const previous = validateV2RetentionBody(prior.base.retention.proposal.operation.payload.checkpoint);
        if (!retention || retention.cutoff < previous.cutoff || Object.entries(previous.frontier).some(([device, count]) => count > (retention.frontier[device] ?? 0))) throw new Error('Snapshot history-retention rollback');
      }
      if (Object.entries(prior?.base.frontier ?? {}).some(([device, count]) => count > (snapshot.base.frontier[device] ?? 0))) throw new Error('Snapshot causal rollback');
      // Validate collisions and replay unpublished changes before replacing or deleting any old rows.
      result = buildSharedReplica(groupId, await loadOperations(db, groupId), snapshot.base);
      await db.runAsync(`INSERT INTO sharing_snapshot_state (group_id, snapshot_id, through_sequence, snapshot_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET snapshot_id=excluded.snapshot_id, through_sequence=excluded.through_sequence, snapshot_json=excluded.snapshot_json`,
      groupId, snapshot.snapshotId, snapshot.throughSequence, JSON.stringify(snapshot));
      await evidence?.record(db);
      for (const [device, sequence] of Object.entries(snapshot.base.frontier)) {
        if (evidence?.acknowledge) {
          const rows = await db.getAllAsync<{ operation_json: string }>('SELECT operation_json FROM sharing_operations WHERE group_id=? AND author_device_id=? AND device_sequence<=?', groupId, device, sequence);
          for (const row of rows) {
            const operation = validateSharedOperation(JSON.parse(row.operation_json), groupId);
            if (!(retention && operation.deviceSequence <= (retention.frontier[operation.authorDeviceId] ?? 0)) && !await evidence.acknowledge(db, operation)) continue;
            await db.runAsync('DELETE FROM sharing_outbox WHERE operation_id=?', operation.operationId);
            await db.runAsync('DELETE FROM sharing_operations WHERE operation_id=?', operation.operationId);
          }
        } else {
          await db.runAsync(`DELETE FROM sharing_outbox WHERE operation_id IN
          (SELECT operation_id FROM sharing_operations WHERE group_id = ? AND author_device_id = ? AND device_sequence <= ?)`, groupId, device, sequence);
          await db.runAsync('DELETE FROM sharing_operations WHERE group_id = ? AND author_device_id = ? AND device_sequence <= ?', groupId, device, sequence);
        }
      }
      await apply(db, result);
      if (retention) {
        // The projection above verifies every member's certificate before any deletion commits.
        if (await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name='sharing_v2_recovery_evidence_cache'")) {
          await db.runAsync('DELETE FROM sharing_v2_recovery_evidence_cache');
        }
        const ids = JSON.stringify(snapshot.facts.map(fact => fact.operation.operationId));
        if (await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name='sharing_v2_server_receipts'")) {
          await db.runAsync(`DELETE FROM sharing_v2_server_receipts WHERE group_id=?
            AND CAST(json_extract(receipt_json,'$.uploadSequence') AS INTEGER)<=?
            AND operation_id NOT IN (SELECT value FROM json_each(?))`, groupId, retention.throughSequence, ids);
        }
        if (await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name='sharing_v2_recovery_review'")) {
          await db.runAsync("DELETE FROM sharing_v2_recovery_review WHERE (status='applied' OR cancelled=1) AND CAST(json_extract(draft_json,'$.review.throughSequence') AS INTEGER)<=?", retention.throughSequence);
          const active = await db.getFirstAsync("SELECT singleton FROM sharing_v2_recovery_review WHERE status='review' AND cancelled=0");
          if (!active) await db.runAsync("DELETE FROM sharing_v2_recovery_originals WHERE CAST(json_extract(raw_json,'$.uploadSequence') AS INTEGER)<=?", retention.throughSequence);
        }
      }
      await db.runAsync(`INSERT INTO sharing_cursors (group_id, cursor, last_successful_sync_at) VALUES (?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET cursor=excluded.cursor, last_successful_sync_at=excluded.last_successful_sync_at`, groupId, String(Math.max(Number(cursor?.cursor ?? 0), snapshot.throughSequence)), now);
    });
    return result;
  });
}

/** Only use after upload confirmed absence under the new server epoch; never re-author the operation. */
export function replaceSharingEnvelopeAfterRotation(db: SQLiteDatabase, groupId: string, operationId: string,
  expectedEnvelope: string, replacement: string, serverAbsentAtKeyVersion: number): Promise<void> {
  return serial(db, async () => {
    const old = JSON.parse(expectedEnvelope); const next = JSON.parse(replacement);
    for (const key of ['operationId', 'groupId', 'authorUserId', 'authorDeviceId', 'logicalClock']) {
      if (old[key] !== next[key]) throw new Error('Rekeying cannot re-author a shared operation');
    }
    if (next.groupId !== groupId || next.operationId !== operationId || next.keyVersion !== serverAbsentAtKeyVersion
      || !Number.isSafeInteger(next.keyVersion) || next.keyVersion <= old.keyVersion) throw new Error('Invalid shared transport rekey');
    const result = await db.runAsync(`UPDATE sharing_outbox SET encrypted_envelope = ?, attempts = 0, next_attempt_at = 0
      WHERE operation_id = ? AND encrypted_envelope = ? AND EXISTS
      (SELECT 1 FROM sharing_operations WHERE operation_id = ? AND group_id = ?)`, replacement, operationId, expectedEnvelope, operationId, groupId);
    if (result.changes !== 1) throw new Error('Shared outbox changed during key rotation');
  });
}

export async function drainSharingLedger(db: SQLiteDatabase): Promise<void> { await tails.get(db); }
