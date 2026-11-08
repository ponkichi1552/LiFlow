import type { SQLiteDatabase } from 'expo-sqlite';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { sharedRosterDigest } from '../../features/sharing/roster.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { assertVerifiedLegacyMigration, readVerifiedLegacyMigrationSnapshot, readVerifiedLegacyMigrationSource } from '../../features/sharing/v2/legacy-migration-source.ts';
import type { VerifiedLegacyMigration } from '../../features/sharing/v2/legacy-migration-source.ts';
import { legacyMigrationDrafts, validateLegacyMigrationPlan } from '../../features/sharing/v2/legacy-migration-plan.ts';
import type { LegacyMigrationPlan } from '../../features/sharing/v2/legacy-migration-plan.ts';
import { createV2EventRepository, initializeV2EventStore } from './sharing-v2-events.ts';
import { applySharingSnapshot, loadSharedReplica, readSharingCheckpoint, withSharingLedgerTransaction } from './sharing-ledger.ts';

interface Row { plan_digest: string; plan_json: string; completed_drafts: number; total_drafts: number }
export interface LegacyMigrationStageStatus { planDigest: string; completedDrafts: number; totalDrafts: number; phase: 'staging' | 'ready' }
export function createV2LegacyMigrationStager(database: SQLiteDatabase, options: {
  checkpoint: VerifiedLegacyMigration; plan: LegacyMigrationPlan; userId: string; groupId: string; householdId: string;
  identity: DeviceSecretIdentity; archive(): readonly VerifiedSharedRoster[]; assertAccess(): void;
  now(): Date; afterBatch?(status: LegacyMigrationStageStatus): void | Promise<void>;
}) {
  options.assertAccess();
  const plan = validateLegacyMigrationPlan(options.plan, options.checkpoint);
  const source = readVerifiedLegacyMigrationSource(options.checkpoint);
  if (plan.userId !== options.userId || plan.groupId !== options.groupId || options.identity.deviceId !== source.roster.body.ownerDeviceId
    || options.userId !== source.roster.body.ownerUserId) throw new Error('移行する管理者の端末と保存先を確認してください。');
  const drafts = legacyMigrationDrafts(plan, options.checkpoint);
  const assertAccess = () => {
    options.assertAccess();
    const latest = options.archive().at(-1);
    if (!latest || sharedRosterDigest(latest) !== plan.targetRosterDigest) throw new Error('移行の参加状態が変わりました。内容を確認してください。');
  };
  assertAccess();
  const repository = createV2EventRepository(database, { userId: options.userId, groupId: options.groupId, householdId: options.householdId,
    identity: options.identity, anchor: options.archive()[0], archive: options.archive, assertWritable: assertAccess, migration: options.checkpoint, now: options.now });
  function status(row: Row): LegacyMigrationStageStatus {
    if (row.plan_digest !== plan.digest || canonicalJson(JSON.parse(row.plan_json)) !== canonicalJson(plan)
      || row.total_drafts !== drafts.length || !Number.isSafeInteger(row.completed_drafts) || row.completed_drafts < 0 || row.completed_drafts > row.total_drafts) throw new Error('保存済みの移行内容が異なります。元の保存先を保持して確認してください。');
    return { planDigest: row.plan_digest, completedDrafts: row.completed_drafts, totalDrafts: row.total_drafts,
      phase: row.completed_drafts === row.total_drafts ? 'ready' : 'staging' };
  }
  async function readInside(transaction: SQLiteDatabase): Promise<LegacyMigrationStageStatus | null> {
    assertAccess();
    const table = await transaction.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_v2_migration_stage'");
    if (!table) return null;
    const binding = await transaction.getFirstAsync<{ user_id: string; group_id: string }>('SELECT user_id,group_id FROM sharing_v2_binding WHERE singleton=1');
    if (binding?.user_id !== options.userId || binding.group_id !== options.groupId) throw new Error('移行の保存先が変わりました。');
    const row = await transaction.getFirstAsync<Row>('SELECT * FROM sharing_v2_migration_stage WHERE singleton=1');
    return row ? status(row) : null;
  }
  let running: Promise<LegacyMigrationStageStatus> | undefined;
  async function perform() {
    // A prepared, private conversion may resume on a later day. Freshness is rechecked before a cloud transition.
    assertAccess();
    await initializeV2EventStore(database, options); assertAccess();
    let progress = await withSharingLedgerTransaction(database, readInside);
    if (!progress) {
      try {
      const before = await loadSharedReplica(database, options.groupId); const position = await readSharingCheckpoint(database, options.groupId);
      if (before.operations.length || before.operationIndex.length || position.cursor !== null) throw new Error('移行先に別のデータがあります。上書きせず保持しました。');
      const snapshot = readVerifiedLegacyMigrationSnapshot(options.checkpoint);
      await applySharingSnapshot(database, options.groupId, snapshot, async (transaction, replica) => {
        assertAccess(); await repository.project(transaction, replica); assertAccess();
        await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_migration_stage (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), plan_digest TEXT NOT NULL, plan_json TEXT NOT NULL,
          completed_drafts INTEGER NOT NULL, total_drafts INTEGER NOT NULL);`);
        await transaction.runAsync('INSERT INTO sharing_v2_migration_stage VALUES (1, ?, ?, 0, ?)', plan.digest, JSON.stringify(plan), drafts.length);
        assertAccess();
      }, null, options.now().getTime());
      progress = { planDigest: plan.digest, completedDrafts: 0, totalDrafts: drafts.length, phase: 'staging' };
      } catch (error) {
        // Another runtime may have atomically prepared the identical target while this one waited.
        progress = await withSharingLedgerTransaction(database, readInside);
        if (!progress) throw error;
      }
    }
    while (progress.completedDrafts < drafts.length) {
      assertAccess();
      const offset = progress.completedDrafts; const page = drafts.slice(offset, offset + 100);
      await repository.commit(page); assertAccess();
      progress = await withSharingLedgerTransaction(database, async transaction => {
        const current = await readInside(transaction); if (!current) throw new Error('移行の確認記録を読み直してください。');
        const count = Math.max(current.completedDrafts, offset + page.length);
        await transaction.runAsync('UPDATE sharing_v2_migration_stage SET completed_drafts=? WHERE singleton=1 AND plan_digest=?', count, plan.digest);
        assertAccess(); return { ...current, completedDrafts: count, phase: count === drafts.length ? 'ready' as const : 'staging' as const };
      });
      await options.afterBatch?.(progress);
    }
    const state = await repository.readState(); assertVerifiedLegacyMigration(options.checkpoint, state.replica, state.archive);
    const expected = new Map(drafts.map(draft => [draft.operationId, draft]));
    const authored = state.replica.operations.filter(op => op.schemaVersion === 2);
    if (state.assessment.rejected.length || authored.length !== drafts.length || authored.some(op => {
      const draft = expected.get(op.operationId);
      return !draft || op.authorUserId !== options.userId || op.authorDeviceId !== options.identity.deviceId
        || op.entityType !== draft.entityType || op.entityId !== draft.entityId || op.operationType !== draft.operationType || canonicalJson(op.payload) !== canonicalJson(draft.payload);
    })) throw new Error('移行する設定の検査を完了できませんでした。元のデータは保持しています。');
    return progress;
  }
  return { repository, readStatus: () => withSharingLedgerTransaction(database, readInside),
    stage(): Promise<LegacyMigrationStageStatus> {
      if (running) return running;
      const pending = perform(); running = pending;
      void pending.then(() => { if (running === pending) running = undefined; }, () => { if (running === pending) running = undefined; });
      return pending;
    } };
}
