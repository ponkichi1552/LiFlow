import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { startupDisplayScope } from '../src/features/planner/startup-display.ts';
import * as transactions from '../src/platform/storage/isolated-transaction.ts';

test('native base64 display decryption keeps the existing AES-GCM nonce ciphertext AAD and sixteen-byte tag on both platforms', async () => {
  for (const platform of ['ios', 'android']) {
    const key = new Uint8Array(32); const aad = new Uint8Array([1, 2]); const nativeKey = {}; const sealed = {}; const result = new Uint8Array([3]); const calls = [];
    const module = loadNativeModule('src/platform/sharing/native-crypto.ts', {
      'expo-crypto': {
        AESEncryptionKey: { import: async input => { assert.equal(input, key); return nativeKey; } },
        AESSealedData: { fromParts: (...args) => { calls.push(args); return sealed; } },
        aesDecryptAsync: async (input, imported, options) => {
          assert.equal(input, sealed); assert.equal(imported, nativeKey); assert.deepEqual(options, { additionalData: aad, output: 'bytes' }); return result;
        },
      },
    });
    assert.equal(await module.decryptNativeBase64(key, 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==', aad), result, platform);
    assert.deepEqual(calls, [['AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==', 16]], platform);
  }
});

function fixture() {
  let selection = { userId: 'owner', groupId: 'house' }; let afterRead = () => {}; let reads = 0; let rows = true; let onQuery = () => {};
  const record = { ...selection, status: 'active', anchor: { groupId: 'house' }, rosterArchive: [] }; let slot = 'house';
  const model = { viewerUserId: 'owner', plan: { groupId: 'house' } };
  const module = loadNativeModule('src/platform/sharing/startup-display.ts', {
    '../../features/planner/startup-display.ts': { startupDisplayScope, createStartupDisplayCache: () => ({ read: async input => { reads++; assert.equal(input, record); afterRead(); return model; } }) },
    './native-crypto.ts': {}, './secure-store.ts': {},
    './workspaces.ts': { readSharingSelection: async () => selection, sharingRegistryDatabase: async () => ({ getFirstAsync: async sql => {
      onQuery(); return sql.includes('SELECT 1') ? rows ? { present: 1 } : null : { group_id: slot };
    } }) },
    '../storage/sharing-registry.ts': { readSharingWorkspace: async () => record, readSharingDisplayCandidate: async () => record },
    '../storage/isolated-transaction.ts': transactions,
  });
  return { module, record, model, reads: () => reads, select: value => { selection = value; }, rows: value => { rows = value; }, query: fn => { onQuery = fn; }, slot: value => { slot = value; }, after: work => { afterRead = work; } };
}
test('startup presentation requires the protected selection and current single membership without initializing Firebase or opening a writable workspace', async () => {
  const f = fixture(); assert.deepEqual(await f.module.readSavedStartupDisplay(), { record: f.record, model: f.model });
  f.slot('another'); assert.equal(await f.module.readSavedStartupDisplay(), undefined); assert.equal(f.reads(), 1);
  f.slot('house'); f.record.status = 'removed'; assert.equal(await f.module.readSavedStartupDisplay(), undefined); assert.equal(f.reads(), 1);
  f.select(null); assert.equal(await f.module.readSavedStartupDisplay(), undefined); assert.equal(f.reads(), 1);
});
test('a logout or account switch during encrypted startup restoration discards the old presentation before it can render', async () => {
  for (const selection of [null, { userId: 'different', groupId: 'house' }, { userId: 'owner', groupId: 'new-house' }]) {
    const f = fixture(); f.after(() => f.select(selection)); assert.equal(await f.module.readSavedStartupDisplay(), undefined);
  }
});
test('a deletion checkpoint adopted while the startup view decrypts prevents old history rendering', async () => {
  const f = fixture(); f.after(() => { f.record.historyRetention = { cutoff: '2026-10-01', throughSequence: 10, digest: 'a'.repeat(64) }; });
  assert.equal(await f.module.readSavedStartupDisplay(), undefined);
});

test('early personal presentation requires no protected selection and no admitted or pending shared workspace from any account', async () => {
  const f = fixture(); assert.equal(await f.module.canShowPersonalStartup(), false);
  f.select(null); assert.equal(await f.module.canShowPersonalStartup(), false);
  f.rows(false); assert.equal(await f.module.canShowPersonalStartup(), true);
  f.query(() => f.select({ userId: 'new-owner', groupId: 'new-house' })); assert.equal(await f.module.canShowPersonalStartup(), false);
  f.select(null); f.query(() => { throw new Error('registry unavailable'); }); assert.equal(await f.module.canShowPersonalStartup(), false);
});

test('historical memberships never delay personal startup while active pending and invalid registry rows remain guarded', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await h.database.execAsync('CREATE TABLE sharing_workspaces(record_json TEXT)');
  const module = loadNativeModule('src/platform/sharing/startup-display.ts', {
    '../../features/planner/startup-display.ts': { createStartupDisplayCache: () => ({}) }, './native-crypto.ts': {}, './secure-store.ts': {},
    './workspaces.ts': { readSharingSelection: async () => null, sharingRegistryDatabase: async () => h.database }, '../storage/sharing-registry.ts': {},
    '../storage/isolated-transaction.ts': transactions,
  });
  for (const status of ['active', 'creating', 'joining', 'left', 'removed', 'invalid', null]) {
    await h.database.runAsync('DELETE FROM sharing_workspaces'); await h.database.runAsync('INSERT INTO sharing_workspaces VALUES(?)', JSON.stringify({ status }));
    assert.equal(await module.canShowPersonalStartup(), ['left', 'removed'].includes(status));
  }
  await h.database.runAsync('INSERT INTO sharing_workspaces VALUES(?)', 'corrupt'); assert.equal(await module.canShowPersonalStartup(), false);
});

test('retention retries purge stale encrypted displays while current-scope writes survive and an older in-flight write is refused', async t => {
  const h = createDatabase(); t.after(() => h.connection.close());
  const record = { userId: 'owner', groupId: 'house', status: 'active', anchor: { groupId: 'house' }, rosterArchive: [],
    historyRetention: { cutoff: '2026-10-01', throughSequence: 10, digest: 'a'.repeat(64) } };
  let writer;
  const module = loadNativeModule('src/platform/sharing/startup-display.ts', {
    '../../features/planner/startup-display.ts': { startupDisplayScope, createStartupDisplayCache: input => { writer = input.write; return {}; } },
    './native-crypto.ts': {}, './secure-store.ts': {},
    './workspaces.ts': { readSharingSelection: async () => ({ userId: 'owner', groupId: 'house' }), sharingRegistryDatabase: async () => h.database },
    '../storage/sharing-registry.ts': { readSharingWorkspace: async () => record, readSharingDisplayCandidate: async () => record }, '../storage/isolated-transaction.ts': transactions,
  });
  const scope = startupDisplayScope(record);
  await writer('owner', 'house', JSON.stringify({ scope }));
  await module.clearSharedStartupDisplay('owner', 'house', scope);
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM sharing_startup_display').get().n, 1);
  await h.database.runAsync('UPDATE sharing_startup_display SET encrypted_json=?', JSON.stringify({ scope: 'older' }));
  await module.clearSharedStartupDisplay('owner', 'house', scope);
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM sharing_startup_display').get().n, 0);
  await writer('owner', 'house', JSON.stringify({ scope: 'older' }));
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM sharing_startup_display').get().n, 0);
});
