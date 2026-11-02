import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import * as rosters from '../src/features/sharing/roster.ts';
import * as operations from '../src/features/sharing/operations.ts';
import * as localDates from '../src/domain/scheduling/local-date.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as registry from '../src/platform/storage/sharing-registry.ts';
async function fixture() {
  const h = createDatabase(); await registry.initializeSharingRegistry(h.database);
  const owner = await createDeviceIdentity(crypto); const anchor = createSharedRoster('group-test', 'owner', owner);
  const record = { userId: 'owner', groupId: 'group-test', displayName: '家族', status: 'active', anchor, rosterArchive: [anchor],
    createdAt: '2026-10-27T00:00:00Z', lastSuccessfulSyncAt: null, lastErrorCode: null };
  return { ...h, owner, record };
}
test('display candidates defer signature work only behind authenticated ciphertext and never populate live authority validation', async t => {
  const h = await fixture(); t.after(() => h.connection.close()); let validations = 0;
  const api = loadNativeModule('src/platform/storage/sharing-registry.ts', {
    '../../features/sharing/operations.ts': operations,
    '../../features/sharing/roster.ts': { ...rosters, validateSharedRoster: value => { validations++; return rosters.validateSharedRoster(value); } },
    '../../domain/scheduling/local-date.ts': localDates,
  });
  await api.saveSharingWorkspace(h.database, h.record); validations = 0;
  const { createStartupDisplayCache } = await import('../src/features/planner/startup-display.ts');
  let saved; const key = await crypto.randomBytes(32);
  const cache = createStartupDisplayCache({ crypto, key: async () => key, read: async () => saved, write: async (_u, _g, value) => { saved = value; }, now: () => new Date('2026-11-02T01:00:00Z') });
  const model = { viewerUserId: 'owner', plan: { groupId: 'group-test', timeZone: 'Asia/Tokyo', range: { asOfDate: '2026-11-02' } } };
  await cache.write(h.record, model);
  const coldConnection = { ...h.database };
  const candidate = await api.readSharingDisplayCandidate(coldConnection, 'owner', 'group-test');
  assert.deepEqual(await cache.read(candidate), model); assert.equal(validations, 0);
  await api.readSharingWorkspace(coldConnection, 'owner', 'group-test'); assert.equal(validations, 1, 'the real session still verifies its roster');
  const forged = structuredClone(h.record); forged.anchor.signature = '00'.repeat(64);
  await h.database.runAsync('UPDATE sharing_workspaces SET record_json=?', JSON.stringify(forged));
  assert.equal(await cache.read(await api.readSharingDisplayCandidate(coldConnection, 'owner', 'group-test')), undefined);
  await assert.rejects(api.readSharingWorkspace(coldConnection, 'owner', 'group-test')); assert.equal(validations, 2);
  const mutated = await api.readSharingDisplayCandidate(coldConnection, 'owner', 'group-test'); mutated.displayName = 'changed by caller';
  assert.equal((await api.readSharingDisplayCandidate(coldConnection, 'owner', 'group-test')).displayName, h.record.displayName);
});

test('unchanged registry bytes reuse validation while every read still checks SQLite and returns isolated current account data', async () => {
  const h = await fixture(); let validations = 0; let reads = 0;
  const api = loadNativeModule('src/platform/storage/sharing-registry.ts', {
    '../../features/sharing/operations.ts': operations,
    '../../features/sharing/roster.ts': { ...rosters, validateSharedRoster: (value) => { validations++; return rosters.validateSharedRoster(value); } },
    '../../domain/scheduling/local-date.ts': localDates,
  });
  const database = { ...h.database, getFirstAsync: async (...args) => { reads++; return h.database.getFirstAsync(...args); } };
  try {
    await registry.saveSharingWorkspace(h.database, h.record);
    const first = await api.readSharingWorkspace(database, 'owner', 'group-test');
    first.status = 'removed'; first.anchor.body.members.length = 0; first.rosterArchive.length = 0;
    for (let i = 0; i < 10; i++) {
      const row = await api.readSharingWorkspace(database, 'owner', 'group-test');
      assert.equal(row.status, 'active'); assert.equal(row.anchor.body.members.length, 1); assert.equal(row.rosterArchive.length, 1);
    }
    assert.equal(reads, 11, 'validation reuse cannot skip a fresh SQLite read');
    assert.equal(validations, 1, 'an identical saved roster need not repeat its signature validation');
    const anotherHandle = { ...database };
    await api.readSharingWorkspace(anotherHandle, 'owner', 'group-test');
    assert.equal(validations, 2, 'verification is scoped to the database handle');
    assert.equal(await api.readSharingWorkspace(database, 'other-account', 'group-test'), null);

    const changed = { ...h.record, status: 'left' };
    await h.database.runAsync('UPDATE sharing_workspaces SET record_json=?', JSON.stringify(changed));
    assert.equal((await api.readSharingWorkspace(database, 'owner', 'group-test')).status, 'left');
    assert.equal(validations, 3, 'a change made by another connection must be validated immediately');
    const tampered = structuredClone(changed); tampered.anchor.signature = '0'.repeat(128);
    await h.database.runAsync('UPDATE sharing_workspaces SET record_json=?', JSON.stringify(tampered));
    await assert.rejects(api.readSharingWorkspace(database, 'owner', 'group-test'));
    await assert.rejects(api.readSharingWorkspace(database, 'owner', 'group-test'), undefined, 'failed validation is never cached');
    const foreign = { ...changed, userId: 'another-account' };
    await h.database.runAsync('UPDATE sharing_workspaces SET record_json=?', JSON.stringify(foreign));
    await assert.rejects(api.readSharingWorkspace(database, 'owner', 'group-test'), /identity/);
    await assert.rejects(api.readSharingWorkspace(database, 'owner', 'group-test'), /identity/);
    await h.database.runAsync('DELETE FROM sharing_workspaces');
    assert.equal(await api.readSharingWorkspace(database, 'owner', 'group-test'), null, 'a prior validation cannot resurrect deleted data');
  } finally { h.connection.close(); }
});

test('an unchanged workspace update performs no SQLite write while real metadata changes still persist behind identity guards', async () => {
  const h = await fixture();
  try {
    await registry.saveSharingWorkspace(h.database, h.record);
    const before = (await h.database.getFirstAsync('SELECT total_changes() AS count')).count;
    await registry.updateSharingWorkspace(h.database, 'owner', 'group-test', row => ({ ...row }));
    assert.equal((await h.database.getFirstAsync('SELECT total_changes() AS count')).count, before);
    await registry.updateSharingWorkspace(h.database, 'owner', 'group-test', row => ({ ...row, displayName: '更新済み' }));
    assert.equal((await registry.readSharingWorkspace(h.database, 'owner', 'group-test')).displayName, '更新済み');
    await assert.rejects(registry.updateSharingWorkspace(h.database, 'owner', 'group-test', row => ({ ...row, userId: 'foreign' })), /identity/);
  } finally { h.connection.close(); }
});

test('confirmed singleton recovery changes only the displayed legacy scope and rejects stale missing or departed targets', async () => {
  const h = await fixture();
  try {
    await registry.saveSharingWorkspace(h.database, h.record);
    const target = { ...h.record, groupId: 'confirmed-group', anchor: createSharedRoster('confirmed-group', 'owner', h.owner) };
    target.rosterArchive = [target.anchor];
    await h.database.runAsync('INSERT INTO sharing_workspaces VALUES (?, ?, ?)', 'owner', target.groupId, JSON.stringify(target));
    const before = await registry.listSharingWorkspaces(h.database, 'owner');
    for (const id of ['unknown', 'group-test']) {
      if (id === 'group-test') continue;
      await assert.rejects(registry.adoptConfirmedSharingWorkspace(h.database, 'owner', 'group-test', id));
    }
    await registry.updateSharingWorkspace(h.database, 'owner', target.groupId, row => ({ ...row, status: 'left' }));
    await assert.rejects(registry.adoptConfirmedSharingWorkspace(h.database, 'owner', 'group-test', target.groupId));
    await h.database.runAsync('UPDATE sharing_workspaces SET record_json=? WHERE user_id=? AND group_id=?', JSON.stringify(target), 'owner', target.groupId);
    await registry.adoptConfirmedSharingWorkspace(h.database, 'owner', 'group-test', target.groupId);
    assert.equal((await registry.readCurrentSharingWorkspace(h.database, 'owner')).groupId, target.groupId);
    assert.deepEqual(await registry.listSharingWorkspaces(h.database, 'owner'), before);
    await assert.rejects(registry.adoptConfirmedSharingWorkspace(h.database, 'owner', 'group-test', target.groupId), /更新/u);
    await assert.rejects(registry.adoptConfirmedSharingWorkspace(h.database, 'other-user', 'group-test', target.groupId));
  } finally { h.connection.close(); }
});

test('workspace registry isolates accounts, preserves trust pins and refuses credentials or secret keys', async () => {
  const h = await fixture();
  try {
    await registry.saveSharingWorkspace(h.database, h.record);
    assert.equal((await registry.listSharingWorkspaces(h.database, 'owner')).length, 1);
    assert.equal((await registry.listSharingWorkspaces(h.database, 'another-account')).length, 0);
    assert.equal(await registry.readSharingWorkspace(h.database, 'another-account', 'group-test'), null);
    const different = createSharedRoster('group-test', 'owner', await createDeviceIdentity(crypto));
    await assert.rejects(registry.saveSharingWorkspace(h.database, { ...h.record, anchor: different }), /pin/);
    await assert.rejects(async () => registry.saveSharingWorkspace(h.database, { ...h.record, accessToken: 'must-not-store' }), /Private/);
    await assert.rejects(async () => registry.saveSharingWorkspace(h.database, { ...h.record, groupKey: 'must-not-store' }), /Private/);
  } finally { h.connection.close(); }
});

test('late sync metadata cannot implicitly rejoin or overwrite another account workspace', async () => {
  const h = await fixture();
  try {
    await registry.saveSharingWorkspace(h.database, h.record);
    await registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, status: 'left' }));
    await registry.saveSharingWorkspace(h.database, h.record);
    await assert.rejects(registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, status: 'active' })), /Explicitly/);
    await assert.rejects(registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => { record.status = 'active'; return record; }), /Explicitly/);
    await assert.rejects(registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, userId: 'another-account' })), /identity/);
    assert.equal((await registry.readSharingWorkspace(h.database, 'owner', 'group-test')).status, 'left');
  } finally { h.connection.close(); }
});

test('a fresh rejoin generation is allowed only after departure and must retain the original local database reference', async () => {
  const h = await fixture();
  try {
    await registry.saveSharingWorkspace(h.database, h.record);
    await assert.rejects(registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, localGeneration: 'replacement', status: 'joining' })), /preserve/);
    await registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, status: 'removed' }));
    await assert.rejects(registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => { record.localGeneration = 'replacement'; record.status = 'joining'; return record; }), /preserve/);
    const joined = await registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, status: 'joining', localGeneration: 'replacement', archivedLocalGenerations: ['initial'] }));
    assert.equal(joined.localGeneration, 'replacement'); assert.deepEqual(joined.archivedLocalGenerations, ['initial']);
    assert.deepEqual(joined.anchor, h.record.anchor);
    await assert.rejects(registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, localGeneration: 'another' })), /preserve/);
  } finally { h.connection.close(); }
});

test('foreground and background registry connections retry a CAS race without losing either update', async () => {
  const base = await fixture(); const path = mkdtempSync(join(tmpdir(), 'liflow-registry-'));
  const a = createDatabase(join(path, 'index.db')); const b = createDatabase(join(path, 'index.db'));
  try {
    await registry.initializeSharingRegistry(a.database); await registry.initializeSharingRegistry(b.database);
    await registry.saveSharingWorkspace(a.database, { ...base.record, lastSuccessfulSyncAt: 0 });
    await Promise.all([a, b].map((h) => registry.updateSharingWorkspace(h.database, 'owner', 'group-test', (record) => ({ ...record, lastSuccessfulSyncAt: record.lastSuccessfulSyncAt + 1 }))));
    assert.equal((await registry.readSharingWorkspace(a.database, 'owner', 'group-test')).lastSuccessfulSyncAt, 2);
  } finally { a.connection.close(); b.connection.close(); base.connection.close(); rmSync(path, { recursive: true }); }
});

for (const status of ['creating', 'joining', 'active']) test(`one ${status} membership blocks a second intent; departure preserves history and releases the slot`, async () => {
  const h = await fixture();
  try {
    const a = { ...h.record, status };
    const anchor = createSharedRoster('group-next', 'owner', h.owner);
    const b = { ...h.record, groupId: 'group-next', anchor, rosterArchive: [anchor], status: 'creating' };
    const results = await Promise.allSettled([registry.saveSharingWorkspace(h.database, a), registry.saveSharingWorkspace(h.database, b)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /一つ/);
    assert.equal((await registry.readCurrentSharingWorkspace(h.database, 'owner')).groupId, a.groupId);
    assert.equal(await registry.readSharingWorkspace(h.database, 'owner', b.groupId), null);
    await registry.updateSharingWorkspace(h.database, 'owner', a.groupId, row => ({ ...row, status: 'left' }));
    assert.equal(await registry.readCurrentSharingWorkspace(h.database, 'owner'), null);
    await registry.saveSharingWorkspace(h.database, b);
    assert.equal((await registry.readCurrentSharingWorkspace(h.database, 'owner')).groupId, b.groupId);
    assert.equal((await registry.readSharingWorkspace(h.database, 'owner', a.groupId)).status, 'left');
  } finally { h.connection.close(); }
});

test('adopting the previously displayed group preserves old QA rows without reopening them after departure', async () => {
  const h = await fixture();
  try {
    const other = createSharedRoster('historical-group', 'owner', h.owner);
    for (const record of [h.record, { ...h.record, groupId: 'historical-group', anchor: other, rosterArchive: [other] }]) {
      await h.database.runAsync('INSERT INTO sharing_workspaces (user_id, group_id, record_json) VALUES (?, ?, ?)', record.userId, record.groupId, JSON.stringify(record));
    }
    await assert.rejects(registry.readCurrentSharingWorkspace(h.database, 'owner'), /保存データは保持/);
    assert.equal((await registry.readCurrentSharingWorkspace(h.database, 'owner', h.record.groupId)).groupId, h.record.groupId);
    await registry.updateSharingWorkspace(h.database, 'owner', h.record.groupId, row => ({ ...row, status: 'left' }));
    assert.equal(await registry.readCurrentSharingWorkspace(h.database, 'owner'), null);
    assert.equal((await registry.listSharingWorkspaces(h.database, 'owner')).length, 2);
    assert.equal((await registry.readSharingWorkspace(h.database, 'owner', 'historical-group')).status, 'active');
  } finally { h.connection.close(); }
});
