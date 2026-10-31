import * as liveMigration from '../src/features/sharing/v2/live-legacy-migration.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as rollout from '../src/features/sharing/rollout.ts';

function fixture(options = {}) {
  const events = []; const handles = []; const synchronizers = []; const syncBudgets = [];
  const session = { userId: 'member' };
  const vault = options.vault ?? new Map();
  const records = (options.groups ?? ['broken', 'healthy']).map((groupId) => ({ userId: 'member', groupId,
    status: 'active', displayName: groupId, rosterArchive: [], anchor: { body: { schemaVersion: 1, groupId, ownerDeviceId: 'another-device',
      members: [{ userId: 'member', devices: [{ identity: { deviceId: 'this-device' } }] }] } } }));
  const registry = { closeAsync: async () => { events.push('registry-close'); } };
  const api = loadNativeModule('src/platform/sharing/workspaces.ts', {
    'expo-crypto': { randomUUID: () => 'test-operation' },
    'expo-sqlite': { openDatabaseAsync: async () => registry },
    './firebase-services.ts': { isSharingConfigured: () => true,
      getSharingServices: () => ({ auth: { authStateReady: async () => {}, currentUser: { uid: session.userId } }, firestore: {} }) },
    './native-crypto.ts': { nativeSharingCrypto: {} },
    './secure-store.ts': { loadOrCreateSharingDeviceIdentity: async () => ({ deviceId: 'this-device' }),
      sharingSecureVault: { getItem: async key => vault.get(key) ?? (key === 'sharing-enabled' ? 'true' : key === 'active-workspace' && options.selection ? JSON.stringify(options.selection) : null),
        setItem: async (key, value) => { vault.set(key, value); } } },
    './database-location.ts': { sharingDatabaseDirectory: async () => '/protected-test-directory',
      openSharingDatabase: async (_userId, groupId) => {
        events.push(`open:${groupId}`);
        if (options.failOpen === groupId) throw new Error(`open failed:${groupId}`);
        options.afterOpen?.(groupId);
        const database = { groupId, closeAsync: async () => { events.push(`close:${groupId}`); } };
        handles.push(database); return database;
      } },
    './firestore-cloud.ts': { createSharingCloud: () => ({ readGroup: async groupId => ({ roster: records.find(record => record.groupId === groupId).anchor }) }) },
    '../../features/sharing/roster.ts': { sharedRosterDigest: () => 'test-digest', verifyPinnedSharedRoster: (roster) => roster },
    '../../features/sharing/operations.ts': { canonicalJson: JSON.stringify },
    '../../features/sharing/rollout.ts': rollout,
    '../../features/sharing/v2/live-legacy-migration.ts': { ...liveMigration, createLiveLegacyMigration: () => ({}) },
    '../../features/sharing/workspace-protocol.ts': { verifyWorkspaceArchive: (record) => [record.anchor], sharedWorkspaceProtocol: () => 1 },
    '../../features/sharing/v2/workspace-session.ts': {}, '../../features/sharing/v2/view-point.ts': {},
    '../../features/sharing/v2/controller-access.ts': {},
    '../../features/sharing/crypto.ts': {},
    '../../features/sharing/conflict-resolution.ts': { planSharedConflictResolution: () => {
      events.push('resolve-plan'); return { operationId: 'resolution', entityType: 'waste', entityId: 'waste', operationType: 'patch', payload: { label: '缶' } };
    } },
    '../../features/sharing/synchronizer.ts': { createSharedSynchronizer: (deps) => { synchronizers.push(deps); return { sync: async (runOptions) => {
      syncBudgets.push(runOptions.budgetMs);
      events.push(`sync:${deps.groupId}`); options.afterSync?.(deps.groupId);
      if (options.failSync === deps.groupId) throw new Error(`sync failed:${deps.groupId}`);
      return { waitingForApproval: true };
    } }; } },
    '../../features/sharing/group-manager.ts': { createSharedGroupManager: () => ({}) },
    '../../features/sharing/access-state.ts': { sharedAccessDisposition: () => 'retain' },
    '../../features/sharing/invitations.ts': {}, '../../features/sharing/group-clock.ts': {},
    '../../features/sharing/workspace-selection.ts': { decodeSharingSelection: JSON.parse },
    '../../features/sharing/planning.ts': {}, '../../features/sharing/cloud-contract.ts': {
      SharingKeyVersionError: class extends Error {}, SharingAccessError: class extends Error {}, SharingSchedulerVersionError: class extends Error {},
    },
    '../storage/sharing-registry.ts': {
      initializeSharingRegistry: async () => { if (options.failRegistry) throw new Error('registry initialization failed'); },
      readSharingWorkspace: async (_db, _user, groupId) => records.find((record) => record.groupId === groupId),
      readCurrentSharingWorkspace: async (_db, _user, previous) => records.find(record => record.groupId === previous) ?? records[0],
      updateSharingWorkspace: async (_db, _user, groupId, change) => {
        const index = records.findIndex((record) => record.groupId === groupId);
        const next = change(records[index]); records[index] = next; return next;
      },
    },
    '../storage/sharing-projection.ts': { initializeSharedProjection: async (db) => {
      events.push(`initialize:${db.groupId}`);
      if (options.failProjection === db.groupId) throw new Error(`projection failed:${db.groupId}`);
    } },
    '../storage/sharing-ledger.ts': { initializeSharingLedger: async () => {}, createLocalSharedOperations: async (database, _scope, plan, project) => {
      const replica = {}; const drafts = await plan(database, replica); await project(database, replica); return drafts;
    } },
    '../storage/shared-planner-repository.ts': { createSharedPlannerRepository: (_database, scope) => ({
      readSnapshot: async () => ({ household: { name: 'group' }, groupId: scope.groupId }),
      project: async () => { events.push('resolve-project'); options.afterProjection?.(); },
    }) },
    '../storage/shared-repository-adapter.ts': { registerSharedRepositoryAdapter: () => {} },
    '../storage/repository.ts': { LOCAL_HOUSEHOLD_ID: 'home', withPlannerDatabaseOperation: async (_database, work) => { await options.beforeQueuedWork?.(); return work(); }, loadGoogleSyncState: async (db) => {
      events.push(`google-state:${db.groupId}`);
      if (options.failGoogleState === db.groupId) throw new Error(`google state failed:${db.groupId}`);
      return { enabled: options.googleEnabled === true };
    } },
    '../../features/google-sync/coordinator': { syncGoogleTasks: async (db) => { events.push(`google-sync:${db.groupId}`); } },
    '../../features/notifications/daily-housework-digest': { syncDailyHouseworkDigest: async (_gateway, snapshot) => { events.push(`notify:${snapshot.groupId}`); } },
    '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: {} },
    './v2-reminders': { clearInactiveV2Reminders: async (_allowed, assertCurrent) => {
      await assertCurrent(); events.push('v2-reminder-cleanup');
      if (options.failReminderCleanup) throw new Error('v2 reminder cleanup failed');
    } },
    '../../features/google-sync/workspace-policy': { sharedGoogleNamespace: () => 'a'.repeat(64) },
  });
  return { api, events, handles, records, synchronizers, syncBudgets, session, vault };
}

for (const [status, name] of [
  ['active', 'legacy migration scope never exposes a planner editor or conflict writer when status becomes active'],
  ['left', 'legacy migration scope never exposes a planner editor or conflict writer when status becomes left'],
  ['removed', 'legacy migration scope never exposes a planner editor or conflict writer when status becomes removed'],
  ['joining', 'legacy migration scope never exposes a planner editor or conflict writer when status becomes joining'],
]) test(name, async () => {
  const h = fixture({ groups: ['healthy'] });
  const workspace = await h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' });
  h.records[0] = { ...h.records[0], status };
  assert.equal(workspace.protocol, 'migration'); assert.equal(workspace.adapter, undefined);
  assert.equal(workspace.manager, null); assert.equal(workspace.resolveConflict, undefined);
  await assert.rejects(workspace.readOverview(), /移行/u);
  assert.equal(h.events.includes('resolve-plan'), false); assert.equal(h.events.includes('resolve-project'), false);
});

test('an unavailable current migration database never starts synchronization for historical groups', async () => {
  const h = fixture({ failOpen: 'broken' });
  await assert.rejects(h.api.syncSharingWorkspace(), /open failed:broken/);
  assert.equal(h.events.includes('sync:healthy'), false, 'historical groups must never be opened by fallback');
  assert.equal(h.events.includes('notify:healthy'), false);
});

test('v2 notification cleanup failure remains observable after migration catch-up without legacy reminders', async () => {
  const h = fixture({ groups: ['healthy'], failReminderCleanup: true, selection: { userId: 'member', groupId: 'healthy' } });
  await assert.rejects(h.api.syncSharingWorkspace(), /v2 reminder cleanup failed/u);
  assert.ok(h.events.includes('sync:healthy')); assert.equal(h.events.includes('notify:healthy'), false);
});

test('migration workers never read retired group Google state or run legacy Google synchronization', async () => {
  const h = fixture({ groups: ['healthy'], failGoogleState: 'healthy' });
  await h.api.syncSharingWorkspace();
  assert.equal(h.events.some(event => event.startsWith('google-state:') || event.startsWith('google-sync:')), false);
  assert.ok(h.events.includes('sync:healthy'));
});

test('a durably reported shared sync failure reaches the worker without attempting other groups', async () => {
  const h = fixture({ failSync: 'broken' });
  await assert.rejects(h.api.syncSharingWorkspace(), /sync failed:broken/u);
  assert.equal(h.events.includes('sync:healthy'), false);
});

test('a shared worker does not start another Google phase after its time budget has already expired', async () => {
  const originalNow = Date.now; let now = 1000;
  Date.now = () => now;
  try {
    const h = fixture({ googleEnabled: true, afterSync: () => { now += 30000; } });
    await h.api.syncSharingWorkspace(20000);
    assert.deepEqual(h.events.filter((event) => event.startsWith('sync:')), ['sync:broken']);
    assert.equal(h.events.some((event) => event.startsWith('google-state:')), false);
    assert.equal(h.events.some((event) => event.startsWith('google-sync:')), false);
  } finally { Date.now = originalNow; }
});

test('opening a shared database consumes the same worker budget instead of granting a fresh interval', async () => {
  const originalNow = Date.now; let now = 1000;
  Date.now = () => now;
  try {
    const h = fixture({ groups: ['healthy'], afterOpen: () => { now += 7000; } });
    await h.api.syncSharingWorkspace(20000);
    assert.deepEqual(h.syncBudgets, [13000]);
  } finally { Date.now = originalNow; }
});

test('a database that finishes opening after the worker deadline does not start a cloud sync', async () => {
  const originalNow = Date.now; let now = 1000;
  Date.now = () => now;
  try {
    const h = fixture({ groups: ['healthy'], afterOpen: () => { now += 30000; } });
    await h.api.syncSharingWorkspace(20000);
    assert.deepEqual(h.syncBudgets, []);
    assert.equal(h.events.some((event) => event.startsWith('google-state:')), false);
  } finally { Date.now = originalNow; }
});

test('bounded worker runs and process restarts never rotate into archived group scopes', async () => {
  const previous = Date.now; let now = 1000; Date.now = () => now;
  try {
    const vault = new Map();
    const first = fixture({ vault, afterSync: () => { now += 30_000; } });
    await first.api.syncSharingWorkspace(20_000);
    assert.deepEqual(first.events.filter(event => event.startsWith('sync:')), ['sync:broken']);
    const restarted = fixture({ vault, afterSync: () => { now += 30_000; } });
    await restarted.api.syncSharingWorkspace(20_000);
    assert.deepEqual(restarted.events.filter(event => event.startsWith('sync:')), ['sync:broken']);
    assert.equal([...vault.keys()].some(key => key.startsWith('sharing-worker-cursor:')), false);
    const third = fixture({ vault, afterSync: () => { now += 30_000; } });
    await third.api.syncSharingWorkspace(20_000);
    assert.deepEqual(third.events.filter(event => event.startsWith('sync:')), ['sync:broken']);
  } finally { Date.now = previous; }
});

test('failed shared database initialization closes only its new handle and a retry can open a fresh connection', async () => {
  const h = fixture({ failProjection: 'broken' });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(h.api.openSharedWorkspace({ userId: 'member', groupId: 'broken' }), /projection failed/);
  assert.equal(h.handles.length, 2);
  assert.equal(h.events.filter((event) => event === 'close:broken').length, 2);
  assert.equal(h.events.includes('registry-close'), false, 'a group failure must not close a healthy shared registry');
});

test('failed sharing registry initialization releases its handle before retrying instead of leaking connections', async () => {
  const h = fixture({ failRegistry: true });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(h.api.sharingRegistryDatabase(), /registry initialization failed/);
  assert.equal(h.events.filter((event) => event === 'registry-close').length, 2);
});

test('a delayed roster result from an archived workspace cannot update a newly requested local generation', async () => {
  const h = fixture({ groups: ['healthy'] });
  await h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' });
  const rejoining = { ...h.records[0], status: 'joining', localGeneration: 'new-generation', archivedLocalGenerations: ['initial'] };
  h.records[0] = rejoining;
  await assert.rejects(h.synchronizers[0].saveArchive([{ body: { groupId: 'healthy', revision: 2 } }]), /再参加前/);
  assert.equal(h.records[0], rejoining);
  assert.equal(h.records[0].rosterArchive.length, 0);
});

test('a cached legacy workspace cannot read or save membership after its Firebase account changes', async () => {
  const h = fixture({ groups: ['healthy'] });
  const workspace = await h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' });
  const before = structuredClone(h.records[0]); h.session.userId = 'another-account';
  await assert.rejects(workspace.record(), /現在編集できません/u);
  await assert.rejects(h.synchronizers[0].saveArchive([{ body: { groupId: 'healthy', revision: 2 } }]), /現在編集できません/u);
  assert.deepEqual(h.records[0], before);
});

test('a legacy workspace account switch during native database opening closes the new handle before schema initialization', async () => {
  const options = { groups: ['healthy'] }; const h = fixture(options);
  options.afterOpen = () => { h.session.userId = 'another-account'; };
  await assert.rejects(h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' }), /切り替わり/u);
  assert.equal(h.events.includes('initialize:healthy'), false); assert.ok(h.events.includes('close:healthy'));
});
