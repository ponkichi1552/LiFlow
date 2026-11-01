import { randomUUID } from 'expo-crypto';
import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { User } from 'firebase/auth';
import { getSharingServices, isSharingConfigured } from './firebase-services.ts';
import { nativeSharingCrypto } from './native-crypto.ts';
import { loadOrCreateSharingDeviceIdentity, loadSharingGroupKey, saveSharingGroupKey, sharingSecureVault } from './secure-store.ts';
import { openSharingDatabase, openSharingV2Database, sharingDatabaseDirectory } from './database-location.ts';
import { createSharingCloud } from './firestore-cloud.ts';
import { createSharedRoster, sharedRosterDigest } from '../../features/sharing/roster.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { wrapGroupKey } from '../../features/sharing/crypto.ts';
import { createSharedSynchronizer } from '../../features/sharing/synchronizer.ts';
import { readCloudWorkspaceArchive, sharedWorkspaceProtocol, verifyWorkspaceArchive } from '../../features/sharing/workspace-protocol.ts';
import { createV2WorkspaceSession, V2WorkspaceMigrationRequiredError } from '../../features/sharing/v2/workspace-session.ts';
import { guardV2GroupController } from '../../features/sharing/v2/controller-access.ts';
import { v2ReadPoint } from '../../features/sharing/v2/view-point.ts';
import type { SharedWorkspace, LegacyMigrationWorkspace, V2SharedWorkspace, PendingSharedWorkspace } from './workspace-types.ts';
import type { SharedSyncDependencies, SharingSyncResult } from '../../features/sharing/synchronizer.ts';
import { createLiveLegacyMigration, v2WorkspaceDatabaseGeneration, verifyKnownLegacyHistory } from '../../features/sharing/v2/live-legacy-migration.ts';
import { createSharedGroupManager } from '../../features/sharing/group-manager.ts';
import { sharedAccessDisposition } from '../../features/sharing/access-state.ts';
import { createSharedJoinRequest, parseSharedInvitation } from '../../features/sharing/invitations.ts';
import { isSharedTimeZone, sharedLocalDate } from '../../features/sharing/group-clock.ts';
import { decodeSharingSelection, encodeSharingSelection } from '../../features/sharing/workspace-selection.ts';
import type { SharingSelection } from '../../features/sharing/workspace-selection.ts';
import { SharingAccessError, SharingKeyVersionError, SharingSchedulerVersionError } from '../../features/sharing/cloud-contract.ts';
import { sharingOwnerRecoveryEnabled } from '../../features/sharing/rollout.ts';
import { initializeSharingRegistry, readCurrentSharingWorkspace, readSharingWorkspace, saveSharingWorkspace, updateSharingWorkspace, adoptConfirmedSharingWorkspace } from '../storage/sharing-registry.ts';
import type { SharingWorkspaceRecord } from '../storage/sharing-registry.ts';
import { initializeSharedProjection } from '../storage/sharing-projection.ts';
import { drainSharingLedger, initializeSharingLedger, loadSharedReplica, readSharingCheckpoint } from '../storage/sharing-ledger.ts';
import { sharedRepositoryAdapter } from '../storage/shared-repository-adapter.ts';
import { drainPlannerDatabaseOperations, loadGoogleSyncState, LOCAL_HOUSEHOLD_ID, withPlannerDatabaseOperation } from '../storage/repository.ts';
import { createNativeApplianceRetention } from './appliance-retention';

export type { SharingSelection } from '../../features/sharing/workspace-selection.ts';
export type { SharedWorkspace } from './workspace-types.ts';
export type SharingChange = SharingSelection & { statusOnly?: boolean };
type Listener = (selection?: SharingChange) => void;
const listeners = new Set<Listener>();
export function subscribeSharingChanges(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function changed(selection?: SharingChange) { for (const listener of listeners) try { listener(selection); } catch { /* A view cannot invalidate a committed edit. */ } }
const keyForScope = (selection: SharingSelection) => canonicalJson([selection.userId, selection.groupId]);
let registryPromise: Promise<SQLiteDatabase> | null = null;
export function sharingRegistryDatabase(): Promise<SQLiteDatabase> {
  if (!registryPromise) {
    const pending = (async () => { const db = await openDatabaseAsync('sharing-index.db', { useNewConnection: true }, await sharingDatabaseDirectory());
      try { await initializeSharingRegistry(db); return db; }
      catch (error) { await db.closeAsync().catch(() => undefined); throw error; }
    })(); registryPromise = pending;
    void pending.catch(() => { if (registryPromise === pending) registryPromise = null; });
  }
  return registryPromise;
}
export async function sharingSessionUser(): Promise<User | null> {
  if (!isSharingConfigured()) return null;
  const auth = getSharingServices().auth; await auth.authStateReady(); return auth.currentUser;
}
export async function enableSharingSession(): Promise<void> { await sharingSecureVault.setItem('sharing-enabled', 'true'); }
export async function hasSharingSessionEnabled(): Promise<boolean> { return await sharingSecureVault.getItem('sharing-enabled') === 'true'; }
async function requireUser(): Promise<User> {
  const user = await sharingSessionUser(); if (!user) throw new SharingAccessError('共有グループ用のアカウントでログインしてください。'); return user;
}
export async function readSharingSelection(): Promise<SharingSelection | null> {
  const saved = await sharingSecureVault.getItem('active-workspace'); if (!saved) return null;
  return decodeSharingSelection(saved);
}
export async function saveSharingSelection(selection: SharingSelection | null): Promise<void> {
  if (selection && (await requireUser()).uid !== selection.userId) throw new SharingAccessError('共有アカウントが一致しません。');
  if ((await sharingSecureVault.getItem('active-workspace')) === (selection ? encodeSharingSelection(selection) : null)) return;
  if (!selection) await sharingSecureVault.removeItem('active-workspace');
  else {
    const user = await requireUser(); if (user.uid !== selection.userId) throw new SharingAccessError('共有アカウントが一致しません。');
    const workspace = await openSharedWorkspace(selection); const record = await workspace.record();
    if (!['active', 'creating'].includes(record.status)) throw new SharingAccessError('参加承認を完了してから切り替えてください。');
    if (workspace.protocol === null) throw new SharingAccessError('参加承認を完了してから切り替えてください。');
    await workspace.readOverview(); await workspace.drain();
    if ((await requireUser()).uid !== selection.userId) throw new SharingAccessError('共有アカウントが切り替わりました。');
    await sharingSecureVault.setItem('active-workspace', encodeSharingSelection(selection));
  }
  changed();
}
export async function currentSharingWorkspace(): Promise<SharingWorkspaceRecord | null> {
  const user = await sharingSessionUser(); if (!user) return null;
  const previous = await readSharingSelection();
  const registry = await sharingRegistryDatabase();
  let record: SharingWorkspaceRecord | null;
  try { record = await readCurrentSharingWorkspace(registry, user.uid, previous?.userId === user.uid ? previous.groupId : undefined); }
  catch (error) {
    if ((error as { code?: string })?.code !== 'sharing/ambiguous-current') throw error;
    if ((await sharingSessionUser())?.uid !== user.uid) throw new SharingAccessError('共有アカウントが変わりました。');
    const cloud = createSharingCloud(getSharingServices().firestore, user.uid, () => getSharingServices().auth.currentUser?.uid ?? null);
    const groupId = await cloud.readMembership();
    if ((await sharingSessionUser())?.uid !== user.uid) throw new SharingAccessError('共有アカウントが変わりました。');
    const known = groupId ? await readSharingWorkspace(registry, user.uid, groupId) : null;
    if (!known || ['left', 'removed'].includes(known.status)) throw error;
    // This chooses only the display scope. Normal open/sync still verifies its
    // locally pinned roster and approved device; historical data is untouched.
    record = await readCurrentSharingWorkspace(registry, user.uid, known.groupId);
  }
  if ((await sharingSessionUser())?.uid !== user.uid) throw new SharingAccessError('共有アカウントが変わりました。');
  return record;
}
export function sharingFailureMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'GoogleAuthorizationCancelledError') return 'Googleログインを完了してから、もう一度お試しください。';
  if (code === 'auth/network-request-failed' || code === 'unavailable') return '通信できません。接続を確認して、もう一度お試しください。端末内の変更は保持しています。';
  if (code === 'permission-denied' || code === 'sharing/access-denied') return '参加状態またはログインを確認してください。端末内の変更は保持しています。';
  if (code === 'resource-exhausted') return '共有先の利用上限に達しました。時間をおいて再送します。';
  if (code === 'unauthenticated' || code.startsWith('auth/')) return '共有アカウントでログインし直してください。';
  if (code === 'sharing/key-version-changed') return '共有鍵の更新を待っています。所有者の端末で同期してください。';
  if (code === 'sharing/recovery-in-progress') return '所有者が共有の復旧を進めています。変更はこの端末に保存され、復旧後に送信されます。';
  if (code === 'sharing/scheduler-version-mismatch') return 'この共有グループの計算ルールに対応するLiFlowへ更新してください。';
  return '同期を完了できませんでした。端末内の変更は保持し、再送します。';
}

const workspacePromises = new Map<string, Promise<SharedWorkspace>>();
export async function openSharedWorkspace(selection: SharingSelection): Promise<SharedWorkspace> {
  const current = await currentSharingWorkspace();
  if (current?.userId !== selection.userId || current.groupId !== selection.groupId) throw new SharingAccessError('現在所属しているグループを確認してください。');
  const key = keyForScope(selection); let promise = workspacePromises.get(key);
  if (!promise) { promise = buildWorkspace(selection); workspacePromises.set(key, promise);
    const pending = promise; void pending.catch(() => { if (workspacePromises.get(key) === pending) workspacePromises.delete(key); }); }
  return promise;
}
interface WorkspaceOpenContext {
  selection: SharingSelection; user: User; registry: SQLiteDatabase; record: SharingWorkspaceRecord;
  identity: Awaited<ReturnType<typeof loadOrCreateSharingDeviceIdentity>>; archive: VerifiedSharedRoster[] | null;
  cloud: ReturnType<typeof createSharingCloud>;
}
async function buildWorkspace(selection: SharingSelection): Promise<SharedWorkspace> {
  const user = await requireUser(); if (user.uid !== selection.userId) throw new SharingAccessError('共有アカウントが切り替わりました。');
  const registry = await sharingRegistryDatabase(); const { userId, groupId } = selection;
  const record = await readSharingWorkspace(registry, userId, groupId); if (!record) throw new Error('共有グループが見つかりません。');
  if (['left', 'removed'].includes(record.status)) throw new SharingAccessError('この共有グループからは退出済みです。');
  const archive = verifyWorkspaceArchive(record); const protocol = archive ? sharedWorkspaceProtocol(archive.at(-1)!) : null;
  if (protocol === 2 && record.status === 'creating' && archive?.some(item => item.body.schemaVersion === 1)) throw new V2WorkspaceMigrationRequiredError();
  const identity = await loadOrCreateSharingDeviceIdentity(userId, record.localGeneration);
  if ((await requireUser()).uid !== userId) throw new SharingAccessError('共有アカウントが切り替わりました。');
  const cloud = createSharingCloud(getSharingServices().firestore, userId, () => getSharingServices().auth.currentUser?.uid ?? null,
    { ownerRecoveryEnabled: sharingOwnerRecoveryEnabled() });
  const context = { selection, user, registry, record, identity, archive, cloud };
  const approved = archive?.at(-1)?.body.members.some((member) => member.userId === userId && member.devices.some((device) => device.identity.deviceId === identity.deviceId));
  if (!protocol || record.status === 'joining' && !approved) return buildPendingWorkspace(context);
  if (protocol === 2) return buildV2Workspace(context);
  return buildLegacyMigrationWorkspace(context);
}

async function buildLegacyMigrationWorkspace(context: WorkspaceOpenContext): Promise<LegacyMigrationWorkspace> {
  const { selection, registry, identity, cloud } = context; const { userId, groupId } = selection;
  let record = context.record;
  const generation = record.localGeneration;
  let roster = context.archive?.at(-1);
  const database = await openSharingDatabase(userId, groupId, generation);
  try {
    if (getSharingServices().auth.currentUser?.uid !== userId) throw new SharingAccessError('共有アカウントが切り替わりました。');
    await initializeSharedProjection(database, { ...selection, householdId: LOCAL_HOUSEHOLD_ID }); await initializeSharingLedger(database);
    const assertGeneration = (current: SharingWorkspaceRecord) => { if (current.localGeneration !== generation) throw new SharingAccessError('再参加前のデータは読み取り専用で保持されています。'); };
    const assertAccount = () => { if (getSharingServices().auth.currentUser?.uid !== userId) throw new SharingAccessError('この共有グループは現在編集できません。'); };
    const readRecord = async () => {
      assertAccount(); const latest = await readSharingWorkspace(registry, userId, groupId); assertAccount();
      if (!latest) throw new Error('共有グループが見つかりません。'); assertGeneration(latest); record = latest; return latest;
    };
    const update = async (change: (prior: SharingWorkspaceRecord) => SharingWorkspaceRecord) => {
      assertAccount(); record = await updateSharingWorkspace(registry, userId, groupId, (prior) => { assertAccount(); assertGeneration(prior); return change(prior); });
      assertAccount(); changed(selection); return record;
    };
    let sync: (options?: { force?: boolean; budgetMs?: number }) => Promise<SharingSyncResult>;
    // A migration imports authenticated facts only. It never mounts a legacy planner or recalculates a legacy schedule.
    const project: SharedSyncDependencies['project'] = async (_transaction, replica) => {
      assertAccount(); if (replica.groupId !== groupId) throw new SharingAccessError('移行するグループが一致しません。');
    };
    const deps: SharedSyncDependencies = { ...selection, database, identity, crypto: nativeSharingCrypto, cloud, readRecord,
      saveArchive: async (archive) => {
        assertAccount();
        const next = archive.at(-1)!;
        record = await updateSharingWorkspace(registry, userId, groupId, (previous) => {
          assertAccount(); assertGeneration(previous);
          if ((previous.rosterArchive.at(-1)?.body.revision ?? 0) > next.body.revision) throw new Error('Membership changed concurrently');
          return { ...previous, rosterArchive: archive };
        }); assertAccount(); roster = next; context.archive = archive;
      },
      readKey: (version) => loadSharingGroupKey(userId, groupId, version), saveKey: (version, bytes) => saveSharingGroupKey(userId, groupId, version, bytes),
      project, serialized: (work) => withPlannerDatabaseOperation(database, work), changed: () => changed(selection) };
    const synchronizer = createSharedSynchronizer(deps);
    const manager = createSharedGroupManager({ ...deps, sync: (options) => synchronizer.sync(options), makeId: randomUUID,
      markLeft: async () => { await update((previous) => ({ ...previous, status: 'left', lastErrorCode: null })); } });
    let serviceRun: Promise<SharingSyncResult> | null = null; let runRequested = false; let forceRequested = false;
    sync = (options = {}) => {
      if (serviceRun) { runRequested = true; forceRequested ||= Boolean(options.force); return serviceRun; }
      const pending = (async () => {
        try {
          const current = await readRecord();
          if (['left', 'removed'].includes(current.status)) throw new SharingAccessError('このグループからは退出済みです。');
          if (current.status === 'creating') throw new Error('旧形式の未送信データは端末に保持しています。新しいグループはv2で作成してください。');
          if (current.status === 'joining') await submitWorkspaceJoin(context, current);
          let result;
          try { result = await synchronizer.sync(options); }
          catch (error) {
            if (!(error instanceof SharingKeyVersionError) || roster?.body.ownerDeviceId !== identity.deviceId) throw error;
            await manager.repairDepartures(); result = await synchronizer.sync(options);
          }
          if (!result.waitingForApproval) {
            const replica = await loadSharedReplica(database, groupId);
            const name = replica.entities.find((entity) => entity.entityType === 'settings' && entity.entityId === 'settings')?.fields.name;
            await update((previous) => ({ ...previous, status: 'active', displayName: typeof name === 'string' ? name : previous.displayName,
              lastSuccessfulSyncAt: Date.now(), lastErrorCode: null }));
          }
          return result;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'sharing/failed';
          const disposition = sharedAccessDisposition({ errorCode: code, currentAccountUserId: getSharingServices().auth.currentUser?.uid ?? null,
            userId, deviceId: identity.deviceId, status: record?.status, roster });
          let removed = disposition === 'removed';
          if (disposition === 'check-membership') {
            try { removed = !await cloud.hasMembership(groupId); } catch { /* A network error does not prove removal. */ }
          }
          await update((previous) => ({ ...previous, ...(removed ? { status: 'removed' as const } : {}), lastErrorCode: code })).catch(() => undefined); throw error;
        }
      })(); serviceRun = pending;
      void pending.finally(() => {
        if (serviceRun === pending) serviceRun = null; changed(selection);
        if (runRequested) { const force = forceRequested; runRequested = false; forceRequested = false;
          setTimeout(() => { void sync({ force }).catch(() => undefined); }, 0); }
      }).catch(() => undefined); return pending;
    };
    const catchUp = sync;
    const migration = createLiveLegacyMigration({ ...deps, catchUp: () => catchUp({ force: true, budgetMs: 120_000 }),
      archive: () => context.archive ?? [], makeId: randomUUID, assertAccess: assertAccount,
      openTarget: generation => openSharingV2Database(userId, groupId, generation),
      readPreparedKey: async id => {
        const value = await sharingSecureVault.getItem(`migration-key:${userId}:${groupId}:${id}`);
        if (value === null) return null;
        if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('移行鍵を確認してください。');
        return new Uint8Array(value.match(/../gu)!.map(part => parseInt(part, 16)));
      },
      savePreparedKey: (id, key) => sharingSecureVault.setItem(`migration-key:${userId}:${groupId}:${id}`, Array.from(key, byte => byte.toString(16).padStart(2, '0')).join('')),
      activate: async (archive, v2Migration) => {
        assertAccount(); await update(previous => ({ ...previous, rosterArchive: archive, v2Migration, lastErrorCode: null }));
        workspacePromises.delete(keyForScope(selection)); changed(selection);
      } });
    return { ...selection, protocol: 'migration', database, cloud, identity, manager: null, migration,
      record: readRecord, drain: () => drainPlannerDatabaseOperations(database),
      readOverview: async () => { throw new Error('履歴・設定を引き継ぐため、所有者によるv2への移行が必要です。'); },
      roster: () => roster, checkpoint: () => readSharingCheckpoint(database, groupId),
      watch: (callback, failed) => cloud.watch(groupId, callback, failed),
      cancelJoinRequest: async () => { throw new Error('移行する参加状態を確認してください。'); }, maintainHistory: async () => {},
      sync: async (options = {}) => {
        const metadata = await cloud.readGroup(groupId); assertAccount();
        if (metadata.roster.body.schemaVersion === 2) {
          const archive = await readCloudWorkspaceArchive(await readRecord(), metadata.roster, cloud.readRoster); assertAccount();
          await deps.saveArchive(archive); workspacePromises.delete(keyForScope(selection)); changed(selection);
          const next = await openSharedWorkspace(selection); return next.sync(options);
        }
        // No legacy edits or private Google sync run here. Only pre-existing outbox/history is drained for conversion.
        return catchUp(options);
      } };

  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

/** Registry writes stay bound to the account and approved local generation that opened this session. */
function workspaceRegistryAccess(context: WorkspaceOpenContext) {
  const { selection: { userId, groupId }, registry } = context; const generation = context.record.localGeneration;
  let record = context.record; let archive = context.archive; let retired = false;
  const assertAccount = () => {
    if (retired) throw new SharingAccessError('表示する所属グループが更新されています。');
    if (getSharingServices().auth.currentUser?.uid !== userId) throw new SharingAccessError('共有アカウントが切り替わりました。');
  };
  const assertGeneration = (current: SharingWorkspaceRecord) => { if (current.localGeneration !== generation) throw new SharingAccessError('再参加前のデータは読み取り専用で保持されています。'); };
  const readRecord = async () => {
    assertAccount(); const current = await readSharingWorkspace(registry, userId, groupId); assertAccount();
    if (!current) throw new Error('共有グループが見つかりません。'); assertGeneration(current); record = current; return record;
  };
  const update = async (change: (prior: SharingWorkspaceRecord) => SharingWorkspaceRecord) => {
    const previous = canonicalJson(record); const { lastSuccessfulSyncAt: _lastSync, ...beforeContent } = record;
    assertAccount(); record = await updateSharingWorkspace(registry, userId, groupId, (prior) => { assertAccount(); assertGeneration(prior); return change(prior); });
    const { lastSuccessfulSyncAt: _nextSync, ...afterContent } = record;
    assertAccount(); if (canonicalJson(record) !== previous) changed({ ...context.selection, statusOnly: canonicalJson(beforeContent) === canonicalJson(afterContent) }); return record;
  };
  const saveArchive = async (next: VerifiedSharedRoster[]) => {
    const latest = next.at(-1); if (!latest || latest.body.groupId !== groupId) throw new SharingAccessError('共有グループが一致しません。');
    await update((prior) => {
      if ((prior.rosterArchive.at(-1)?.body.revision ?? 0) > latest.body.revision) throw new Error('Membership changed concurrently');
      return { ...prior, rosterArchive: next };
    }); archive = next;
  };
  const assertWritable = () => {
    assertAccount(); assertGeneration(record);
    if (!['active', 'creating', 'joining'].includes(record.status)) throw new SharingAccessError('この共有グループは現在編集できません。');
  };
  const cancelJoinRequest = async () => {
    const current = await readRecord(); if (current.status !== 'joining' || !current.join) throw new Error('参加申請が見つかりません。');
    if (!await context.cloud.cancelOwnJoinRequest(current.join.invitation, current.join.request)) throw new Error('参加は承認済みです。同期してからメンバー・端末の管理で解除してください。');
    await update((prior) => ({ ...prior, status: 'left', lastErrorCode: null }));
  };
  return { assertAccount, assertWritable, readRecord, update, saveArchive, cancelJoinRequest, record: () => record, archive: () => archive, retire: () => { retired = true; } };
}

async function submitWorkspaceJoin(context: WorkspaceOpenContext, record: SharingWorkspaceRecord): Promise<void> {
  if (!record.join) throw new Error('参加要求が見つかりません。');
  try { await context.cloud.submitJoinRequest(record.join.invitation, record.join.request); }
  catch (error) {
    const actual = await context.cloud.readInvitation(record.join.invitation.body.inviteId);
    if (actual.status !== 'used' || actual.usedBy !== context.selection.userId) throw error;
  }
}

function buildPendingWorkspace(context: WorkspaceOpenContext): PendingSharedWorkspace {
  const access = workspaceRegistryAccess(context); let running: Promise<SharingSyncResult> | null = null;
  const waiting = (): SharingSyncResult => ({ sent: 0, received: 0, pending: 0, waitingForApproval: true, complete: false });
  const workspace: PendingSharedWorkspace = { ...context.selection, protocol: null, database: null, manager: null, cloud: context.cloud, identity: context.identity,
    record: access.readRecord, roster: () => access.archive()?.at(-1), drain: async () => {}, cancelJoinRequest: access.cancelJoinRequest,
    checkpoint: async () => ({ cursor: null, sequence: 0, snapshotId: null, lastSuccessfulSyncAt: null, pendingCount: 0 }),
    readOverview: async () => { throw new SharingAccessError('参加承認と初回同期を完了してください。'); }, maintainHistory: async () => {},
    watch: (callback, failed) => context.cloud.watch(context.selection.groupId, callback, failed),
    sync(options = {}) {
      if (running) return running;
      const task = (async () => {
        const current = await access.readRecord(); if (current.status !== 'joining') throw new SharingAccessError('参加申請の状態を確認してください。');
        await submitWorkspaceJoin(context, current); access.assertAccount();
        let metadata;
        try { metadata = await context.cloud.readGroup(context.selection.groupId); }
        catch (error) {
          access.assertAccount(); const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (['permission-denied', 'sharing/access-denied'].includes(code)) return waiting(); throw error;
        }
        const archive = await readCloudWorkspaceArchive(await access.readRecord(), metadata.roster, context.cloud.readRoster); access.assertAccount();
        await access.saveArchive(archive);
        if (!archive.at(-1)!.body.members.some((member) => member.userId === context.selection.userId && member.devices.some((device) => device.identity.deviceId === context.identity.deviceId))) return waiting();
        const cacheKey = keyForScope(context.selection); const cached = workspacePromises.get(cacheKey);
        if (cached && await cached === workspace && workspacePromises.get(cacheKey) === cached) workspacePromises.delete(cacheKey);
        const opened = await openSharedWorkspace(context.selection); if (opened.protocol === null) return waiting();
        return opened.sync(options);
      })(); running = task;
      void task.catch(async (error) => {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'sharing/failed';
        await access.update((prior) => ({ ...prior, lastErrorCode: code })).catch(() => undefined);
      }).finally(() => { if (running === task) running = null; changed(context.selection); });
      return task;
    } };
  return workspace;
}

async function buildV2Workspace(context: WorkspaceOpenContext): Promise<V2SharedWorkspace> {
  const { selection, identity, cloud, user } = context; const { userId, groupId } = selection;
  const access = workspaceRegistryAccess(context); access.assertWritable();
  const databaseGeneration = v2WorkspaceDatabaseGeneration(context.record, context.archive ?? []);
  const database = await openSharingV2Database(userId, groupId, databaseGeneration);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let refreshIntegrations: ((localChange?: boolean) => void) | undefined;
  let syncDeadline: number | null = null;
  let membershipBound = false;
  try {
    access.assertWritable();
    let sync!: V2SharedWorkspace['sync'];
    const openedSession = await createV2WorkspaceSession({ ...selection, database, householdId: 'shared-v2', identity, crypto: nativeSharingCrypto, cloud,
      readRecord: access.readRecord, saveArchive: access.saveArchive, archive: () => access.archive() ?? [],
      readKey: (version) => loadSharingGroupKey(userId, groupId, version), saveKey: (version, bytes) => saveSharingGroupKey(userId, groupId, version, bytes),
      serialized: (work) => withPlannerDatabaseOperation(database, work), changed: () => changed(selection), assertCurrentAccount: access.assertAccount,
      assertWritable: access.assertWritable, makeId: randomUUID, creationKind: context.record.creation?.kind,
      pinMigration: async pin => {
        if (!databaseGeneration) throw new V2WorkspaceMigrationRequiredError();
        await access.update(prior => ({ ...prior, v2Migration: { databaseGeneration, ...pin } }));
      },
      verifyMigrationHistory: async snapshot => {
        const legacy = await openSharingDatabase(userId, groupId, context.record.localGeneration);
        try {
          const table = await legacy.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_operations'");
          if (table) await verifyKnownLegacyHistory(legacy, groupId, snapshot);
        } finally { await legacy.closeAsync(); }
      },
      markLeft: async () => { await access.update((prior) => ({ ...prior, status: 'left', lastErrorCode: null })); },
      afterCommit: () => {
        changed(selection); if (syncDeadline === null) refreshIntegrations?.(true);
        const deadline = syncDeadline; clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (!sync) return;
          const remaining = deadline === null ? undefined : deadline - Date.now();
          if (remaining !== undefined && remaining < 1_000) return;
          void sync(remaining === undefined ? {} : { budgetMs: remaining }).catch(() => undefined);
        }, 350);
      } });
    const retention = createNativeApplianceRetention({ database, repository: openedSession.repository, assertAccess: () => openedSession.assertCurrentAccess(false) });
    const baseController = openedSession.controller;
    const session = { ...openedSession, controller: guardV2GroupController({ ...baseController, actions: { ...baseController.actions,
      reviewAppliance: async input => {
        const result = await baseController.actions.reviewAppliance(input);
        await retention.refresh(); return result;
      },
    } }, openedSession.assertCurrentAccess) };
    let reminderPromise: Promise<import('../../features/sharing/v2/reminder-runtime').V2ReminderRuntime> | undefined;
    let taskPromise: Promise<import('../../features/sharing/v2/google-tasks-runtime').V2GoogleTaskRuntime> | undefined;
    const assertNativeAccess = async () => {
      const record = await access.readRecord(); access.assertWritable();
      if (record.status !== 'active') throw new SharingAccessError('共有連携の参加状態を確認してください。');
    };
    const reminders = () => {
      if (!reminderPromise) {
        const pending = import('./v2-reminders').then(module => module.createNativeV2Reminders({ database, ...selection, repository: session.repository, controller: session.controller, assertAccess: assertNativeAccess }));
        reminderPromise = pending; void pending.catch(() => { if (reminderPromise === pending) reminderPromise = undefined; });
      }
      return reminderPromise;
    };
    const googleTasks = () => {
      if (!taskPromise) {
        const pending = import('./v2-google-tasks').then(module => module.createNativeV2GoogleTasks({ repository: session.repository, ...selection, assertAccess: assertNativeAccess }));
        taskPromise = pending; void pending.catch(() => { if (taskPromise === pending) taskPromise = undefined; });
      }
      return taskPromise;
    };
    let calendarPromise: Promise<import('../../features/calendar/shared-google-export').SharedGoogleCalendarExport> | undefined;
    const googleCalendar = () => {
      if (!calendarPromise) {
        const pending = import('./v2-google-calendar').then(module => module.createNativeV2GoogleCalendar({ repository: session.repository, ...selection, assertAccess: assertNativeAccess }));
        calendarPromise = pending; void pending.catch(() => { if (calendarPromise === pending) calendarPromise = undefined; });
      }
      return calendarPromise;
    };
    refreshIntegrations = localChange => {
      void retention.refresh().catch(() => undefined);
      void reminders().then(runtime => runtime.synchronize()).catch(() => undefined);
      void googleTasks().then(runtime => runtime.synchronize({ localChange })).catch(() => undefined);
      void googleCalendar().then(runtime => runtime.synchronize()).catch(() => undefined);
    };
    let running: Promise<SharingSyncResult> | null = null; let requested = false; let forceRequested = false;
    let unboundedRequested = false; let requestedDeadline: number | undefined;
    sync = (options = {}) => {
      if (running) {
        requested = true; forceRequested ||= Boolean(options.force);
        if (options.budgetMs === undefined) unboundedRequested = true;
        else requestedDeadline = Math.min(requestedDeadline ?? Infinity, Date.now() + options.budgetMs);
        return running;
      }
      clearTimeout(debounce); debounce = undefined;
      syncDeadline = options.budgetMs === undefined ? null : Date.now() + options.budgetMs;
      const task = (async () => {
        try {
          const current = await access.readRecord(); access.assertWritable();
          if (current.status === 'creating') {
            if (!current.creation) throw new Error('作成途中の共有グループを復旧できません。');
            try { await cloud.createGroup(access.archive()!.at(-1)!, current.creation.wrappedKey); }
            catch (error) {
              if ((error as { code?: string }).code === 'permission-denied') {
                const membership = await cloud.readMembership().catch(() => null);
                if (membership && membership !== groupId) {
                  await access.update(prior => ({ ...prior, status: 'removed', lastErrorCode: 'sharing/membership-exists' }));
                  throw new SharingAccessError('別の端末でグループへの参加・作成が確定しています。この端末の未送信内容は保存しました。');
                }
              }
              throw error;
            }
            membershipBound = true;
            await access.update((prior) => ({ ...prior, status: 'active' }));
          } else if (current.status === 'active' && !membershipBound) {
            try { await cloud.bindMembership(groupId); membershipBound = true; }
            catch (error) {
              if (['sharing/access-denied', 'permission-denied'].includes((error as { code?: string }).code ?? '')) {
                const confirmed = await cloud.readMembership().catch(() => null); access.assertAccount();
                const known = confirmed && confirmed !== groupId ? await readSharingWorkspace(context.registry, userId, confirmed) : null;
                if (known?.status === 'active') {
                  // Verify the retained local view before replacing its display
                  // scope. Unknown/unapproved/empty workspaces cannot be adopted.
                  const nextKey = keyForScope(known); let candidate = workspacePromises.get(nextKey);
                  const created = !candidate; let next: SharedWorkspace | undefined;
                  if (!candidate) { candidate = buildWorkspace(known); workspacePromises.set(nextKey, candidate); }
                  try { next = await candidate; if (next.protocol !== 2) throw error; await next.readOverview(); }
                  catch {
                    if (workspacePromises.get(nextKey) === candidate) workspacePromises.delete(nextKey);
                    if (created && next?.database) await next.database.closeAsync().catch(() => undefined);
                    throw error;
                  }
                  await adoptConfirmedSharingWorkspace(context.registry, userId, groupId, known.groupId); access.assertAccount();
                  access.retire(); workspacePromises.delete(keyForScope(selection));
                  await saveSharingSelection({ userId, groupId: known.groupId }); changed({ userId, groupId: known.groupId });
                }
              }
              throw error;
            }
          } else if (current.status === 'joining') await submitWorkspaceJoin(context, current);
          const remainingOptions = () => {
            if (syncDeadline === null) return options;
            const remaining = syncDeadline - Date.now();
            if (remaining < 1000) throw new Error('今回の同期時間を使い切りました。未送信内容を保持し、次の機会に再送します。');
            return { ...options, budgetMs: remaining };
          };
          let result;
          try { result = await session.synchronizer.sync(remainingOptions()); }
          catch (error) {
            if (!(error instanceof SharingKeyVersionError) || access.archive()?.at(-1)?.body.ownerDeviceId !== identity.deviceId) throw error;
            await session.manager.repairDepartures(); result = await session.synchronizer.sync(remainingOptions());
          }
          if (!result.waitingForApproval && result.complete) {
            const initialState = await session.repository.readState(); const initialAt = v2ReadPoint(initialState.assessment.view, initialState.archive.at(-1)!);
            if (!initialState.assessment.view.field('groupPolicy', 'policy', 'configuration', initialAt)
              || typeof initialState.assessment.view.field('settings', 'settings', 'timeZone', initialAt)?.value !== 'string') return { ...result, complete: false };
            const created = await session.repository.commitCurrent(async (state) => {
              const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
              return state.assessment.view.field('member', userId, 'displayName', at) ? [] : [{ operationId: randomUUID(), entityType: 'member', entityId: userId,
                operationType: 'patch', payload: { userId, displayName: user.displayName?.trim() || 'メンバー' } }];
            });
            if (created.length) result = await session.synchronizer.sync({ ...remainingOptions(), force: true });
            const state = await session.repository.readState(); const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
            let name: unknown; try { name = state.assessment.view.field('settings', 'settings', 'name', at)?.value; } catch { /* Preserve a conflict for explicit review. */ }
            await access.update((prior) => ({ ...prior, status: 'active', displayName: typeof name === 'string' ? name : prior.displayName,
              lastSuccessfulSyncAt: Date.now(), lastErrorCode: null }));
          }
          if (!result.waitingForApproval && result.complete && (syncDeadline === null || syncDeadline - Date.now() >= 1000))
            await retention.refresh(syncDeadline === null ? undefined : syncDeadline - Date.now());
          return result;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'sharing/failed';
          const disposition = sharedAccessDisposition({ errorCode: code, currentAccountUserId: getSharingServices().auth.currentUser?.uid ?? null,
            userId, deviceId: identity.deviceId, status: access.record().status, roster: access.archive()?.at(-1) });
          let removed = disposition === 'removed';
          if (disposition === 'check-membership') try { removed = !await cloud.hasMembership(groupId); } catch { /* Offline is not removal. */ }
          await access.update((prior) => ({ ...prior, ...(removed ? { status: 'removed' as const } : {}), lastErrorCode: code })).catch(() => undefined);
          if (removed) void import('./v2-reminders').then(module => module.clearV2RemindersForScope(userId, groupId)).catch(() => undefined);
          throw error;
        }
      })(); running = task;
      void task.finally(() => { if (running === task) { running = null; syncDeadline = null; } changed({ ...selection, statusOnly: true });
        // The bounded coordinator refreshes reminders once with its actual remaining time.
        if (options.budgetMs === undefined) refreshIntegrations?.();
        if (requested) {
          const force = forceRequested; const unbounded = unboundedRequested; const deadline = requestedDeadline;
          requested = false; forceRequested = false; unboundedRequested = false; requestedDeadline = undefined;
          setTimeout(() => {
            const remaining = unbounded || deadline === undefined ? undefined : deadline - Date.now();
            if (remaining !== undefined && remaining < 1_000) return;
            void sync(remaining === undefined ? { force } : { force, budgetMs: remaining }).catch(() => undefined);
          }, 0);
        }
      }).catch(() => undefined); return task;
    };
    return { ...selection, protocol: 2, database, session, identity, cloud, manager: session.manager, sync, reminders, googleTasks, googleCalendar, record: access.readRecord,
      roster: () => access.archive()?.at(-1), checkpoint: () => readSharingCheckpoint(database, groupId),
      drain: async () => { await drainPlannerDatabaseOperations(database); await drainSharingLedger(database); }, cancelJoinRequest: access.cancelJoinRequest,
      watch: (callback, failed) => cloud.watch(groupId, callback, failed),
      async readOverview() {
        const model = await session.controller.readModel(({ timeZone }) => { const today = sharedLocalDate(new Date(), timeZone); return { from: today, through: today, asOfDate: today }; });
        if (!model.plan.initialized) throw new Error('初回同期を完了してから共有グループを開いてください。');
        return { timeZone: model.plan.timeZone, members: model.plan.members.filter((member) => member.active).map((member) => ({ id: member.userId, displayName: member.displayName })),
          chores: model.plan.chores, hasConflicts: model.configurations.some((entry) => entry.candidates.length > 1),
          ...(model.recoverySummary ? { recoverySummary: model.recoverySummary } : {}) };
      },
      async maintainHistory(budgetMs = 120_000) {
        const deadline = Date.now() + budgetMs;
        const remaining = () => { const left = deadline - Date.now(); if (left < 1000) throw new Error('履歴の整理は次回同期で続けます。'); return left; };
        if (access.archive()?.at(-1)?.body.ownerDeviceId !== identity.deviceId || access.record().status !== 'active') return;
        remaining(); const { group } = await cloud.readGroup(groupId); remaining(); if (group.rotationRequired) return;
        if (group.headSequence - group.snapshotThroughSequence >= 256) await session.manager.publishSnapshot(remaining());
        remaining(); await cloud.compactHistory(groupId, Date.now(), remaining);
      } };
  } catch (error) { clearTimeout(debounce); await database.closeAsync().catch(() => undefined); throw error; }
}

/** The caller must explicitly choose a kind. New v2 groups never convert an existing workspace in place. */
export async function createV2SharingWorkspace(name: string, kind: 'family' | 'roommates', timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<V2SharedWorkspace> {
  if (!['family', 'roommates'].includes(kind)) throw new Error('グループの種類を選んでください。');
  const workspace = await createWorkspaceIntent(name, timeZone, { protocol: 2, kind });
  if (workspace.protocol !== 2) throw new SharingSchedulerVersionError(); return workspace;
}

async function createWorkspaceIntent(name: string, timeZone: string, options: { protocol: 2; kind: 'family' | 'roommates' }): Promise<SharedWorkspace> {
  const trimmed = name.trim(); if (!trimmed || trimmed.length > 100) throw new Error('グループ名は1〜100文字で入力してください。');
  if (!isSharedTimeZone(timeZone)) throw new Error('共有するタイムゾーンを確認してください。');
  const user = await requireUser();
  if (await currentSharingWorkspace() || await createSharingCloud(getSharingServices().firestore, user.uid, () => getSharingServices().auth.currentUser?.uid ?? null).readMembership()) throw new Error('現在のグループから退出するか、参加申請を取り消してから作成してください。');
  const groupId = `group.${randomUUID()}`; const userId = user.uid; const registry = await sharingRegistryDatabase();
  const identity = await loadOrCreateSharingDeviceIdentity(userId); const roster = createSharedRoster(groupId, userId, identity, { schemaVersion: 2 }); const key = await nativeSharingCrypto.randomBytes(32);
  const now = new Date();
  try {
    const wrappedKey = await wrapGroupKey(nativeSharingCrypto, groupId, 1, key, identity, identity, userId);
    await saveSharingGroupKey(userId, groupId, 1, key);
    const creation = { wrappedKey, timeZone, anchorDate: sharedLocalDate(now, timeZone), ownerDisplayName: user.displayName?.trim() || '自分', kind: options.kind };
    await saveSharingWorkspace(registry, { userId, groupId, displayName: trimmed, status: 'creating', anchor: roster, rosterArchive: [roster],
      createdAt: now.toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null, creation });
    const workspace = await openSharedWorkspace({ userId, groupId });
    await enableSharingSession(); changed({ userId, groupId });
    void import('../../features/google-sync/background-task').then((module) => module.registerGoogleSyncBackgroundTask()).catch(() => undefined);
    void workspace.sync().catch(() => undefined); return workspace;
  } finally { key.fill(0); }
}

export async function requestSharingWorkspace(linkText: string): Promise<SharedWorkspace> {
  const link = parseSharedInvitation(linkText.trim(), Date.now()); const user = await requireUser(); const userId = user.uid;
  const groupId = link.invitation.body.groupId;
  const current = await currentSharingWorkspace();
  const remote = await createSharingCloud(getSharingServices().firestore, userId, () => getSharingServices().auth.currentUser?.uid ?? null).readMembership();
  if (current && current.groupId !== groupId || remote && remote !== groupId) throw new Error('現在のグループから退出するか、参加申請を取り消してから参加してください。');
  const registry = await sharingRegistryDatabase(); const old = await readSharingWorkspace(registry, userId, groupId);
  const rejoining = old && ['left', 'removed'].includes(old.status);
  const generation = rejoining ? randomUUID() : old?.localGeneration;
  const identity = await loadOrCreateSharingDeviceIdentity(userId, generation);
  const request = createSharedJoinRequest(link, userId, identity, Date.now());
  if (old) {
    const pin = 'body' in old.anchor ? sharedRosterDigest(old.anchor) : old.anchor.digest;
    // A new invitation may pin a later verified epoch, but cannot replace a previously trusted chain silently.
    if (pin !== link.invitation.body.pin.digest && !old.rosterArchive.some((item) => sharedRosterDigest(item) === link.invitation.body.pin.digest)
      && link.invitation.body.pin.revision <= old.rosterArchive.length) throw new Error('以前の共有グループと招待の確認情報が一致しません。');
    if (['active', 'creating'].includes(old.status)) return openSharedWorkspace({ userId, groupId });
    await updateSharingWorkspace(registry, userId, groupId, (previous) => {
      if (previous.status !== old.status || previous.localGeneration !== old.localGeneration) throw new Error('参加状態が変わりました。画面を開き直してください。');
      const { v2Migration: _previousMigration, ...withoutMigration } = previous;
      return { ...(rejoining ? withoutMigration : previous), status: 'joining', join: { invitation: link.invitation, request }, lastErrorCode: null,
        ...(rejoining ? { localGeneration: generation, archivedLocalGenerations: [...new Set([...(previous.archivedLocalGenerations ?? []), previous.localGeneration ?? 'initial'])] } : {}) };
    });
    if (rejoining) workspacePromises.delete(keyForScope({ userId, groupId }));
  } else await saveSharingWorkspace(registry, { userId, groupId, displayName: '参加を申請したグループ', status: 'joining', anchor: link.invitation.body.pin, rosterArchive: [],
    createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null, join: { invitation: link.invitation, request } });
  const workspace = await openSharedWorkspace({ userId, groupId }); await enableSharingSession(); changed({ userId, groupId });
  void import('../../features/google-sync/background-task').then((module) => module.registerGoogleSyncBackgroundTask()).catch(() => undefined);
  await workspace.sync({ force: true }); return workspace;
}

/** Foreground and the single OS worker call the same bounded coordinator. */
export async function syncSharingWorkspace(budgetMs = 20_000): Promise<void> {
  if (!await hasSharingSessionEnabled()) return;
  const start = Date.now(); const owner = (await sharingSessionUser())?.uid; const record = await currentSharingWorkspace();
  if ((await sharingSessionUser())?.uid !== owner) throw new SharingAccessError('同期する共有アカウントが変わりました。');
  if (!owner) return;
  const failures: unknown[] = [];
  if (Date.now() - start < budgetMs - 1000) try {
    const { clearInactiveV2Reminders } = await import('./v2-reminders');
    await clearInactiveV2Reminders(record?.status === 'active' ? [record] : [], async () => {
      if ((await sharingSessionUser())?.uid !== owner || Date.now() - start >= budgetMs) throw new Error('通知の更新状態が変わりました。');
    });
  } catch (error) { failures.push(error); }
  if (record && budgetMs - (Date.now() - start) >= 1000) {
    try {
      if ((await sharingSessionUser())?.uid !== owner) throw new SharingAccessError('同期する共有アカウントが変わりました。');
      const workspace = await openSharedWorkspace(record);
      const syncBudget = budgetMs - (Date.now() - start);
      if (syncBudget < 1000) { if (failures.length) throw failures[0]; return; }
      await workspace.sync({ budgetMs: syncBudget }).catch(error => { failures.push(error); });
      if (budgetMs - (Date.now() - start) >= 1000 && workspace.protocol === 2) {
        if (budgetMs - (Date.now() - start) >= 1000) await workspace.reminders().then(runtime => {
          const remaining = budgetMs - (Date.now() - start); if (remaining >= 1000) return runtime.synchronize(Math.min(15_000, remaining));
        }).catch(error => { failures.push(error); });
        const taskBudget = budgetMs - (Date.now() - start);
        if (taskBudget >= 1000) await workspace.googleTasks().then(runtime => {
          const remaining = budgetMs - (Date.now() - start);
          if (remaining >= 1000) return runtime.synchronize({ budgetMs: Math.min(15_000, remaining) }).then(result => {
            if (result.kind !== 'success') throw new Error('Google Tasksへの同期を完了できませんでした。接続状態を確認してください。');
          });
        }).catch(error => { failures.push(error); });
        const calendarBudget = budgetMs - (Date.now() - start);
        if (calendarBudget >= 1000) await workspace.googleCalendar().then(runtime => {
          const remaining = budgetMs - (Date.now() - start);
          return remaining >= 1000 ? runtime.synchronize({ budgetMs: Math.min(15_000, remaining) }) : undefined;
        }).then(result => {
          if (result && !['success', 'skipped'].includes(result.kind)) throw new Error('共有予定のGoogle追加は未完了です。続きを再送します。');
        }).catch(error => { failures.push(error); });
      }
      const historyBudget = budgetMs - (Date.now() - start);
      if (historyBudget >= 5000) await workspace.maintainHistory(historyBudget).catch(() => undefined);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}

/** Native OAuth is shared by the process, while connection settings and Task IDs remain per workspace. */
export async function hasOtherGoogleWorkspaceConnections(except: SQLiteDatabase): Promise<boolean> {
  if (sharedRepositoryAdapter(except)) {
    const personal = await openDatabaseAsync('housework.db', { useNewConnection: true });
    try { const state = await loadGoogleSyncState(personal); if (state && !state.disconnected && (state.accountSubject || state.taskListId || state.enabled)) return true; }
    finally { await personal.closeAsync(); }
  }
  if (!await hasSharingSessionEnabled()) return false;
  const record = await currentSharingWorkspace();
  if (record) {
    const workspace = await openSharedWorkspace(record); if (workspace.protocol === 2) {
      const control = await workspace.googleTasks().then(runtime => runtime.readControl());
      if (control.state && !control.state.disconnected && (control.state.accountSubject || control.state.taskListId || control.state.enabled)) return true;
    }
  }
  return false;
}

export async function isSharedWorkerNeeded(): Promise<boolean> {
  if (!await hasSharingSessionEnabled()) return false;
  if (await currentSharingWorkspace()) return true;
  const { isPrivateCalendarWorkerNeeded } = await import('./private-calendar-sync');
  return isPrivateCalendarWorkerNeeded();
}
