import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson } from '../../features/sharing/operations.ts';
import type { SharedOperation } from '../../features/sharing/operations.ts';
import type { SharedReplica } from '../../features/sharing/replica.ts';
import { buildSharedReplica } from '../../features/sharing/replica.ts';
import type { V2RetentionBody } from '../../features/sharing/v2/history-retention-schema';
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
import { createLocalSharedOperations, createSharedReplicaReader, initializeSharingLedger, readSharedFactsInsideTransaction, withSharingLedgerTransaction } from './sharing-ledger.ts';
import type { SharedOperationDraft, SharedLedgerEvidence } from './sharing-ledger.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { initializeV2ReceiptTable, persistV2ServerReceiptsInside, readV2ServerReceiptsInside } from './sharing-v2-receipts.ts';
import { bindV2ServerReceipt, v2AuthorProofDigest } from '../../features/sharing/v2/server-receipts.ts';
import type { V2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';
import { v2ConfirmedReceiptContext } from '../../features/sharing/v2/receipt-context.ts';
import { captureV2Input } from '../../features/sharing/v2/input-capture.ts';
import { isolatedProjectionValue } from './isolated-projection-value.ts';
import { traceStartup, traceStartupSync } from '../diagnostics/startup-timing.ts';

interface V2StoreScope { userId: string; groupId: string; householdId: string }
export interface V2LocalCompletionIntent { id: string; digest: string }
type V2LocalMutationIntent = V2LocalCompletionIntent & { kind: 'completion' | 'calendar' };
function digestPages(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < values.length; offset += 1000) result.push(sharedDocumentDigest(values.slice(offset, offset + 1000)));
  return result;
}

/** Keep cold authentication responsive without publishing a partially checked replica. */
async function verifyInSlices<T>(values: Iterable<T>, verify: (value: T) => void, assertCurrent: () => void) {
  let resumedAt = performance.now();
  for (const value of values) {
    verify(value);
    if (performance.now() - resumedAt >= 8) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      assertCurrent();
      resumedAt = performance.now();
    }
  }
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
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_catalog_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), catalog_version INTEGER NOT NULL);`);
    if (await transaction.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_v2_completion_intents'")) {
      await transaction.execAsync('ALTER TABLE sharing_v2_completion_intents RENAME TO sharing_v2_mutation_intents');
    }
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_mutation_intents (
      intent_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      target_digest TEXT NOT NULL);`);
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
  const readReplica = createSharedReplicaReader();
  async function assertCurrentAccess(editing = false) {
    options.assertWritable(); await options.verifyCurrentAccess?.(editing); options.assertWritable();
  }
  let checkedArchive: { digest: string; value: VerifiedSharedRoster[] } | null = null;
  let projectionCache: { source: string; migration?: VerifiedLegacyMigration; value: ReturnType<typeof assessV2BusinessHistory>; factHash?: string } | undefined;
  const authenticated = new Map<string, string>();
  let seededMigration: VerifiedLegacyMigration | undefined;
  function archive() {
    const input = options.archive(); const latest = input.at(-1); if (!latest) throw new SharingAccessError('共有メンバーを確認できません。');
    const digest = canonicalJson([options.anchor, input]);
    if (checkedArchive?.digest !== digest) checkedArchive = { digest,
      value: traceStartupSync('v2.archiveVerify', () => isolatedProjectionValue(verifySharedRosterArchive(options.anchor, input))) };
    return isolatedProjectionValue(checkedArchive.value);
  }
  async function project(transaction: SQLiteDatabase, replica: SharedReplica, localIds?: ReadonlySet<string>) {
    await assertCurrentAccess(localIds !== undefined);
    await assertV2Binding(transaction, options);
    if (replica.groupId !== options.groupId) throw new SharingAccessError('共有グループが一致しません。');
    const history = archive(); const latest = history.at(-1)!;
    const expectedRoster = sharedRosterDigest(latest);
    if (latest.body.schemaVersion !== 2 || !isSupportedV2Scheduler(latest.body.schedulerVersion)) throw new SharingSchedulerVersionError();
    sharedAuthorIdentity(latest, options.userId, options.identity.deviceId, latest.body.keyVersion);
    const proofs = new Map((await readSharedFactsInsideTransaction(transaction, options.groupId)).map((fact) => [fact.operation.operationId, fact]));
    const receipts = await readV2ServerReceiptsInside(transaction, options.groupId);
    const pendingRows = await transaction.getAllAsync<{ operation_id: string }>(`SELECT q.operation_id FROM sharing_outbox q
      JOIN sharing_operations o USING(operation_id) WHERE o.group_id=? AND o.author_device_id=?`, options.groupId, options.identity.deviceId);
    const source = traceStartupSync('v2.projectionSource', () => JSON.stringify({ replica, history, proofs: [...proofs], receipts: [...receipts], pending: pendingRows }));
    const migration = replica.retention ? undefined : options.migration;
    const unchanged = projectionCache?.source === source && projectionCache.migration === migration;
    if (replica.retention) seededMigration = undefined;
    // The opaque migration checkpoint already authenticated every original proof
    // during this process's restore. Reuse those exact proofs in the existing
    // content-addressed cache instead of verifying all legacy signatures twice.
    // Deserialized/forged checkpoints, a changed chain or a changed fact still fail.
    if (migration && migration !== seededMigration) {
      await traceStartup('v2.migrationProofs', async () => {
        assertVerifiedLegacyMigration(migration, replica, history);
        await verifyInSlices(readVerifiedLegacyMigrationSnapshot(migration).facts, fact => {
          const operation = fact.operation; const epoch = rosterAtOperation(history, operation);
          const identity = sharedAuthorIdentity(epoch, operation.authorUserId, operation.authorDeviceId, operation.keyVersion);
          authenticated.set(operation.operationId, sharedDocumentDigest([operation, fact.authorSignature, identity]));
        }, options.assertWritable);
      });
      seededMigration = migration;
    }
    if (!unchanged) await traceStartup('v2.operationProofs', () =>
      verifyInSlices(replica.operations, operation => {
        const fact = proofs.get(operation.operationId);
        if (!fact || canonicalJson(fact.operation) !== canonicalJson(operation)) throw new Error('Missing original v2 author proof');
        const epoch = rosterAtOperation(history, operation);
        const identity = sharedAuthorIdentity(epoch, operation.authorUserId, operation.authorDeviceId, operation.keyVersion);
        const digest = sharedDocumentDigest([operation, fact.authorSignature, identity]);
        if (authenticated.get(operation.operationId) !== digest) {
          verifyAuthenticatedSharedOperation(fact, identity, options.groupId); authenticated.set(operation.operationId, digest);
        }
        const receipt = receipts.get(operation.operationId); if (receipt) bindV2ServerReceipt(receipt, fact, history);
      }, options.assertWritable));
    while (authenticated.size > 50_000) authenticated.delete(authenticated.keys().next().value!);
    // Every proof/receipt is authenticated on a miss, and every read checks current
    // membership and exact input equality. Never trust SQLite revision flags alone.
    // The cached query closures capture private copies and callers receive isolated values.
    const cache: NonNullable<typeof projectionCache> = unchanged ? projectionCache! : { source, migration,
      value: traceStartupSync('v2.businessAssessment', () => assessV2BusinessHistory(isolatedProjectionValue(replica), isolatedProjectionValue(history), migration,
        { receipts: isolatedProjectionValue(receipts), facts: isolatedProjectionValue(proofs), pendingLocalIds: new Set(pendingRows.map(row => row.operation_id)) })) };
    // Assessment verifies the collective retention certificate before exposing
    // its frontier. Reuse that result here instead of authenticating it twice.
    // Missing history still rejects the entire read before any projection write.
    const retained = new Set(replica.operations.map((operation) => operation.operationId));
    const retainedFrontier = cache.value.view.retainedFrontier();
    if (replica.operationIndex.some((receipt) => receipt.sequence > Math.max(migration?.frontier[receipt.deviceId] ?? 0, retainedFrontier?.[receipt.deviceId] ?? 0)
      && !retained.has(receipt.operationId))) throw new Error('A v2 snapshot cannot discard authority or business history');
    projectionCache = cache;
    const assessment = isolatedProjectionValue(cache.value);
    const failedLocal = assessment.rejected.find((entry) => localIds?.has(entry.operationId)); if (failedLocal) throw failedLocal.error;
    const accepted = assessment.view.ready.map((operation) => operation.operationId);
    const rejected = assessment.rejected.map((entry) => ({ operationId: entry.operationId, kind: entry.kind,
      reason: 'code' in entry.error ? String(entry.error.code) : 'sharing/v2-invalid-business-fact' }));
    const requestStates = assessment.requestStates;
    options.assertWritable();
    if (sharedRosterDigest(archive().at(-1)!) !== expectedRoster) throw new SharingAccessError('処理中に共有権限が変わりました。');
    const factHash = cache.factHash ??= sharedDocumentDigest({ protocol: 2, projection: 'v2-authority-5', algorithm: latest.body.schedulerVersion,
      sources: digestPages(replica.operations.map((operation) => sharedDocumentDigest(operation))),
      receipts: digestPages([...receipts.values()].map((receipt) => sharedDocumentDigest(receipt))),
      accepted: digestPages(accepted), rejected: digestPages(rejected), provisional: digestPages(assessment.provisionalOperationIds),
      requests: digestPages(requestStates.map(({ decisions, counteroffers, conflictIds, ...state }) => sharedDocumentDigest({ ...state,
        decisions: digestPages(decisions), counteroffers: digestPages(counteroffers), conflictIds: digestPages(conflictIds) }))),
      formalRules: digestPages(assessment.approvedRules.map((rule) => sharedDocumentDigest(rule))),
      assignmentRequests: digestPages(assessment.assignmentRequests.map((request) => sharedDocumentDigest(request))),
      roster: sharedRosterDigest(latest) });
    const projectionValues = [factHash, JSON.stringify(accepted), JSON.stringify(rejected), JSON.stringify(replica.pendingOperationIds),
      JSON.stringify(assessment.provisionalOperationIds), JSON.stringify(requestStates), JSON.stringify(assessment.approvedRules)] as const;
    // Even an UPSERT whose WHERE is false acquires SQLite's writer lock. Keep
    // unchanged reads read-only, checking the actual stored row after rollback
    // or repair rather than trusting the in-memory assessment cache.
    const stored = await transaction.getFirstAsync(`SELECT 1 FROM sharing_v2_projection WHERE singleton=1
      AND fact_hash=? AND accepted_ids_json=? AND rejected_json=? AND pending_ids_json=?
      AND provisional_ids_json=? AND request_states_json=? AND formal_rules_json=?`, ...projectionValues);
    if (!stored) await transaction.runAsync(`INSERT INTO sharing_v2_projection (singleton, fact_hash, accepted_ids_json, rejected_json, pending_ids_json, provisional_ids_json, request_states_json, formal_rules_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
      fact_hash=excluded.fact_hash, accepted_ids_json=excluded.accepted_ids_json, rejected_json=excluded.rejected_json,
      pending_ids_json=excluded.pending_ids_json, provisional_ids_json=excluded.provisional_ids_json,
      request_states_json=excluded.request_states_json, formal_rules_json=excluded.formal_rules_json`, ...projectionValues);
    await assertCurrentAccess(localIds !== undefined);
    if (sharedRosterDigest(archive().at(-1)!) !== expectedRoster) throw new SharingAccessError('保存中に共有権限が変わりました。');
    return { ...assessment, pendingOutboxIds: pendingRows.map((row) => row.operation_id) };
  }
  async function readStateInside(transaction: SQLiteDatabase, replica?: SharedReplica) {
    options.assertWritable();
    const source = replica ?? await readReplica(transaction, options.groupId);
    const assessment = await project(transaction, source);
    const history = archive(); const expected = sharedRosterDigest(history.at(-1)!);
    const receipts = await readV2ServerReceiptsInside(transaction, options.groupId);
    await assertCurrentAccess(); if (sharedRosterDigest(archive().at(-1)!) !== expected) throw new SharingAccessError('読み込み中に共有権限が変わりました。');
    return { assessment, replica: source, archive: history, receipts };
  }
  type CurrentBuilder = (state: Awaited<ReturnType<typeof readStateInside>>, transaction: SQLiteDatabase) => Promise<readonly SharedOperationDraft[]>;
  async function commit(input: readonly SharedOperationDraft[] | ((replica: SharedReplica) => Promise<readonly SharedOperationDraft[]>) | { build: CurrentBuilder; intent?: V2LocalMutationIntent }): Promise<SharedOperation[]> {
    options.assertWritable(); const latest = archive().at(-1)!; const localIds = new Set<string>();
    const capturedInput = typeof input === 'function' ? input : 'build' in input ? { build: input.build, intent: input.intent ? { ...input.intent } : undefined } : captureV2Input(input);
    const intent = typeof capturedInput !== 'function' && 'build' in capturedInput ? capturedInput.intent : undefined;
    if (intent && (!['completion', 'calendar'].includes(intent.kind) || !(intent.kind === 'completion'
      ? /^completion-intent\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
      : /^calendar-intent\.[A-Za-z0-9._-]{1,100}$/u).test(intent.id) || !/^[a-f0-9]{64}$/u.test(intent.digest))) {
      throw new Error('保存待ちの操作を確認できません。');
    }
    if (latest.body.schemaVersion !== 2 || !isSupportedV2Scheduler(latest.body.schedulerVersion)) throw new SharingSchedulerVersionError();
    const operationTime = clock();
    const author = { groupId: options.groupId, userId: options.userId, deviceId: options.identity.deviceId,
      keyVersion: latest.body.keyVersion, schemaVersion: 2 as const, now: () => operationTime, receiptContext: {} as Record<string, number> };
    const created = await createLocalSharedOperations(database, author, async (transaction, replica) => {
      await assertCurrentAccess(true); await assertV2Binding(transaction, options);
      if (sharedRosterDigest(archive().at(-1)!) !== sharedRosterDigest(latest)) throw new SharingAccessError('編集開始後に共有権限が変わりました。');
      const current = await readStateInside(transaction, replica);
      if (intent) {
        const saved = await transaction.getFirstAsync<{ user_id: string; device_id: string; target_digest: string }>(
          'SELECT user_id, device_id, target_digest FROM sharing_v2_mutation_intents WHERE intent_id=?', intent.id);
        if (saved) {
          if (saved.user_id !== options.userId || saved.device_id !== options.identity.deviceId || saved.target_digest !== intent.digest) {
            throw new SharingAccessError('保存待ちの操作と保存先が一致しません。');
          }
          await assertCurrentAccess(true); await assertV2Binding(transaction, options);
          if (sharedRosterDigest(archive().at(-1)!) !== sharedRosterDigest(latest)) throw new SharingAccessError('保存待ちの確認中に共有権限が変わりました。');
          return [];
        }
      }
      author.receiptContext = v2ConfirmedReceiptContext(current.assessment.view.ready, current.receipts);
      for (const [device, sequence] of Object.entries(current.assessment.view.retainedFrontier() ?? {})) author.receiptContext[device] = Math.max(author.receiptContext[device] ?? 0, sequence);
      const drafts = typeof capturedInput === 'function' ? captureV2Input(await capturedInput(replica))
        : 'build' in capturedInput ? captureV2Input(await capturedInput.build(current, transaction)) : capturedInput;
      await assertCurrentAccess(true);
      if (intent) {
        if (intent.kind === 'completion' && drafts.some(draft => draft.entityType !== 'completion' && draft.entityType !== 'retainedCompletionUndo')) {
          throw new Error('完了の保存待ちから別の設定は変更できません。');
        }
        if (intent.kind === 'calendar' && drafts.some(draft => draft.entityType !== 'calendarEvent')) throw new Error('予定の保存待ちから別の設定は変更できません。');
        // The marker commits or rolls back with the signed facts and Outbox.
        // Replaying a protected request after a crash cannot repeat that action.
        await transaction.runAsync('INSERT INTO sharing_v2_mutation_intents VALUES (?, ?, ?, ?)',
          intent.id, options.userId, options.identity.deviceId, intent.digest);
      }
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
    /** Reconstruct the proposal's original causal cut; later edits cannot become approval evidence. */
    async readRetentionCut(checkpoint: V2RetentionBody) {
      return withSharingLedgerTransaction(database, async transaction => {
        const current = await readStateInside(transaction); const epoch = current.archive.at(-1)!;
        if (checkpoint.groupId !== options.groupId || checkpoint.rosterDigest !== sharedRosterDigest(epoch)
          || Object.entries(checkpoint.frontier).some(([device, sequence]) => sequence > (current.replica.frontier[device] ?? 0))) throw new Error('履歴整理の対象を再同期してください。');
        const previous = current.replica.retention?.proposal.operation.payload.checkpoint as unknown as V2RetentionBody | undefined;
        if (previous && Object.entries(previous.frontier).some(([device, sequence]) => sequence > (checkpoint.frontier[device] ?? 0))) throw new Error('より新しい履歴整理が既に適用されています。');
        const base = { ...current.replica, frontier: { ...checkpoint.frontier },
          operations: current.replica.operations.filter(op => op.deviceSequence <= (checkpoint.frontier[op.authorDeviceId] ?? 0)),
          operationIndex: current.replica.operationIndex.filter(row => row.sequence <= (checkpoint.frontier[row.deviceId] ?? 0)) };
        const replica = buildSharedReplica(options.groupId, [], base);
        const facts = new Map((await readSharedFactsInsideTransaction(transaction, options.groupId)).filter(fact => fact.operation.deviceSequence <= (checkpoint.frontier[fact.operation.authorDeviceId] ?? 0)).map(fact => [fact.operation.operationId, fact]));
        const ids = new Set(replica.operations.map(op => op.operationId));
        const receipts = new Map([...current.receipts].filter(([id]) => ids.has(id)));
        if ([...receipts.values()].some(receipt => receipt.uploadSequence > checkpoint.throughSequence)) throw new Error('履歴整理の受付位置が一致しません。');
        const assessment = assessV2BusinessHistory(replica, current.archive, previous ? undefined : options.migration,
          { receipts, facts, pendingLocalIds: new Set() });
        await assertCurrentAccess(); await assertV2Binding(transaction, options);
        return { replica, assessment, archive: current.archive, receipts, facts };
      });
    },
    /** Local adapters may read their private bindings against the same authenticated state and transaction. */
    readCurrent<T>(read: (state: Awaited<ReturnType<typeof readStateInside>>, transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
      return withSharingLedgerTransaction(database, async transaction => {
        const state = await readStateInside(transaction); const value = await read(state, transaction);
        await assertCurrentAccess(); await assertV2Binding(transaction, options); return value;
      });
    },
    /** Private connection metadata needs current membership, not a replay of business history per HTTP guard. */
    withPrivateStorage<T>(work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
      return withSharingLedgerTransaction(database, async transaction => {
        await assertCurrentAccess(); await assertV2Binding(transaction, options);
        const current = archive().at(-1)!; const expected = sharedRosterDigest(current);
        if (current.body.closed || current.body.schemaVersion !== 2 || !isSupportedV2Scheduler(current.body.schedulerVersion)) throw new SharingAccessError('現在の共有メンバーを確認してください。');
        sharedAuthorIdentity(current, options.userId, options.identity.deviceId, current.body.keyVersion);
        const value = await work(transaction);
        await assertCurrentAccess(); await assertV2Binding(transaction, options);
        if (sharedRosterDigest(archive().at(-1)!) !== expected) throw new SharingAccessError('保存中に共有権限が変わりました。');
        return value;
      });
    },
    project: async (transaction: SQLiteDatabase, replica: SharedReplica) => { await project(transaction, replica); },
    evidenceForServerReceipts(receipts: readonly V2ServerReceipt[]): SharedLedgerEvidence {
      let stored: ReadonlyMap<string, V2ServerReceipt> = new Map();
      return { record: async (transaction) => {
        await assertCurrentAccess();
        await assertV2Binding(transaction, options);
        const snapshotRow = await transaction.getFirstAsync<{ snapshot_json: string }>('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id=?', options.groupId);
        const base = snapshotRow ? (JSON.parse(snapshotRow.snapshot_json) as { base: SharedReplica }).base : undefined;
        const retained = base?.retention ? new Set(base.operations.map(op => op.operationId)) : undefined;
        const changed = await persistV2ServerReceiptsInside(transaction, options.groupId, receipts.filter(receipt => !retained
          || retained.has(receipt.operationId) || receipt.uploadSequence > Number((base!.retention!.proposal.operation.payload.checkpoint as { throughSequence: number }).throughSequence)));
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
    commitCompletionIntent: (intent: V2LocalCompletionIntent, build: CurrentBuilder) => commit({ build, intent: { ...intent, kind: 'completion' } }),
    commitCalendarIntent: (intent: V2LocalCompletionIntent, build: CurrentBuilder) => commit({ build, intent: { ...intent, kind: 'calendar' } }),
  };
}
