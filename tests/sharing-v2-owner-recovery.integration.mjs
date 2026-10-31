import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, getDocsFromServer, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createDeviceIdentity, encryptSharedOperation, signSharedDocument, signSharedOperation, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { createSharedJoinRequest } from '../src/features/sharing/invitations.ts';
import { readCloudWorkspaceArchive } from '../src/features/sharing/workspace-protocol.ts';
import { createV2WorkspaceSession } from '../src/features/sharing/v2/workspace-session.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { signV2RecoveryLock } from '../src/features/sharing/v2/recovery-lock.ts';
import { openV2RecoveryHeader } from '../src/features/sharing/v2/recovery-encryption.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { seeds } from './helpers/sharing-v2-repository-fixture.mjs';
import { loadSharedFacts, loadSharedReplica, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';

if (!/^(localhost|127\.0\.0\.1):\d+$/u.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Owner recovery attacks require the local Firestore emulator.');
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId: 'demo-liflow-owner-recovery',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { await environment?.cleanup(); });
const groupId = 'owner-recovery-test';

async function fixture(t, { recoveryEnabled = true, env = environment } = {}) {
  const databases = []; t.after(() => databases.forEach(h => h.connection.close())); let ordinal = 0;
  const identity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const store = env.authenticatedContext('owner').firestore();
  const cloud = createSharingCloud(store, 'owner', () => 'owner', { ownerRecoveryEnabled: recoveryEnabled });
  const roster = createSharedRoster(groupId, 'owner', identity, { schemaVersion: 2 });
  await cloud.createGroup(roster, await wrapGroupKey(crypto, groupId, 1, key, identity, identity, 'owner'));
  async function device(uid, identity, cloud, initialArchive, record = {}) {
    const h = createDatabase(); databases.push(h); let archive = initialArchive; const keys = new Map(); let active = true;
    const deps = { database: h.database, householdId: `household-${uid}`, groupId, userId: uid, identity, cloud, crypto,
      readRecord: async () => ({ userId: uid, groupId, status: 'active', anchor: archive[0], rosterArchive: archive, ...record }),
      archive: () => archive, saveArchive: async value => { archive = value; },
      readKey: async version => keys.get(version)?.slice() ?? null, saveKey: async (version, value) => { keys.set(version, value.slice()); },
      serialized: work => work(), changed: () => {}, assertCurrentAccount: () => { if (!active) throw new Error('account changed'); },
      assertWritable: () => { if (!active) throw new Error('account changed'); }, makeId: () => `${uid}-${++ordinal}`, markLeft: async () => {} };
    const session = await createV2WorkspaceSession(deps);
    return { ...h, ...session, deps, identity, cloud, keys, archive: () => archive, stop: () => { active = false; }, restart: () => createV2WorkspaceSession(deps) };
  }
  const owner = await device('owner', identity, cloud, [roster]);
  await owner.repository.commit(seeds()); await owner.synchronizer.sync({ force: true });
  async function member(uid) {
    const nextIdentity = await createDeviceIdentity(crypto); const invite = await owner.manager.createInvitation();
    const request = createSharedJoinRequest(invite, uid, nextIdentity, Date.now());
    const nextCloud = createSharingCloud(env.authenticatedContext(uid).firestore(), uid, () => uid, { ownerRecoveryEnabled: recoveryEnabled });
    await nextCloud.submitJoinRequest(invite.invitation, request); await owner.manager.approve(invite.invitation, request);
    const record = { userId: uid, groupId, anchor: invite.invitation.body.pin, rosterArchive: [], join: { invitation: invite.invitation, request } };
    const archive = await readCloudWorkspaceArchive(record, (await nextCloud.readGroup(groupId)).roster, nextCloud.readRoster);
    const value = await device(uid, nextIdentity, nextCloud, archive); await value.synchronizer.sync({ force: true }); return value;
  }
  const a = await member('member-a'); const b = await member('member-b'); await a.synchronizer.sync({ force: true });
  async function send(device, id, name, broken = false) {
    await device.repository.commit([{ operationId: id, entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name } }]);
    const fact = (await loadSharedFacts(device.database, groupId)).find(fact => fact.operation.operationId === id);
    const epoch = (await device.cloud.readGroup(groupId)).group.keyVersion;
    const key = device.keys.get(epoch) ?? owner.keys.get(epoch);
    const envelope = await encryptSharedOperation(crypto, fact.operation, key, device.identity, epoch);
    if (broken) {
      const { signature: _signature, ...body } = envelope;
      body.encryptedPayload = `${body.encryptedPayload.startsWith('00') ? 'ff' : '00'}${body.encryptedPayload.slice(2)}`;
      Object.assign(envelope, body, { signature: signSharedDocument(body, device.identity) });
    }
    await device.cloud.upload(envelope, { authorProofDigest: v2AuthorProofDigest(fact) }); return { fact, envelope };
  }
  return { owner, a, b, cloud, store, send, root: doc(store, 'sharingGroups', groupId) };
}

test('owner-confirmed recovery preserves independent edits original evidence held facts and offline outbox across restart and compaction', async t => {
  const f = await fixture(t);
  await f.send(f.a, 'corrupt-one', '壊れた通信の元の変更', true);
  await f.send(f.a, 'dependent-one', '消さずに保留する変更');
  await f.send(f.b, 'independent-one', '正常な独立変更');
  await f.owner.repository.commit([{ operationId: 'offline-owner', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { description: '未送信の所有者変更' } }]);
  const before = await loadSharedReplica(f.owner.database, groupId); const unsent = await listSharingOutbox(f.owner.database, groupId);
  await assert.rejects(f.owner.synchronizer.sync({ force: true }));
  const review = await f.owner.recovery.prepare();
  assert.deepEqual([review.unreadableChanges, review.heldChanges, review.retainedChanges], [1, 1, 1]);
  assert.deepEqual(review.removeDeviceIds, [f.a.identity.deviceId]); assert.deepEqual(review.removeUserIds, ['member-a']);
  assert.deepEqual(await loadSharedReplica(f.owner.database, groupId), before);
  assert.deepEqual(await listSharingOutbox(f.owner.database, groupId), unsent);
  assert.equal(await f.cloud.readRecoveryLock(groupId), null, 'preview does not freeze anyone');
  const restarted = await f.owner.restart(); assert.deepEqual((await restarted.recovery.read()).draft.review, review);
  const upload = f.cloud.upload; f.cloud.upload = async () => { throw Object.assign(new Error('post-recovery offline'), { code: 'unavailable' }); };
  await assert.rejects(restarted.recovery.confirm(review.id, review.reviewDigest), { code: 'unavailable' });
  const saved = await restarted.recovery.read(); assert.equal(saved.status, 'applied'); assert.equal(saved.locallyApplied, true);
  assert.equal((await listSharingOutbox(f.owner.database, groupId, Number.MAX_SAFE_INTEGER)).length, 1);
  assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, 7);
  assert.equal(await f.cloud.readRecoveryLock(groupId), null);
  const metadata = await f.cloud.readGroup(groupId); assert.equal(metadata.group.keyVersion, 4);
  assert.deepEqual([...metadata.group.memberIds].sort(), ['member-b', 'owner']);
  await assertFails(getDocFromServer(doc(environment.authenticatedContext('member-a').firestore(), 'sharingGroups', groupId)));
  const record = await f.cloud.readRecoveryRecord(groupId, saved.snapshotId);
  const encoded = JSON.stringify(record);
  for (const value of ['壊れた通信', '正常な独立変更', '消さずに保留', review.entries[0].operationId, 'baselineIndexDigest', 'retainedIndexDigest']) assert.equal(encoded.includes(value), false);
  const header = await openV2RecoveryHeader(crypto, JSON.parse(record.encryptedHeaderJson), f.owner.keys.get(4), f.owner.archive(), { groupId, snapshotId: saved.snapshotId, keyVersion: 4 });
  assert.deepEqual(header.body.entries, review.entries);
  const checkpoint = await f.b.deps.readRecord(); assert.equal(checkpoint.status, 'active');
  const originalRead = f.b.cloud.readRecoveryOriginals;
  f.b.cloud.readRecoveryOriginals = async (...args) => (await originalRead(...args)).map((raw, i) => i ? raw : { ...raw, envelopeJson: 'modified evidence' });
  const bBefore = await loadSharedReplica(f.b.database, groupId);
  await assert.rejects(f.b.synchronizer.sync({ force: true }), /immutable original evidence/);
  assert.deepEqual(await loadSharedReplica(f.b.database, groupId), bBefore);
  f.b.cloud.readRecoveryOriginals = originalRead; await f.b.synchronizer.sync({ force: true });
  const received = await loadSharedReplica(f.b.database, groupId);
  assert.equal(received.operations.some(op => op.operationId === 'independent-one'), true);
  assert.equal(received.operations.some(op => op.operationId === 'corrupt-one' || op.operationId === 'dependent-one'), false);
  assert.equal(received.recoveryWitnesses[0].preservedFacts[0].fact.operation.operationId, 'dependent-one');
  assert.equal(f.b.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_recovery_originals').get().n, 2);
  assert.equal((await listSharingOutbox(f.b.database, groupId)).length, 0);
  f.cloud.upload = upload; await restarted.synchronizer.sync({ force: true }); await f.b.synchronizer.sync({ force: true });
  assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, 0);
  await restarted.manager.publishSnapshot(); await f.b.synchronizer.sync({ force: true });
  assert.equal((await loadSharedReplica(f.b.database, groupId)).recoveryWitnesses[0].body.snapshotId, saved.snapshotId);
  const removed = await f.cloud.compactHistory(groupId, Date.now() + 8 * 24 * 60 * 60_000); assert.ok(removed.deleted > 0);
  for (const id of ['corrupt-one', 'dependent-one']) {
    assert.equal((await getDocFromServer(doc(f.root, 'events', id))).exists(), true);
    await assertFails(deleteDoc(doc(f.root, 'events', id)));
  }
  await f.b.synchronizer.sync({ force: true });
  assert.equal((await loadSharedReplica(f.b.database, groupId)).pendingOperationIds.length, 0);
});

test('recovery cancellation persists before a late start and releases a current lock without erasing the review originals or edits', async t => {
  const f = await fixture(t); await f.send(f.a, 'corrupt-one', '保存する元の変更', true);
  const review = await f.owner.recovery.prepare(); const roster = f.owner.archive().at(-1);
  const lock = signV2RecoveryLock(roster, f.owner.identity, { id: review.id, throughSequence: review.throughSequence, reviewDigest: review.reviewDigest });
  await f.cloud.cancelRecoveryLock(lock); await assert.rejects(f.cloud.startRecoveryLock(lock), /中断済み/u);
  assert.equal(await f.cloud.readRecoveryLock(groupId), null);
  await f.owner.recovery.cancel(review.id, review.reviewDigest); assert.equal((await f.owner.recovery.read()).status, 'cancelled');
  const next = await f.owner.recovery.prepare();
  await f.cloud.startRecoveryLock(signV2RecoveryLock(roster, f.owner.identity, { id: next.id, throughSequence: next.throughSequence, reviewDigest: next.reviewDigest }));
  await assert.rejects(f.b.synchronizer.sync({ force: true }), { code: 'sharing/recovery-in-progress' });
  await f.owner.recovery.cancel(next.id, next.reviewDigest); assert.equal(await f.cloud.readRecoveryLock(groupId), null);
  assert.equal(f.owner.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_recovery_originals').get().n, 1);
  assert.equal((await f.cloud.readGroup(groupId)).group.keyVersion, 3);
});

test('a stale owner review cannot freeze or rotate a changed log and a member cannot prepare or confirm recovery', async t => {
  const f = await fixture(t); await f.send(f.a, 'corrupt-one', 'bad', true);
  const review = await f.owner.recovery.prepare(); await f.send(f.b, 'later-one', '後から届いた正常な変更');
  await assert.rejects(f.owner.recovery.confirm(review.id, review.reviewDigest), { code: 'sharing/recovery-review-stale' });
  assert.equal(await f.cloud.readRecoveryLock(groupId), null); assert.equal((await f.cloud.readGroup(groupId)).group.keyVersion, 3);
  await assert.rejects(f.b.recovery.prepare(), { code: 'sharing/access-denied' });
  await assert.rejects(f.b.recovery.confirm(review.id, review.reviewDigest), { code: 'sharing/recovery-review-stale' });
  await f.owner.recovery.cancel(review.id, review.reviewDigest);
  const next = await f.owner.recovery.prepare(); assert.equal(next.retainedChanges, 1);
});

test('a lost final recovery response uses the actual committed next key once and retry does not create another epoch', async t => {
  const f = await fixture(t); await f.send(f.a, 'corrupt-one', 'bad', true);
  const review = await f.owner.recovery.prepare(); const commit = f.cloud.commitMembership; let attempts = 0;
  f.cloud.commitMembership = async (...args) => { attempts++; await commit(...args); throw Object.assign(new Error('lost final response'), { code: 'unavailable' }); };
  const id = await f.owner.recovery.confirm(review.id, review.reviewDigest);
  assert.equal(attempts, 1); assert.equal((await f.cloud.readGroup(groupId)).group.keyVersion, 4);
  const restarted = await f.owner.restart(); assert.equal(await restarted.recovery.confirm(review.id, review.reviewDigest), id);
  assert.equal(attempts, 1); assert.equal((await f.cloud.readGroup(groupId)).group.keyVersion, 4);
  await f.b.synchronizer.sync({ force: true }); assert.equal((await loadSharedReplica(f.b.database, groupId)).recoveryWitnesses.length, 1);
});

test('recovery Rules deny non-owner controls proof replacement cross-group reads and unpaired membership or deletion while locked', async t => {
  const f = await fixture(t); await f.send(f.a, 'corrupt-one', 'bad', true);
  const review = await f.owner.recovery.prepare(); const lock = signV2RecoveryLock(f.owner.archive().at(-1), f.owner.identity,
    { id: review.id, throughSequence: review.throughSequence, reviewDigest: review.reviewDigest });
  await f.cloud.startRecoveryLock(lock);
  const otherStore = environment.authenticatedContext('member-b').firestore(); const other = doc(otherStore, 'sharingGroups', groupId);
  const lockData = (await getDocFromServer(doc(f.root, 'recoveryLocks', 'current'))).data();
  await assertFails(setDoc(doc(other, 'recoveryLocks', 'current'), { ...lockData, createdAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(other, 'recoveryLocks', 'current')));
  await assertFails(deleteDoc(doc(f.root, 'recoveryLocks', 'current')));
  await assertFails(setDoc(doc(other, 'recoveryCancellations', review.id), { schemaVersion: 1, lockId: review.id, keyVersion: 3,
    reviewDigest: review.reviewDigest, ownerDeviceId: f.owner.identity.deviceId, createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(other, 'quarantines', 'corrupt-one'), { schemaVersion: 1, recoveryId: 'fake', keyVersion: 3, uploadSequence: 5, rawDigest: 'a'.repeat(64), createdAt: serverTimestamp() }));
  const outsider = environment.authenticatedContext('outsider').firestore();
  for (const path of [['recoveryLocks', 'current'], ['recoveryCancellations', review.id], ['recoveries', 'unknown'], ['quarantines', 'corrupt-one']]) await assertFails(getDocFromServer(doc(outsider, 'sharingGroups', groupId, ...path)));
  await f.owner.recovery.confirm(review.id, review.reviewDigest);
  const stored = await f.owner.recovery.read();
  for (const path of [['recoveries', stored.snapshotId], ['quarantines', 'corrupt-one']]) {
    await assertFails(updateDoc(doc(f.root, ...path), { modified: true })); await assertFails(deleteDoc(doc(f.root, ...path)));
  }
  assert.equal((await getDocsFromServer(collection(f.root, 'recoveries'))).size, 1);
});

test('an exact original restores damaged owner transport without removing healthy devices or duplicating the original operation', async t => {
  const f = await fixture(t); const original = await f.send(f.owner, 'owner-original', '元の署名から復元する家事', true);
  const review = await f.owner.recovery.prepare();
  assert.equal(review.restoredOriginals, 1); assert.equal(review.unreadableChanges, 0); assert.deepEqual(review.removeDeviceIds, []);
  await f.owner.recovery.confirm(review.id, review.reviewDigest);
  for (const device of [f.a, f.b]) {
    await device.synchronizer.sync({ force: true });
    const facts = await loadSharedFacts(device.database, groupId);
    assert.deepEqual(facts.find(fact => fact.operation.operationId === 'owner-original'), original.fact);
  }
  assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, 5);
  assert.deepEqual((await f.cloud.readGroup(groupId)).group.memberIds, ['member-a', 'member-b', 'owner']);
  assert.equal((await listSharingOutbox(f.owner.database, groupId, Number.MAX_SAFE_INTEGER)).length, 0);
});

test('a process interruption after quarantine preparation resumes the confirmed intent with fresh encryption while reusing immutable original protection', async t => {
  const f = await fixture(t); await f.send(f.a, 'corrupt-one', '保護する元の暗号文', true);
  const review = await f.owner.recovery.prepare(); const prepare = f.cloud.prepareSnapshot;
  f.cloud.prepareSnapshot = async () => { throw Object.assign(new Error('interrupted before snapshot upload'), { code: 'unavailable' }); };
  await assert.rejects(f.owner.recovery.confirm(review.id, review.reviewDigest), { code: 'unavailable' });
  assert.equal((await f.owner.recovery.read()).status, 'confirming'); assert.ok(await f.cloud.readRecoveryLock(groupId));
  await assert.rejects(f.b.synchronizer.sync({ force: true }), { code: 'sharing/recovery-in-progress' });
  const old = (await f.cloud.readRecoveryQuarantines(groupId, ['corrupt-one']))[0];
  f.cloud.prepareSnapshot = prepare; const restart = await f.owner.restart();
  const newSnapshot = await restart.recovery.confirm(review.id, review.reviewDigest); assert.notEqual(old.recoveryId, newSnapshot);
  assert.deepEqual((await f.cloud.readRecoveryQuarantines(groupId, ['corrupt-one']))[0], old);
  await f.b.synchronizer.sync({ force: true }); assert.equal((await loadSharedReplica(f.b.database, groupId)).recoveryWitnesses.length, 1);
});

test('maximum 256-event recovery obeys Rules access limits and protected originals do not starve ordinary history compaction', async t => {
  const f = await fixture(t); const key = f.a.keys.get(3); const ownerSequence = 4;
  for (let index = 0; index < 256; index++) {
    const operation = { schemaVersion: 2, groupId, operationId: `corrupt-${index}`, authorUserId: 'member-a', authorDeviceId: f.a.identity.deviceId,
      keyVersion: 3, deviceSequence: index + 1, logicalClock: index + ownerSequence + 1, recordedAt: new Date().toISOString(), receiptContext: {},
      context: { [f.owner.identity.deviceId]: ownerSequence, ...(index ? { [f.a.identity.deviceId]: index } : {}) },
      entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: `合成データ ${index}` } };
    const envelope = await encryptSharedOperation(crypto, operation, key, f.a.identity);
    const { signature: _old, ...body } = envelope;
    body.encryptedPayload = `${body.encryptedPayload.startsWith('00') ? 'ff' : '00'}${body.encryptedPayload.slice(2)}`;
    await f.a.cloud.upload({ ...body, signature: signSharedDocument(body, f.a.identity) }, { authorProofDigest: v2AuthorProofDigest(signSharedOperation(operation, f.a.identity)) });
  }
  const review = await f.owner.recovery.prepare(); assert.equal(review.unreadableChanges, 256);
  await f.owner.recovery.confirm(review.id, review.reviewDigest); await f.b.synchronizer.sync({ force: true, budgetMs: 120_000 });
  assert.equal((await f.cloud.readRecoveryOriginals(groupId, review.entries.map(entry => entry.operationId))).length, 256);
  await f.send(f.owner, 'ordinary-after-recovery', '正常な変更'); await f.owner.manager.publishSnapshot();
  for (let page = 0; page < 4; page++) await f.cloud.compactHistory(groupId, Date.now() + 8 * 24 * 60 * 60_000);
  assert.equal((await getDocFromServer(doc(f.root, 'events', 'ordinary-after-recovery'))).exists(), false);
  assert.equal((await getDocsFromServer(collection(f.root, 'events'))).size, 256);
});

test('disabled owner recovery preserves ordinary single-group v2 sync membership and compaction', async t => {
  const legacy = await initializeTestEnvironment({ projectId: 'demo-liflow-owner-recovery-legacy',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  try {
    await legacy.clearFirestore(); const f = await fixture(t, { recoveryEnabled: false, env: legacy });
    assert.equal(f.cloud.ownerRecoveryEnabled, false);
    await f.owner.repository.commit([{ operationId: 'ordinary', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: '以前の接続先でも同期する' } }]);
    await f.owner.synchronizer.sync({ force: true }); await f.b.synchronizer.sync({ force: true });
    assert.ok((await loadSharedReplica(f.b.database, groupId)).operations.some(op => op.operationId === 'ordinary'));
    await f.owner.manager.publishSnapshot(); await f.cloud.compactHistory(groupId, Date.now() + 8 * 24 * 60 * 60_000);
    await assert.rejects(f.owner.recovery.prepare(), /復旧機能の準備/u);
  } finally { await legacy.cleanup(); }
});
