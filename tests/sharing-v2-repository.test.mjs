import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { initializeSharedProjection } from '../src/platform/storage/sharing-projection.ts';
import { createDeviceIdentity, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, sharedAuthorIdentity, transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { v2OccurrenceId, v2DatePermissionId } from '../src/features/sharing/v2/occurrence-id.ts';
import { loadSharedFacts, loadSharedReplica, listSharingOutbox, applyReceivedSharedFacts, readSharingCheckpoint, applySharingSnapshot } from '../src/platform/storage/sharing-ledger.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';
import { withIsolatedSqliteTransaction } from '../src/platform/storage/isolated-transaction.ts';
import { selectManualRule } from '../src/features/sharing/v2/period-rules.ts';
import { createV2HistoryView } from '../src/features/sharing/v2/history-view.ts';
import { observedDateRules } from '../src/features/sharing/v2/formal-rule-view.ts';
const { ensureLocalHousehold } = await import('../src/platform/storage/repository.ts');

import { fixture, groupId, scope, now, receiptsFor, draft, seeds } from './helpers/sharing-v2-repository-fixture.mjs';

test('unchanged authenticated v2 reads do not acquire a SQLite writer for the projection', async () => {
  const f = await fixture(); const h = await f.device();
  try {
    await h.repository.commit(seeds()); const before = h.writes.length;
    for (let index = 0; index < 10; index++) await h.repository.readState();
    await h.repository.commitCurrent(async () => []);
    assert.equal(h.writes.length, before, 'reading and an empty member update must not attempt even a no-op INSERT');
    h.stopWrites();
    await assert.rejects(h.repository.readState(), /account changed/u, 'skipping a redundant write must still recheck access');
  } finally { h.connection.close(); }
});

test('cold v2 authentication yields to foreground work but never publishes an unchecked tail proof', async (t) => {
  const f = await fixture(); const h = await f.device();
  try {
    await h.repository.commit([...seeds(), ...Array.from({ length: 48 }, (_, index) =>
      draft(`cold-${String(index).padStart(3, '0')}`, 'chore', 'floor', { name: `床の掃除${index}` }))]);
    const before = h.state(); const writes = h.writes.length;
    let tick = 0; t.mock.method(performance, 'now', () => { tick += 4; return tick; });
    let foregroundRan = false;
    setTimeout(() => { foregroundRan = true; assert.deepEqual(h.state(), before); }, 0);
    const restart = createV2EventRepository(h.database, h.options);
    const state = await restart.readState();
    assert.equal(foregroundRan, true, 'timer work must run before a cold authentication pass completes');
    assert.equal(state.assessment.view.ready.length, 52);
    assert.deepEqual(state.assessment.rejected, []);
    assert.equal(h.writes.length, writes, 'cooperative authentication must not rewrite an unchanged projection');

    h.connection.prepare('UPDATE sharing_operations SET author_signature=? WHERE operation_id=?').run('0'.repeat(128), 'cold-047');
    const damaged = createV2EventRepository(h.database, h.options);
    await assert.rejects(damaged.readState(), /signature/i);
    assert.deepEqual(h.state(), before, 'a bad final proof cannot publish a partially verified prefix');
    assert.equal(h.writes.length, writes);
  } finally { h.connection.close(); }
});

test('revocation during a cooperative v2 proof slice aborts the read without changing projection or outbox', async (t) => {
  const f = await fixture(); const h = await f.device();
  try {
    await h.repository.commit([...seeds(), ...Array.from({ length: 48 }, (_, index) =>
      draft(`slice-${index}`, 'chore', 'floor', { name: `床の掃除${index}` }))]);
    const before = h.state(); const pending = h.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all();
    const writes = h.writes.length; let tick = 0;
    t.mock.method(performance, 'now', () => { tick += 4; return tick; });
    let revoked = false;
    setTimeout(() => { revoked = true; h.stopWrites(); }, 0);
    const restart = createV2EventRepository(h.database, h.options);
    await assert.rejects(restart.readState(), /account changed/);
    assert.equal(revoked, true);
    assert.deepEqual(h.state(), before);
    assert.deepEqual(h.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all(), pending);
    assert.equal(h.writes.length, writes);
    assert.equal(h.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { h.connection.close(); }
});

test('v2 reads repair a missing or altered projection even when their authenticated inputs are cached', async () => {
  const f = await fixture(); const h = await f.device();
  try {
    await h.repository.commit(seeds());
    const original = h.connection.prepare('SELECT * FROM sharing_v2_projection WHERE singleton=1').get();
    for (const column of ['fact_hash', 'accepted_ids_json', 'rejected_json', 'pending_ids_json', 'provisional_ids_json', 'request_states_json', 'formal_rules_json']) {
      h.connection.prepare(`UPDATE sharing_v2_projection SET ${column}=? WHERE singleton=1`).run('altered');
      await h.repository.readState();
      assert.deepEqual(h.connection.prepare('SELECT * FROM sharing_v2_projection WHERE singleton=1').get(), original, column);
    }
    h.connection.exec('DELETE FROM sharing_v2_projection');
    await h.repository.readState();
    assert.deepEqual(h.connection.prepare('SELECT * FROM sharing_v2_projection WHERE singleton=1').get(), original);
  } finally { h.connection.close(); }
});

test('an authenticated unchanged v2 read survives another native-style WAL writer without replaying or acknowledging operations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-v2-projection-lock-')); const path = join(directory, 'shared.db');
  const f = await fixture(); const h = await f.device('owner', f.owner, path); const writer = new DatabaseSync(path);
  try {
    await h.repository.commit(seeds());
    const original = h.state(); const outbox = h.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all();
    writer.exec('BEGIN IMMEDIATE; UPDATE sharing_v2_projection SET fact_hash=fact_hash WHERE singleton=1');
    const state = await h.repository.readState();
    assert.equal(state.replica.operations.length, 4);
    await h.repository.commitCurrent(async () => []);
    assert.deepEqual(h.state(), original);
    assert.deepEqual(h.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all(), outbox);
    writer.exec('ROLLBACK');
    await h.repository.commit([draft('after-writer', 'chore', 'floor', { name: '床の掃除' })]);
    assert.equal((await h.repository.readState()).replica.operations.length, 5, 'real edits still persist after contention ends');
  } finally {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    writer.close(); h.connection.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('v2 repository binds a fresh database and preserves every personal table and v1 workspace without in-place conversion', async () => {
  const personal = createDatabase(); const legacy = createDatabase();
  const dump = (h) => ({ schema: h.connection.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
    version: h.connection.prepare('PRAGMA user_version').get(),
    rows: Object.fromEntries(h.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, h.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])) });
  try {
    await migrateLocalDatabase(personal.database); await ensureLocalHousehold(personal.database);
    const before = dump(personal); await assert.rejects(initializeV2EventStore(personal.database, scope), /個人DB/); assert.deepEqual(dump(personal), before);
    await initializeSharedProjection(legacy.database, scope); const legacyBefore = dump(legacy);
    await assert.rejects(initializeV2EventStore(legacy.database, scope), /separate v2 database/); assert.deepEqual(dump(legacy), legacyBefore);
  } finally { personal.connection.close(); legacy.connection.close(); }
  const f = await fixture(); const d = await f.device();
  try {
    await initializeV2EventStore(d.database, scope);
    await assert.rejects(initializeV2EventStore(d.database, { ...scope, userId: 'another-user' }), { code: 'sharing/access-denied' });
    assert.equal(d.connection.prepare('SELECT user_id FROM sharing_v2_binding').get().user_id, 'owner');
  } finally { d.connection.close(); }
});
test('v2 local repository atomically signs operations and outbox, retains original times on retry and resumes after restart', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const created = await d.repository.commit(seeds()); assert.equal(created.length, 4);
    assert.ok(created.every((op) => op.recordedAt === now().toISOString())); assert.equal((await listSharingOutbox(d.database, groupId)).length, 4);
    const before = d.state(); const restart = createV2EventRepository(d.database, { ...d.options, now: () => new Date('2026-10-28T00:00:00Z') });
    const retry = await restart.commit(seeds()); assert.deepEqual(retry, created); assert.deepEqual(d.state(), before);
    await assert.rejects(restart.commit([draft('configuration', 'chorePolicy', 'floor', { configuration: {} })]));
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 4); assert.equal(d.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    d.stopWrites(); await assert.rejects(restart.commit([draft('new', 'chore', 'floor', { name: '変更' })]), /account changed/);
  } finally { d.connection.close(); }
});
test('v2 receive quarantines signed unauthorized edits and their forged privileges but commits independent changes and receive position', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const initial = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, initial, '4', member.repository.project, null,
      now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(initial)));
    const before = member.state();
    await assert.rejects(member.repository.commit([draft('forbidden-local', 'chore', 'floor', { enabled: false })]), { code: 'sharing/v2-authority-denied' });
    assert.deepEqual(member.state(), before); assert.equal((await listSharingOutbox(member.database, groupId)).length, 0);
    const [valid] = await member.repository.commit([draft('valid-local', 'chore', 'floor', { name: '床掃除' })]); assert.equal(valid.deviceSequence, 1);
    const context = { [f.owner.deviceId]: 4 };
    const invalid = signSharedOperation({ schemaVersion: 2, recordedAt: now().toISOString(), operationId: 'forbidden-remote', groupId,
      authorUserId: 'member', authorDeviceId: f.member.deviceId, keyVersion: 2, deviceSequence: 1, logicalClock: 5, context, receiptContext: context,
      entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { enabled: false } }, f.member);
    const independent = signSharedOperation({ ...invalid.operation, operationId: 'independent-remote', deviceSequence: 2,
      logicalClock: 6, context: { ...context, [f.member.deviceId]: 1 }, payload: { instructions: ['ほこりを取る'] } }, f.member);
    await applyReceivedSharedFacts(owner.database, groupId, [independent, invalid], '6', owner.repository.project, null,
      now().getTime(), owner.repository.evidenceForServerReceipts(receiptsFor([...initial, invalid, independent])));
    assert.deepEqual(owner.state().rejected.map((op) => op.operationId), ['forbidden-remote']);
    assert.ok(owner.state().accepted.includes('independent-remote')); assert.equal((await readSharingCheckpoint(owner.database, groupId)).sequence, 6);
    assert.ok((await loadSharedReplica(owner.database, groupId)).operations.some((op) => op.operationId === 'forbidden-remote'));
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 projection rejects missing or altered original author proofs before changing derived state or cursor', async () => {
  const f = await fixture(); const owner = await f.device(); const receiver = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const facts = await loadSharedFacts(owner.database, groupId);
    const tampered = facts.map((fact, index) => index === 2 ? { ...fact, authorSignature: '0'.repeat(128) } : fact);
    await assert.rejects(applyReceivedSharedFacts(receiver.database, groupId, tampered, '4', receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receiptsFor(facts))));
    assert.equal(receiver.state(), null); assert.equal((await readSharingCheckpoint(receiver.database, groupId)).cursor, null);
    assert.equal((await loadSharedReplica(receiver.database, groupId)).operations.length, 0);
    await applyReceivedSharedFacts(receiver.database, groupId, facts, '4', receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.equal(receiver.state().accepted.length, 4);
  } finally { owner.connection.close(); receiver.connection.close(); }
});
test('v2 encrypted snapshots retain original proofs, restore authority state and refuse manifest protocol tampering', async () => {
  const f = await fixture(); const owner = await f.device(); const receiver = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const replica = await loadSharedReplica(owner.database, groupId); const facts = await loadSharedFacts(owner.database, groupId);
    const resolve = (uid, device, version) => sharedAuthorIdentity(f.archive[version - 1], uid, device, version); const key = await crypto.randomBytes(32);
    const receipts = receiptsFor(facts);
    await applyReceivedSharedFacts(owner.database, groupId, facts, '4', owner.repository.project, null,
      now().getTime(), owner.repository.evidenceForServerReceipts(receipts));
    const encrypted = await createEncryptedSharedSnapshot(crypto, replica, facts, f.archive.at(-1), f.owner, key, 'snapshot-v2', 4, resolve);
    assert.equal(encrypted.manifest.body.schemaVersion, 2);
    const opened = await openEncryptedSharedSnapshot(crypto, encrypted, key, f.archive.at(-1), resolve);
    const erased = { ...opened, base: { ...opened.base, operations: opened.base.operations.slice(1) }, facts: opened.facts.slice(1) };
    await assert.rejects(applySharingSnapshot(receiver.database, groupId, erased, receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receipts)), /cannot discard/);
    assert.equal(receiver.state(), null); assert.equal((await readSharingCheckpoint(receiver.database, groupId)).cursor, null);
    await applySharingSnapshot(receiver.database, groupId, opened, receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receipts));
    assert.deepEqual(receiver.state(), owner.state()); assert.deepEqual((await loadSharedReplica(receiver.database, groupId)).frontier, replica.frontier);
    await assert.rejects(openEncryptedSharedSnapshot(crypto, { ...encrypted, manifest: { ...encrypted.manifest, body: { ...encrypted.manifest.body, schemaVersion: 1 } } },
      key, f.archive.at(-1), resolve), /manifest/);
  } finally { owner.connection.close(); receiver.connection.close(); }
});
test('v2 snapshots without independent server receipts remain unconfirmed and cannot acknowledge the original offline outbox', async () => {
  const f = await fixture(); const owner = await f.device(); const receiver = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const replica = await loadSharedReplica(owner.database, groupId); const facts = await loadSharedFacts(owner.database, groupId);
    const key = await crypto.randomBytes(32); const resolve = (uid, device, version) => sharedAuthorIdentity(f.archive[version - 1], uid, device, version);
    const sealed = await createEncryptedSharedSnapshot(crypto, replica, facts, f.archive.at(-1), f.owner, key, 'without-receipts', 4, resolve);
    const snapshot = await openEncryptedSharedSnapshot(crypto, sealed, key, f.archive.at(-1), resolve);
    await applySharingSnapshot(receiver.database, groupId, snapshot, receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts([]));
    assert.equal(receiver.state().accepted.length, 0); assert.equal(receiver.state().rejected.length, 4);
    assert.ok(receiver.state().rejected.every((entry) => entry.kind === 'unconfirmed'));
    await applySharingSnapshot(owner.database, groupId, snapshot, owner.repository.project, null,
      now().getTime(), owner.repository.evidenceForServerReceipts([]));
    assert.equal((await listSharingOutbox(owner.database, groupId)).length, 4);
    assert.equal(owner.connection.prepare('SELECT COUNT(*) AS count FROM sharing_operations').get().count, 4);
    await applyReceivedSharedFacts(owner.database, groupId, facts, '4', owner.repository.project, '4',
      now().getTime(), owner.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.equal((await listSharingOutbox(owner.database, groupId)).length, 0);
    assert.equal(JSON.parse(owner.connection.prepare('SELECT provisional_ids_json FROM sharing_v2_projection').get().provisional_ids_json).length, 0);
  } finally { owner.connection.close(); receiver.connection.close(); }
});
test('v2 delayed former-administrator edits lose privileged effects at server delivery without erasing original facts or ordinary member edits', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const original = await loadSharedFacts(d.database, groupId);
    await d.repository.commit([draft('old-admin-policy', 'groupPolicy', 'policy', { configuration: createGroupPolicy('roommates') }),
      draft('ordinary-name', 'chore', 'floor', { name: '説明の訂正' })]);
    const facts = await loadSharedFacts(d.database, groupId);
    f.archive.push(transferSharedOwnership(f.archive.at(-1), f.owner, { userId: 'member', deviceId: f.member.deviceId }));
    const receipts = receiptsFor(facts).map((receipt) => ['old-admin-policy', 'ordinary-name'].includes(receipt.operationId)
      ? { ...receipt, receivedKeyVersion: 3 } : receipt);
    await applyReceivedSharedFacts(d.database, groupId, facts, '6', d.repository.project, null,
      now().getTime(), d.repository.evidenceForServerReceipts(receipts));
    assert.deepEqual(d.state().rejected.map((entry) => entry.operationId), ['old-admin-policy']);
    assert.ok(d.state().accepted.includes('ordinary-name')); assert.ok(d.state().accepted.includes(original[0].operation.operationId));
    assert.equal((await loadSharedFacts(d.database, groupId)).length, 6); assert.equal((await listSharingOutbox(d.database, groupId)).length, 0);
  } finally { d.connection.close(); }
});
test('v2 receipt recovery refuses another user database before any partial progress write', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const receipts = receiptsFor(await loadSharedFacts(owner.database, groupId));
    await assert.rejects(owner.repository.readReceiptCache(member.database), { code: 'sharing/access-denied' });
    await assert.rejects(owner.repository.evidenceForServerReceipts(receipts).record(member.database), { code: 'sharing/access-denied' });
    assert.equal(member.connection.prepare('SELECT COUNT(*) AS count FROM sharing_v2_server_receipts').get().count, 0);
    assert.equal(member.state(), null);
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 server order prevents predicted future grants from retroactively authorizing a signed date change while later legitimate changes still work', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const initial = await loadSharedFacts(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, initial, '4', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(initial)));
    const base = { schemaVersion: 2, receiptContext: {}, recordedAt: now().toISOString(), groupId, keyVersion: 2, operationType: 'patch' };
    const configuration = (id) => ({ id, choreId: 'floor', subjectUserId: null, referenceAnchorDate: '2026-10-27', timeZoneAtCreation: 'Asia/Tokyo',
      selector: { scope: 'once', occurrenceId: v2OccurrenceId(groupId, 'floor', '2026-10-27'), anchorDate: '2026-10-27' },
      mode: 'day', target: { precision: 'date', date: '2026-10-28' }, strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'member', ruleVersion: 1 });
    const grant = signSharedOperation({ ...base, operationId: 'future-grant', authorUserId: 'owner', authorDeviceId: f.owner.deviceId,
      deviceSequence: 5, logicalClock: 5, context: { [f.owner.deviceId]: 4 }, entityType: 'datePermission', entityId: v2DatePermissionId(groupId, 'floor', 'member'),
      payload: { choreId: 'floor', userId: 'member', enabled: true, rights: { changeDate: true, changeOthers: true, changeBeforeWindow: false } } }, f.owner);
    const predicted = signSharedOperation({ ...base, operationId: 'predicted', authorUserId: 'member', authorDeviceId: f.member.deviceId,
      deviceSequence: 1, logicalClock: 6, context: { [f.owner.deviceId]: 5 }, entityType: 'designation', entityId: 'predicted', payload: { configuration: configuration('predicted') } }, f.member);
    const [predictionReceipt] = receiptsFor([predicted]).map((receipt) => ({ ...receipt, uploadSequence: 5 }));
    const [grantReceipt] = receiptsFor([grant]).map((receipt) => ({ ...receipt, uploadSequence: 6 }));
    await applyReceivedSharedFacts(d.database, groupId, [predicted], '5', d.repository.project, '4', now().getTime(), d.repository.evidenceForServerReceipts([predictionReceipt]));
    assert.ok(!d.state().accepted.includes('predicted'));
    await applyReceivedSharedFacts(d.database, groupId, [grant], '6', d.repository.project, '5', now().getTime(), d.repository.evidenceForServerReceipts([grantReceipt]));
    assert.deepEqual(d.state().rejected, [{ operationId: 'predicted', kind: 'unauthorized', reason: 'sharing/v2-receipt-causality' }]);
    const legitimate = signSharedOperation({ ...predicted.operation, operationId: 'legitimate', entityId: 'legitimate', deviceSequence: 2,
      logicalClock: 7, context: { [f.owner.deviceId]: 5, [f.member.deviceId]: 1 }, payload: { configuration: configuration('legitimate') } }, f.member);
    await applyReceivedSharedFacts(d.database, groupId, [legitimate], '7', d.repository.project, '6', now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor([legitimate])));
    assert.ok(d.state().accepted.includes('legitimate')); assert.ok(d.state().accepted.includes('future-grant'));
  } finally { d.connection.close(); }
});

const requestDraft = (authorUserId = 'member') => draft('request-date', 'changeRequest', 'request-date', {
  requesterUserId: authorUserId, choreId: 'floor', anchorDate: '2026-10-27', occurrenceId: v2OccurrenceId(groupId, 'floor', '2026-10-27'),
  subjectUserId: null, originalDesignationId: null, original: { precision: 'date', date: '2026-10-27' }, proposed: { precision: 'date', date: '2026-10-30' },
  proposedMode: 'day', proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false },
  selector: { scope: 'once', occurrenceId: v2OccurrenceId(groupId, 'floor', '2026-10-27'), anchorDate: '2026-10-27' }, extensionScope: 'once',
});
const requestStates = (d) => JSON.parse(d.connection.prepare('SELECT request_states_json FROM sharing_v2_projection').get().request_states_json);
async function receiveRequestFacts(d, facts, cursor, receipts) {
  const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(cursor), d.repository.project, checkpoint.cursor,
    now().getTime(), d.repository.evidenceForServerReceipts(receipts));
}

test('v2 request receipts atomically project pending and approved dates on two databases and survive restart and an encrypted snapshot', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member); const restored = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const initial = await loadSharedFacts(owner.database, groupId); const initialReceipts = receiptsFor(initial);
    await receiveRequestFacts(owner, initial, 4, initialReceipts); await receiveRequestFacts(member, initial, 4, initialReceipts);
    await member.repository.commit([requestDraft()]); const request = (await loadSharedFacts(member.database, groupId)).find((fact) => fact.operation.operationId === 'request-date');
    assert.equal(requestStates(member)[0].kind, 'pendingDelivery');
    const requestReceipt = { ...receiptsFor([request])[0], uploadSequence: 5 };
    await receiveRequestFacts(owner, [request], 5, [requestReceipt]); await receiveRequestFacts(member, [request], 5, [requestReceipt]);
    assert.equal(requestStates(owner)[0].kind, 'awaiting'); assert.deepEqual(requestStates(owner), requestStates(member));
    await owner.repository.commit([draft('approve-date', 'requestDecision', 'approve-date', { requestId: 'request-date', decision: 'approve', target: null, referenceDecisionId: null })]);
    assert.equal(requestStates(owner)[0].kind, 'awaiting'); assert.equal(requestStates(owner)[0].decisions[0].kind, 'pendingDelivery');
    const approval = (await loadSharedFacts(owner.database, groupId)).find((fact) => fact.operation.operationId === 'approve-date');
    const approvalReceipt = { ...receiptsFor([approval])[0], uploadSequence: 6, receivedAtMs: now().getTime() + 1000 };
    await receiveRequestFacts(owner, [approval], 6, [approvalReceipt]); await receiveRequestFacts(member, [approval], 6, [approvalReceipt]);
    const confirmed = requestStates(owner); assert.equal(confirmed[0].kind, 'approved'); assert.deepEqual(confirmed[0].formal, { precision: 'date', date: '2026-10-30' });
    assert.deepEqual(requestStates(member), confirmed); assert.deepEqual(member.state(), owner.state());
    assert.equal((await listSharingOutbox(member.database, groupId)).length, 0); assert.equal((await listSharingOutbox(owner.database, groupId)).length, 0);
    const restarted = createV2EventRepository(owner.database, { ...owner.options, now: () => new Date('2036-01-01T00:00:00Z') });
    const replica = await loadSharedReplica(owner.database, groupId);
    await withIsolatedSqliteTransaction(owner.database, (tx) => restarted.project(tx, replica)); assert.deepEqual(requestStates(owner), confirmed);
    const resolve = (uid, device, version) => sharedAuthorIdentity(f.archive[version - 1], uid, device, version); const key = await crypto.randomBytes(32);
    const encrypted = await createEncryptedSharedSnapshot(crypto, replica, await loadSharedFacts(owner.database, groupId), f.archive.at(-1), f.owner, key, 'request-snapshot', 6, resolve);
    const opened = await openEncryptedSharedSnapshot(crypto, encrypted, key, f.archive.at(-1), resolve);
    await applySharingSnapshot(restored.database, groupId, opened, restored.repository.project, null, now().getTime(),
      restored.repository.evidenceForServerReceipts([...initialReceipts, requestReceipt, approvalReceipt]));
    assert.deepEqual(requestStates(restored), confirmed); assert.deepEqual(restored.state(), owner.state());
  } finally { owner.connection.close(); member.connection.close(); restored.connection.close(); }
});
test('v2 an offline approval delivered after expiry is retained and acknowledged without changing the formal date', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const initial = await loadSharedFacts(owner.database, groupId);
    for (const d of [owner, member]) await applyReceivedSharedFacts(d.database, groupId, initial, '4', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(initial)));
    await member.repository.commit([requestDraft()]); const request = (await loadSharedFacts(member.database, groupId)).find((fact) => fact.operation.operationId === 'request-date');
    const requestReceipt = { ...receiptsFor([request])[0], uploadSequence: 5 };
    await receiveRequestFacts(owner, [request], 5, [requestReceipt]);
    const expiresAt = requestStates(owner)[0].deadline.expiresAt;
    await owner.repository.commit([draft('late-approval', 'requestDecision', 'late-approval', { requestId: 'request-date', decision: 'approve', target: null, referenceDecisionId: null })]);
    const approval = (await loadSharedFacts(owner.database, groupId)).find((fact) => fact.operation.operationId === 'late-approval');
    await receiveRequestFacts(owner, [approval], 6, [{ ...receiptsFor([approval])[0], uploadSequence: 6, receivedAtMs: expiresAt + 1 }]);
    const state = requestStates(owner)[0]; assert.equal(state.kind, 'expired'); assert.deepEqual(state.formal, state.original);
    assert.equal(state.decisions[0].kind, 'late'); assert.equal((await listSharingOutbox(owner.database, groupId)).length, 0);
    assert.ok((await loadSharedFacts(owner.database, groupId)).some((fact) => fact.operation.operationId === 'late-approval'));
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 an administrator request delivered after ownership transfer loses automatic approval and only its delivery-epoch administrator can approve', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const initial = await loadSharedFacts(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, initial, '4', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(initial)));
    await d.repository.commit([requestDraft('owner')]); const request = (await loadSharedFacts(d.database, groupId)).find((fact) => fact.operation.operationId === 'request-date');
    assert.equal(requestStates(d)[0].kind, 'pendingDelivery');
    f.archive.push(transferSharedOwnership(f.archive.at(-1), f.owner, { userId: 'member', deviceId: f.member.deviceId }));
    const requestReceipt = { ...receiptsFor([request])[0], uploadSequence: 5, receivedKeyVersion: 3 };
    await receiveRequestFacts(d, [request], 5, [requestReceipt]);
    assert.equal(requestStates(d)[0].kind, 'awaiting', 'the author was an administrator at the click, but no longer at server acceptance');
    const oldApproval = signSharedOperation({ schemaVersion: 2, receiptContext: {}, operationId: 'former-owner-approval', groupId, authorUserId: 'owner', authorDeviceId: f.owner.deviceId,
      deviceSequence: 6, logicalClock: 6, context: { [f.owner.deviceId]: 5 }, keyVersion: 2, recordedAt: now().toISOString(), entityType: 'requestDecision',
      entityId: 'former-owner-approval', operationType: 'patch', payload: { requestId: 'request-date', decision: 'approve', target: null, referenceDecisionId: null } }, f.owner);
    const newApproval = signSharedOperation({ ...oldApproval.operation, operationId: 'current-owner-approval', authorUserId: 'member', authorDeviceId: f.member.deviceId,
      deviceSequence: 1, keyVersion: 3, entityId: 'current-owner-approval' }, f.member);
    const receipts = [{ ...receiptsFor([oldApproval])[0], uploadSequence: 6, receivedKeyVersion: 3 }, { ...receiptsFor([newApproval])[0], uploadSequence: 7 }];
    await receiveRequestFacts(d, [newApproval, oldApproval], 7, receipts);
    assert.equal(requestStates(d)[0].kind, 'approved'); assert.deepEqual(d.state().rejected.map((entry) => entry.operationId), ['former-owner-approval']);
    assert.equal(requestStates(d)[0].decisions[0].operationId, 'current-owner-approval');
  } finally { d.connection.close(); }
});

const formalRules = (d) => JSON.parse(d.connection.prepare('SELECT formal_rules_json FROM sharing_v2_projection').get().formal_rules_json);
async function approvedFixture() {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  await owner.repository.commit(seeds()); const initial = await loadSharedFacts(owner.database, groupId);
  await receiveRequestFacts(owner, initial, 4, receiptsFor(initial)); await receiveRequestFacts(member, initial, 4, receiptsFor(initial));
  await member.repository.commit([requestDraft()]);
  const request = (await loadSharedFacts(member.database, groupId)).find((fact) => fact.operation.operationId === 'request-date');
  const receipt = { ...receiptsFor([request])[0], uploadSequence: 5 };
  await receiveRequestFacts(owner, [request], 5, [receipt]); await receiveRequestFacts(member, [request], 5, [receipt]);
  await owner.repository.commit([draft('approve-first', 'requestDecision', 'approve-first', { requestId: 'request-date', decision: 'approve', target: null, referenceDecisionId: null })]);
  const approval = (await loadSharedFacts(owner.database, groupId)).find((fact) => fact.operation.operationId === 'approve-first');
  const approvalReceipt = { ...receiptsFor([approval])[0], uploadSequence: 6 };
  await receiveRequestFacts(owner, [approval], 6, [approvalReceipt]); await receiveRequestFacts(member, [approval], 6, [approvalReceipt]);
  return { ...f, owner, member, close: () => { owner.connection.close(); member.connection.close(); } };
}
test('v2 a second date request can reference an approved semantic rule and replaces it only with observed confirmation and explicit basis', async () => {
  const f = await approvedFixture();
  try {
    const first = formalRules(f.member)[0]; assert.ok(first.confirmation); assert.equal(first.rule.target.date, '2026-10-30');
    const second = requestDraft(); second.operationId = second.entityId = 'second-request';
    second.payload = { ...second.payload, originalDesignationId: first.operationId, original: first.rule.target,
      proposed: { precision: 'date', date: '2026-10-31' }, basisRuleIds: [first.operationId] };
    await f.member.repository.commit([second]);
    const request = (await loadSharedFacts(f.member.database, groupId)).find((fact) => fact.operation.operationId === 'second-request');
    const receipt = { ...receiptsFor([request])[0], uploadSequence: 7 };
    await receiveRequestFacts(f.owner, [request], 7, [receipt]); await receiveRequestFacts(f.member, [request], 7, [receipt]);
    await f.owner.repository.commit([draft('approve-second', 'requestDecision', 'approve-second', { requestId: 'second-request', decision: 'approve', target: null, referenceDecisionId: null })]);
    const approval = (await loadSharedFacts(f.owner.database, groupId)).find((fact) => fact.operation.operationId === 'approve-second');
    const approvalReceipt = { ...receiptsFor([approval])[0], uploadSequence: 8 };
    await receiveRequestFacts(f.owner, [approval], 8, [approvalReceipt]); await receiveRequestFacts(f.member, [approval], 8, [approvalReceipt]);
    assert.equal(requestStates(f.owner).length, 2); assert.ok(requestStates(f.owner).every((state) => state.kind === 'approved'));
    assert.deepEqual(formalRules(f.owner), formalRules(f.member));
    const selected = selectManualRule(formalRules(f.owner), { id: v2OccurrenceId(groupId, 'floor', '2026-10-27'), choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1 }, null, 'Asia/Tokyo');
    assert.equal(selected.kind, 'selected'); assert.equal(selected.fact.rule.target.date, '2026-10-31'); assert.equal(selected.fact.sourceRequestId, 'second-request');
    const stale = requestDraft(); stale.operationId = stale.entityId = 'stale-request';
    await assert.rejects(f.member.repository.commit([stale]), /formal date/);
  } finally { f.close(); }
});
test('v2 cancelling an observed approved date preserves its source request and receipts and returns subsequent changes to the common baseline', async () => {
  const f = await approvedFixture();
  try {
    const rule = formalRules(f.owner)[0];
    await f.owner.repository.commit([draft('cancel-approved', 'designationCancel', 'cancel-approved', { targetOperationIds: [rule.operationId] })]);
    const replica = await loadSharedReplica(f.owner.database, groupId); const probe = { ...replica.operations.at(-1), context: replica.frontier };
    const visible = observedDateRules(createV2HistoryView(replica), probe, formalRules(f.owner)); assert.equal(visible.length, 0);
    assert.equal(requestStates(f.owner)[0].kind, 'approved', 'cancellation does not falsify the earlier approval history');
    assert.equal(formalRules(f.owner)[0].operationId, rule.operationId);
    const predicted = draft('cancel-unconfirmed', 'designationCancel', 'cancel-unconfirmed', { targetOperationIds: ['v2-rule-' + 'a'.repeat(64)] });
    await assert.rejects(f.owner.repository.commit([predicted]), /confirmed and observed/);
  } finally { f.close(); }
});
test('v2 approved fixed intervals participate in later shared overlap checks and rollback an invalid local edit with its outbox', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initialDrafts = seeds(); initialDrafts[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']);
    await owner.repository.commit(initialDrafts); const initial = await loadSharedFacts(owner.database, groupId);
    await receiveRequestFacts(owner, initial, 4, receiptsFor(initial)); await receiveRequestFacts(member, initial, 4, receiptsFor(initial));
    const requested = requestDraft(); requested.payload.proposedMode = 'fixed';
    requested.payload.proposed = { precision: 'interval', start: '2026-10-28T01:00:00Z', end: '2026-10-28T02:00:00Z' };
    // A locked source makes the owner decision necessary even for one's assigned chore.
    requested.payload.proposedOptions.adminLocked = true;
    await assert.rejects(member.repository.commit([requested]), /administrator/);
    requested.payload.proposedOptions.adminLocked = false;
    // Family policy requires approval for dates after its common window.
    requested.payload.proposed = { precision: 'interval', start: '2026-10-30T01:00:00Z', end: '2026-10-30T02:00:00Z' };
    await member.repository.commit([requested]); const request = (await loadSharedFacts(member.database, groupId)).find((fact) => fact.operation.operationId === 'request-date');
    await receiveRequestFacts(owner, [request], 5, [{ ...receiptsFor([request])[0], uploadSequence: 5 }]);
    await owner.repository.commit([draft('approve-fixed', 'requestDecision', 'approve-fixed', { requestId: 'request-date', decision: 'approve', target: null, referenceDecisionId: null })]);
    const approval = (await loadSharedFacts(owner.database, groupId)).find((fact) => fact.operation.operationId === 'approve-fixed');
    await receiveRequestFacts(owner, [approval], 6, [{ ...receiptsFor([approval])[0], uploadSequence: 6 }]);
    await owner.repository.commit([draft('second-floor', 'chore', 'second', { name: '別の家事', enabled: true }),
      draft('second-policy', 'chorePolicy', 'second', { configuration: { ...seeds()[3].payload.configuration, policy: chorePolicyFromPreset('assigned', ['member']) } })]);
    const make = (id, start, end) => draft(id, 'designation', id, { configuration: { id, choreId: 'second', subjectUserId: null,
      selector: { scope: 'once', occurrenceId: v2OccurrenceId(groupId, 'second', '2026-10-27'), anchorDate: '2026-10-27' }, referenceAnchorDate: '2026-10-27',
      timeZoneAtCreation: 'Asia/Tokyo', mode: 'fixed', target: { precision: 'interval', start, end }, strict: false, adminLocked: false, forbidEarlier: false,
      issuerUserId: 'owner', ruleVersion: 1 } });
    const before = owner.state(); const pending = await listSharingOutbox(owner.database, groupId);
    await assert.rejects(owner.repository.commit([make('overlap', '2026-10-30T01:30:00Z', '2026-10-30T02:30:00Z')]), /forbidden/);
    assert.deepEqual(owner.state(), before); assert.deepEqual(await listSharingOutbox(owner.database, groupId), pending);
    await owner.repository.commit([make('adjacent', '2026-10-30T02:00:00Z', '2026-10-30T03:00:00Z')]);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 a batch of 256 counteroffers retains all facts and converges through 100-event receipt pages with one current alternative', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const initial = await loadSharedFacts(owner.database, groupId);
    await receiveRequestFacts(owner, initial, 4, receiptsFor(initial)); await receiveRequestFacts(member, initial, 4, receiptsFor(initial));
    await member.repository.commit([requestDraft()]); const request = (await loadSharedFacts(member.database, groupId)).find((fact) => fact.operation.operationId === 'request-date');
    const receipt = { ...receiptsFor([request])[0], uploadSequence: 5 };
    await receiveRequestFacts(owner, [request], 5, [receipt]); await receiveRequestFacts(member, [request], 5, [receipt]);
    await owner.repository.commit(Array.from({ length: 256 }, (_, index) => {
      const id = `counter-${String(index).padStart(3, '0')}`;
      return draft(id, 'requestDecision', id, { requestId: 'request-date', decision: 'counteroffer',
        target: { precision: 'date', date: index % 2 ? '2026-10-30' : '2026-10-31' }, referenceDecisionId: null });
    }));
    assert.equal((await listSharingOutbox(owner.database, groupId)).length, 100, 'outbox reading remains bounded even for a larger atomic local action');
    const counteroffers = (await loadSharedFacts(owner.database, groupId)).filter((fact) => fact.operation.entityType === 'requestDecision');
    assert.equal(counteroffers.length, 256);
    for (let index = 0; index < counteroffers.length; index += 100) {
      const page = counteroffers.slice(index, index + 100); const cursor = 5 + index + page.length;
      await receiveRequestFacts(owner, page, cursor, receiptsFor(page)); await receiveRequestFacts(member, page, cursor, receiptsFor(page));
    }
    const state = requestStates(owner)[0]; assert.equal(state.kind, 'counteroffered'); assert.equal(state.decisions.length, 256);
    assert.equal(state.counteroffers.length, 1); assert.equal(state.counteroffers[0].operationId, 'counter-255');
    assert.deepEqual(requestStates(owner), requestStates(member)); assert.deepEqual(owner.state(), member.state());
    assert.equal((await listSharingOutbox(owner.database, groupId)).length, 0);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 repository serializes authenticated reads and current-state mutation builders without nested transactions or stale updates', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    let release; let entered;
    const gate = new Promise((resolve) => { release = resolve; }); const started = new Promise((resolve) => { entered = resolve; });
    const update = d.repository.commitCurrent(async (state) => {
      assert.equal(state.assessment.view.ready.length, 4); entered(); await gate;
      return [draft('first-update', 'chore', 'floor', { name: '最初の編集' })];
    });
    await started;
    const read = d.repository.readState();
    const second = d.repository.commitCurrent(async (state) => {
      const latest = state.assessment.view.ready.find((op) => op.operationId === 'first-update'); assert.ok(latest);
      return [draft('second-update', 'chore', 'floor', { name: `${latest.payload.name}の次` })];
    });
    release(); await update;
    assert.equal((await read).assessment.view.ready.length, 5); await second;
    const current = await d.repository.readState(); assert.equal(current.assessment.view.ready.length, 6);
    assert.deepEqual(current.assessment.rejected, []); assert.equal((await listSharingOutbox(d.database, groupId)).length, 6);
  } finally { d.connection.close(); }
});
test('v2 repository revocation during projection rolls back the fact, outbox and projection together', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const before = d.state();
    const run = d.database.runAsync;
    d.database.runAsync = async (sql, ...parameters) => {
      const result = await run(sql, ...parameters);
      if (sql.startsWith('INSERT INTO sharing_v2_projection')) d.stopWrites();
      return result;
    };
    await assert.rejects(d.repository.commit([draft('revoked-mid-write', 'chore', 'floor', { name: '権限変更中' })]), /account changed/);
    assert.deepEqual(d.state(), before);
    assert.equal(d.connection.prepare('SELECT count(*) AS n FROM sharing_operations').get().n, 4);
    assert.equal(d.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n, 4);
    await assert.rejects(d.repository.readState(), /account changed/);
  } finally { d.connection.close(); }
});
test('v2 repository revocation while reading signed facts refuses to return account-bound state', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const before = d.state(); const read = d.database.getAllAsync;
    d.database.getAllAsync = async (sql, ...parameters) => {
      const result = await read(sql, ...parameters);
      if (sql.includes('author_signature')) d.stopWrites(); return result;
    };
    await assert.rejects(d.repository.readState(), /account changed/); assert.deepEqual(d.state(), before);
  } finally { d.connection.close(); }
});

test('v2 repository observer failures after commit cannot report a durable edit as a failed transaction', async () => {
  for (const observer of [() => { throw new Error('observer failed'); }, async () => { throw new Error('async observer failed'); }]) {
    const f = await fixture(); const d = await f.device();
    try {
      const repository = createV2EventRepository(d.database, { ...d.options, afterCommit: observer });
      assert.equal((await repository.commit(seeds())).length, 4); await Promise.resolve();
      assert.equal((await listSharingOutbox(d.database, groupId)).length, 4); assert.equal((await repository.readState()).assessment.view.ready.length, 4);
    } finally { d.connection.close(); }
  }
});
