import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { legacyMigrationFixture } from './helpers/sharing-v2-legacy-fixture.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createLiveLegacyMigration, verifyKnownLegacyHistory, legacyMigrationDatabaseGeneration, v2WorkspaceDatabaseGeneration } from '../src/features/sharing/v2/live-legacy-migration.ts';
import { createV2WorkspaceSession } from '../src/features/sharing/v2/workspace-session.ts';
import { openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { sharedAuthorIdentity, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { initializeSharingLedger, applySharingSnapshot, loadSharedFacts, readSharingCheckpoint, loadSharedReplica } from '../src/platform/storage/sharing-ledger.ts';
import { createLegacyHouseholdChoreDefinitionsV3 } from '../src/domain/chores/catalog-v3.ts';
import { sharedPatchFromDefinition } from '../src/features/sharing/planning.ts';

async function fixture(withBuiltIn = false) {
  const f = await legacyMigrationFixture();
  Object.assign(f.operations[0].payload, { anchorDate: '2026-10-01' });
  Object.assign(f.operations[1].payload, { windowRadiusDays: 2, frequencyDaysByMode: { frequent: 3, balanced: 7, relaxed: 14 }, load: 'normal' });
  if (withBuiltIn) {
    const bath = createLegacyHouseholdChoreDefinitionsV3('shared-v2').find(chore => chore.id === 'builtin-chore-01');
    f.operations.push(f.op('legacy-bath', f.owner, 'owner', 6, 8, { [f.owner.deviceId]: 5, [f.member.deviceId]: 2 },
      'chore', `${f.groupId}.${bath.id}`, sharedPatchFromDefinition(bath)));
  }
  const encrypted = await f.make();
  const source = createDatabase(), target = createDatabase();
  await initializeSharingLedger(source.database);
  const opened = await openEncryptedSharedSnapshot(crypto, encrypted, f.key, f.roster,
    (user, device, version) => sharedAuthorIdentity(f.archive[version - 1], user, device, version));
  await applySharingSnapshot(source.database, f.groupId, opened, async () => {}, null);
  let archive = f.archive, current = f.roster, pin, activated = 0, prepared, loseResponse = false, account = true, mutations = 0;
  const keys = new Map([[f.roster.body.keyVersion, f.key.slice()]]), vault = new Map();
  const record = { userId: 'owner', groupId: f.groupId, status: 'active', displayName: '旧グループ', anchor: f.archive[0], get rosterArchive() { return archive; }, get v2Migration() { return pin; } };
  const deps = { database: source.database, groupId: f.groupId, userId: 'owner', identity: f.owner, crypto,
    project: async () => {}, serialized: work => work(), changed() {}, readRecord: async () => record,
    saveArchive: async value => { archive = value; }, archive: () => archive, makeId: () => 'live-test', now: () => Date.parse('2026-10-30T02:00:00Z'),
    catchUp: async () => {}, assertAccess() { if (!account) throw new Error('account changed'); },
    readKey: async version => keys.get(version)?.slice() ?? null, saveKey: async (version, value) => keys.set(version, value.slice()),
    readPreparedKey: async id => vault.get(id)?.slice() ?? null, savePreparedKey: async (id, value) => vault.set(id, value.slice()),
    openTarget: async () => ({ ...target.database, closeAsync: async () => {} }),
    activate: async (value, migration) => { archive = value; pin = migration; activated++; },
    cloud: {
      readGroup: async () => ({ roster: current, group: { headSequence: f.operations.length, rotationRequired: false } }),
      prepareSnapshot: async snapshot => { prepared = snapshot; },
      commitMembership: async (previous, next, envelopes, sequence, manifest) => {
        assert.equal(sharedRosterDigest(previous), sharedRosterDigest(current)); assert.equal(sequence, f.operations.length);
        assert.equal(envelopes.length, 2); assert.deepEqual(manifest, prepared.manifest); current = next; mutations++;
        if (loseResponse) throw new Error('response lost');
      },
    },
  };
  return { ...f, source, target, deps, record, encrypted, opened,
    runtime: () => createLiveLegacyMigration(deps), targetSnapshot: () => prepared,
    loseResponse: () => { loseResponse = true; }, stopAccount: () => { account = false; }, activated: () => activated, mutations: () => mutations,
    targetRoster: () => current, keys, vault,
    close() { source.connection.close(); target.connection.close(); } };
}

test('live v1 to v2 migration retains every signed setting completion undo and private source row before activating the reviewed target', async () => {
  const f = await fixture();
  try {
    const before = canonicalJson(await loadSharedReplica(f.source.database, f.groupId));
    const runtime = f.runtime(); const review = await runtime.prepare('family');
    assert.equal(review.chores[0].name, '共有の床'); assert.equal(review.chores[0].intervalDays, 7); assert.equal(review.chores[0].assignees, 1);
    assert.equal(f.mutations(), 0); assert.equal(f.activated(), 0);
    await runtime.commit(review.id);
    assert.equal(f.mutations(), 1); assert.equal(f.activated(), 1); assert.equal(f.record.rosterArchive.at(-1).body.schemaVersion, 2);
    assert.equal(canonicalJson(await loadSharedReplica(f.source.database, f.groupId)), before);
    const staged = await loadSharedFacts(f.target.database, f.groupId);
    assert.deepEqual(staged.filter(value => value.operation.schemaVersion === 1), f.opened.facts);
    assert.ok(staged.some(value => value.operation.entityType === 'migration'));
    assert.ok((await readSharingCheckpoint(f.target.database, f.groupId)).pendingCount > 0, 'new settings wait for actual cloud receipts');
    assert.equal(f.targetSnapshot().manifest.body.throughSequence, f.operations.length);
    assert.equal(f.targetSnapshot().manifest.body.factCount, f.operations.length, 'unreceipted new settings are not presented as published history');
    assert.equal(f.source.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(f.target.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { f.close(); }
});

test('a verified migrated owner refreshes the original built-in ID without changing legacy completion history or applying the catalog twice', async () => {
  const f = await fixture(true);
  try {
    const review = await f.runtime().prepare('family'); await f.runtime().commit(review.id);
    const before = await loadSharedFacts(f.target.database, f.groupId); let n = 0;
    const session = await createV2WorkspaceSession({ ...f.deps, database: f.target.database, householdId: 'shared-v2', archive: () => f.record.rosterArchive,
      makeId: () => `migrated-catalog-${++n}`, assertCurrentAccount: f.deps.assertAccess, assertWritable: () => {}, markLeft: async () => {},
      pinMigration: async () => {}, verifyMigrationHistory: snapshot => verifyKnownLegacyHistory(f.source.database, f.groupId, snapshot) });
    const range = { from: '2026-11-01', through: '2026-11-30', asOfDate: '2026-11-01' };
    await session.controller.readModel(range);
    const state = await session.repository.readState();
    const bath = state.replica.entities.find(row => row.entityId === `${f.groupId}.builtin-chore-01`);
    assert.equal(bath.fields.name, '浴室掃除'); assert.equal(bath.fields.estimatedMinutes, 25);
    assert.equal(state.assessment.rejected.length, 0);
    const after = await loadSharedFacts(f.target.database, f.groupId);
    assert.deepEqual(after.filter(fact => fact.operation.schemaVersion === 1), before.filter(fact => fact.operation.schemaVersion === 1));
    assert.ok(after.length > before.length);
    await session.controller.readModel(range); assert.deepEqual(await loadSharedFacts(f.target.database, f.groupId), after);
  } finally { f.close(); }
});

test('migration resumes a lost atomic cloud response and cold SQLite staging without rotating twice or duplicating drafts', async () => {
  const f = await fixture();
  try {
    const review = await f.runtime().prepare('roommates'); f.loseResponse();
    await assert.rejects(f.runtime().commit(review.id), /response lost/u); assert.equal(f.activated(), 0); assert.equal(f.mutations(), 1);
    const before = await loadSharedFacts(f.target.database, f.groupId);
    const resumed = f.runtime(); assert.equal((await resumed.resumeReview()).id, review.id);
    await resumed.commit(review.id);
    assert.equal(f.mutations(), 1); assert.equal(f.activated(), 1); assert.deepEqual(await loadSharedFacts(f.target.database, f.groupId), before);
  } finally { f.close(); }
});

test('a stale migration review or changed account preserves the source without publishing or activating it', async () => {
  for (const scenario of ['clock', 'account', 'changed-head']) {
    const f = await fixture();
    try {
      const review = await f.runtime().prepare('family');
      if (scenario === 'clock') f.deps.now = () => Date.parse('2026-11-02T02:00:00Z');
      if (scenario === 'account') f.stopAccount();
      if (scenario === 'changed-head') f.deps.cloud.readGroup = async () => ({ roster: f.roster, group: { headSequence: 100, rotationRequired: false } });
      await assert.rejects(f.runtime().commit(review.id)); assert.equal(f.mutations(), 0); assert.equal(f.activated(), 0);
      assert.deepEqual((await loadSharedReplica(f.source.database, f.groupId)).operations, f.opened.base.operations);
    } finally { f.close(); }
  }
});

test('receivers refuse omitted accepted legacy history and pending offline edits while preserving both databases', async () => {
  const f = await fixture();
  try {
    await verifyKnownLegacyHistory(f.source.database, f.groupId, f.opened);
    const omitted = structuredClone(f.opened); omitted.base.operationIndex.pop();
    await assert.rejects(verifyKnownLegacyHistory(f.source.database, f.groupId, omitted));
    const fact = f.opened.facts[0]; await f.source.database.runAsync('INSERT INTO sharing_operations VALUES (?,?,?,?,?,?,?)', fact.operation.operationId, f.groupId,
      fact.operation.authorDeviceId, fact.operation.deviceSequence, fact.operation.logicalClock, canonicalJson(fact.operation), fact.authorSignature);
    await f.source.database.runAsync('INSERT INTO sharing_outbox (operation_id) VALUES (?)', fact.operation.operationId);
    await assert.rejects(verifyKnownLegacyHistory(f.source.database, f.groupId, f.opened), /未送信/u);
    assert.equal((await readSharingCheckpoint(f.source.database, f.groupId)).pendingCount, 1);
  } finally { f.close(); }
});

test('a cold migrated v2 session reauthenticates its preserved witness and signed source before allowing business edits', async () => {
  const f = await fixture();
  try {
    const review = await f.runtime().prepare('family'); await f.runtime().commit(review.id);
    const before = await loadSharedFacts(f.target.database, f.groupId);
    const session = await createV2WorkspaceSession({ ...f.deps, database: f.target.database, householdId: 'shared-v2', archive: () => f.record.rosterArchive,
      assertCurrentAccount: f.deps.assertAccess, assertWritable: () => {}, markLeft: async () => {}, pinMigration: async pin => {
        assert.equal(pin.sourceSnapshotDigest, f.record.v2Migration.sourceSnapshotDigest);
      }, verifyMigrationHistory: snapshot => verifyKnownLegacyHistory(f.source.database, f.groupId, snapshot) });
    const state = await session.repository.readState(); assert.equal(state.assessment.rejected.length, 0);
    assert.deepEqual(await loadSharedFacts(f.target.database, f.groupId), before);
    f.record.v2Migration.sourceSnapshotDigest = '0'.repeat(64);
    await assert.rejects(createV2WorkspaceSession({ ...f.deps, database: f.target.database, householdId: 'shared-v2', archive: () => f.record.rosterArchive,
      assertCurrentAccount: f.deps.assertAccess, assertWritable: () => {}, markLeft: async () => {}, pinMigration: async () => {} }), { code: 'sharing/v2-migration-unverified' });
  } finally { f.close(); }
});


test('migrated workspace rejoining uses a fresh database generation without changing its original approved migration source', async () => {
  const f = await fixture();
  try {
    const first = legacyMigrationDatabaseGeneration(f.next);
    const rejoined = legacyMigrationDatabaseGeneration(f.next, 'new-approved-device');
    assert.notEqual(first, rejoined); assert.notEqual(rejoined, legacyMigrationDatabaseGeneration(f.next, 'another-approved-device'));
    const review = await f.runtime().prepare('family'); await f.runtime().commit(review.id);
    assert.equal(f.record.v2Migration.databaseGeneration, first);
  } finally { f.close(); }
});


test('cold converted workspaces keep a previously pinned database even when its member has a rejoin identity generation', async () => {
  const f = await fixture();
  try {
    const archive = [...f.archive, f.next]; const previous = legacyMigrationDatabaseGeneration(f.next);
    const record = { localGeneration: 'already-approved-member', v2Migration: { databaseGeneration: previous, sourceSnapshotDigest: 'a'.repeat(64), witnessDigest: 'b'.repeat(64) } };
    assert.equal(v2WorkspaceDatabaseGeneration(record, archive), previous);
    assert.notEqual(v2WorkspaceDatabaseGeneration({ localGeneration: 'newly-approved-member' }, archive), previous);
  } finally { f.close(); }
});
