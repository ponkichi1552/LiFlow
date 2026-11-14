import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createSharedDeliveryArchive } from '../src/platform/storage/sharing-delivery-archive.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation, encryptSharedOperation, decryptAuthenticatedSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { sweepSharedDeliveries, sweepPrivateDeliveries, startSharedDeliveryWorker } from '../server/appliance-care-api/src/sharing-delivery-worker.mjs';
import { privatePlannerSyncFixture, privatePreferenceInput } from './helpers/private-planner-sync.mjs';
import { createPrivateDelivery } from '../src/platform/sharing/private-delivery.ts';
import { createPrivateDeliveryArchive } from '../src/platform/storage/private-delivery-archive.ts';
import { createPrivateCalendarCloud } from '../src/platform/sharing/private-calendar-cloud.ts';
import { createPrivatePlannerCloud } from '../src/platform/sharing/private-planner-cloud.ts';
import { sealPrivatePreferences, privatePreferenceCursor } from '../src/features/sharing/private-planner/preference-crypto.ts';
import { sealPrivateCalendarCache, openPrivateCalendarCache } from '../src/features/sharing/private-calendar/cache-crypto.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';

if (!/^127\.0\.0\.1:\d+$/u.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Use the isolated local Firestore emulator only');
const require = createRequire(new URL('../server/appliance-care-api/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app'); const { getFirestore } = require('firebase-admin/firestore');
let environment, admin, store;
before(async () => {
  environment = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  admin = initializeApp({ projectId: 'demo-liflow-sharing' }, 'delivery-integration'); store = getFirestore(admin);
});
beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { await store?.terminate(); await deleteApp(admin); await environment?.cleanup(); });
const groupId = 'synthetic-delivery-group';

async function privateFixture(t) {
  const h = await privatePlannerSyncFixture(t, { ownerUserId: 'synthetic-private-delivery-owner' });
  const uid = h.ownerUserId; const db = environment.authenticatedContext(uid).firestore();
  const setup = createPrivateCalendarCloud(db, uid, () => uid, crypto); await setup.createRoot(h.root); await setup.commitAuthority(h.root, h.authority);
  function device(f) {
    const assertOwner = () => assert.equal(f.state.currentUser, uid);
    const archive = createPrivateDeliveryArchive({ ownerUserId: uid, exclusive: f.exclusive, assertOwner });
    const delivery = createPrivateDelivery({ firestore: db, userId: uid, archive, assertOwner,
      state: async () => { const current = await f.secrets.publicState(uid); return current ? { identity: current.identity, authority: current.authority } : null; } });
    const calendar = createPrivateCalendarCloud(db, uid, () => f.state.currentUser, crypto, delivery);
    const planner = createPrivatePlannerCloud(db, uid, () => f.state.currentUser, delivery);
    return { f, delivery, archive, calendar, planner, ...h.service(f, { cloud: planner }) };
  }
  const left = device(h.left.f), right = device(h.right.f); const calendarBinding = 'synthetic-private-calendar-binding';
  const cache = { ownerUserId: uid, accountGeneration: h.authority.signed.body.accountGeneration, mainDeviceId: h.author.deviceId,
    mainRevision: h.authority.signed.body.revision, calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: '2026-11-15T00:00:00.000Z',
    coverage: { start: '2026-11-15T00:00:00.000Z', end: '2026-12-15T00:00:00.000Z' },
    intervals: [{ start: '2026-11-15T01:00:00.000Z', end: '2026-11-15T02:00:00.000Z' }] };
  const encrypted = await sealPrivateCalendarCache(crypto, { cache, authority: h.authority, calendarBinding, accountKey: h.key, mainDevice: h.author, sequence: 1 });
  const preferences = await sealPrivatePreferences(crypto, { preferences: privatePreferenceInput(), authority: h.authority, author: h.author, accountKey: h.key, parent: null });
  const upload = async () => {
    await left.planner.publish(h.authority, preferences); await left.calendar.uploadCache(h.authority, encrypted);
    await left.delivery.confirm(h.authority, 'calendar', sharedDocumentDigest(encrypted.manifest));
    await left.delivery.confirm(h.authority, 'preferences', privatePreferenceCursor(preferences).digest);
  };
  const receive = async () => {
    await right.planner.read(h.authority); await right.calendar.readCache(h.authority);
    await right.delivery.confirm(h.authority, 'calendar', sharedDocumentDigest(encrypted.manifest));
    await right.delivery.confirm(h.authority, 'preferences', privatePreferenceCursor(preferences).digest);
  };
  return { ...h, uid, left, right, cache, encrypted, preferences, calendarBinding, device, upload, receive };
}

test('private device delivery erases received preference and busy ciphertext while durable peer archives preserve exact recovery and idempotent publication', async t => {
  const h = await privateFixture(t); await h.upload(); await h.receive();
  assert.equal((await sweepPrivateDeliveries(store, h.uid)).active, true);
  const root = store.doc(`privateCalendars/${h.uid}`); const saved = (await root.collection('plannerPreferences').doc('current').get()).data();
  assert.equal(saved.encryptedJson, null); assert.ok(saved.erasedAt);
  assert.equal((await root.collection('caches').doc(h.encrypted.manifest.body.cacheId).collection('parts').get()).size, 0);
  assert.equal((await h.left.calendar.uploadCache(h.authority, h.encrypted)).published, false, 'a lost publication response does not upload erased bytes again');
  await h.right.f.exclusive(h.uid, database => database.execAsync('DELETE FROM private_delivery_archive'));
  const restored = h.device(h.right.f); const source = h.device(h.left.f);
  await assert.rejects(restored.planner.read(h.authority), error => error.code === 'sharing/delivery-pending');
  await source.planner.read(h.authority);
  assert.deepEqual(await restored.planner.read(h.authority), h.preferences);
  await assert.rejects(restored.calendar.readCache(h.authority), error => error.code === 'sharing/delivery-pending');
  const resumedSource = h.device(h.left.f); await resumedSource.planner.read(h.authority);
  const received = await restored.calendar.readCache(h.authority);
  assert.deepEqual(await openPrivateCalendarCache(crypto, received, { authority: h.authority, calendarBinding: h.calendarBinding, accountKey: h.key }), h.cache);
  await restored.delivery.confirm(h.authority, 'calendar', sharedDocumentDigest(h.encrypted.manifest));
  await restored.delivery.confirm(h.authority, 'preferences', privatePreferenceCursor(h.preferences).digest);
  await sweepPrivateDeliveries(store, h.uid);
  assert.equal((await root.collection('deliveryRequests').get()).size, 0);
});

test('expired private delivery rehydrates through a peer before merging and keeps both an unsent local edit and its explicit conflict candidate', async t => {
  const h = await privateFixture(t); await h.upload(); await h.receive();
  await h.left.store.save(0, privatePreferenceInput()); await h.right.store.save(0, privatePreferenceInput());
  await h.left.sync.synchronize(true); await h.right.sync.synchronize(true);
  const leftBefore = await h.left.store.readSyncState(), rightBefore = await h.right.store.readSyncState();
  await h.left.store.save(leftBefore.local.revision, { ...privatePreferenceInput(), restDays: [1] });
  assert.equal((await h.left.sync.synchronize(true)).kind, 'sent');
  await h.right.store.save(rightBefore.local.revision, { ...privatePreferenceInput(), restDays: [2] });
  await sweepPrivateDeliveries(store, h.uid, Date.now() + 86400_001);
  await h.right.f.exclusive(h.uid, database => database.execAsync('DELETE FROM private_delivery_archive'));
  const right = h.device(h.right.f); await assert.rejects(right.sync.synchronize(true), error => error.code === 'sharing/delivery-pending');
  await h.device(h.left.f).planner.read(h.authority);
  assert.equal((await right.sync.synchronize(true)).kind, 'conflict');
  const kept = await right.store.readSyncState(); assert.deepEqual(kept.local.restDays, [2]); assert.deepEqual(kept.review.preferences.restDays, [1]);
  const outsider = environment.authenticatedContext('unrelated-group-owner').firestore();
  await assertFails(getDocFromServer(doc(outsider, 'privateCalendars', h.uid, 'deliveryControl', 'policy')));
  h.right.f.state.currentUser = 'another-user'; await assert.rejects(right.planner.read(h.authority));
});

test('private delivery retains ciphertext while one approved device has not seeded the new protocol and never treats expiry as an empty preference baseline', async t => {
  const h = await privateFixture(t); await h.upload();
  assert.equal((await sweepPrivateDeliveries(store, h.uid, Date.now() + 10 * 86400_000)).active, false);
  assert.equal((await store.doc(`privateCalendars/${h.uid}/plannerPreferences/current`).get()).data().encryptedJson.length > 0, true);
  await h.receive(); await sweepPrivateDeliveries(store, h.uid, Date.now() + 86400_001);
  await h.right.f.exclusive(h.uid, database => database.execAsync('DELETE FROM private_delivery_archive'));
  const restored = h.device(h.right.f);
  await assert.rejects(restored.planner.read(h.authority), error => error.code === 'sharing/delivery-pending');
  await assert.rejects(restored.planner.read(h.authority), error => error.code === 'sharing/delivery-pending');
});
async function fixture() {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const first = createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 });
  const roster = approveSharedDevice(first, owner, 'member', member); const archive = [first, roster]; const dbs = [];
  await store.doc(`sharingGroups/${groupId}`).set({ ...rosterCloudFields(roster), headSequence: 0, lastOperationId: null,
    snapshotId: null, snapshotThroughSequence: 0, createdAt: new Date(), updatedAt: new Date() });
  async function device(uid, identity, enabled = true) {
    const db = createDatabase(); dbs.push(db); let active = uid;
    const firestore = environment.authenticatedContext(uid).firestore();
    const cloud = createSharingCloud(firestore, uid, () => active);
    const local = await createSharedDeliveryArchive(db.database, groupId, async work => work(), () => { if (active !== uid) throw new Error('synthetic account changed'); });
    if (enabled) cloud.setDeliveryArchive(identity.deviceId, local, () => archive);
    return { db, cloud, local, firestore, switchAccount: () => { active = 'someone-else'; } };
  }
  async function upload(source, sequence = 1) {
    const operation = { schemaVersion: 2, groupId, operationId: `synthetic-delivery-${sequence}`, authorUserId: 'owner', authorDeviceId: owner.deviceId,
      keyVersion: roster.body.keyVersion, deviceSequence: sequence, logicalClock: sequence, context: sequence === 1 ? {} : { [owner.deviceId]: sequence - 1 },
      receiptContext: {}, recordedAt: '2026-11-15T00:00:00Z', entityType: 'chore', entityId: 'synthetic-floor', operationType: 'patch', payload: { name: `合成した家事${sequence}` } };
    const fact = signSharedOperation(operation, owner); const envelope = await encryptSharedOperation(crypto, operation, key, owner);
    const event = await source.cloud.upload(envelope, { authorProofDigest: v2AuthorProofDigest(fact) }); return { fact, event };
  }
  return { owner, member, key, roster, archive, device, upload, close: () => dbs.forEach(db => db.connection.close()) };
}

test('shared delivery erases acknowledged ciphertext and a fresh approved device recovers original signed events from a peer without losing its unsent edit', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner); const receiver = await f.device('member', f.member);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 0);
    const { event, fact } = await f.upload(source);
    assert.equal((await receiver.cloud.pull(groupId, 0)).events.length, 1);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 1); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 1);
    assert.equal((await sweepSharedDeliveries(store, groupId)).active, true);
    assert.equal((await store.doc(`sharingGroups/${groupId}/events/${event.operationId}`).get()).exists, false);
    assert.equal((await store.doc(`sharingGroups/${groupId}/receipts/${event.operationId}`).get()).exists, true, 'minimal authority/replay proof remains');
    const restored = await f.device('member', f.member); restored.db.connection.exec("CREATE TABLE synthetic_outbox(value TEXT); INSERT INTO synthetic_outbox VALUES('unsent local edit')");
    await assert.rejects(restored.cloud.pull(groupId, 0), error => error.code === 'sharing/delivery-pending');
    await source.cloud.prepareDelivery(groupId);
    const page = await restored.cloud.pull(groupId, 0); assert.deepEqual(page.events[0], event);
    assert.deepEqual(await decryptAuthenticatedSharedOperation(crypto, page.events[0].envelope, f.key, f.owner, groupId, f.roster.body.keyVersion), fact);
    await restored.cloud.acknowledge(groupId, f.member.deviceId, 1);
    await sweepSharedDeliveries(store, groupId);
    assert.equal((await store.collection(`sharingGroups/${groupId}/deliveryRequests`).get()).size, 0);
    assert.equal((await store.collectionGroup('parts').get()).size, 0, 'receipt removes nested ciphertext parts too');
    assert.equal(restored.db.connection.prepare('SELECT value FROM synthetic_outbox').get().value, 'unsent local edit');
  } finally { f.close(); }
});

test('shared ciphertext expires after twenty four hours without a receiver acknowledgement and a missing peer never yields an empty replacement', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner); const receiver = await f.device('member', f.member);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 0);
    const { event } = await f.upload(source);
    await sweepSharedDeliveries(store, groupId, Date.now() + 86400_001);
    assert.equal((await store.doc(`sharingGroups/${groupId}/events/${event.operationId}`).get()).exists, false);
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(receiver.cloud.pull(groupId, 0), error => error.code === 'sharing/delivery-pending');
    assert.equal((await store.collection(`sharingGroups/${groupId}/deliveryRequests`).get()).size, 1, 'pending work reuses one small request');
    await source.cloud.prepareDelivery(groupId); assert.equal((await receiver.cloud.pull(groupId, 0)).events.length, 1);
  } finally { f.close(); }
});

test('a negotiated closed group with no remaining recipients still expires old ciphertext without deleting its independent receipt', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner), receiver = await f.device('member', f.member);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 0);
    const { event } = await f.upload(source); assert.equal((await sweepSharedDeliveries(store, groupId)).active, true);
    const root = store.doc(`sharingGroups/${groupId}`); await root.update({ closed: true, revokedUserIds: ['owner', 'member'] });
    assert.equal((await sweepSharedDeliveries(store, groupId, Date.now() + 86400_001)).active, false);
    assert.equal((await root.collection('events').get()).size, 0);
    assert.equal((await root.collection('receipts').doc(event.operationId).get()).exists, true);
  } finally { f.close(); }
});

test('a durable relay receipt closes late and partial responders before recursive erasure so no orphan ciphertext survives a concurrent sender', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner); const receiver = await f.device('member', f.member);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 0);
    const { event } = await f.upload(source); await sweepSharedDeliveries(store, groupId, Date.now() + 86400_001);
    await assert.rejects(receiver.cloud.pull(groupId, 0), error => error.code === 'sharing/delivery-pending');
    const request = (await store.collection(`sharingGroups/${groupId}/deliveryRequests`).get()).docs[0];
    const expiresAt = Timestamp.fromMillis(request.data().expiresAt.toMillis());
    const response = doc(source.firestore, request.ref.path, 'responses', f.owner.deviceId);
    await assertFails(setDoc(doc(response, 'parts', '0'), { index: 0, data: 'eA==', expiresAt, createdAt: serverTimestamp() }));
    await setDoc(response, { schemaVersion: 1, userId: 'owner', deviceId: f.owner.deviceId, digest: 'a'.repeat(64),
      size: 1, parts: 1, ready: false, expiresAt, createdAt: serverTimestamp() });
    await setDoc(doc(response, 'parts', '0'), { index: 0, data: 'eA==', expiresAt, createdAt: serverTimestamp() });
    await assertFails(deleteDoc(response));
    // Model another peer's complete, independently receipted delivery winning this race.
    await receiver.local.saveEvents([event]); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 1);
    assert.ok((await request.ref.get()).data().receivedAt);
    await assertFails(updateDoc(response, { ready: true })); await assertFails(deleteDoc(doc(receiver.firestore, request.ref.path)));
    await sweepSharedDeliveries(store, groupId);
    assert.equal((await store.collection(`sharingGroups/${groupId}/deliveryRequests`).get()).size, 0);
    assert.equal((await store.collectionGroup('parts').get()).size, 0);
  } finally { f.close(); }
});

test('shared delivery never activates erasure with an old unseeded approved device or allows a client to activate it or impersonate another recipient', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner); const legacy = await f.device('member', f.member, false);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); const { event } = await f.upload(source);
    const cleanup = await sweepSharedDeliveries(store, groupId, Date.now() + 10 * 86400_000);
    assert.equal(cleanup.active, false); assert.equal((await store.doc(`sharingGroups/${groupId}/events/${event.operationId}`).get()).exists, true);
    await assertFails(setDoc(doc(source.firestore, 'sharingGroups', groupId, 'deliveryControl', 'policy'), { schemaVersion: 1, ttlMs: 86400_000, enabled: true, active: true, createdAt: serverTimestamp() }));
    await assertFails(setDoc(doc(legacy.firestore, 'sharingGroups', groupId, 'deliveryDevices', f.owner.deviceId), { schemaVersion: 1, userId: 'member', deviceId: f.owner.deviceId, seededThrough: 0, createdAt: serverTimestamp() }));
    const outsider = environment.authenticatedContext('outsider').firestore();
    await assertFails(getDocFromServer(doc(outsider, 'sharingGroups', groupId, 'deliveryControl', 'policy')));
  } finally { f.close(); }
});

test('peer snapshot recovery preserves owner authority after current snapshot chunks are erased and expires abandoned nested transfer parts', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner); const receiver = await f.device('member', f.member);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 0);
    const { fact } = await f.upload(source); const author = (uid, id, version) => sharedAuthorIdentity(f.archive.find(epoch => epoch.body.keyVersion === version), uid, id, version);
    const snapshot = await createEncryptedSharedSnapshot(crypto, buildSharedReplica(groupId, [fact.operation]), [fact], f.roster, f.owner, f.key, 'synthetic-current-snapshot', 1, author, f.archive);
    await source.cloud.prepareSnapshot(snapshot, f.roster); await source.cloud.publishSnapshot(snapshot.manifest, f.roster);
    const received = await receiver.cloud.readSnapshot(groupId, snapshot.manifest.body.snapshotId, f.archive);
    await openEncryptedSharedSnapshot(crypto, received, f.key, f.roster, author, f.archive);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 1); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 1);
    await sweepSharedDeliveries(store, groupId);
    assert.equal((await store.collection(`sharingGroups/${groupId}/snapshotChunks`).get()).size, 0);
    assert.equal((await store.collection(`sharingGroups/${groupId}/snapshots`).get()).size, 1, 'the small signed manifest stays as an integrity anchor');
    const restored = await f.device('member', f.member);
    await assert.rejects(restored.cloud.readSnapshot(groupId, snapshot.manifest.body.snapshotId, f.archive), error => error.code === 'sharing/delivery-pending');
    await source.cloud.prepareDelivery(groupId);
    const result = await restored.cloud.readSnapshot(groupId, snapshot.manifest.body.snapshotId, f.archive);
    assert.deepEqual((await openEncryptedSharedSnapshot(crypto, result, f.key, f.roster, author, f.archive)).facts, [fact]);
    const requests = await store.collection(`sharingGroups/${groupId}/deliveryRequests`).get();
    await sweepSharedDeliveries(store, groupId, Date.now() + 86400_001);
    assert.ok(requests.size > 0); assert.equal((await store.collection(`sharingGroups/${groupId}/deliveryRequests`).get()).size, 0);
    assert.equal((await store.collectionGroup('parts').get()).size, 0);
  } finally { f.close(); }
});

test('delivery cleanup observes an abandoned snapshot upload without a root update and erases its expired ciphertext', async () => {
  const f = await fixture(); let stop;
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, 'delivery worker did not process a real metadata change'); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  try {
    const source = await f.device('owner', f.owner), receiver = await f.device('member', f.member);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 0);
    const root = store.doc(`sharingGroups/${groupId}`); stop = startSharedDeliveryWorker(store);
    await until(async () => (await root.collection('deliveryControl').doc('policy').get()).data()?.active === true);
    const before = (await root.get()).updateTime.toMillis();
    const batch = store.batch();
    for (let part = 0; part < 12; part++) batch.set(root.collection('snapshotChunks').doc(`synthetic-interrupted-upload-${part}`), {
      snapshotId: 'synthetic-unpublished-snapshot', keyVersion: f.roster.body.keyVersion,
      envelopeJson: 'synthetic-ciphertext', createdAt: new Date(Date.now() - 86400_001) });
    await batch.commit();
    await until(async () => (await root.collection('snapshotChunks').get()).empty);
    assert.equal((await root.get()).updateTime.toMillis(), before, 'no group change was needed to trigger expiry');
  } finally { stop?.(); f.close(); }
});
