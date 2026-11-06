import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc, updateDoc, getDocsFromServer, collection } from 'firebase/firestore';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, wrapGroupKey, sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, removeSharedDevice, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { createEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { createAccountDeviceRestoreRequest, createAccountDeviceRestoreGrant, accountDeviceRestoreAcknowledgment } from '../src/features/sharing/account-device-restore.ts';
import { createAccountDeviceApi } from '../src/platform/sharing/account-device-api.ts';
import { createAccountDeviceController } from '../src/features/sharing/account-device-controller.ts';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createV2WorkspaceSession } from '../src/features/sharing/v2/workspace-session.ts';
import { createSharedJoinRequest } from '../src/features/sharing/invitations.ts';
import { readCloudWorkspaceArchive } from '../src/features/sharing/workspace-protocol.ts';
import { resolveSharedGroupKey } from '../src/features/sharing/account-device-key-continuity.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { initializeSharingRegistry, saveSharingWorkspace, readCurrentSharingWorkspace } from '../src/platform/storage/sharing-registry.ts';
import { createAccountDeviceService } from '../server/account-device-api/src/service.mjs';
import { createAccountDeviceHttpServer } from '../server/account-device-api/src/http.mjs';

if (!/^127\.0\.0\.1:\d+$/u.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') || !/^127\.0\.0\.1:\d+$/u.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) throw new Error('Isolated local emulators required');
const require = createRequire(new URL('../server/account-device-api/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app'), { getFirestore, Timestamp } = require('firebase-admin/firestore'), { getAuth } = require('firebase-admin/auth');
const projectId = 'demo-liflow-sharing', groupId = 'account-device-cloud'; let env, app, db, auth;
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  app = initializeApp({ projectId }, 'account-device-integration'); db = getFirestore(app); auth = getAuth(app);
});
beforeEach(async () => env.clearFirestore());
after(async () => { await db?.terminate(); if (app) await deleteApp(app); await env?.cleanup(); });
async function google(sub = randomUUID()) {
  const token = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub, email: `${sub}@synthetic.example`, email_verified: true, aud: 'synthetic-client', iss: 'https://accounts.google.com' })).toString('base64url') + '.';
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=synthetic`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestUri: 'http://localhost',
      postBody: new URLSearchParams({ providerId: 'google.com', id_token: token }).toString(), returnSecureToken: true }) });
  const body = await response.json(); assert.equal(response.status, 200);
  return { uid: body.localId, token: body.idToken, sub };
}
async function fixture({ accountDailyLimit = 120 } = {}) {
  const owner = await createDeviceIdentity(crypto), phone = await createDeviceIdentity(crypto), tablet = await createDeviceIdentity(crypto), who = await google();
  const initial = createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 }), roster = approveSharedDevice(initial, owner, who.uid, phone), key = await crypto.randomBytes(32);
  const snapshot = await createEncryptedSharedSnapshot(crypto, buildSharedReplica(groupId, [], undefined, 2), [], roster, owner, key, 'owner-snapshot', 0, () => { throw new Error('no facts'); });
  await db.doc(`sharingGroups/${groupId}`).set({ ...rosterCloudFields(roster), headSequence: 0, lastOperationId: null,
    snapshotId: 'owner-snapshot', snapshotThroughSequence: 0, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  for (const value of [initial, roster]) await db.doc(`sharingGroups/${groupId}/rosters/${value.body.revision}`).set({ rosterJson: canonicalJson(value) });
  await db.doc(`sharingGroups/${groupId}/snapshots/owner-snapshot`).set({ keyVersion: 2, throughSequence: 0, manifestJson: canonicalJson(snapshot.manifest) });
  await db.doc(`sharingUsers/${who.uid}/memberships/current`).set({ groupId, invitationId: null });
  const actor = { uid: who.uid, provider: 'google.com', authTime: Date.now() }; let stamp = Date.now();
  const service = createAccountDeviceService({ firestore: db, now: () => stamp, accountDailyLimit });
  const request = createAccountDeviceRestoreRequest(roster, who.uid, tablet, 'account-request');
  const grant = (await createAccountDeviceRestoreGrant({ crypto, previous: roster, request, sponsor: phone, userId: who.uid,
    minimumKeyVersion: 2, readKey: async () => key, archive: [initial, roster] })).grant;
  return { owner, phone, tablet, initial, roster, key, who, actor, request, grant, service, advance: ms => { stamp += ms; },
    submit: () => service.request(actor, { groupId, slot: 0, request, replaceRequestId: null }),
    accept: () => service.accept(actor, { groupId, slot: 0, requestId: request.body.requestId, grant }) };
}

test('same-account service admits one device transactionally across independent servers and physically clears an acknowledged encrypted grant', async () => {
  const h = await fixture(); await h.submit(); const other = createAccountDeviceService({ firestore: db });
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? other : h.service).accept(h.actor, { groupId, slot: 0, requestId: 'account-request', grant: h.grant })));
  const metadata = (await db.doc(`sharingGroups/${groupId}`).get()).data(); assert.equal(metadata.rosterRevision, 3); assert.equal(metadata.ownerDeviceId, h.owner.deviceId);
  assert.equal((await db.collection(`sharingGroups/${groupId}/rosters`).get()).size, 3);
  const record = (await h.service.read(h.actor, { groupId })).records[0]; assert.equal(record.status, 'accepted');
  const pending = { slot: 0, request: h.request };
  const ack = accountDeviceRestoreAcknowledgment(pending, h.grant, h.tablet);
  await h.service.acknowledge(h.actor, ack); await h.service.acknowledge(h.actor, ack); await h.accept();
  const stored = (await db.doc(`sharingGroups/${groupId}/accountDeviceRestores/${h.who.uid}/accountDeviceRequests/0`).get()).data();
  assert.equal(stored.status, 'acknowledged'); assert.equal(stored.grantJson, undefined); assert.equal(stored.minimumKeyVersion, undefined);
  const usage = await db.collection('accountDeviceServiceUsage').get(); assert.equal(usage.docs.find(row => row.id.startsWith('global-')).data().count, 2);
});

test('Rules expose only a same-account restoration signal and never permit direct request grant or root forgery', async () => {
  const h = await fixture(); await h.submit(); const own = env.authenticatedContext(h.who.uid).firestore(), stranger = env.authenticatedContext('stranger').firestore();
  const signal = `sharingUsers/${h.who.uid}/deviceRestoreSignals/current`, slot = `sharingGroups/${groupId}/accountDeviceRestores/${h.who.uid}/accountDeviceRequests/0`;
  await assertSucceeds(getDocFromServer(doc(own, signal))); await assertFails(getDocFromServer(doc(stranger, signal)));
  await assertFails(setDoc(doc(own, signal), { groupId: 'fake' })); await assertFails(getDocsFromServer(collection(own, `sharingUsers/${h.who.uid}/deviceRestoreSignals`)));
  for (const database of [own, stranger]) { await assertFails(getDocFromServer(doc(database, slot))); await assertFails(setDoc(doc(database, slot), { status: 'accepted' })); }
  await assertFails(updateDoc(doc(own, 'sharingGroups', groupId), { ...rosterCloudFields(h.grant.body.roster) }));
  await db.doc('serviceConfiguration/billing').set({ enforced: true }); await assertFails(getDocFromServer(doc(own, signal)));
  await assert.rejects(h.service.read(h.actor, { groupId }), error => error.code === 'subscription_required');
});

test('device requests and grants reject cross-account identity privilege tampering stale authentication and slot flooding', async () => {
  const h = await fixture();
  await assert.rejects(h.service.request({ ...h.actor, uid: 'stranger' }, { groupId, slot: 0, request: h.request, replaceRequestId: null }));
  await assert.rejects(h.service.request({ ...h.actor, authTime: 0 }, { groupId, slot: 0, request: h.request, replaceRequestId: null }), error => error.code === 'identity_required');
  for (const slot of [-1, 4, 0.5]) await assert.rejects(h.service.request(h.actor, { groupId, slot, request: h.request, replaceRequestId: null }));
  const bad = structuredClone(h.request); bad.body.identity = h.phone;
  await assert.rejects(h.service.request(h.actor, { groupId, slot: 0, request: bad, replaceRequestId: null }));
  await h.submit(); const forged = structuredClone(h.grant); forged.body.roster.body.ownerDeviceId = h.phone.deviceId;
  await assert.rejects(h.service.accept(h.actor, { groupId, slot: 0, requestId: 'account-request', grant: forged }), error => error.code === 'invalid_request');
  await h.accept(); const ack = accountDeviceRestoreAcknowledgment({ slot: 0, request: h.request }, h.grant, h.tablet);
  ack.signature = signSharedDocument({ bad: 'ack' }, h.phone); await assert.rejects(h.service.acknowledge(h.actor, ack));
  assert.equal((await h.service.read(h.actor, { groupId })).records[0].status, 'accepted');
});

test('expired requests revoked members snapshot tampering and active recovery never disclose or accept restoration keys', async () => {
  const h = await fixture(); await h.submit(); h.advance(16 * 60_000);
  await assert.rejects(h.accept(), error => error.code === 'request_expired'); assert.deepEqual(await h.service.read(h.actor, { groupId }), { records: [] });
  const next = await fixture(); await next.submit();
  await db.doc(`sharingGroups/${groupId}/recoveryLocks/current`).set({ keyVersion: 2 }); await assert.rejects(next.accept(), error => error.code === 'recovery_active');
  await db.doc(`sharingGroups/${groupId}/recoveryLocks/current`).delete();
  await db.doc(`sharingGroups/${groupId}/snapshots/owner-snapshot`).update({ keyVersion: 1 }); await assert.rejects(next.accept(), error => error.code === 'snapshot_changed');
  await db.doc(`sharingGroups/${groupId}`).update({ revokedUserIds: [next.who.uid], rotationRequired: true });
  await assert.rejects(next.service.read(next.actor, { groupId }), error => error.code === 'membership_required');
});

test('removed device identities cannot reapprove themselves and current device admission limits remain bounded', async () => {
  const h = await fixture(); await h.submit(); await h.accept(); const joined = h.grant.body.roster, removed = removeSharedDevice(joined, h.owner, h.tablet.deviceId);
  await db.doc(`sharingGroups/${groupId}`).update(rosterCloudFields(removed)); await db.doc(`sharingGroups/${groupId}/rosters/4`).set({ rosterJson: canonicalJson(removed) });
  const request = createAccountDeviceRestoreRequest(removed, h.who.uid, h.tablet, 'removed-device-request');
  await h.service.request(h.actor, { groupId, slot: 0, request, replaceRequestId: 'account-request' });
  // A forged grant signed by another approved device cannot bypass the immutable removed-device archive.
  const grant = (await createAccountDeviceRestoreGrant({ crypto, previous: removed, request, sponsor: h.phone, userId: h.who.uid,
    minimumKeyVersion: 2, readKey: async () => h.key, archive: [h.initial, h.roster, removed] })).grant;
  await assert.rejects(h.service.accept(h.actor, { groupId, slot: 0, requestId: request.body.requestId, grant }), error => error.code === 'device_removed');
});

test('retention removes an undelivered grant and the fifth device cannot allocate another restoration request', async () => {
  const h = await fixture(); await h.submit(); await h.accept();
  const changed = removeSharedDevice(h.grant.body.roster, h.owner, h.phone.deviceId);
  await db.doc(`sharingGroups/${groupId}`).update({ ...rosterCloudFields(changed), retentionCutoff: '2026-10-01', retentionThroughSequence: 0, retentionKeyVersion: 3 });
  assert.deepEqual(await h.service.read(h.actor, { groupId }), { records: [] });
  assert.equal((await db.doc(`sharingGroups/${groupId}/accountDeviceRestores/${h.who.uid}/accountDeviceRequests/0`).get()).exists, false);
  const other = await fixture(); let full = other.roster;
  for (let index = 0; index < 3; index++) full = approveSharedDevice(full, other.owner, other.who.uid, await createDeviceIdentity(crypto));
  await db.doc(`sharingGroups/${groupId}`).update(rosterCloudFields(full));
  const request = createAccountDeviceRestoreRequest(full, other.who.uid, other.tablet, 'fifth-device');
  await assert.rejects(other.service.request(other.actor, { groupId, slot: 0, request, replaceRequestId: null }), error => error.code === 'device_limit');
});

test('valid refreshed Firebase sessions need no repeated 24-hour login but malformed entitlements fail closed', async () => {
  const h = await fixture();
  await h.service.request({ ...h.actor, authTime: Date.now() - 7 * 24 * 60 * 60_000 }, { groupId, slot: 0, request: h.request, replaceRequestId: null });
  await db.doc('serviceConfiguration/billing').set({ enforced: true });
  await db.doc(`billingEntitlements/${h.who.uid}`).set({ userId: h.who.uid, status: 'active' });
  await assert.rejects(h.service.read(h.actor, { groupId }), error => error.code === 'subscription_required');
  await db.doc(`billingEntitlements/${h.who.uid}`).set({ userId: h.who.uid, status: 'grace', validUntil: Date.now() + 60000, expiresAt: Date.now() + 60000 });
  assert.equal((await h.service.read(h.actor, { groupId })).records.length, 1);
});

test('the metadata HTTP service verifies real Firebase Google tokens with revocation checks without returning credentials', async () => {
  const h = await fixture(); let verified = 0;
  const server = createAccountDeviceHttpServer({ service: h.service, verifyIdToken: async (token, revoked) => { assert.equal(revoked, true); verified++; return auth.verifyIdToken(token, revoked); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const again = await google(h.who.sub); assert.equal(again.uid, h.who.uid);
    const api = createAccountDeviceApi({ url, testLoopback: true, userId: h.who.uid, assertCurrent() {}, getToken: async () => again.token });
    await api.request({ groupId, slot: 0, request: h.request, replaceRequestId: null }); assert.equal((await api.read(groupId))[0].status, 'requested');
    await api.accept({ groupId, slot: 0, requestId: 'account-request', grant: h.grant });
    assert.equal((await api.read(groupId))[0].status, 'accepted');
    await api.acknowledge(accountDeviceRestoreAcknowledgment({ slot: 0, request: h.request }, h.grant, h.tablet)); assert.ok(verified >= 5);
    const refused = await fetch(url + '/v1/restore/read', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid.token' }, body: '{}' });
    assert.equal(refused.status, 401); assert.equal((await refused.text()).includes('invalid.token'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('independent same-account SQLite devices restore an older owner snapshot and converge offline edits across the new device epoch', async () => {
  const h = await fixture(), ownerDb = createDatabase(), firstDb = createDatabase(), secondDb = createDatabase(), index = createDatabase(), personal = createDatabase();
  const keys = [new Map([[2, h.key.slice()]]), new Map([[2, h.key.slice()]]), new Map()], archives = [[h.initial, h.roster], [h.initial, h.roster], []];
  let ordinal = 0, restoredRecord, pending;
  const record = (userId, archive) => ({ userId, groupId, status: 'active', displayName: '同一アカウント検査', anchor: h.initial, rosterArchive: archive,
    createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null });
  const clouds = [createSharingCloud(env.authenticatedContext('owner').firestore(), 'owner', () => 'owner'),
    createSharingCloud(env.authenticatedContext(h.who.uid).firestore(), h.who.uid, () => h.who.uid),
    createSharingCloud(env.authenticatedContext(h.who.uid).firestore(), h.who.uid, () => h.who.uid)];
  const dependencies = (i, database, userId, identity, creating = false) => ({ database, userId, groupId, identity, crypto, cloud: clouds[i], householdId: 'isolated-shared-house',
    readRecord: async () => ({ ...record(userId, archives[i]), ...(creating ? { status: 'creating', creation: { ownerDisplayName: '所有者', timeZone: 'Asia/Tokyo', anchorDate: '2026-11-06' } } : {}) }),
    saveArchive: async value => { archives[i] = value; }, archive: () => archives[i], readKey: async version => keys[i].get(version)?.slice() ?? null,
    saveKey: async (version, value) => { keys[i].set(version, value.slice()); }, serialized: async task => task(), changed() {}, assertCurrentAccount() {}, assertWritable() {},
    makeId: () => `automatic-${i}-${++ordinal}`, markLeft: async () => {}, ...(creating ? { creationKind: 'roommates' } : {}) });
  try {
    await initializeSharingRegistry(index.database);
    await personal.database.execAsync("CREATE TABLE private_records(value TEXT); INSERT INTO private_records VALUES ('personal settings and history stay private')");
    const privateBefore = personal.connection.prepare('SELECT * FROM private_records').all();
    const owner = await createV2WorkspaceSession(dependencies(0, ownerDb.database, 'owner', h.owner, true));
    await owner.synchronizer.sync({ force: true }); await owner.manager.publishSnapshot();
    const first = await createV2WorkspaceSession(dependencies(1, firstDb.database, h.who.uid, h.phone));
    await first.synchronizer.sync({ force: true });
    const range = { from: '2026-11-06', through: '2026-11-20', asOfDate: '2026-11-06' };
    const before = await first.controller.readModel(range), chore = before.plan.chores[0]; assert.ok(chore);
    await first.repository.commit([{ operationId: 'older-epoch-offline-edit', entityType: 'chore', entityId: chore.id, operationType: 'patch', payload: { name: '同じアカウントの変更' } }]);
    const api = { read: async id => (await h.service.read(h.actor, { groupId: id })).records,
      request: input => h.service.request(h.actor, input), accept: input => h.service.accept(h.actor, input), acknowledge: input => h.service.acknowledge(h.actor, input) };
    const makeRestore = i => createAccountDeviceController({ userId: h.who.uid, identity: i === 1 ? h.phone : h.tablet, crypto, api, assertCurrent() {},
      newRequestId: () => `automatic-request-${++ordinal}`,
      loadPending: async () => i === 2 ? pending ?? null : null, savePending: async value => { pending = structuredClone(value); }, clearPending: async () => { pending = null; },
      discover: async () => {
        const metadata = await clouds[i].readGroup(groupId), base = i === 1 ? record(h.who.uid, archives[1]) : record(h.who.uid, [h.initial]);
        const archive = await readCloudWorkspaceArchive(base, metadata.roster, clouds[i].readRoster);
        return { ...metadata, archive };
      },
      minimum: async metadata => (await clouds[i].readSnapshotManifest(groupId, metadata.group.snapshotId, metadata.archive)).body.keyVersion,
      readKey: async (version, metadata) => {
        if (i === 2 && !keys[2].has(version)) return null;
        return resolveSharedGroupKey({ crypto, userId: h.who.uid, identity: i === 1 ? h.phone : h.tablet, archive: metadata.archive,
          epoch: metadata.archive.find(epoch => epoch.body.keyVersion === version), readKey: async value => keys[i].get(value)?.slice() ?? null,
          saveKey: async (value, key) => keys[i].set(value, key.slice()), readEnvelope: value => clouds[i].readGroupKey(groupId, value, i === 1 ? h.phone.deviceId : h.tablet.deviceId) });
      },
      saveKey: async (_group, version, key) => keys[i].set(version, key.slice()),
      activate: async metadata => { archives[i] = metadata.archive;
        if (i === 2 && !restoredRecord) { restoredRecord = record(h.who.uid, archives[2]); await saveSharingWorkspace(index.database, restoredRecord); } },
    });
    assert.equal(await makeRestore(2).run(), 'waiting'); assert.equal(await makeRestore(1).run(), 'sent');
    assert.equal(await makeRestore(2).run(), 'restored'); assert.equal((await readCurrentSharingWorkspace(index.database, h.who.uid)).groupId, groupId);
    const second = await createV2WorkspaceSession(dependencies(2, secondDb.database, h.who.uid, h.tablet));
    await second.synchronizer.sync({ force: true }); await first.synchronizer.sync({ force: true }); await second.synchronizer.sync({ force: true });
    assert.equal((await second.controller.readModel(range)).plan.chores.find(row => row.id === chore.id).name, '同じアカウントの変更');
    await second.repository.commit([{ operationId: 'new-device-edit', entityType: 'chore', entityId: chore.id, operationType: 'patch', payload: { name: '新しい端末からの変更' } }]);
    await second.synchronizer.sync({ force: true }); await first.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    assert.equal((await owner.controller.readModel(range)).plan.chores.find(row => row.id === chore.id).name, '新しい端末からの変更');
    const restarted = await createV2WorkspaceSession(dependencies(2, secondDb.database, h.who.uid, h.tablet));
    await restarted.synchronizer.sync({ force: true });
    assert.deepEqual((await first.controller.readModel(range)).plan, (await restarted.controller.readModel(range)).plan);
    assert.deepEqual(personal.connection.prepare('SELECT * FROM private_records').all(), privateBefore);
    const final = (await clouds[1].readGroup(groupId)).roster; assert.equal(final.body.revision, 3);
    assert.deepEqual(final.body.members.find(row => row.userId === h.who.uid).devices.map(row => row.identity.deviceId).sort(), [h.phone.deviceId, h.tablet.deviceId].sort());
  } finally { for (const handle of [ownerDb, firstDb, secondDb, index, personal]) handle.connection.close(); }
});
