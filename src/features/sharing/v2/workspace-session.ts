import { createV2EventRepository, initializeV2EventStore } from '../../../platform/storage/sharing-v2-events.ts';
import type { SharedSyncDependencies } from '../synchronizer.ts';
import { createSharedGroupManager } from '../group-manager.ts';
import { SharingAccessError, SharingSchedulerVersionError } from '../cloud-contract.ts';
import { sharedWorkspaceProtocol, verifyWorkspaceArchive } from '../workspace-protocol.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { createV2GroupController } from './controller.ts';
import { createV2Synchronizer } from './synchronizer.ts';
import { v2GroupBootstrap } from './bootstrap.ts';
import type { GroupKind } from './model.ts';
import { createV2OwnerRecovery } from './owner-recovery.ts';
import { restoreLegacyMigrationSourceFromSnapshot, verifiedLegacyMigrationPin } from './legacy-migration-source.ts';
import type { VerifiedLegacyMigration } from './legacy-migration-source.ts';
import type { VerifiedSharedSnapshot } from '../snapshots.ts';
import { legacyCompletionHistory } from './legacy-history.ts';
import { ensureV2CatalogCurrent } from './catalog-update.ts';

export class V2WorkspaceMigrationRequiredError extends Error {
  readonly code = 'sharing/v2-migration-required';
  constructor() { super('旧グループを保持したまま、所有者が確認した移行データを準備する必要があります。'); }
}

/** This factory cannot receive a private/v1 planner adapter or invent server receipts. */
export async function createV2WorkspaceSession(deps: Omit<SharedSyncDependencies, 'v2' | 'project'> & {
  householdId: string; archive: () => readonly VerifiedSharedRoster[]; assertCurrentAccount: () => void;
  assertWritable: () => void; makeId: () => string; markLeft: () => Promise<void>; afterCommit?: () => void;
  creationKind?: GroupKind;
  pinMigration?: (pin: { sourceSnapshotDigest: string; witnessDigest: string }) => Promise<void>;
  verifyMigrationHistory?: (snapshot: VerifiedSharedSnapshot) => Promise<void>;
}) {
  const { householdId, archive, assertCurrentAccount, assertWritable, makeId, markLeft, afterCommit, creationKind, pinMigration, verifyMigrationHistory, ...transport } = deps;
  assertCurrentAccount(); const record = await deps.readRecord(); assertCurrentAccount();
  if (record.userId !== deps.userId || record.groupId !== deps.groupId || ['left', 'removed'].includes(record.status)) throw new SharingAccessError('共有グループの利用状態を確認してください。');
  const verified = verifyWorkspaceArchive(record);
  if (!verified || sharedWorkspaceProtocol(verified.at(-1)!) !== 2) throw new SharingSchedulerVersionError();
  const migrating = verified.some((roster) => roster.body.schemaVersion === 1);
  if (migrating && !pinMigration) throw new V2WorkspaceMigrationRequiredError();
  let migration: VerifiedLegacyMigration | undefined;
  if (record.status === 'creating' && (!record.creation || !['family', 'roommates'].includes(creationKind ?? ''))) throw new Error('新しい共有グループの種類を確認してください。');
  assertCurrentAccount(); assertWritable();
  const scope = { userId: deps.userId, groupId: deps.groupId, householdId };
  const generation = record.localGeneration;
  await initializeV2EventStore(deps.database, scope); assertCurrentAccount(); assertWritable();
  const acceptMigrationSnapshot = async (snapshot: VerifiedSharedSnapshot, history: readonly VerifiedSharedRoster[]) => {
    if (!migrating) {
      if (snapshot.base.legacyMigrationWitness) throw new V2WorkspaceMigrationRequiredError();
      return;
    }
    assertCurrentAccount(); const current = await deps.readRecord(); assertCurrentAccount();
    const restored = restoreLegacyMigrationSourceFromSnapshot(snapshot, history, current.v2Migration);
    await verifyMigrationHistory?.(snapshot); assertCurrentAccount();
    await pinMigration?.(verifiedLegacyMigrationPin(restored)); assertCurrentAccount();
    migration = restored;
  };
  if (migrating) {
    const saved = await deps.database.getFirstAsync<{ snapshot_json: string }>('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id=?', deps.groupId);
    if (saved) await acceptMigrationSnapshot(JSON.parse(saved.snapshot_json), verified);
  }
  const assertCurrentAccess = async (editing: boolean) => {
    assertCurrentAccount(); const current = await deps.readRecord(); assertCurrentAccount(); assertWritable();
    if (current.userId !== scope.userId || current.groupId !== scope.groupId || !['active', 'creating', 'joining'].includes(current.status)) throw new SharingAccessError('この共有グループは現在編集できません。');
    if (current.localGeneration !== generation) throw new SharingAccessError('再参加前のデータは読み取り専用で保持されています。');
    if (!editing) return;
    if (migrating && !migration) throw new V2WorkspaceMigrationRequiredError();
    if (current.lastErrorCode === 'sharing/scheduler-version-mismatch') throw new SharingSchedulerVersionError();
    if (['sharing/access-denied', 'permission-denied'].includes(current.lastErrorCode ?? '')) throw new SharingAccessError('共有グループの参加状態を同期して確認してください。');
  };
  const repository = createV2EventRepository(deps.database, { ...scope, identity: deps.identity, anchor: verified[0], archive,
    get migration() { return migration; },
    assertWritable: () => { assertCurrentAccount(); assertWritable(); }, verifyCurrentAccess: assertCurrentAccess,
    now: () => new Date((deps.now ?? Date.now)()), afterCommit });
  const synchronizer = createV2Synchronizer({ ...transport, repository, assertCurrentAccount, acceptMigrationSnapshot });
  const manager = createSharedGroupManager({ ...transport, project: repository.project, sync: synchronizer.sync,
    verifyMembership: synchronizer.verifyMembership, makeId, markLeft: async () => { assertCurrentAccount(); await markLeft(); assertCurrentAccount(); } });
  const baseController = createV2GroupController(repository, { makeId, now: () => new Date((deps.now ?? Date.now)()), sync: () => synchronizer.sync({ force: true }) });
  let catalogCheck: Promise<boolean> | undefined;
  const controller = { ...baseController, readModel: async (...args: Parameters<typeof baseController.readModel>) => {
    if (archive().at(-1)?.body.ownerUserId === deps.userId && (!migrating || migration)) {
      catalogCheck ??= ensureV2CatalogCurrent(repository, makeId);
      try { if (!await catalogCheck) catalogCheck = undefined; } catch (error) {
        catalogCheck = undefined;
        // A remembered transport permission failure blocks writes, not reading
        // authenticated local history. The normal read still rechecks access.
        if (!(error instanceof SharingAccessError)) throw error;
      }
    }
    const model = await baseController.readModel(...args);
    return migration ? { ...model, legacyHistory: legacyCompletionHistory(migration) } : model;
  } };
  const recovery = createV2OwnerRecovery({ ...transport, repository, verifyMembership: synchronizer.verifyMembership,
    withMaintenance: synchronizer.withMaintenance, sync: synchronizer.sync, assertCurrentAccount, makeId });
  if (record.status === 'creating') {
    const creation = record.creation!;
    // Deterministic bootstrap operation IDs recover a crash without duplicating catalog entries.
    await repository.commit(v2GroupBootstrap({ groupId: deps.groupId, ownerUserId: deps.userId, ownerDisplayName: creation.ownerDisplayName,
      name: record.displayName, timeZone: creation.timeZone, anchorDate: creation.anchorDate as Parameters<typeof v2GroupBootstrap>[0]['anchorDate'], kind: creationKind! }));
  }
  return { repository, synchronizer, manager, controller, recovery, assertCurrentAccess };
}
export type V2WorkspaceSession = Awaited<ReturnType<typeof createV2WorkspaceSession>>;
