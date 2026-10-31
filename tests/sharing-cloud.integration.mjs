import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createDeviceIdentity, decryptAuthenticatedSharedOperation, encryptSharedOperation, signSharedOperation,
  unwrapGroupKey, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, createSharedRoster, removeSharedMember, sharedAuthorIdentity,
  sharedRosterDigest, verifyPinnedSharedRoster, verifySharedRosterArchive } from '../src/features/sharing/roster.ts';
import { createSharedInvitation, createSharedJoinRequest } from '../src/features/sharing/invitations.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run against the local Firestore emulator.');
let env;
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });
function client(uid) {
  const firestore = env.authenticatedContext(uid).firestore(); let current = uid;
  return { firestore, cloud: createSharingCloud(firestore, uid, () => current), switch: (value) => { current = value; } };
}
async function fixture() {
  const owner = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32); const store = client('owner');
  const roster = createSharedRoster('group-test', 'owner', owner);
  const wrapped = await wrapGroupKey(crypto, 'group-test', 1, key, owner, owner, 'owner');
  await store.cloud.createGroup(roster, wrapped);
  return { owner, key, store, roster, wrapped };
}
function operation(identity, sequence = 1, overrides = {}) {
  return { schemaVersion: 1, operationId: `operation-${sequence}`, groupId: 'group-test', authorUserId: 'owner',
    authorDeviceId: identity.deviceId, deviceSequence: sequence, logicalClock: sequence,
    context: sequence > 1 ? { [identity.deviceId]: sequence - 1 } : {}, keyVersion: 1,
    entityType: 'chore', entityId: 'group-test.floor', operationType: 'patch', payload: { name: `秘密の掃除 ${sequence}` }, ...overrides };
}
const refs = (store) => doc(store.firestore, 'sharingGroups', 'group-test');

test('membership discovery reads one group and never enumerates historical group indexes', async () => {
  const h = await fixture();
  await env.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), 'sharingUsers', 'owner', 'memberships', 'historical'), { groupId: 'historical', createdAt: serverTimestamp() }));
  assert.equal(await h.store.cloud.readMembership(), 'group-test');
  assert.equal(await h.store.cloud.hasMembership('group-test'), true);
  assert.equal(await h.store.cloud.hasMembership('historical'), false);
  assert.equal(await client('other-user').cloud.hasMembership('group-test'), false);
  h.store.switch('other-user'); await assert.rejects(h.store.cloud.hasMembership('group-test'), /切り替わり/);
});

test('cloud transport bounds 250 encrypted edits into 100/100/50 pages and retries a create or lost upload response without duplicates', async () => {
  const h = await fixture(); await h.store.cloud.createGroup(h.roster, h.wrapped);
  assert.equal(await h.store.cloud.readMembership(), 'group-test');
  for (let index = 1; index <= 250; index++) {
    const envelope = await encryptSharedOperation(crypto, operation(h.owner, index), h.key, h.owner);
    const first = await h.store.cloud.upload(envelope); assert.equal(first.uploadSequence, index);
    if (index % 25 === 0) assert.equal((await h.store.cloud.upload(envelope)).uploadSequence, index);
  }
  const first = await h.store.cloud.pull('group-test', 0); const second = await h.store.cloud.pull('group-test', 100); const third = await h.store.cloud.pull('group-test', 200);
  assert.deepEqual([first.events.length, second.events.length, third.events.length], [100, 100, 50]);
  assert.equal(third.throughSequence, 250); assert.equal((await h.store.cloud.pull('group-test', 250)).events.length, 0);
  const fact = await decryptAuthenticatedSharedOperation(crypto, third.events.at(-1).envelope, h.key, h.owner, 'group-test', 1);
  assert.equal(fact.operation.payload.name, '秘密の掃除 250');
  const serialized = JSON.stringify((await getDocsFromServer(collection(refs(h.store), 'events'))).docs.map((item) => item.data()));
  assert.ok(!serialized.includes('秘密の掃除')); assert.ok(!serialized.includes('group-test.floor'));
  assert.ok(!serialized.includes(h.owner.signingSecretKey)); assert.ok(!serialized.includes(Buffer.from(h.key).toString('hex')));
  await assert.rejects(h.store.cloud.pull('group-test', 251), { code: 'sharing/snapshot-required' });
  await assert.rejects(client('outsider').cloud.readGroup('group-test'));
  h.store.switch('another-user'); await assert.rejects(h.store.cloud.readGroup('group-test'), { code: 'sharing/access-denied' });
});

async function approvedFixture() {
  const h = await fixture(); const op = operation(h.owner); const envelope = await encryptSharedOperation(crypto, op, h.key, h.owner);
  await h.store.cloud.upload(envelope);
  const member = await createDeviceIdentity(crypto); const memberStore = client('member');
  const link = await createSharedInvitation(crypto, h.roster, h.owner, 'invite-test', Date.now());
  await h.store.cloud.createInvitation(link.invitation); const request = createSharedJoinRequest(link, 'member', member, Date.now());
  await memberStore.cloud.submitJoinRequest(link.invitation, request);
  await memberStore.cloud.submitJoinRequest(link.invitation, request);
  await assert.rejects(memberStore.cloud.readGroup('group-test'));
  const requests = await h.store.cloud.listJoinRequests(link.invitation); assert.equal(requests.requests.length, 1);
  const next = approveSharedDevice(h.roster, h.owner, 'member', member); const nextKey = await crypto.randomBytes(32);
  const author = (uid, device, version) => sharedAuthorIdentity(version === 1 ? h.roster : next, uid, device, version);
  const snapshot = await createEncryptedSharedSnapshot(crypto, buildSharedReplica('group-test', [op]),
    [signSharedOperation(op, h.owner)], next, h.owner, nextKey, 'join-snapshot', 1, author);
  const keys = await Promise.all(next.body.members.flatMap((entry) => entry.devices.map((device) =>
    wrapGroupKey(crypto, 'group-test', 2, nextKey, h.owner, device.identity, entry.userId))));
  await h.store.cloud.prepareSnapshot(snapshot, next);
  await h.store.cloud.commitMembership(h.roster, next, keys, 1, snapshot.manifest, { invitation: link.invitation, request });
  await h.store.cloud.commitMembership(h.roster, next, keys, 1, snapshot.manifest, { invitation: link.invitation, request });
  return { ...h, op, member, memberStore, link, request, next, nextKey, author, snapshot };
}

test('a new device is explicitly approved with a fresh key and restores existing encrypted data from the same atomic membership snapshot', async () => {
  const h = await approvedFixture(); const group = await h.memberStore.cloud.readGroup('group-test');
  assert.equal(group.group.keyVersion, 2); assert.equal(group.group.snapshotId, 'join-snapshot');
  assert.equal(await h.memberStore.cloud.readMembership(), 'group-test');
  const pin = verifyPinnedSharedRoster(await h.memberStore.cloud.readRoster('group-test', 1), h.link.invitation.body.pin);
  const archive = verifySharedRosterArchive(pin, [pin, await h.memberStore.cloud.readRoster('group-test', 2)]);
  assert.equal(sharedRosterDigest(archive.at(-1)), sharedRosterDigest(h.next));
  const keyEnvelope = await h.memberStore.cloud.readGroupKey('group-test', 2, h.member.deviceId);
  const key = await unwrapGroupKey(crypto, keyEnvelope, h.member, 'member', h.owner, 'group-test', 2);
  assert.deepEqual(key, h.nextKey);
  await assert.rejects(h.memberStore.cloud.pull('group-test', 0), { code: 'sharing/snapshot-required' });
  const received = await h.memberStore.cloud.readSnapshot('group-test', 'join-snapshot');
  const restored = await openEncryptedSharedSnapshot(crypto, received, key, h.next, h.author);
  assert.equal(buildSharedReplica('group-test', [], restored.base).entities[0].fields.name, '秘密の掃除 1');
  assert.equal((await h.store.cloud.readInvitation('invite-test')).status, 'used');
  assert.equal((await h.store.cloud.listJoinRequests(h.link.invitation)).requests.length, 0);
  await h.memberStore.cloud.acknowledge('group-test', h.member.deviceId, 1);
  await h.memberStore.cloud.acknowledge('group-test', h.member.deviceId, 1);
  await assert.rejects(client('third').cloud.submitJoinRequest(h.link.invitation, h.request));
});

test('voluntary departure stops all sending and a retained device rotates future keys while preserving former authors in the encrypted history', async () => {
  const h = await approvedFixture();
  const completion = operation(h.member, 1, { operationId: 'completed-by-member', authorUserId: 'member', keyVersion: 2,
    logicalClock: 2, context: { [h.owner.deviceId]: 1 }, entityType: 'completion', entityId: 'group-test.floor:initial', operationType: 'complete',
    payload: { choreId: 'group-test.floor', completedAt: '2026-10-27T01:00:00Z', outcome: 'completed' } });
  await h.memberStore.cloud.upload(await encryptSharedOperation(crypto, completion, h.nextKey, h.member));
  await h.memberStore.cloud.leaveGroup('group-test'); await assert.rejects(h.memberStore.cloud.readGroup('group-test'));
  await assert.rejects(h.store.cloud.upload(await encryptSharedOperation(crypto, operation(h.owner, 2), h.nextKey, h.owner, 2)), { code: 'sharing/key-version-changed' });
  const removed = removeSharedMember(h.next, h.owner, 'member'); const key = await crypto.randomBytes(32);
  const author = (uid, device, version) => sharedAuthorIdentity(version === 1 ? h.roster : h.next, uid, device, version);
  const snapshot = await createEncryptedSharedSnapshot(crypto, buildSharedReplica('group-test', [h.op, completion]),
    [signSharedOperation(h.op, h.owner), signSharedOperation(completion, h.member)], removed, h.owner, key, 'removed-snapshot', 2, author);
  await h.store.cloud.prepareSnapshot(snapshot, removed);
  await h.store.cloud.commitMembership(h.next, removed,
    [await wrapGroupKey(crypto, 'group-test', 3, key, h.owner, h.owner, 'owner')], 2, snapshot.manifest);
  assert.equal((await h.store.cloud.readGroup('group-test')).group.rotationRequired, false);
  await assert.rejects(h.memberStore.cloud.readGroupKey('group-test', 2, h.member.deviceId));
  const received = await h.store.cloud.readSnapshot('group-test', 'removed-snapshot');
  const restored = await openEncryptedSharedSnapshot(crypto, received, key, removed, author);
  assert.equal(buildSharedReplica('group-test', [], restored.base).completions.length, 1);
  await h.store.cloud.upload(await encryptSharedOperation(crypto, operation(h.owner, 2, { logicalClock: 3,
    context: { [h.owner.deviceId]: 1, [h.member.deviceId]: 1 } }), key, h.owner, 3));
  assert.equal((await h.store.cloud.readGroup('group-test')).group.headSequence, 3);
});

test('a stale membership snapshot fails atomically when another device commits an edit during preparation', async () => {
  const h = await fixture(); const member = await createDeviceIdentity(crypto);
  const next = approveSharedDevice(h.roster, h.owner, 'member', member); const key = await crypto.randomBytes(32);
  const snapshot = await createEncryptedSharedSnapshot(crypto, buildSharedReplica('group-test', []), [], next, h.owner, key, 'stale-snapshot', 0, () => h.owner);
  await h.store.cloud.prepareSnapshot(snapshot, next);
  await h.store.cloud.upload(await encryptSharedOperation(crypto, operation(h.owner), h.key, h.owner));
  const keys = await Promise.all(next.body.members.flatMap((entry) => entry.devices.map((device) => wrapGroupKey(crypto, 'group-test', 2, key, h.owner, device.identity, entry.userId))));
  await assert.rejects(h.store.cloud.commitMembership(h.roster, next, keys, 0, snapshot.manifest), { code: 'sharing/cloud-changed' });
  assert.equal((await h.store.cloud.readGroup('group-test')).group.keyVersion, 1);
  await assert.rejects(client('member').cloud.readGroup('group-test'));
});

test('a malformed join request is quarantined instead of preventing a valid family member from being approved', async () => {
  const h = await fixture(); const link = await createSharedInvitation(crypto, h.roster, h.owner, 'invite-test', Date.now());
  await h.store.cloud.createInvitation(link.invitation);
  const bad = client('malformed');
  const malformed = writeBatch(bad.firestore);
  malformed.set(doc(bad.firestore, 'sharingUsers', 'malformed', 'memberships', 'current'), { groupId: 'group-test', invitationId: 'invite-test', createdAt: serverTimestamp() });
  malformed.set(doc(bad.firestore, 'sharingInvites', 'invite-test', 'requests', 'malformed'), { userId: 'malformed', deviceId: 'not-a-real-public-key', requestJson: '{broken', createdAt: serverTimestamp() });
  await malformed.commit();
  const member = await createDeviceIdentity(crypto); const good = client('member');
  await good.cloud.submitJoinRequest(link.invitation, createSharedJoinRequest(link, 'member', member, Date.now()));
  const requests = await h.store.cloud.listJoinRequests(link.invitation);
  assert.deepEqual(requests.invalidUserIds, ['malformed']); assert.equal(requests.requests.length, 1);
  await h.store.cloud.withdrawOrRejectJoinRequest('invite-test', 'malformed');
  assert.deepEqual((await h.store.cloud.listJoinRequests(link.invitation)).invalidUserIds, []);
  await h.store.cloud.revokeInvitation('invite-test');
  assert.equal((await h.store.cloud.readInvitation('invite-test')).status, 'revoked');
  await assert.rejects(good.cloud.submitJoinRequest(link.invitation, requests.requests[0]), /取り消され/);
  assert.equal((await getDocFromServer(refs(h.store))).data().keyVersion, 1);
});

test('simultaneous group creation from two devices commits exactly one account membership', async () => {
  const first = client('owner'), second = client('owner');
  const a = await createDeviceIdentity(crypto), b = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const inputs = await Promise.all([[first, a, 'house-a'], [second, b, 'house-b']].map(async ([store, identity, groupId]) => ({ store,
    roster: createSharedRoster(groupId, 'owner', identity), key: await wrapGroupKey(crypto, groupId, 1, key, identity, identity, 'owner') })));
  const results = await Promise.allSettled(inputs.map(input => input.store.cloud.createGroup(input.roster, input.key)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = inputs[results.findIndex(result => result.status === 'fulfilled')].roster.body.groupId;
  assert.equal(await first.cloud.readMembership(), winner);
  await env.withSecurityRulesDisabled(async context => {
    const groups = await getDocsFromServer(collection(context.firestore(), 'sharingGroups')); assert.equal(groups.size, 1);
  });
});

test('pending membership blocks another invitation and creation until its request is cancelled', async () => {
  const h = await fixture();
  const anotherOwner = await createDeviceIdentity(crypto), key = await crypto.randomBytes(32), store = client('other-owner');
  const roster = createSharedRoster('other-house', 'other-owner', anotherOwner);
  await store.cloud.createGroup(roster, await wrapGroupKey(crypto, 'other-house', 1, key, anotherOwner, anotherOwner, 'other-owner'));
  const linkA = await createSharedInvitation(crypto, h.roster, h.owner, 'single-a', Date.now());
  const linkB = await createSharedInvitation(crypto, roster, anotherOwner, 'single-b', Date.now());
  await h.store.cloud.createInvitation(linkA.invitation); await store.cloud.createInvitation(linkB.invitation);
  const member = await createDeviceIdentity(crypto), memberStore = client('member');
  const a = createSharedJoinRequest(linkA, 'member', member, Date.now()), b = createSharedJoinRequest(linkB, 'member', member, Date.now());
  const results = await Promise.allSettled([memberStore.cloud.submitJoinRequest(linkA.invitation, a), memberStore.cloud.submitJoinRequest(linkB.invitation, b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const accepted = results[0].status === 'fulfilled' ? [linkA, a, linkB, b] : [linkB, b, linkA, a];
  const own = createSharedRoster('member-created-house', 'member', member);
  await assert.rejects(memberStore.cloud.createGroup(own, await wrapGroupKey(crypto, own.body.groupId, 1, key, member, member, 'member')));
  assert.equal(await memberStore.cloud.cancelOwnJoinRequest(accepted[0].invitation, accepted[1]), true);
  assert.equal(await memberStore.cloud.readMembership(), null);
  await memberStore.cloud.submitJoinRequest(accepted[2].invitation, accepted[3]);
  assert.equal(await memberStore.cloud.readMembership(), accepted[2].invitation.body.groupId);
});

test('an existing displayed group adopts the singleton index without changing its roster or event history', async () => {
  const h = await fixture(); const before = await h.store.cloud.readGroup('group-test');
  await env.withSecurityRulesDisabled(context => deleteDoc(doc(context.firestore(), 'sharingUsers', 'owner', 'memberships', 'current')));
  assert.equal(await h.store.cloud.readMembership(), null);
  assert.equal(await h.store.cloud.hasMembership('group-test'), true, 'a missing old index cannot prove removal');
  await h.store.cloud.bindMembership('group-test'); await h.store.cloud.bindMembership('group-test');
  assert.equal(await h.store.cloud.readMembership(), 'group-test');
  assert.deepEqual(await h.store.cloud.readGroup('group-test'), before);
  await assert.rejects(h.store.cloud.bindMembership('unrelated-group'));
});
