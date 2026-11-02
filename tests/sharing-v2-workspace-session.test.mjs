import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, upgradeSharedRoster } from '../src/features/sharing/roster.ts';
import { createV2WorkspaceSession } from '../src/features/sharing/v2/workspace-session.ts';
import { listSharingOutbox, loadSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';

async function fixture(version = 2) {
  const h = createDatabase(); const identity = await createDeviceIdentity(crypto); const groupId = 'v2-session';
  let archive = [createSharedRoster(groupId, 'owner', identity, { schemaVersion: version })]; let active = true; let commits = 0;
  const record = { groupId, userId: 'owner', displayName: '新しいグループ', status: 'creating', anchor: archive[0], rosterArchive: archive,
    creation: { ownerDisplayName: '自分', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27', wrappedKey: {} } };
  const options = { ...h, groupId, userId: 'owner', householdId: 'group-local', identity, crypto, cloud: {},
    archive: () => archive, readRecord: async () => ({ ...record, rosterArchive: archive }), saveArchive: async (next) => { archive = next; },
    readKey: async () => null, saveKey: async () => {}, serialized: async (work) => work(), changed: () => {},
    assertCurrentAccount: () => { if (!active) throw new Error('account changed'); }, assertWritable: () => {},
    makeId: () => 'session-operation', markLeft: async () => {}, afterCommit: () => { commits++; }, now: () => Date.parse('2026-10-27T01:00:00Z'), creationKind: 'family' };
  return { ...h, options, record, commits: () => commits, stop: () => { active = false; }, upgrade: () => { archive = [...archive, upgradeSharedRoster(archive[0], identity)]; } };
}
test('v2 workspace creation restores one disabled catalog and explicit family or roommate policy without duplicate bootstrap writes', async () => {
  for (const kind of ['family', 'roommates']) {
    const f = await fixture();
    try {
      const session = await createV2WorkspaceSession({ ...f.options, creationKind: kind });
      const model = await session.controller.readModel({ from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' });
      assert.equal(model.plan.policy.kind, kind); assert.equal(model.plan.chores.length, 36);
      assert.ok(model.plan.chores.every((chore) => !chore.enabled)); assert.equal(model.plan.occurrences.length, 0);
      const before = await loadSharedFacts(f.database, 'v2-session'); assert.equal(before.length, 39);
      assert.ok(before.every((fact) => fact.operation.schemaVersion === 2 && fact.authorSignature));
      await createV2WorkspaceSession({ ...f.options, creationKind: kind, now: () => Date.parse('2026-10-28T01:00:00Z') });
      assert.deepEqual(await loadSharedFacts(f.database, 'v2-session'), before);
      assert.equal((await listSharingOutbox(f.database, 'v2-session')).length, 39);
      assert.equal(f.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { f.connection.close(); }
  }
});
test('a workspace factory refuses v1, unresolved protocol and unsigned format substitution before initializing any tables', async () => {
  for (const mode of ['v1', 'waiting', 'forged']) {
    const f = await fixture(mode === 'v1' ? 1 : 2);
    try {
      if (mode === 'waiting') { const first = f.record.anchor; f.record.anchor = { groupId: 'v2-session', digest: 'a'.repeat(64), revision: 1, ownerUserId: 'owner', ownerIdentity: first.signer }; f.record.status = 'joining'; }
      if (mode === 'forged') f.record.anchor = { ...f.record.anchor, body: { ...f.record.anchor.body, schemaVersion: 1 } };
      await assert.rejects(createV2WorkspaceSession({ ...f.options, readRecord: async () => ({ ...f.record, rosterArchive: mode === 'waiting' ? [] : [f.record.anchor] }) }));
      assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
    } finally { f.connection.close(); }
  }
});
test('a signed v1 to v2 membership transition cannot initialize a database without verified business migration evidence', async () => {
  const f = await fixture(1); f.upgrade();
  try {
    await assert.rejects(createV2WorkspaceSession(f.options), { code: 'sharing/v2-migration-required' });
    assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  } finally { f.connection.close(); }
});
test('workspace account identity and a missing creation kind are checked before any database schema change', async () => {
  for (const mode of ['account', 'scope', 'kind', 'left']) {
    const f = await fixture();
    try {
      const options = { ...f.options };
      if (mode === 'account') options.readRecord = async () => { f.stop(); return f.record; };
      if (mode === 'scope') options.userId = 'another-account';
      if (mode === 'kind') delete options.creationKind;
      if (mode === 'left') f.record.status = 'left';
      await assert.rejects(createV2WorkspaceSession(options));
      assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
    } finally { f.connection.close(); }
  }
});
test('v2 workspace reads and edits stop after an account change while committed events and outbox remain intact', async () => {
  const f = await fixture();
  try {
    const session = await createV2WorkspaceSession(f.options); const before = await loadSharedFacts(f.database, 'v2-session'); f.stop();
    await assert.rejects(session.repository.readState(), /account changed/u);
    await assert.rejects(session.repository.commit([{ operationId: 'never-saved', entityType: 'chore', entityId: 'new', operationType: 'patch', payload: { name: '変更' } }]), /account changed/u);
    await assert.rejects(async () => session.synchronizer.verifyMembership(f.record.anchor), /account changed/u);
    assert.deepEqual(await loadSharedFacts(f.database, 'v2-session'), before);
    assert.equal((await listSharingOutbox(f.database, 'v2-session')).length, 39);
  } finally { f.connection.close(); }
});
test('an empty authenticated commit does not announce another local edit or schedule an endless synchronization loop', async () => {
  const f = await fixture();
  try {
    const session = await createV2WorkspaceSession(f.options); const notifications = f.commits();
    assert.deepEqual(await session.repository.commitCurrent(async () => []), []);
    assert.equal(f.commits(), notifications);
    assert.equal((await listSharingOutbox(f.database, 'v2-session')).length, 39);
  } finally { f.connection.close(); }
});

test('a retained permission failure defers catalog writes without blocking authenticated local calendar reads', async () => {
  const f = await fixture();
  try {
    const session = await createV2WorkspaceSession(f.options);
    await f.database.runAsync('DELETE FROM sharing_v2_catalog_state');
    f.record.lastErrorCode = 'permission-denied';
    const before = await loadSharedFacts(f.database, 'v2-session');
    const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
    const model = await session.controller.readModel(range);
    assert.equal(model.plan.chores.length, 36); assert.equal((await session.controller.readCalendar()).groupId, 'v2-session');
    await assert.rejects(session.controller.actions.addChore('blocked write'), /参加状態/u);
    assert.deepEqual(await loadSharedFacts(f.database, 'v2-session'), before);
    f.record.lastErrorCode = null; await session.controller.readModel(range);
    assert.ok(await f.database.getFirstAsync('SELECT catalog_version FROM sharing_v2_catalog_state'));
    f.stop(); await assert.rejects(session.controller.readModel(range), /account changed/u);
  } finally { f.connection.close(); }
});
test('a mistakenly supplied personal database is rejected without changing any existing table or row', async () => {
  const f = await fixture(); const dump = () => JSON.stringify(f.connection.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all());
  try {
    await migrateLocalDatabase(f.database); const before = dump(); const userVersion = f.connection.prepare('PRAGMA user_version').get().user_version;
    await assert.rejects(createV2WorkspaceSession(f.options));
    assert.equal(dump(), before); assert.equal(f.connection.prepare('PRAGMA user_version').get().user_version, userVersion);
    assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sharing_v2_binding'").get().n, 0);
  } finally { f.connection.close(); }
});
