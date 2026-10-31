import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import * as ledger from '../src/platform/storage/sharing-ledger.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, encryptSharedOperation, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';

function operation(i = 1) { return { schemaVersion: 1, operationId: `op-${i}`, groupId: 'group-test', authorUserId: 'user-a',
  authorDeviceId: 'device-a', deviceSequence: i, logicalClock: i, context: i > 1 ? { 'device-a': i - 1 } : {},
  keyVersion: 1, entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: `床掃除${i}` } }; }

async function fixture() {
  const h = createDatabase(); await ledger.initializeSharingLedger(h.database);
  h.connection.exec('CREATE TABLE ui_state (name TEXT)'); return h;
}
const noProjection = async () => {};

test('an outbox predecessor in backoff prevents later local changes from bypassing its causal position', async () => {
  const h = await fixture();
  try {
    for (let index = 1; index <= 3; index++) await ledger.commitLocalSharedOperation(h.database, operation(index), noProjection);
    await ledger.deferSharingUpload(h.database, 'op-1', 1000, 0.5);
    assert.equal((await ledger.listSharingOutbox(h.database, 'group-test', 1000)).length, 0);
    assert.equal((await ledger.listSharingOutbox(h.database, 'group-test', 100000)).length, 3);
  } finally { h.connection.close(); }
});

test('authenticated echoes acknowledge a lost upload response while retaining the original author proof', async () => {
  const h = await fixture(); const identity = await createDeviceIdentity(crypto);
  try {
    const author = { groupId: 'group-test', userId: 'user-a', deviceId: identity.deviceId, keyVersion: 1 };
    const op = await ledger.createLocalSharedOperation(h.database, author, { operationId: 'proof-edit', entityType: 'chore',
      entityId: 'floor', operationType: 'patch', payload: { name: '床' } }, noProjection, (value) => signSharedOperation(value, identity).authorSignature);
    const fact = signSharedOperation(op, identity);
    assert.equal((await ledger.readSharingCheckpoint(h.database, 'group-test')).pendingCount, 1);
    await ledger.applyReceivedSharedFacts(h.database, 'group-test', [fact], '1', noProjection, null);
    assert.equal((await ledger.readSharingCheckpoint(h.database, 'group-test')).pendingCount, 0);
    assert.deepEqual(await ledger.loadSharedFacts(h.database, 'group-test'), [fact]);
    await assert.rejects(ledger.applyReceivedSharedFacts(h.database, 'group-test', [fact], '2', noProjection, null), /position changed/);
    assert.equal((await ledger.readSharingCheckpoint(h.database, 'group-test')).sequence, 1);
  } finally { h.connection.close(); }
});

test('applying an authenticated snapshot atomically preserves unpublished edits, proof history and the next device sequence', async () => {
  const h = await fixture(); const identity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  try {
    const author = { groupId: 'group-test', userId: 'user-a', deviceId: identity.deviceId, keyVersion: 1 };
    const sign = (value) => signSharedOperation(value, identity).authorSignature;
    const draft = (id, name) => ({ operationId: id, entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name } });
    const first = await ledger.createLocalSharedOperation(h.database, author, draft('first', '同期済み'), noProjection, sign);
    await ledger.applyReceivedSharedFacts(h.database, 'group-test', [signSharedOperation(first, identity)], '1', noProjection, null);
    await ledger.createLocalSharedOperation(h.database, author, draft('offline', '未送信'), noProjection, sign);
    const roster = createSharedRoster('group-test', 'user-a', identity);
    const pack = await createEncryptedSharedSnapshot(crypto, await ledger.loadPublishedSharedReplica(h.database, 'group-test'),
      await ledger.loadSharedFacts(h.database, 'group-test'), roster, identity, key, 'ledger-snapshot', 1, () => identity);
    const snapshot = await openEncryptedSharedSnapshot(crypto, pack, key, roster, () => identity);
    await assert.rejects(ledger.applySharingSnapshot(h.database, 'group-test', snapshot, async () => { throw new Error('projection-failure'); }, '1'), /projection-failure/);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_operations').get().n, 2);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_snapshot_state').get().n, 0);
    const after = await ledger.applySharingSnapshot(h.database, 'group-test', snapshot, noProjection, '1');
    assert.equal(after.entities[0].fields.name, '未送信');
    assert.equal((await ledger.readSharingCheckpoint(h.database, 'group-test')).pendingCount, 1);
    assert.equal((await ledger.loadSharedFacts(h.database, 'group-test')).length, 2);
    const next = await ledger.createLocalSharedOperation(h.database, author, draft('next', '次の編集'), noProjection, sign);
    assert.equal(next.deviceSequence, 3); assert.equal(next.logicalClock, 3);
  } finally { h.connection.close(); }
});

test('rekey retries preserve the authored operation and a late acknowledgement cannot remove a replacement envelope', async () => {
  const h = await fixture(); const identity = await createDeviceIdentity(crypto);
  try {
    const op = await ledger.createLocalSharedOperation(h.database, { groupId: 'group-test', userId: 'user-a',
      deviceId: identity.deviceId, keyVersion: 1 }, { operationId: 'rekey-edit', entityType: 'chore', entityId: 'floor',
      operationType: 'patch', payload: { name: 'そのまま再送' } }, noProjection, (value) => signSharedOperation(value, identity).authorSignature);
    const original = JSON.stringify(await encryptSharedOperation(crypto, op, await crypto.randomBytes(32), identity));
    const next = JSON.stringify(await encryptSharedOperation(crypto, op, await crypto.randomBytes(32), identity, 2));
    await ledger.saveSharingEnvelope(h.database, op.operationId, original);
    await assert.rejects(ledger.replaceSharingEnvelopeAfterRotation(h.database, 'group-test', op.operationId, original, next, 3), /rekey/);
    await ledger.replaceSharingEnvelopeAfterRotation(h.database, 'group-test', op.operationId, original, next, 2);
    await ledger.acknowledgeSharingUpload(h.database, op.operationId, { groupId: 'group-test', envelope: original });
    assert.equal((await ledger.listSharingOutbox(h.database, 'group-test'))[0].encryptedEnvelope, next);
    assert.deepEqual((await ledger.loadSharedFacts(h.database, 'group-test'))[0], signSharedOperation(op, identity));
    await ledger.acknowledgeSharingUpload(h.database, op.operationId, { groupId: 'group-test', envelope: next });
    assert.equal((await ledger.readSharingCheckpoint(h.database, 'group-test')).pendingCount, 0);
  } finally { h.connection.close(); }
});

test('a shared local mutation commits its projection and outbox in one transaction and rolls both back after failure', async () => {
  const h = await fixture();
  try {
    await assert.rejects(ledger.commitLocalSharedOperation(h.database, operation(), async (db) => {
      await db.runAsync('INSERT INTO ui_state VALUES (?)', 'must roll back'); throw new Error('injected projection failure');
    }), /injected/);
    for (const table of ['ui_state', 'sharing_operations', 'sharing_outbox']) {
      assert.equal(h.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    await ledger.commitLocalSharedOperation(h.database, operation(), async (db) => { await db.runAsync('INSERT INTO ui_state VALUES (?)', 'saved'); });
    assert.equal(h.connection.prepare('SELECT name FROM ui_state').get().name, 'saved');
    assert.equal((await ledger.listSharingOutbox(h.database, 'group-test')).length, 1);
  } finally { h.connection.close(); }
});

test('shared duplicate local operations cannot repeat projection side effects or requeue an acknowledged operation', async () => {
  const h = await fixture();
  try {
    let calls = 0; const project = async () => { calls++; };
    await ledger.commitLocalSharedOperation(h.database, operation(), project);
    await ledger.acknowledgeSharingUpload(h.database, 'op-1');
    await ledger.commitLocalSharedOperation(h.database, operation(), project);
    assert.equal(calls, 1); assert.equal((await ledger.listSharingOutbox(h.database, 'group-test')).length, 0);
  } finally { h.connection.close(); }
});

test('shared receive commits the cursor only with all applied operations and never adds remote events to the upload queue', async () => {
  const h = await fixture();
  try {
    await assert.rejects(ledger.applyReceivedSharedOperations(h.database, 'group-test', [operation()], 'cursor-1',
      async () => { throw new Error('projection failed'); }), /projection/);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_cursors').get().n, 0);
    assert.equal((await ledger.loadSharedReplica(h.database, 'group-test')).operations.length, 0);
    await ledger.applyReceivedSharedOperations(h.database, 'group-test', [operation(2), operation()], 'cursor-2', noProjection, 100);
    assert.equal(h.connection.prepare('SELECT cursor FROM sharing_cursors').get().cursor, 'cursor-2');
    assert.equal((await ledger.listSharingOutbox(h.database, 'group-test')).length, 0);
    const snapshot = await ledger.loadSharedReplica(h.database, 'group-test');
    assert.equal(snapshot.entities[0].fields.name, '床掃除2');
    await assert.rejects(ledger.applyReceivedSharedOperations(h.database, 'group-test', [{ ...operation(), payload: { name: 'ID collision' } }],
      'bad-cursor', noProjection), /ID reused/);
    assert.equal(h.connection.prepare('SELECT cursor FROM sharing_cursors').get().cursor, 'cursor-2');
  } finally { h.connection.close(); }
});

test('sharing batches stay bounded at 100, retries retain their exact encrypted envelope, and backoff does not discard offline edits', async () => {
  const h = await fixture();
  try {
    for (let i = 1; i <= 105; i++) await ledger.commitLocalSharedOperation(h.database, operation(i), noProjection);
    const batch = await ledger.listSharingOutbox(h.database, 'group-test', 1000); assert.equal(batch.length, 100);
    await ledger.saveSharingEnvelope(h.database, 'op-1', '{"ciphertext":"synthetic-test-value"}');
    await ledger.deferSharingUpload(h.database, 'op-1', 1000, 0.5);
    assert.equal((await ledger.listSharingOutbox(h.database, 'group-test', 5999)).some((x) => x.operation.operationId === 'op-1'), false);
    const retry = (await ledger.listSharingOutbox(h.database, 'group-test', 6000)).find((x) => x.operation.operationId === 'op-1');
    assert.equal(retry.attempts, 1); assert.equal(retry.encryptedEnvelope, '{"ciphertext":"synthetic-test-value"}');
    await assert.rejects(ledger.saveSharingEnvelope(h.database, 'op-1', 'different ciphertext'), /cannot replace/);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n, 105);
    await assert.rejects(ledger.applyReceivedSharedOperations(h.database, 'group-test', Array.from({ length: 101 }, () => operation()), '', noProjection), /exceeds 100/);
  } finally { h.connection.close(); }
});

test('concurrent shared ledger calls serialize transaction boundaries and a failed mutation does not poison the next one', async () => {
  const h = await fixture();
  try {
    const first = ledger.commitLocalSharedOperation(h.database, operation(), async () => { await Promise.resolve(); throw new Error('injected'); });
    const next = ledger.commitLocalSharedOperation(h.database, operation(2), noProjection);
    await assert.rejects(first, /injected/); await next;
    assert.equal((await ledger.loadSharedReplica(h.database, 'group-test')).operations.length, 1);
  } finally { h.connection.close(); }
});

test('shared clocks are allocated with the local transaction so rollback and concurrent edits cannot skip or reuse a device sequence', async () => {
  const h = await fixture();
  try {
    const author = { groupId: 'group-test', userId: 'user-a', deviceId: 'device-a', keyVersion: 1 };
    const draft = (id) => ({ operationId: id, entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: id } });
    await assert.rejects(ledger.createLocalSharedOperation(h.database, author, draft('failed'), async () => { throw new Error('injected'); }), /injected/);
    const [a, b] = await Promise.all(['one', 'two'].map((id) => ledger.createLocalSharedOperation(h.database, author, draft(id), noProjection)));
    assert.equal(a.deviceSequence, 1); assert.equal(b.deviceSequence, 2);
    const replica = await ledger.loadSharedReplica(h.database, 'group-test');
    assert.equal(replica.pendingOperationIds.length, 0); assert.equal(replica.entities[0].fields.name, 'two');
  } finally { h.connection.close(); }
});

test('adding the sharing ledger leaves all legacy SQLite tables and personal Google mappings intact', async () => {
  const h = createDatabase();
  try {
    const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
    await initializeLocalDatabase(h.database);
    h.connection.exec(`INSERT INTO sync_outbox VALUES ('legacy-outbox', 'legacy', '{"original":true}', '2026-10-27', 'pending')`);
    const before = h.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sharing_%' ORDER BY name").all()
      .map(({ name }) => [name, h.connection.prepare(`SELECT * FROM ${name}`).all()]);
    await ledger.initializeSharingLedger(h.database); await ledger.initializeSharingLedger(h.database);
    for (const [name, rows] of before) assert.deepEqual(h.connection.prepare(`SELECT * FROM ${name}`).all(), rows, name);
    assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version, 21);
  } finally { h.connection.close(); }
});
