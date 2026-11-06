import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import * as registry from '../src/platform/storage/sharing-registry.ts';
import * as operations from '../src/features/sharing/operations.ts';
import * as rosters from '../src/features/sharing/roster.ts';
import * as protocols from '../src/features/sharing/workspace-protocol.ts';
import * as restore from '../src/features/sharing/account-device-restore.ts';
import * as controller from '../src/features/sharing/account-device-controller.ts';
import * as continuity from '../src/features/sharing/account-device-key-continuity.ts';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';

async function fixture() {
  const owner = await createDeviceIdentity(crypto), phone = await createDeviceIdentity(crypto), tablet = await createDeviceIdentity(crypto), key = await crypto.randomBytes(32);
  const root = rosters.createSharedRoster('native-account-restore', 'owner', owner, { schemaVersion: 2 });
  let archive = [root, rosters.approveSharedDevice(root, owner, 'same-account', phone)], records = [], ordinal = 0;
  const handles = [], metadata = () => ({ roster: archive.at(-1), group: { ...rosterCloudFields(archive.at(-1)), headSequence: 0,
    snapshotId: 'snapshot-at-2', snapshotThroughSequence: 0, lastOperationId: null } });
  const api = {
    read: async () => structuredClone(records), request: async input => { records = [{ slot: input.slot, request: input.request, receivedAt: Date.now(), status: 'requested' }]; },
    accept: async input => { archive.push(input.grant.body.roster); records[0] = { ...records[0], status: 'accepted', grant: input.grant, acceptedAt: Date.now() }; },
    acknowledge: async () => { records[0] = { ...records[0], status: 'acknowledged' }; delete records[0].grant; delete records[0].acceptedAt; },
  };
  async function device(identity, approved = false) {
    const database = createDatabase(); handles.push(database); await registry.initializeSharingRegistry(database.database);
    const vault = new Map(), keys = new Map(approved ? [[2, key.slice()]] : []); const user = { uid: 'same-account', getIdToken: async () => 'synthetic-token' };
    const auth = { currentUser: user }; let notifications = 0, blockDiscovery;
    if (approved) await registry.saveSharingWorkspace(database.database, { userId: user.uid, groupId: root.body.groupId, status: 'active', displayName: '端末検査',
      anchor: root, rosterArchive: archive, createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null });
    const cloud = { readMembership: async () => { if (blockDiscovery) await blockDiscovery; return root.body.groupId; }, readGroup: async () => metadata(), readRoster: async (_id, revision) => archive[revision - 1],
      readSnapshotManifest: async () => ({ body: { keyVersion: 2, throughSequence: 0 } }),
      readGroupKey: async () => { throw new Error('Missing device key envelope'); }, watchAccountDeviceRestores: () => () => {} };
    const mocks = {
      'expo-crypto': { randomUUID: () => `native-request-${++ordinal}` },
      '../../features/sharing/account-device-controller.ts': controller, '../../features/sharing/account-device-restore.ts': restore,
      '../../features/sharing/operations.ts': operations, '../../features/sharing/roster.ts': rosters,
      '../../features/sharing/workspace-protocol.ts': protocols, '../../features/sharing/account-device-key-continuity.ts': continuity,
      '../storage/sharing-registry.ts': registry, './account-device-api.ts': { createAccountDeviceApi: () => api },
      './firebase-services.ts': { isSharingConfigured: () => true, getSharingServices: () => ({ auth, firestore: {} }) },
      './firestore-cloud.ts': { createSharingCloud: () => cloud }, './native-crypto.ts': { nativeSharingCrypto: crypto },
      './secure-store.ts': { loadOrCreateSharingDeviceIdentity: async () => identity, loadSharingGroupKey: async (_uid, _group, version) => keys.get(version)?.slice() ?? null,
        saveSharingGroupKey: async (_uid, _group, version, bytes) => keys.set(version, bytes.slice()),
        sharingSecureVault: { getItem: async name => vault.get(name) ?? null, setItem: async (name, value) => vault.set(name, value), removeItem: async name => vault.delete(name) } },
      './workspaces.ts': { currentSharingWorkspace: () => registry.readCurrentSharingWorkspace(database.database, user.uid),
        notifySharingWorkspaceChanged: () => { notifications++; }, sharingRegistryDatabase: async () => database.database, sharingSessionUser: async () => auth.currentUser },
    };
    return { database, vault, keys, user, auth, mocks, cloud, notifications: () => notifications, block: promise => { blockDiscovery = promise; },
      reload: () => loadNativeModule('src/platform/sharing/account-device-runtime.ts', mocks) };
  }
  return { device, key, phone, tablet, archive: () => archive, records: () => records, close: () => handles.forEach(handle => handle.connection.close()) };
}
function configured() { const old = process.env.EXPO_PUBLIC_SHARING_ACCOUNT_DEVICE_API_URL; process.env.EXPO_PUBLIC_SHARING_ACCOUNT_DEVICE_API_URL = 'https://synthetic.example/';
  return () => { if (old === undefined) delete process.env.EXPO_PUBLIC_SHARING_ACCOUNT_DEVICE_API_URL; else process.env.EXPO_PUBLIC_SHARING_ACCOUNT_DEVICE_API_URL = old; }; }

test('native account restoration persists its pin across reloads and activates only the same account without overwriting personal SQLite', async () => {
  const reset = configured(), h = await fixture();
  try {
    const first = await h.device(h.phone, true), second = await h.device(h.tablet);
    await second.database.database.execAsync("CREATE TABLE unrelated_personal_data(value TEXT); INSERT INTO unrelated_personal_data VALUES ('keep settings and history')");
    const saved = second.database.connection.prepare('SELECT * FROM unrelated_personal_data').all();
    const runtime = second.reload(); assert.equal(await runtime.syncAccountDeviceRestoration(), 'waiting');
    assert.ok(second.vault.has('account-group-restore:same-account')); assert.equal(runtime.accountDeviceRestoreStatus('same-account').phase, 'waiting');
    assert.equal(await first.reload().syncAccountDeviceRestoration(), 'sent');
    assert.equal(await second.reload().syncAccountDeviceRestoration(), 'restored');
    const record = await registry.readCurrentSharingWorkspace(second.database.database, 'same-account');
    assert.equal(record.status, 'active'); assert.equal(record.rosterArchive.length, 3); assert.equal(second.notifications(), 1);
    assert.deepEqual(second.keys.get(2), h.key); assert.deepEqual(second.keys.get(3), h.key); assert.equal(second.vault.size, 0);
    assert.deepEqual(second.database.connection.prepare('SELECT * FROM unrelated_personal_data').all(), saved);
    assert.equal(h.records()[0].status, 'acknowledged');
    await second.reload().syncAccountDeviceRestoration(); assert.equal(second.notifications(), 1, 'Unchanged membership must not remount every view');
  } finally { h.close(); reset(); }
});

test('native restoration fences an account replacement during discovery and never starts a duplicate concurrent request', async () => {
  const reset = configured(), h = await fixture();
  try {
    const second = await h.device(h.tablet); let release; second.block(new Promise(resolve => { release = resolve; }));
    const runtime = second.reload(), first = runtime.syncAccountDeviceRestoration(); assert.equal(runtime.syncAccountDeviceRestoration(), first);
    await new Promise(resolve => setImmediate(resolve)); second.auth.currentUser = { uid: 'another-account' }; release();
    await assert.rejects(first, /session changed/); assert.equal(second.keys.size, 0); assert.equal(second.vault.size, 0); assert.equal(second.notifications(), 0);
    assert.equal(await registry.readCurrentSharingWorkspace(second.database.database, 'same-account'), null);
  } finally { h.close(); reset(); }
});

test('same-account automation leaves an existing manual join alone and is disabled without the managed endpoint', async () => {
  const reset = configured(), h = await fixture();
  try {
    const second = await h.device(h.tablet), root = h.archive()[0];
    await registry.saveSharingWorkspace(second.database.database, { userId: 'same-account', groupId: root.body.groupId, status: 'joining', displayName: 'manual invitation',
      anchor: root, rosterArchive: [root], createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null });
    assert.equal(await second.reload().syncAccountDeviceRestoration(), 'absent'); assert.equal(second.vault.size, 0);
    delete process.env.EXPO_PUBLIC_SHARING_ACCOUNT_DEVICE_API_URL;
    assert.equal(await second.reload().syncAccountDeviceRestoration(), 'disabled'); assert.equal(second.keys.size, 0);
  } finally { h.close(); reset(); }
});
