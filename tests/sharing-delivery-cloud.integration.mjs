import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { collection, disableNetwork, doc, enableNetwork, getDocFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query,
  setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createSharedDeliveryArchive } from '../src/platform/storage/sharing-delivery-archive.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation, encryptSharedOperation, decryptAuthenticatedSharedOperation, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
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
import { tracedDeliveryRelay } from './helpers/delivery-relay-trace.mjs';

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
async function eventually(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function privateResponsesReady(userId) {
  await eventually(async () => {
    const requests = await store.collection(`privateCalendars/${userId}/deliveryRequests`).get();
    const ready = await Promise.all(requests.docs.filter(request => request.data().receivedAt === undefined).map(async request => {
      const replies = await request.ref.collection('responses').get(); return replies.docs.some(reply => reply.data().ready === true);
    }));
    return ready.every(Boolean);
  }, 'the private peer did not finish its independent response');
}

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
  await privateResponsesReady(h.uid);
  assert.deepEqual(await restored.planner.read(h.authority), h.preferences);
  await assert.rejects(restored.calendar.readCache(h.authority), error => error.code === 'sharing/delivery-pending');
  const resumedSource = h.device(h.left.f); await resumedSource.planner.read(h.authority);
  await privateResponsesReady(h.uid);
  const received = await restored.calendar.readCache(h.authority);
  assert.deepEqual(await openPrivateCalendarCache(crypto, received, { authority: h.authority, calendarBinding: h.calendarBinding, accountKey: h.key }), h.cache);
  await restored.delivery.confirm(h.authority, 'calendar', sharedDocumentDigest(h.encrypted.manifest));
  await restored.delivery.confirm(h.authority, 'preferences', privatePreferenceCursor(h.preferences).digest);
  await sweepPrivateDeliveries(store, h.uid);
  assert.equal((await root.collection('deliveryRequests').get()).size, 0);
});

test('a durable private receipt retries interrupted device readiness with the same digest and coalesces unchanged confirmations', async t => {
  const h = await privateFixture(t); await h.upload();
  const calendarDigest = sharedDocumentDigest(h.encrypted.manifest);
  const preferencesId = `preferences.${privatePreferenceCursor(h.preferences).digest}`;
  await h.right.archive.saveChunk(`calendar.${calendarDigest}`, h.encrypted);
  await h.right.archive.saveChunk(preferencesId, h.preferences);
  const originalChunk = h.right.archive.chunk;
  let preferenceReads = 0;
  t.mock.method(h.right.archive, 'chunk', async id => {
    if (id === preferencesId && ++preferenceReads === 1) throw new Error('synthetic archive interruption');
    return originalChunk(id);
  });
  const confirm = () => h.right.delivery.confirm(h.authority, 'calendar', calendarDigest);
  const root = store.doc(`privateCalendars/${h.uid}`);
  const deviceId = (await h.right.f.secrets.publicState(h.uid)).identity.deviceId;
  const receipt = root.collection('deliveryAcknowledgements').doc(deviceId);
  const capability = root.collection('deliveryDevices').doc(deviceId);
  await assert.rejects(confirm(), /synthetic archive interruption/);
  const durable = await receipt.get();
  assert.equal(durable.data()?.calendarDigest, calendarDigest);
  assert.equal((await capability.get()).exists, false);
  await Promise.all([confirm(), confirm()]);
  const ready = await capability.get();
  assert.equal(ready.exists, true, 'a receipt already saved before the interruption must still finish the readiness notification');
  await confirm();
  assert.equal(preferenceReads, 2, 'concurrent retries share one seed check and settled confirmations skip it');
  assert.ok((await receipt.get()).updateTime.isEqual(durable.updateTime));
  assert.ok((await capability.get()).updateTime.isEqual(ready.updateTime));
});

test('an unchanged private receipt finishes readiness when its missing companion is later stored without another domain confirmation', async t => {
  const h = await privateFixture(t); await h.upload();
  const digest = sharedDocumentDigest(h.encrypted.manifest), calendarId = `calendar.${digest}`;
  const preferenceId = `preferences.${privatePreferenceCursor(h.preferences).digest}`;
  await h.right.delivery.remember(h.authority, calendarId, h.encrypted);
  const root = store.doc(`privateCalendars/${h.uid}`), deviceId = (await h.right.f.secrets.publicState(h.uid)).identity.deviceId;
  const receipt = root.collection('deliveryAcknowledgements').doc(deviceId), capability = root.collection('deliveryDevices').doc(deviceId);
  const read = h.right.archive.chunk; let calendarReads = 0;
  t.mock.method(h.right.archive, 'chunk', async id => { if (id === calendarId) calendarReads++; return read(id); });
  const confirm = () => h.right.delivery.confirm(h.authority, 'calendar', digest);
  await confirm(); const durable = await receipt.get();
  assert.equal(durable.data()?.calendarDigest, digest);
  const before = calendarReads; await confirm();
  assert.equal(calendarReads - before, 1, 'waiting for the same missing companion must not re-read the whole calendar seed');
  assert.equal((await capability.get()).exists, false);
  await h.right.delivery.remember(h.authority, preferenceId, h.preferences);
  await Promise.all([confirm(), confirm()]);
  assert.equal((await capability.get()).exists, true, 'the same confirmed digest must resume readiness after its companion is stored');
  assert.ok((await receipt.get()).updateTime.isEqual(durable.updateTime));
});

test('serving another private device cannot delay a normal preferences read and an account change cancels its delayed response', async t => {
  const h = await privateFixture(t); await h.upload(); await h.receive(); let release, read, stop;
  const source = h.device(h.left.f), target = h.device(h.right.f); const id = 'synthetic-private-delayed';
  try {
    await source.archive.saveChunk(id, { encryptedPayload: 'synthetic-private-opaque' });
    await assert.rejects(target.delivery.recover(h.authority, id), error => error.code === 'sharing/delivery-pending');
    const failures = []; stop = source.delivery.watch(() => {}, error => failures.push(error));
    let entered; const blocked = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const previous = source.archive.chunk;
    source.archive.chunk = async key => { if (key === id) { entered(); await gate; } return previous(key); };
    let resolved = false; read = source.planner.read(h.authority).then(value => { resolved = true; return value; });
    await Promise.race([blocked, read]); await new Promise(setImmediate);
    assert.equal(resolved, true, 'a personal read cannot await a reply for another device');
    await blocked; h.left.f.state.currentUser = 'another-user'; release(); await read;
    await eventually(() => failures.length > 0, 'the old account response was not cancelled');
    assert.equal((await store.collectionGroup('responses').get()).size, 0);
  } finally { release?.(); stop?.(); await read?.catch(() => {}); h.left.f.state.currentUser = h.uid; }
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
  await privateResponsesReady(h.uid);
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
async function fixture(testEnvironment = environment, testStore = store) {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const first = createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 });
  const roster = approveSharedDevice(first, owner, 'member', member); const archive = [first, roster]; const dbs = [];
  await testStore.doc(`sharingGroups/${groupId}`).set({ ...rosterCloudFields(roster), headSequence: 0, lastOperationId: null,
    snapshotId: null, snapshotThroughSequence: 0, createdAt: new Date(), updatedAt: new Date() });
  async function device(uid, identity, enabled = true) {
    const db = createDatabase(); dbs.push(db); let active = uid;
    const firestore = testEnvironment.authenticatedContext(uid).firestore();
    const cloud = createSharingCloud(firestore, uid, () => active);
    const local = await createSharedDeliveryArchive(db.database, groupId, async work => work(), () => { if (active !== uid) throw new Error('synthetic account changed'); });
    if (enabled) cloud.setDeliveryArchive(identity.deviceId, local, () => archive);
    return { db, cloud, local, firestore, checkAccount: () => assert.equal(active, uid), switchAccount: () => { active = 'someone-else'; } };
  }
  async function upload(source, sequence = 1) {
    const operation = { schemaVersion: 2, groupId, operationId: `synthetic-delivery-${sequence}`, authorUserId: 'owner', authorDeviceId: owner.deviceId,
      keyVersion: roster.body.keyVersion, deviceSequence: sequence, logicalClock: sequence, context: sequence === 1 ? {} : { [owner.deviceId]: sequence - 1 },
      receiptContext: {}, recordedAt: '2026-11-15T00:00:00Z', entityType: 'chore', entityId: 'synthetic-floor', operationType: 'patch', payload: { name: `合成した家事${sequence}` } };
    const fact = signSharedOperation(operation, owner); const envelope = await encryptSharedOperation(crypto, operation, key, owner);
    const event = await source.cloud.upload(envelope, { authorProofDigest: v2AuthorProofDigest(fact) }); return { fact, event };
  }
  const transport = (target, uid, identity, local = target.local) => tracedDeliveryRelay({ firestore: target.firestore, userId: uid,
    checkAccount: target.checkAccount, reference: id => doc(target.firestore, 'sharingGroups', id), readGroup: id => target.cloud.readGroup(id) }, identity.deviceId, local);
  return { owner, member, key, roster, archive, device, upload, transport, close: () => dbs.forEach(db => db.connection.close()) };
}

test('more than eight simultaneous recovery artifacts all arrive and completed replies never reread or upload the same ciphertext', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner, false), target = await f.device('member', f.member, false);
    let reads = 0; const sender = f.transport(source, 'owner', f.owner, { ...source.local, chunk: async id => { reads++; return source.local.chunk(id); } });
    const receiver = f.transport(target, 'member', f.member);
    const values = Array.from({ length: 12 }, (_, index) => ({ id: `synthetic-bulk-${index}`, wire: { encryptedPayload: `synthetic-opaque-${index}` } }));
    for (const value of values) await source.local.saveChunk(value.id, value.wire);
    for (const value of values) await assert.rejects(receiver.relay.snapshotChunk(groupId, value.id, 0), error => error.code === 'sharing/delivery-pending');
    await sender.relay.serve(groupId);
    for (const value of values) assert.deepEqual(await receiver.relay.snapshotChunk(groupId, value.id, 0), value.wire);
    const sent = sender.counts.ciphertextCharsWritten; assert.ok(sent > 0); assert.equal(reads, values.length);
    await sender.relay.serve(groupId);
    assert.equal(sender.counts.ciphertextCharsWritten, sent); assert.equal(reads, values.length, 'an immutable completed response needs no repeated local PDF read');
    const metadata = await source.cloud.readGroup(groupId), settled = { ...sender.counts };
    sender.relay.request(groupId, metadata.group); await new Promise(setImmediate);
    assert.deepEqual(sender.counts, settled, 'normal reads cannot poll completed recovery work');
    for (const value of values) await receiver.relay.archive.saveChunk(value.id, value.wire);
    const received = { ...receiver.counts };
    for (const value of values) assert.deepEqual(await receiver.relay.snapshotChunk(groupId, value.id, 0), value.wire);
    assert.deepEqual(receiver.counts, received, 'already durable artifacts are read locally without contacting the server');
  } finally { f.close(); }
});

test('a pending recovery resumes when its source later acquires the artifact without another request or unrelated user action', async t => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner, false), target = await f.device('member', f.member, false);
    const sender = f.transport(source, 'owner', f.owner), receiver = f.transport(target, 'member', f.member);
    const id = 'synthetic-late-source-data', value = { encryptedPayload: 'synthetic-delayed-source' };
    await assert.rejects(receiver.relay.snapshotChunk(groupId, id, 0), error => error.code === 'sharing/delivery-pending');
    await sender.relay.serve(groupId); const before = { ...sender.counts };
    await sender.relay.archive.saveChunk(id, value);
    await eventually(async () => (await store.collectionGroup('responses').get()).docs.some(response => response.data().ready === true), 'the source did not wake for its newly durable artifact');
    assert.deepEqual(await receiver.relay.snapshotChunk(groupId, id, 0), value);
    assert.equal(sender.counts.queries, before.queries, 'no metadata polling is needed when the missing bytes arrive locally');
    t.diagnostic(JSON.stringify({ scenario: 'late-source-data', additionalMetadataQueries: sender.counts.queries - before.queries }));
  } finally { f.close(); }
});

test('a durable receipt for one artifact never closes a second requested artifact that has not reached device storage', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner, false), target = await f.device('member', f.member, false);
    const sender = f.transport(source, 'owner', f.owner), receiver = f.transport(target, 'member', f.member);
    for (const id of ['synthetic-saved', 'synthetic-still-receiving']) {
      await source.local.saveChunk(id, { encryptedPayload: id });
      await assert.rejects(receiver.relay.snapshotChunk(groupId, id, 0), error => error.code === 'sharing/delivery-pending');
    }
    await sender.relay.serve(groupId);
    await target.local.saveChunk('synthetic-saved', await receiver.relay.snapshotChunk(groupId, 'synthetic-saved', 0));
    await receiver.relay.acknowledge(groupId, 0);
    const requests = await store.collection(`sharingGroups/${groupId}/deliveryRequests`).get();
    const saved = requests.docs.find(row => row.data().key === 'synthetic-saved'), pending = requests.docs.find(row => row.data().key === 'synthetic-still-receiving');
    assert.ok(saved.data().receivedAt); assert.equal(pending.data().receivedAt, undefined);
    assert.deepEqual(await receiver.relay.snapshotChunk(groupId, 'synthetic-still-receiving', 0), { encryptedPayload: 'synthetic-still-receiving' });
  } finally { f.close(); }
});

test('a lost local copy recovers from an unexpired acknowledged reply but skips response queries at the parent expiry', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner, false), target = await f.device('member', f.member, false);
    const sender = f.transport(source, 'owner', f.owner), receiver = f.transport(target, 'member', f.member);
    const id = 'received-then-restored', value = { encryptedPayload: 'synthetic-durable' };
    await source.local.saveChunk(id, value);
    await assert.rejects(receiver.relay.snapshotChunk(groupId, id, 0), error => error.code === 'sharing/delivery-pending');
    await sender.relay.serve(groupId);
    await target.local.saveChunk(id, await receiver.relay.snapshotChunk(groupId, id, 0));
    await receiver.relay.acknowledge(groupId, 0);
    const requests = store.collection(`sharingGroups/${groupId}/deliveryRequests`);
    const closed = (await requests.get()).docs[0]; assert.ok(closed.data().receivedAt);
    const empty = await f.device('member', f.member, false), restored = f.transport(empty, 'member', f.member);
    assert.deepEqual(await restored.relay.snapshotChunk(groupId, id, 0), value, 'a retained unexpired reply must still restore a lost local copy');
    assert.equal(restored.counts.writes, 0);
    const pending = () => assert.rejects(restored.relay.snapshotChunk(groupId, id, 0), error => error.code === 'sharing/delivery-pending');
    await store.recursiveDelete(closed.ref.collection('responses'));
    const beforeEmpty = restored.counts.queries;
    await pending(); await pending();
    assert.equal(restored.counts.queries - beforeEmpty, 1, 'a closed response list only needs to be confirmed empty once');
    await closed.ref.delete(); await pending(); await sender.relay.serve(groupId);
    assert.deepEqual(await restored.relay.snapshotChunk(groupId, id, 0), value, 'a freshly created request with the same daily ID must receive again');
    const replacement = (await requests.get()).docs[0];
    const reply = (await replacement.ref.collection('responses').get()).docs[0];
    const slightlyLater = new Date(Date.now() + 30_000);
    await replacement.ref.update({ createdAt: new Date(Date.now() - 86400_001), expiresAt: slightlyLater });
    await reply.ref.update({ expiresAt: slightlyLater });
    const beforeExpiry = restored.counts.queries;
    await pending();
    assert.equal(restored.counts.queries, beforeExpiry, 'the server-created age bounds delivery even if the declared expiry is later');
    await replacement.ref.update({ createdAt: new Date(), expiresAt: new Date(Date.now() - 1) });
    await pending();
    assert.equal(restored.counts.queries, beforeExpiry, 'the explicit parent expiry also skips response and part queries');
    assert.deepEqual(await receiver.relay.snapshotChunk(groupId, id, 0), value, 'the already durable local copy survives the server deadline');
  } finally { f.close(); }
});

test('an expired recovery releases its response listener and durable-receipt checks while a live sibling keeps listening', async t => {
  const f = await fixture();
  try {
    const target = await f.device('member', f.member, false);
    const checked = [];
    const receiver = f.transport(target, 'member', f.member, { ...target.local,
      chunk: async id => { checked.push(id); return target.local.chunk(id); } });
    const requests = store.collection(`sharingGroups/${groupId}/deliveryRequests`);
    const base = Date.now();
    for (const [key, expiresIn] of [['expiring', 60_000], ['pending', 600_000]]) {
      await requests.doc(key).set({ schemaVersion: 1, userId: 'member', deviceId: f.member.deviceId, kind: 'chunk', key,
        after: 0, through: 0, keyVersion: f.roster.body.keyVersion, createdAt: new Date(base), expiresAt: new Date(base + expiresIn) });
    }
    const group = (await target.cloud.readGroup(groupId)).group;
    let discovered = false;
    const stop = receiver.relay.watch(groupId, () => { discovered = true; }, () => {});
    try {
      await eventually(async () => discovered, 'the server should report the pending requests');
      await receiver.relay.serve(groupId, group);
      assert.equal(receiver.counts.activeListeners, 3);
      const queries = receiver.counts.queries;
      const clock = t.mock.method(Date, 'now', () => base + 90_000);
      try {
        await receiver.relay.serve(groupId, group, false);
        await receiver.relay.acknowledge(groupId, 0);
      } finally { clock.mock.restore(); }
      t.diagnostic(JSON.stringify({ scenario: 'expired-response-listener', active: receiver.counts.activeListeners,
        expiredStorageChecks: checked.filter(id => id === 'expiring').length, liveStorageChecks: checked.filter(id => id === 'pending').length }));
      assert.deepEqual({ active: receiver.counts.activeListeners, checked }, { active: 2, checked: ['pending'] },
        'expired requests must release their response listeners and stop checking device storage');
      assert.equal(receiver.counts.queries, queries);
      await assert.rejects(receiver.relay.snapshotChunk(groupId, 'requested-locally', 0), error => error.code === 'sharing/delivery-pending');
      assert.equal(receiver.counts.activeListeners, 3);
      checked.length = 0;
      const afterBoth = t.mock.method(Date, 'now', () => base + 2 * 86400_000);
      try { await receiver.relay.acknowledge(groupId, 0); } finally { afterBoth.mock.restore(); }
      assert.equal(receiver.counts.activeListeners, 1, 'a locally created request can expire before another discovery pass');
      assert.deepEqual(checked, []);
    } finally { stop(); }
    assert.equal(receiver.counts.activeListeners, 0);
  } finally { f.close(); }
});

test('server confirmation of cached group metadata and recovery requests and replies wakes each listener once across reconnects', async t => {
  // The emulator can retain a disconnected watch while clearing documents. Give this reconnect scenario its own local demo project.
  const projectId = `demo-liflow-reconnect-${randomUUID().slice(0, 8)}`;
  const isolated = await initializeTestEnvironment({ projectId, firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  const app = initializeApp({ projectId }, projectId); const testStore = getFirestore(app);
  const f = await fixture(isolated, testStore); const stops = [], clients = [];
  try {
    const source = await f.device('owner', f.owner, false), target = await f.device('member', f.member, false);
    clients.push(source.firestore, target.firestore);
    const sender = f.transport(source, 'owner', f.owner), receiver = f.transport(target, 'member', f.member);
    const id = 'cached-recovery';
    await source.local.saveChunk(id, { encryptedPayload: 'synthetic-cached' });
    await assert.rejects(receiver.relay.snapshotChunk(groupId, id, 0), error => error.code === 'sharing/delivery-pending');
    await sender.relay.serve(groupId);
    const group = (await target.cloud.readGroup(groupId)).group;
    await receiver.relay.serve(groupId, group);
    const requests = collection(target.firestore, 'sharingGroups', groupId, 'deliveryRequests');
    const latest = query(requests, orderBy('createdAt', 'desc'), limit(1));
    const request = (await getDocsFromServer(latest)).docs[0];
    const replies = collection(request.ref, 'responses');
    assert.equal((await getDocsFromServer(replies)).docs[0].data().ready, true);
    await disableNetwork(target.firestore);
    let wakes = 0, groupWakes = 0;
    stops.push(receiver.relay.watch(groupId, () => { wakes++; }, () => {}));
    stops.push(target.cloud.watch(groupId, () => { groupWakes++; }, () => {}));
    await receiver.relay.serve(groupId, group, false);
    const observed = [latest, replies, doc(target.firestore, 'sharingGroups', groupId)].map(ref => {
      const seen = { cache: 0, server: 0 };
      stops.push(onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.fromCache) seen.cache++; else seen.server++;
      }));
      return seen;
    });
    await eventually(async () => observed.every(seen => seen.cache === 1), 'all cached snapshots should arrive');
    assert.deepEqual([wakes, groupWakes], [0, 0]);
    await enableNetwork(target.firestore);
    await eventually(async () => observed.every(seen => seen.server === 1), 'all cached snapshots should reach the server');
    t.diagnostic(JSON.stringify({ scenario: 'confirmed-cache-reconnect', confirmedSnapshots: observed.length, relayWakes: wakes, groupWakes }));
    assert.deepEqual([wakes, groupWakes], [2, 1], 'each server-confirmed cached snapshot must notify the receiver once');
    await disableNetwork(target.firestore);
    await eventually(async () => observed.every(seen => seen.cache === 2), 'all listeners should observe the second disconnect');
    await enableNetwork(target.firestore);
    await eventually(async () => observed.every(seen => seen.server === 2), 'all listeners should observe the second reconnect');
    assert.deepEqual([wakes, groupWakes], [2, 1], 'already confirmed snapshots cannot retrigger unchanged work');
  } finally {
    for (const stop of stops) stop();
    try { await Promise.all(clients.map(client => client.terminate())); } finally {
      f.close(); await testStore.terminate(); await deleteApp(app); await isolated.cleanup();
    }
  }
});

test('a slow peer recovery cannot hold a normal group metadata read or continue after its account changes', async () => {
  const f = await fixture(); let release; let read;
  try {
    const source = await f.device('owner', f.owner), target = await f.device('member', f.member, false);
    await f.upload(source); const receiver = f.transport(target, 'member', f.member);
    await assert.rejects(receiver.relay.eventPage(groupId, 0, 1), error => error.code === 'sharing/delivery-pending');
    let entered; const blocked = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    const previous = source.local.events; source.local.events = async (...args) => { entered(); await gate; return previous(...args); };
    let resolved = false; read = source.cloud.readGroup(groupId).then(value => { resolved = true; return value; });
    await Promise.race([blocked, read]); await new Promise(setImmediate);
    assert.equal(resolved, true, 'normal metadata must not await another device recovery');
    await blocked; source.switchAccount(); release(); await read;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await store.collectionGroup('responses').get()).size, 0, 'a delayed old-account response cannot be uploaded');
  } finally { release?.(); await read?.catch(() => {}); f.close(); }
});

test('a new recovery request behind forty older requests is observed once and only its new metadata is fetched', async t => {
  const f = await fixture(); let stop;
  try {
    const source = await f.device('owner', f.owner, false), sender = f.transport(source, 'owner', f.owner);
    const requests = store.collection(`sharingGroups/${groupId}/deliveryRequests`);
    const createdAt = new Date(Date.now() - 5000), expiresAt = new Date(Date.now() + 86400_000);
    const value = key => ({ schemaVersion: 1, userId: 'member', deviceId: f.member.deviceId, kind: 'chunk', key,
      after: 0, through: 0, keyVersion: f.roster.body.keyVersion, createdAt, expiresAt });
    const batch = store.batch(); for (let index = 0; index < 40; index++) batch.set(requests.doc(index.toString(16).padStart(64, '0')), value(`synthetic-not-held-${index}`));
    await batch.commit(); let wakes = 0, pending = Promise.resolve(); const errors = [];
    stop = sender.relay.watch(groupId, () => { wakes++; pending = sender.relay.serve(groupId).catch(error => { errors.push(error); }); }, error => errors.push(error));
    await eventually(() => wakes > 0, 'initial requests were not observed'); await pending;
    const before = { ...sender.counts }; const id = 'f'.repeat(64), key = 'synthetic-after-forty';
    await source.local.saveChunk(key, { encryptedPayload: 'synthetic-new-opaque' });
    await requests.doc(id).set({ ...value(key), createdAt: new Date() });
    await eventually(async () => (await requests.doc(id).collection('responses').doc(f.owner.deviceId).get()).data()?.ready === true, 'the new request remained hidden behind old ones');
    await pending; assert.deepEqual(errors, []);
    assert.equal(sender.counts.queryDocuments - before.queryDocuments, 1, 'the forty old metadata records need not be fetched again');
    const settled = { ...sender.counts }; await new Promise(resolve => setTimeout(resolve, 40)); assert.deepEqual(sender.counts, settled);
    t.diagnostic(JSON.stringify({ scenario: 'one-request-after-forty', newQueryDocuments: sender.counts.queryDocuments - before.queryDocuments,
      newQueries: sender.counts.queries - before.queries, newCiphertextCharacters: sender.counts.ciphertextCharsWritten - before.ciphertextCharsWritten }));
  } finally { stop?.(); f.close(); }
});

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

test('real recovery cleanup erases a received request behind pending work and drains large received batches without expiring pending bodies', async () => {
  const f = await fixture();
  try {
    const source = await f.device('owner', f.owner), receiver = await f.device('member', f.member);
    await source.cloud.acknowledge(groupId, f.owner.deviceId, 0); await receiver.cloud.acknowledge(groupId, f.member.deviceId, 0);
    const root = store.doc(`sharingGroups/${groupId}`), at = Date.now();
    async function seed(id, createdAt, received = false) {
      const request = root.collection('deliveryRequests').doc(id), expiresAt = new Date(createdAt + 86400_000);
      const response = request.collection('responses').doc(f.owner.deviceId), batch = store.batch();
      batch.set(request, { schemaVersion: 1, userId: 'member', deviceId: f.member.deviceId, kind: 'chunk', key: id,
        after: 0, through: 0, keyVersion: f.roster.body.keyVersion, createdAt: new Date(createdAt), expiresAt,
        ...(received ? { receivedAt: new Date(at) } : {}) });
      batch.set(response, { schemaVersion: 1, userId: 'owner', deviceId: f.owner.deviceId, digest: 'a'.repeat(64),
        size: 1, parts: 1, ready: true, createdAt: new Date(createdAt), expiresAt });
      batch.set(response.collection('parts').doc('0'), { index: 0, data: 'eA==', createdAt: new Date(createdAt), expiresAt });
      await batch.commit(); return request;
    }
    const pending = [];
    for (let i = 0; i < 40; i++) pending.push(await seed(`pending-${i}`, at - 60_000 + i));
    const received = await seed('received-new', at, true);
    await sweepSharedDeliveries(store, groupId, at);
    assert.equal((await received.get()).exists, false, 'the durable receipt is selected independently of older unreceived requests');
    assert.equal((await received.collection('responses').get()).size, 0);
    const completed = [];
    for (let i = 0; i < 65; i++) completed.push(await seed(`received-batch-${i}`, at, true));
    const first = await sweepSharedDeliveries(store, groupId, at);
    const remaining = (await store.getAll(...completed)).filter(row => row.exists).length;
    assert.ok(remaining > 0 && remaining < completed.length, 'one pass makes bounded progress');
    assert.equal(first.nextAt, at);
    for (let attempt = 0; attempt < 4 && (await store.getAll(...completed)).some(row => row.exists); attempt++) await sweepSharedDeliveries(store, groupId, at);
    assert.ok((await store.getAll(...completed)).every(row => !row.exists));
    assert.ok((await store.getAll(...pending)).every(row => row.exists));
    assert.equal((await store.collectionGroup('parts').get()).size, pending.length, 'only unreceived ciphertext remains');
    const idle = await sweepSharedDeliveries(store, groupId, at); assert.equal(idle.deleted, 0); assert.ok(idle.nextAt > at);
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
