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
import * as registry from '../src/platform/storage/sharing-registry.ts';
async function fixture() {
  const h = createDatabase(); await registry.initializeSharingRegistry(h.database);
  const owner = await createDeviceIdentity(crypto); const anchor = createSharedRoster('group-test', 'owner', owner);
  const record = { userId: 'owner', groupId: 'group-test', displayName: '家族', status: 'active', anchor, rosterArchive: [anchor],
    createdAt: '2026-10-27T00:00:00Z', lastSuccessfulSyncAt: null, lastErrorCode: null };
  return { ...h, owner, record };
}

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
