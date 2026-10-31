import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, removeSharedMember, upgradeSharedRoster, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { verifyLegacyMigrationSource, readVerifiedLegacyMigrationSource, assertVerifiedLegacyMigration } from '../src/features/sharing/v2/legacy-migration-source.ts';
import { previewLegacyMigration } from '../src/features/sharing/v2/legacy-migration-preview.ts';
import { assessV2BusinessHistory } from '../src/features/sharing/v2/receiver-authority.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { applySharingSnapshot, loadSharedReplica, listSharingOutbox, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';

import { legacyMigrationFixture as fixture } from './helpers/sharing-v2-legacy-fixture.mjs';

test('v2 legacy preview preserves original performer recorder and targeted undo without inventing prior assignment or recording time', async () => {
  const h = await fixture(); const before = canonicalJson(h.input.encrypted); const key = [...h.key];
  const checkpoint = await verifyLegacyMigrationSource(h.input); const preview = previewLegacyMigration(checkpoint, { userId: 'owner', kind: 'roommates' });
  assert.equal(preview.mode, 'previewOnly'); assert.equal(preview.mayActivate, false); assert.equal(preview.selectedPolicy.kind, 'roommates');
  const undone = preview.legacyCompletions.find(row => row.operationId === 'member-completion');
  assert.equal(undone.performedByUserId, 'owner'); assert.equal(undone.recordedByUserId, 'member'); assert.equal(undone.recordedAt, null);
  assert.equal(undone.originalAssigneeIds, null); assert.equal(undone.active, false); assert.deepEqual(undone.undoOperationIds, ['member-undo']);
  const independent = preview.legacyCompletions.find(row => row.operationId === 'owner-completion');
  assert.equal(independent.active, true); assert.equal(independent.performedByUserId, null, 'the author does not prove who actually performed old work');
  assert.ok(preview.requiredReview.includes('privateGoogleMappingAliases')); assert.equal(preview.devices.length, 2);
  assert.ok(preview.devices.every(device => device.protocolSupport === 'unconfirmed'));
  assert.equal(canonicalJson(h.input.encrypted), before); assert.deepEqual([...h.key], key);
  const replica = readVerifiedLegacyMigrationSource(checkpoint).replica;
  assertVerifiedLegacyMigration(checkpoint, replica, [...h.archive, h.next]);
  assert.equal(assessV2BusinessHistory(replica, [...h.archive, h.next], checkpoint).rejected.length, 0);
});

test('v2 migration rejects a structural or deserialized checkpoint before legacy authority can be admitted', async () => {
  const h = await fixture(); const checkpoint = await verifyLegacyMigrationSource(h.input); const replica = readVerifiedLegacyMigrationSource(checkpoint).replica;
  for (const forged of [{ sourceSnapshotDigest: h.input.expectedSnapshotDigest, frontier: replica.frontier }, { ...checkpoint }, JSON.parse(JSON.stringify(checkpoint)), null]) {
    assert.throws(() => assessV2BusinessHistory(replica, [...h.archive, h.next], forged), { code: 'sharing/v2-migration-unverified' });
    assert.throws(() => previewLegacyMigration(forged, { userId: 'owner', kind: 'family' }), { code: 'sharing/v2-migration-unverified' });
  }
  assert.ok(Object.isFrozen(checkpoint)); assert.ok(Object.isFrozen(checkpoint.frontier));
});

test('v2 legacy verification rejects changed protected positions pending edits bad keys ciphertext and unsupported source epochs', async () => {
  const h = await fixture();
  for (const changes of [{ expectedSnapshotDigest: '0'.repeat(64) }, { expectedThroughSequence: 1 }, { pendingLocalOperationIds: ['unsent'] },
    { key: new Uint8Array(32) }, { archive: [...h.archive, h.next] }, { expectedThroughSequence: NaN }]) {
    await assert.rejects(verifyLegacyMigrationSource({ ...h.input, ...changes }));
  }
  const changed = structuredClone(h.input.encrypted); changed.chunks[0].ciphertext = 'AA';
  await assert.rejects(verifyLegacyMigrationSource({ ...h.input, encrypted: changed }));
  const other = createSharedRoster('different-group', 'owner', h.owner);
  await assert.rejects(verifyLegacyMigrationSource({ ...h.input, anchor: other }));
});

test('v2 verified migration binds every compacted receipt and retained source fact to the exact protocol transition', async () => {
  const h = await fixture(); const checkpoint = await verifyLegacyMigrationSource(h.input); const { replica } = readVerifiedLegacyMigrationSource(checkpoint);
  const archive = [...h.archive, h.next]; const clone = () => structuredClone(replica);
  for (const change of [value => { value.operationIndex.pop(); }, value => { value.operations.pop(); },
    value => { value.operationIndex[0].digest = '0'.repeat(64); }, value => { value.groupId = 'different-group'; },
    value => { value.operations.find(op => op.entityType === 'chore').payload.name = '書換え'; }]) {
    const bad = clone(); change(bad); assert.throws(() => assertVerifiedLegacyMigration(checkpoint, bad, archive), { code: 'sharing/v2-migration-unverified' });
  }
  assert.throws(() => assertVerifiedLegacyMigration(checkpoint, replica, h.archive));
  const another = approveSharedDevice(h.roster, h.owner, 'later', await createDeviceIdentity(crypto));
  assert.throws(() => assertVerifiedLegacyMigration(checkpoint, replica, [...h.archive, another, upgradeSharedRoster(another, h.owner)]));
  assertVerifiedLegacyMigration(checkpoint, replica, archive);
});

test('v2 legacy verification captures encrypted source roster and key before asynchronous decryption', async () => {
  const h = await fixture(); const sourceName = h.input.encrypted.manifest.body.snapshotId;
  let changed = false; const delayed = { ...crypto, async decrypt(...args) {
    if (!changed) { changed = true; h.input.encrypted.manifest.body.snapshotId = 'changed-after-await'; h.archive.at(-1).body.ownerUserId = 'attacker'; h.key.fill(0); }
    return crypto.decrypt(...args);
  } };
  const checkpoint = await verifyLegacyMigrationSource({ ...h.input, crypto: delayed });
  const detached = readVerifiedLegacyMigrationSource(checkpoint); assert.equal(detached.snapshotId, sourceName); assert.equal(detached.roster.body.ownerUserId, 'owner');
  detached.replica.operations[0].payload.name = '変更'; detached.roster.body.ownerUserId = '別人';
  assert.equal(readVerifiedLegacyMigrationSource(checkpoint).roster.body.ownerUserId, 'owner');
  assert.notEqual(readVerifiedLegacyMigrationSource(checkpoint).replica.operations[0].payload.name, '変更');
});

test('v2 legacy preview exposes concurrent settings instead of picking a winner or silently enabling conversion', async () => {
  const h = await fixture(); const independent = h.op('parallel-name', h.member, 'member', 1, 1, {}, 'chore', 'floor', { name: '並行した名前' });
  // A separate source contains the concurrent edit, without the old member sequence being reused.
  const values = [...h.operations.slice(0, 4), independent]; const encrypted = await h.make(values, 'conflicted-source');
  const checkpoint = await verifyLegacyMigrationSource({ ...h.input, encrypted, expectedSnapshotDigest: sharedDocumentDigest(encrypted.manifest), expectedThroughSequence: values.length });
  const preview = previewLegacyMigration(checkpoint, { userId: 'owner', kind: 'family' });
  assert.ok(preview.unresolvedFields.some(item => item.entityId === 'floor' && item.fields.includes('name'))); assert.equal(preview.mayActivate, false);
  assert.throws(() => previewLegacyMigration(checkpoint, { userId: 'member', kind: 'family' }));
  assert.throws(() => previewLegacyMigration(checkpoint, { userId: 'owner', kind: 'unknown' }));
});

test('v2 legacy migration retains more than four thousand compacted receipts in a detached preview', async () => {
  const h = await fixture(); const values = Array.from({ length: 4100 }, (_, index) => h.op(`long-${index}`, h.owner, 'owner', index + 1, index + 1,
    index ? { [h.owner.deviceId]: index } : {}, 'chore', 'floor', { name: `名前 ${index}` }));
  const encrypted = await h.make(values, 'long-source');
  const checkpoint = await verifyLegacyMigrationSource({ ...h.input, encrypted, expectedSnapshotDigest: sharedDocumentDigest(encrypted.manifest), expectedThroughSequence: values.length });
  const source = readVerifiedLegacyMigrationSource(checkpoint); assert.equal(source.replica.operationIndex.length, 4100);
  assert.equal(previewLegacyMigration(checkpoint, { userId: 'owner', kind: 'family' }).entities[0].fields.name, '名前 4099');
  assertVerifiedLegacyMigration(checkpoint, source.replica, [...h.archive, h.next]);
});

test('v2 legacy source authenticates former member facts at their original membership epoch after key rotation', async () => {
  const h = await fixture(); const roster = removeSharedMember(h.roster, h.owner, 'member'); const archive = [...h.archive, roster];
  const key = await crypto.randomBytes(32); const replica = buildSharedReplica(h.groupId, h.operations);
  const facts = h.operations.map(op => signSharedOperation(op, op.authorDeviceId === h.owner.deviceId ? h.owner : h.member));
  const encrypted = await createEncryptedSharedSnapshot(crypto, replica, facts, roster, h.owner, key, 'after-removal', h.operations.length,
    (user, device, version) => sharedAuthorIdentity(archive[version - 1], user, device, version));
  const checkpoint = await verifyLegacyMigrationSource({ ...h.input, encrypted, key, archive,
    expectedSnapshotDigest: sharedDocumentDigest(encrypted.manifest) });
  const preview = previewLegacyMigration(checkpoint, { userId: 'owner', kind: 'family' });
  assert.equal(preview.devices.length, 1); assert.ok(preview.legacyCompletions.some(row => row.recordedByUserId === 'member'));
  assertVerifiedLegacyMigration(checkpoint, readVerifiedLegacyMigrationSource(checkpoint).replica, [...archive, upgradeSharedRoster(roster, h.owner)]);
});

test('v2 SQLite staging rolls back a forged migration checkpoint and retains every original legacy proof with a verified source', async () => {
  const h = await fixture(); const target = createDatabase(); const encryptedBefore = canonicalJson(h.input.encrypted);
  const checkpoint = await verifyLegacyMigrationSource(h.input); const archive = [...h.archive, h.next];
  const opened = await openEncryptedSharedSnapshot(crypto, h.input.encrypted, h.key, h.roster,
    (user, device, version) => sharedAuthorIdentity(h.archive[version - 1], user, device, version));
  const scope = { userId: 'owner', groupId: h.groupId, householdId: 'shared-household' };
  const dump = () => target.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, target.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
  try {
    await initializeV2EventStore(target.database, scope); const before = dump();
    let permitted = true;
    const options = { ...scope, identity: h.owner, anchor: h.archive[0], archive: () => archive, assertWritable: () => {},
      verifyCurrentAccess: async () => { if (!permitted) throw new Error('access revoked'); } };
    const forged = createV2EventRepository(target.database, { ...options, migration: { ...checkpoint } });
    await assert.rejects(applySharingSnapshot(target.database, h.groupId, opened, forged.project, null), { code: 'sharing/v2-migration-unverified' });
    assert.deepEqual(dump(), before); assert.equal((await readSharingCheckpoint(target.database, h.groupId)).cursor, null);
    const verified = createV2EventRepository(target.database, { ...options, migration: checkpoint });
    await applySharingSnapshot(target.database, h.groupId, opened, verified.project, null);
    const restored = await loadSharedReplica(target.database, h.groupId);
    assert.deepEqual(restored.operations, readVerifiedLegacyMigrationSource(checkpoint).replica.operations);
    assert.deepEqual(restored.operationIndex, opened.base.operationIndex); assert.deepEqual(await listSharingOutbox(target.database, h.groupId), []);
    assert.equal(target.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(canonicalJson(h.input.encrypted), encryptedBefore);
    await verified.readState();
    const saved = target.connection.prepare('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id=?').get(h.groupId).snapshot_json;
    const tampered = JSON.parse(saved); tampered.facts[0].authorSignature = '0'.repeat(128);
    target.connection.prepare('UPDATE sharing_snapshot_state SET snapshot_json=? WHERE group_id=?').run(JSON.stringify(tampered), h.groupId);
    await assert.rejects(verified.readState(), /signature authentication failed/u,
      'reusing a verified migration proof must still authenticate a different stored signature');
    target.connection.prepare('UPDATE sharing_snapshot_state SET snapshot_json=? WHERE group_id=?').run(saved, h.groupId);
    await verified.readState();
    permitted = false;
    await assert.rejects(verified.readState(), /access revoked/u, 'a verified proof is never current membership authorization');
  } finally { target.connection.close(); }
});

test('v2 compaction after a new edit retains the verified legacy source facts and their original signatures', async () => {
  const h = await fixture(); const checkpoint = await verifyLegacyMigrationSource(h.input); const source = readVerifiedLegacyMigrationSource(checkpoint);
  const archive = [...h.archive, h.next]; const operation = { schemaVersion: 2, operationId: 'new-v2-name', groupId: h.groupId,
    recordedAt: '2026-10-29T00:00:00Z', receiptContext: source.replica.frontier, context: source.replica.frontier,
    authorUserId: 'owner', authorDeviceId: h.owner.deviceId, deviceSequence: 6, logicalClock: 8, keyVersion: 3,
    entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: 'v2で変更した名前', enabled: true, userIntervalDays: 14 } };
  const replica = buildSharedReplica(h.groupId, [operation], { ...source.replica, operations: source.replica.operations });
  const facts = h.operations.map(op => signSharedOperation(op, op.authorDeviceId === h.owner.deviceId ? h.owner : h.member));
  facts.push(signSharedOperation(operation, h.owner)); const key = await crypto.randomBytes(32);
  const author = (user, device, version) => sharedAuthorIdentity(archive[version - 1], user, device, version);
  const encrypted = await createEncryptedSharedSnapshot(crypto, replica, facts, h.next, h.owner, key, 'after-v2-edit', 8, author);
  const opened = await openEncryptedSharedSnapshot(crypto, encrypted, key, h.next, author);
  const restored = buildSharedReplica(h.groupId, [], opened.base);
  assertVerifiedLegacyMigration(checkpoint, restored, archive);
  assert.equal(restored.entities.find(row => row.entityType === 'chore').fields.name, 'v2で変更した名前');
  for (const fact of source.replica.operations) assert.ok(opened.facts.some(row => row.operation.operationId === fact.operationId));
});
