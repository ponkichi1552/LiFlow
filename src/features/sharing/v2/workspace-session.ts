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
import { assertV2RetentionBase } from './history-retention-certificate.ts';
import type { VerifiedSharedSnapshot } from '../snapshots.ts';
import { legacyCompletionHistory } from './legacy-history.ts';
import { ensureV2CatalogCurrent } from './catalog-update.ts';
import { readSharingWorkspaceCopy, discardPublishedWorkspaceCopyDraft } from '../../../platform/storage/sharing-workspace-copy.ts';
import { workspaceCopyPin, type WorkspaceCopyOrigin } from './workspace-copy-origin.ts';
import type { SignedWorkspaceCopy } from './workspace-copy-source.ts';
import { verifyCopyOrigin } from './workspace-copy-source.ts';
import { planWorkspaceCopy } from './workspace-copy-plan.ts';
import { canonicalJson } from '../operations.ts';
import { WORKSPACE_COPY_SCHEDULER_VERSION } from './payload-schema.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';

export class V2WorkspaceMigrationRequiredError extends Error {
  readonly code = 'sharing/v2-migration-required';
  constructor() { super('旧グループを保持したまま、管理者が確認した移行データを準備する必要があります。'); }
}

/** This factory cannot receive a private/v1 planner adapter or invent server receipts. */
export async function createV2WorkspaceSession(deps: Omit<SharedSyncDependencies, 'v2' | 'project'> & {
  householdId: string; archive: () => readonly VerifiedSharedRoster[]; assertCurrentAccount: () => void;
  assertWritable: () => void; makeId: () => string; markLeft: () => Promise<void>; afterCommit?: () => void;
  creationKind?: GroupKind;
  pinMigration?: (pin: { sourceSnapshotDigest: string; witnessDigest: string }) => Promise<void>;
  pinCopyOrigin?: (origin: WorkspaceCopyOrigin) => Promise<void>;
  verifyMigrationHistory?: (snapshot: VerifiedSharedSnapshot) => Promise<void>;
  afterRetentionApplied?: (snapshot: VerifiedSharedSnapshot) => Promise<void>;
}) {
  const { householdId, archive, assertCurrentAccount, assertWritable, makeId, markLeft, afterCommit, creationKind, pinMigration, pinCopyOrigin, verifyMigrationHistory, afterRetentionApplied, ...transport } = deps;
  assertCurrentAccount(); const record = await deps.readRecord(); assertCurrentAccount();
  if (record.userId !== deps.userId || record.groupId !== deps.groupId || ['left', 'removed'].includes(record.status)) throw new SharingAccessError('共有グループの利用状態を確認してください。');
  const verified = verifyWorkspaceArchive(record);
  if (!verified || sharedWorkspaceProtocol(verified.at(-1)!) !== 2) throw new SharingSchedulerVersionError();
  const migrating = verified.some((roster) => roster.body.schemaVersion === 1);
  if (migrating && !pinMigration) throw new V2WorkspaceMigrationRequiredError();
  let migration: VerifiedLegacyMigration | undefined;
  let retainedMigration = false;
  if (record.status === 'creating' && (!record.creation || !['family', 'roommates'].includes(creationKind ?? ''))) throw new Error('新しい共有グループの種類を確認してください。');
  assertCurrentAccount(); assertWritable();
  const scope = { userId: deps.userId, groupId: deps.groupId, householdId };
  const generation = record.localGeneration;
  await initializeV2EventStore(deps.database, scope); assertCurrentAccount(); assertWritable();
  let copyOrigin: WorkspaceCopyOrigin | undefined = record.copyOrigin;
  let storedCopy: SignedWorkspaceCopy | undefined;
  let copiedPlan: ReturnType<typeof planWorkspaceCopy> | undefined;
  const confirmCopy = async (copy: SignedWorkspaceCopy) => {
    const origin = copyOrigin ?? await deps.cloud.readWorkspaceCopyOrigin(deps.groupId);
    assertCurrentAccount();
    if (!origin) throw new Error('引き継ぎ元の承認情報が確認できません。');
    if (storedCopy && canonicalJson(storedCopy) !== canonicalJson(copy)) throw new Error('保存済みの引き継ぎデータが変わりました。');
    if (!storedCopy) verifyCopyOrigin(copy, origin, deps.groupId);
    if (!copyOrigin) { await pinCopyOrigin?.(origin); assertCurrentAccount(); copyOrigin = origin; }
  };
  const workspaceCopyForSnapshot = async () => {
    if (storedCopy) return storedCopy;
    if (!copyOrigin) return undefined;
    const candidate = await readSharingWorkspaceCopy(deps.database, deps.groupId);
    if (!candidate) {
      if (copyOrigin) throw new Error('引き継ぎデータを受信してから続けてください。');
      return undefined;
    }
    await confirmCopy(candidate); storedCopy = candidate; return candidate;
  };
  const copyPlan = async () => {
    const copy = await workspaceCopyForSnapshot();
    if (!copy || !copyOrigin) return undefined;
    copiedPlan ??= planWorkspaceCopy(copy, workspaceCopyPin(copyOrigin), { groupId: deps.groupId, userIds: copyOrigin.userIds },
      deps.userId, record.displayName);
    return copiedPlan;
  };
  const acceptMigrationSnapshot = async (snapshot: VerifiedSharedSnapshot, history: readonly VerifiedSharedRoster[]) => {
    if (snapshot.workspaceCopy) await confirmCopy(snapshot.workspaceCopy);
    else if (copyOrigin || history.at(-1)?.body.schedulerVersion === WORKSPACE_COPY_SCHEDULER_VERSION) throw new Error('元の実施履歴を確認できません。');
    if (snapshot.base.retention) { assertV2RetentionBase(snapshot.base, snapshot.base.retention, history); return; }
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
  {
    const saved = await deps.database.getFirstAsync<{ snapshot_json: string }>('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id=?', deps.groupId);
    if (saved) {
      const snapshot = JSON.parse(saved.snapshot_json) as VerifiedSharedSnapshot;
      if (migrating || snapshot.base.retention || snapshot.workspaceCopy || copyOrigin) await acceptMigrationSnapshot(snapshot, verified);
      storedCopy = snapshot.workspaceCopy;
      retainedMigration = Boolean(snapshot.base.retention);
    }
  }
  const assertCurrentAccess = async (editing: boolean) => {
    assertCurrentAccount(); const current = await deps.readRecord(); assertCurrentAccount(); assertWritable();
    if (current.userId !== scope.userId || current.groupId !== scope.groupId || !['active', 'creating', 'joining'].includes(current.status)) throw new SharingAccessError('この共有グループは現在編集できません。');
    if (current.localGeneration !== generation) throw new SharingAccessError('再参加前のデータは読み取り専用で保持されています。');
    if (!editing) return;
    if (migrating && !migration && !retainedMigration) throw new V2WorkspaceMigrationRequiredError();
    if (current.lastErrorCode === 'sharing/scheduler-version-mismatch') throw new SharingSchedulerVersionError();
    if (['sharing/access-denied', 'permission-denied'].includes(current.lastErrorCode ?? '')) throw new SharingAccessError('共有グループの参加状態を同期して確認してください。');
  };
  const repository = createV2EventRepository(deps.database, { ...scope, identity: deps.identity, anchor: verified[0], archive,
    get migration() { return migration; },
    assertWritable: () => { assertCurrentAccount(); assertWritable(); }, verifyCurrentAccess: assertCurrentAccess,
    now: () => new Date((deps.now ?? Date.now)()), afterCommit });
  const commitCopyDrafts = async (drafts: readonly SharedOperationDraft[], permitted: (current: VerifiedSharedRoster) => boolean) => {
    let saved = 0;
    for (let offset = 0; offset < drafts.length; offset += 128) {
      const batch = drafts.slice(offset, offset + 128);
      const committed = await repository.commitCurrent(async state => {
        if (!permitted(state.archive.at(-1)!)) throw new SharingAccessError('引き継ぎ先の承認状態が変わりました。');
        const ids = new Set(state.replica.operationIndex.map(row => row.operationId));
        return batch.filter(draft => !ids.has(draft.operationId));
      });
      saved += committed.length;
    }
    return saved > 0;
  };
  const synchronizer = createV2Synchronizer({ ...transport, repository, assertCurrentAccount, acceptMigrationSnapshot,
    afterSnapshot: async snapshot => {
      if (snapshot.workspaceCopy) {
        storedCopy = snapshot.workspaceCopy;
        await discardPublishedWorkspaceCopyDraft(deps.database, deps.groupId, snapshot.workspaceCopy);
      }
      if (snapshot.base.retention) { retainedMigration = true; migration = undefined; await afterRetentionApplied?.(snapshot); }
    } });
  const manager = createSharedGroupManager({ ...transport, project: repository.project, sync: synchronizer.sync,
    verifyMembership: synchronizer.verifyMembership, withMaintenance: synchronizer.withMaintenance,
    makeId, workspaceCopyForSnapshot, markLeft: async () => { assertCurrentAccount(); await markLeft(); assertCurrentAccount(); } });
  const baseController = createV2GroupController(repository, { makeId, now: () => new Date((deps.now ?? Date.now)()), sync: () => synchronizer.sync({ force: true }) });
  let catalogCheck: Promise<boolean> | undefined;
  const controller = { ...baseController, readModel: async (...args: Parameters<typeof baseController.readModel>) => {
    if (!copyOrigin && archive().at(-1)?.body.ownerUserId === deps.userId && (!migrating || migration || retainedMigration)) {
      catalogCheck ??= ensureV2CatalogCurrent(repository, makeId);
      try { if (!await catalogCheck) catalogCheck = undefined; } catch (error) {
        catalogCheck = undefined;
        // A remembered transport permission failure blocks writes, not reading
        // authenticated local history. The normal read still rechecks access.
        if (!(error instanceof SharingAccessError)) throw error;
      }
    }
    const model = await baseController.readModel(...args);
    if (migration) return { ...model, legacyHistory: legacyCompletionHistory(migration) };
    if (!args[1]?.copiedHistory || !copyOrigin) return model;
    const prior = await copyPlan(); assertCurrentAccount();
    if (!prior) return model;
    const viewer = deps.userId;
    return { ...model, copiedHistory: prior.history.filter(row => viewer === prior.originalAdmin || prior.policy.showCompletionStatus
      || [row.recorderUserId, row.performerUserId, row.subjectUserId].includes(viewer)
      || row.subjectUserId === null && (!row.originalAssigneeIds.length || row.originalAssigneeIds.includes(viewer))) };
  } };
  const recovery = createV2OwnerRecovery({ ...transport, repository, verifyMembership: synchronizer.verifyMembership,
    withMaintenance: synchronizer.withMaintenance, sync: synchronizer.sync, assertCurrentAccount, makeId, workspaceCopyForSnapshot });
  if (record.status === 'creating') {
    const creation = record.creation!;
    // Deterministic bootstrap operation IDs recover a crash without duplicating catalog entries.
    const initial = copyOrigin ? await copyPlan() : undefined;
    if (copyOrigin && !initial) throw new Error('引き継ぎの準備を確認してください。');
    if (initial) await commitCopyDrafts([...initial.initial, { operationId: `${deps.groupId}.bootstrap.member`, entityType: 'member', entityId: deps.userId,
      operationType: 'patch', payload: { userId: deps.userId, displayName: creation.ownerDisplayName } }], roster => roster.body.ownerDeviceId === deps.identity.deviceId);
    else await repository.commitCurrent(async state => state.replica.operations.some(operation => operation.operationId === `${deps.groupId}.bootstrap.policy`) ? []
      : v2GroupBootstrap({ groupId: deps.groupId, ownerUserId: deps.userId, ownerDisplayName: creation.ownerDisplayName,
        name: record.displayName, timeZone: creation.timeZone, anchorDate: creation.anchorDate as Parameters<typeof v2GroupBootstrap>[0]['anchorDate'], kind: creationKind! }));
  }
  if (retainedMigration && afterRetentionApplied) {
    const saved = await deps.database.getFirstAsync<{ snapshot_json: string }>('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id=?', deps.groupId);
    if (saved) await afterRetentionApplied(JSON.parse(saved.snapshot_json));
  }
  let copyCompleted = false;
  const completeWorkspaceCopy = async () => {
    if (copyCompleted) return false;
    const allowed = (current: VerifiedSharedRoster) => current.body.ownerDeviceId === deps.identity.deviceId
      && copyOrigin?.userIds.every(uid => current.body.members.some(member => member.userId === uid)) === true;
    const current = archive().at(-1);
    if (!current || !allowed(current)) return false;
    const plan = await copyPlan(); if (!plan) return false;
    const saved = await commitCopyDrafts(plan.whenApproved, allowed);
    copyCompleted = true;
    return saved;
  };
  return { repository, synchronizer, manager, controller, recovery, assertCurrentAccess, completeWorkspaceCopy };
}
export type V2WorkspaceSession = Awaited<ReturnType<typeof createV2WorkspaceSession>>;
