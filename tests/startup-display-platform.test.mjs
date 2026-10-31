import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';

function fixture() {
  let selection = { userId: 'owner', groupId: 'house' }; let afterRead = () => {}; let reads = 0; let rows = true; let onQuery = () => {};
  const record = { ...selection, status: 'active' }; let slot = 'house';
  const model = { viewerUserId: 'owner', plan: { groupId: 'house' } };
  const module = loadNativeModule('src/platform/sharing/startup-display.ts', {
    '../../features/planner/startup-display.ts': { createStartupDisplayCache: () => ({ read: async input => { reads++; assert.equal(input, record); afterRead(); return model; } }) },
    './native-crypto.ts': {}, './secure-store.ts': {},
    './workspaces.ts': { readSharingSelection: async () => selection, sharingRegistryDatabase: async () => ({ getFirstAsync: async sql => {
      onQuery(); return sql.includes('SELECT 1') ? rows ? { present: 1 } : null : { group_id: slot };
    } }) },
    '../storage/sharing-registry.ts': { readSharingWorkspace: async () => record },
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
  });
  for (const status of ['active', 'creating', 'joining', 'left', 'removed', 'invalid', null]) {
    await h.database.runAsync('DELETE FROM sharing_workspaces'); await h.database.runAsync('INSERT INTO sharing_workspaces VALUES(?)', JSON.stringify({ status }));
    assert.equal(await module.canShowPersonalStartup(), ['left', 'removed'].includes(status));
  }
  await h.database.runAsync('INSERT INTO sharing_workspaces VALUES(?)', 'corrupt'); assert.equal(await module.canShowPersonalStartup(), false);
});
