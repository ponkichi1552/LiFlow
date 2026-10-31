import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson } from '../../features/sharing/operations.ts';
import type { SharedOperation } from '../../features/sharing/operations.ts';
import type { SharedReplica } from '../../features/sharing/replica.ts';
import { assertVerifiedLegacyMigration, readVerifiedLegacyMigrationSnapshot } from '../../features/sharing/v2/legacy-migration-source.ts';
import { sharedDocumentDigest, signSharedOperation, verifyAuthenticatedSharedOperation } from '../../features/sharing/crypto.ts';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifySharedRosterArchive } from '../../features/sharing/roster.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { assessV2BusinessHistory } from '../../features/sharing/v2/receiver-authority.ts';
import type { VerifiedLegacyMigration } from '../../features/sharing/v2/receiver-authority.ts';
import { rosterAtOperation } from '../../features/sharing/v2/authority-context.ts';
import { isSupportedV2Scheduler } from '../../features/sharing/v2/payload-schema.ts';
import { SharingAccessError, SharingSchedulerVersionError } from '../../features/sharing/cloud-contract.ts';
import { assertSharedProjectionCanInitialize, initializeSharedProjection } from './sharing-projection.ts';
import { createLocalSharedOperations, initializeSharingLedger, readSharedFactsInsideTransaction, readSharedReplicaInsideTransaction, withSharingLedgerTransaction } from './sharing-ledger.ts';
import type { SharedOperationDraft, SharedLedgerEvidence } from './sharing-ledger.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { initializeV2ReceiptTable, persistV2ServerReceiptsInside, readV2ServerReceiptsInside } from './sharing-v2-receipts.ts';
import { bindV2ServerReceipt, v2AuthorProofDigest } from '../../features/sharing/v2/server-receipts.ts';
import type { V2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';
import { v2ConfirmedReceiptContext } from '../../features/sharing/v2/receipt-context.ts';
import { captureV2Input } from '../../features/sharing/v2/input-capture.ts';

interface V2StoreScope { userId: string; groupId: string; householdId: string }
function digestPages(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < values.length; offset += 1000) result.push(sharedDocumentDigest(values.slice(offset, offset + 1000)));
  return result;
}

const initializations = new WeakMap<SQLiteDatabase, Promise<void>>();
/** Coalesce startup on one handle; subsequent callers still verify the permanent account/group binding. */
export function initializeV2EventStore(database: SQLiteDatabase, scope: V2StoreScope): Promise<void> {
  const captured = { userId: scope.userId, groupId: scope.groupId, householdId: scope.householdId };
  const existing = initializations.get(database);
  if (existing) return existing.then(() => assertV2Binding(database, captured));
  const pending = initializeV2EventStoreImpl(database, captured); initializations.set(database, pending);
  void pending.catch(() => { if (initializations.get(database) === pending) initializations.delete(database); });
  return pending;
}

/** A fresh, explicitly selected DB only. Existing private and v1 workspaces are never converted in place. */
async function initializeV2EventStoreImpl(database: SQLiteDatabase, scope: V2StoreScope): Promise<void> {
  const tables = new Set((await database.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map((row) => row.name));
  if (tables.has('sharing_workspace_metadata') && !tables.has('sharing_v2_binding')) throw new Error('Prepare a separate v2 database before migrating a v1 workspace');
  if (!tables.has('sharing_v2_binding') && ['households', 'household_settings', 'chore_definitions', 'chore_completions'].some((name) => tables.has(name))) {
    throw new Error('既存の個人DB構造を共有v2へ変換することはできません。別の共有用DBを準備してください。');
  }
  if (!tables.has('sharing_v2_binding') && tables.has('sharing_operations') && await database.getFirstAsync('SELECT 1 FROM sharing_operations LIMIT 1')) throw new Error('An existing unbound ledger requires a verified migration');
  await assertSharedProjectionCanInitialize(database);
  await withIsolatedSqliteTransaction(database, async (transaction) => {
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_binding (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL, group_id TEXT NOT NULL,
      household_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=2));`);
    await transaction.runAsync('INSERT OR IGNORE INTO sharing_v2_binding VALUES (1, ?, ?, ?, 2)', scope.userId, scope.groupId, scope.householdId);
    await assertV2Binding(transaction, scope);
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_projection (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), fact_hash TEXT NOT NULL, accepted_ids_json TEXT NOT NULL,
      rejected_json TEXT NOT NULL, pending_ids_json TEXT NOT NULL, provisional_ids_json TEXT NOT NULL DEFAULT '[]');`);
    if (!(await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_v2_projection)')).some((column) => column.name === 'provisional_ids_json')) {
      await transaction.execAsync("ALTER TABLE sharing_v2_projection ADD COLUMN provisional_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!(await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_v2_projection)')).some((column) => column.name === 'request_states_json')) {
      await transaction.execAsync("ALTER TABLE sharing_v2_projection ADD COLUMN request_states_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!(await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_v2_projection)')).some((column) => column.name === 'formal_rules_json')) {
      await transaction.execAsync("ALTER TABLE sharing_v2_projection ADD COLUMN formal_rules_json TEXT NOT NULL DEFAULT '[]'");
    }
    await initializeV2ReceiptTable(transaction);
  });
  await initializeSharedProjection(database, scope); await initializeSharingLedger(database);
}
async function assertV2Binding(database: SQLiteDatabase, scope: V2StoreScope): Promise<void> {
  const stored = await database.getFirstAsync<{ user_id: string; group_id: string; household_id: string; schema_version: number }>('SELECT * FROM sharing_v2_binding WHERE singleton=1');
  if (stored?.user_id !== scope.userId || stored.group_id !== scope.groupId || stored.household_id !== scope.householdId || stored.schema_version !== 2) throw new SharingAccessError('共有v2のアカウント・グループが一致しません。');
}

export function createV2EventRepository(database: SQLiteDatabase, options: V2StoreScope & {
  identity: DeviceSecretIdentity; anchor: VerifiedSharedRoster; archive: () => readonly VerifiedSharedRoster[];
  assertWritable: () => void; verifyCurrentAccess?: (editing: boolean) => Promise<void>;
  migration?: VerifiedLegacyMigration; now?: () => Date; afterCommit?: () => void;
}) {
  const clock = options.now ?? (() => new Date());
  async function assertCurrentAccess(editing = false) {
    options.assertWritable(); await options.verifyCurrentAccess?.(editing); options.assertWritable();
  }
  let checkedArchive: { digest: string; value: VerifiedSharedRoster[] } | null = null;
  const authenticated = new Map<string, string>();
  let seededMigration: VerifiedLegacyMigration | undefined;
  function archive() {
    const input = options.archive(); const latest = input.at(-1); if (!latest) throw new SharingAccessError('共有メンバーを確認できません。');
    const digest = sharedRosterDigest(latest);
    if (checkedArchive?.digest !== digest) checkedArchive = { digest, value: verifySharedRosterArchive(options.anchor, input) };
    return checkedArchive.value;
  }
  async function project(transaction: SQLiteDatabase, replica: SharedReplica, localIds?: ReadonlySet<string>) {
    await assertCurrentAccess(localIds !== undefined);
    await assertV2Binding(transaction, options);
    if (replica.groupId !== options.groupId) throw new SharingAccessError('共有グループが一致しません。');
    const history = archive(); const latest = history.at(-1)!;
    const expectedRoster = sharedRosterDigest(latest);
    if (latest.body.schemaVersion !== 2 || !isSupportedV2Scheduler(latest.body.schedulerVersion)) throw new SharingSchedulerVersionError();
    sharedAuthorIdentity(latest, options.userId, options.identity.deviceId, latest.body.keyVersion);
    // The opaque migration checkpoint already authenticated every original proof
    // during this process's restore. Reuse those exact proofs in the existing
    // content-addressed cache instead of verifying all legacy signatures twice.
    // Deserialized/forged checkpoints, a changed chain or a changed fact still fail.
    const migration = options.migration;
    if (migration && migration !== seededMigration) {
      assertVerifiedLegacyMigration(migration, replica, history);
      for (const fact of readVerifiedLegacyMigrationSnapshot(migration).facts) {
        const operation = fact.operation; const epoch = rosterAtOperation(history, operation);
        const identity = sharedAuthorIdentity(epoch, operation.authorUserId, operation.authorDeviceId, operation.keyVersion);
        authenticated.set(operation.operationId, sharedDocumentDigest([operation, fact.authorSignature, identity]));
      }
      seededMigration = migration;
    }
    const proofs = new Map((await readSharedFactsInsideTransaction(transaction, options.groupId)).map((fact) => [fact.operation.operationId, fact]));
    const receipts = await readV2ServerReceiptsInside(transaction, options.groupId);
    const retained = new Set(replica.operations.map((operation) => operation.operationId));
    if (replica.operationIndex.some((receipt) => receipt.sequence > (options.migration?.frontier[receipt.deviceId] ?? 0)
      && !retained.has(receipt.operationId))) throw new Error('A v2 snapshot cannot discard authority or business history');
    for (const operation of replica.operations) {
      const fact = proofs.get(operation.operationId);
      if (!fact || canonicalJson(fact.operation) !== canonicalJson(operation)) throw new Error('Missing original v2 author proof');
      const epoch = rosterAtOperation(history, operation);
      const identity = sharedAuthorIdentity(epoch, operation.authorUserId, operation.authorDeviceId, operation.keyVersion);
      const digest = sharedDocumentDigest([operation, fact.authorSignature, identity]);
      if (authenticated.get(operation.operationId) !== digest) {
        verifyAuthenticatedSharedOperation(fact, identity, options.groupId); authenticated.set(operation.operationId, digest);
      }
      const receipt = receipts.get(operation.operationId); if (receipt) bindV2ServerReceipt(receipt, fact, history);
    }
    while (authenticated.size > 50_000) authenticated.delete(authenticated.keys().next().value!);
    const pendingRows = await transaction.getAllAsync<{ operation_id: string }>(`SELECT q.operation_id FROM sharing_outbox q
      JOIN sharing_operations o USING(operation_id) WHERE o.group_id=? AND o.author_device_id=?`, options.groupId, options.identity.deviceId);
    const assessment = assessV2BusinessHistory(replica, history, options.migration, { receipts, facts: proofs, pendingLocalIds: new Set(pendingRows.map((row) => row.operation_id)) });
    const failedLocal = assessment.rejected.find((entry) => localIds?.has(entry.operationId)); if (failedLocal) throw failedLocal.error;
    const accepted = assessment.view.ready.map((operation) => operation.operationId);
    const rejected = assessment.rejected.map((entry) => ({ operationId: entry.operationId, kind: entry.kind,
      reason: 'code' in entry.error ? String(entry.error.code) : 'sharing/v2-invalid-business-fact' }));
    const requestStates = assessment.requestStates;
    options.assertWritable();
    if (sharedRosterDigest(archive().at(-1)!) !== expectedRoster) throw new SharingAccessError('処理中に共有権限が変わりました。');
    const factHash = sharedDocumentDigest({ protocol: 2, projection: 'v2-authority-5', algorithm: latest.body.schedulerVersion,
      sources: digestPages(replica.operations.map((operation) => sharedDocumentDigest(operation))),
      receipts: digestPages([...receipts.values()].map((receipt) => sharedDocumentDigest(receipt))),
      accepted: digestPages(accepted), rejected: digestPages(rejected), provisional: digestPages(assessment.provisionalOperationIds),
      requests: digestPages(requestStates.map(({ decisions, counteroffers, conflictIds, ...state }) => sharedDocumentDigest({ ...state,
        decisions: digestPages(decisions), counteroffers: digestPages(counteroffers), conflictIds: digestPages(conflictIds) }))),
      formalRules: digestPages(assessment.approvedRules.map((rule) => sharedDocumentDigest(rule))),
      assignmentRequests: digestPages(assessment.assignmentRequests.map((request) => sharedDocumentDigest(request))),
      roster: sharedRosterDigest(latest) });
    await transaction.runAsync(`INSERT INTO sharing_v2_projection (singleton, fact_hash, accepted_ids_json, rejected_json, pending_ids_json, provisional_ids_json, request_states_json, formal_rules_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
      fact_hash=excluded.fact_hash, accepted_ids_json=excluded.accepted_ids_json, rejected_json=excluded.rejected_json,
      pending_ids_json=excluded.pending_ids_json, provisional_ids_json=excluded.provisional_ids_json,
      request_states_json=excluded.request_states_json, formal_rules_json=excluded.formal_rules_json WHERE fact_hash != excluded.fact_hash`, factHash,
    JSON.stringify(accepted), JSON.stringify(rejected), JSON.stringify(replica.pendingOperationIds), JSON.stringify(assessment.provisionalOperationIds), JSON.stringify(requestStates), JSON.stringify(assessment.approvedRules));
    await assertCurrentAccess(localIds !== undefined);
    if (sharedRosterDigest(archive().at(-1)!) !== expectedRoster) throw new SharingAccessError('保存中に共有権限が変わりました。');
    return { ...assessment, pendingOutboxIds: pendingRows.map((row) => row.operation_id) };
  }
  async function readStateInside(transaction: SQLiteDatabase, replica?: SharedReplica) {
    options.assertWritable();
    const source = replica ?? await readSharedReplicaInsideTransaction(transaction, options.groupId);
    const assessment = await project(transaction, source);
    const history = archive(); const expected = sharedRosterDigest(history.at(-1)!);
    const receipts = await readV2ServerReceiptsInside(transaction, options.groupId);
    await assertCurrentAccess(); if (sharedRosterDigest(archive().at(-1)!) !== expected) throw new SharingAccessError('読み込み中に共有権限が変わりました。');
    return { assessment, replica: source, archive: history, receipts };
  }
  type CurrentBuilder = (state: Awaited<ReturnType<typeof readStateInside>>, transaction: SQLiteDatabase) => Promise<readonly SharedOperationDraft[]>;
  async function commit(input: readonly SharedOperationDraft[] | ((replica: SharedReplica) => Promise<readonly SharedOperationDraft[]>) | { build: CurrentBuilder }): Promise<SharedOperation[]> {
    options.assertWritable(); const latest = archive().at(-1)!; const localIds = new Set<string>();
    const capturedInput = typeof input === 'function' ? input : 'build' in input ? { build: input.build } : captureV2Input(input);
    if (latest.body.schemaVersion !== 2 || !isSupportedV2Scheduler(latest.body.schedulerVersion)) throw new SharingSchedulerVersionError();
    const operationTime = clock();
    const author = { groupId: options.groupId, userId: options.userId, deviceId: options.identity.deviceId,
      keyVersion: latest.body.keyVersion, schemaVersion: 2 as const, now: () => operationTime, receiptContext: {} };
    const created = await createLocalSharedOperations(database, author, async (transaction, replica) => {
      await assertCurrentAccess(true); await assertV2Binding(transaction, options);
      if (sharedRosterDigest(archive().at(-1)!) !== sharedRosterDigest(latest)) throw new SharingAccessError('編集開始後に共有権限が変わりました。');
      const current = await readStateInside(transaction, replica);
      author.receiptContext = v2ConfirmedReceiptContext(current.assessment.view.ready, current.receipts);
      const drafts = typeof capturedInput === 'function' ? captureV2Input(await capturedInput(replica))
        : 'build' in capturedInput ? captureV2Input(await capturedInput.build(current, transaction)) : capturedInput;
      await assertCurrentAccess(true);
      for (const draft of drafts) localIds.add(draft.operationId); return drafts;
    }, async (transaction, replica) => { options.assertWritable(); await project(transaction, replica, localIds); }, (op) => signSharedOperation(op, options.identity).authorSignature);
    if (created.length) try { void Promise.resolve(options.afterCommit?.()).catch(() => undefined); } catch { /* A notification cannot undo committed facts or require another business write. */ }
    return created;
  }
  return {
    scope: Object.freeze({ groupId: options.groupId, userId: options.userId, householdId: options.householdId, deviceId: options.identity.deviceId }),
    readReceiptCache: async (transaction: SQLiteDatabase) => {
      await assertCurrentAccess(); await assertV2Binding(transaction, options);
      const receipts = await readV2ServerReceiptsInside(transaction, options.groupId); await assertCurrentAccess(); return receipts;
    },
    async readState() {
      options.assertWritable();
      return withSharingLedgerTransaction(database, readStateInside);
    },
    /** Local adapters may read their private bindings against the same authenticated state and transaction. */
    readCurrent<T>(read: (state: Awaited<ReturnType<typeof readStateInside>>, transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
      return withSharingLedgerTransaction(database, async transaction => {
        const state = await readStateInside(transaction); const value = await read(state, transaction);
        await assertCurrentAccess(); await assertV2Binding(transaction, options); return value;
      });
    },
    project: async (transaction: SQLiteDatabase, replica: SharedReplica) => { await project(transaction, replica); },
    evidenceForServerReceipts(receipts: readonly V2ServerReceipt[]): SharedLedgerEvidence {
      let stored: ReadonlyMap<string, V2ServerReceipt> = new Map();
      return { record: async (transaction) => {
        await assertCurrentAccess();
        await assertV2Binding(transaction, options);
        const changed = await persistV2ServerReceiptsInside(transaction, options.groupId, receipts);
        stored = await readV2ServerReceiptsInside(transaction, options.groupId); await assertCurrentAccess(); return changed;
      }, acknowledge: async (transaction, operation) => {
        if (operation.schemaVersion === 1) return true;
        const receipt = stored.get(operation.operationId); if (!receipt) return false;
        const row = await transaction.getFirstAsync<{ author_signature: string | null }>('SELECT author_signature FROM sharing_operations WHERE operation_id=?', operation.operationId);
        return Boolean(row?.author_signature && receipt.authorProofDigest === v2AuthorProofDigest({ operation, authorSignature: row.author_signature }));
      } };
    },
    commit,
    /** Build against this transaction's authenticated state, without a nested read or stale UI snapshot. */
    commitCurrent: (build: CurrentBuilder) => commit({ build }),
  };
}
