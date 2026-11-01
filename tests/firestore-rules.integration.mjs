import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, runTransaction, serverTimestamp,
  setDoc, Timestamp, updateDoc, where, writeBatch } from 'firebase/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run the sharing Rules tests against a local Firestore emulator.');
let env;
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });
const db = (uid) => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const root = (store, group = 'group-a') => doc(store, 'sharingGroups', group);

async function createGroup(store, group = 'group-a') {
  const batch = writeBatch(store); const ref = root(store, group);
  batch.set(ref, { schemaVersion: 1, ownerUserId: 'owner', ownerDeviceId: 'owner-device', memberIds: ['owner'],
    deviceOwners: { 'owner-device': 'owner' }, keyVersion: 1, rosterRevision: 1, rosterJson: 'signed-public-roster-1',
    revokedUserIds: [], rotationRequired: false, closed: false, headSequence: 0, lastOperationId: null,
    snapshotId: null, snapshotThroughSequence: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.set(doc(ref, 'rosters', '1'), { rosterJson: 'signed-public-roster-1', createdAt: serverTimestamp() });
  batch.set(doc(store, 'sharingUsers', 'owner', 'memberships', 'current'), { groupId: group, invitationId: null, createdAt: serverTimestamp() });
  await batch.commit();
}

async function approve(store, members = ['owner', 'member'], group = 'group-a') {
  const ref = root(store, group); const old = (await getDoc(ref)).data(); const version = old.keyVersion + 1;
  const rosterJson = `signed-public-roster-${version}`; const batch = writeBatch(store);
  const snapshotId = `membership-snapshot-${version}`;
  const deviceOwners = Object.fromEntries(members.map((uid) => [`${uid}-device`, uid]));
  batch.update(ref, { memberIds: members, deviceOwners, keyVersion: version, rosterRevision: version, rosterJson,
    revokedUserIds: [], rotationRequired: false, snapshotId, snapshotThroughSequence: old.headSequence, updatedAt: serverTimestamp() });
  batch.set(doc(ref, 'rosters', String(version)), { rosterJson, createdAt: serverTimestamp() });
  batch.set(doc(ref, 'snapshots', snapshotId), { keyVersion: version, throughSequence: old.headSequence,
    manifestJson: 'authenticated-snapshot-manifest', createdAt: serverTimestamp() });
  for (const uid of members.filter(uid => !old.memberIds.includes(uid))) await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'sharingUsers', uid, 'memberships', 'current'), { groupId: group, invitationId: 'fixture-approval', createdAt: serverTimestamp() }));
  for (const uid of members) {
    if (!old.memberIds.includes(uid)) batch.set(doc(store, 'sharingUsers', uid, 'memberships', 'current'), { groupId: group, invitationId: null, createdAt: serverTimestamp() });
    batch.set(doc(ref, 'keyEnvelopes', `${version}_${uid}-device`), { userId: uid, deviceId: `${uid}-device`, keyVersion: version,
      wrappedKeyJson: 'authenticated-encrypted-key', createdAt: serverTimestamp() });
  }
  await batch.commit();
}

async function send(store, uid, operationId = 'operation-1', group = 'group-a', extra = {}) {
  await runTransaction(store, async (tx) => {
    const ref = root(store, group); const g = (await tx.get(ref)).data();
    tx.set(doc(ref, 'events', operationId), { schemaVersion: 1, authorUserId: uid, authorDeviceId: `${uid}-device`,
      keyVersion: g.keyVersion, uploadSequence: g.headSequence + 1, envelopeJson: 'authenticated-ciphertext',
      createdAt: serverTimestamp(), ...extra });
    tx.update(ref, { headSequence: g.headSequence + 1, lastOperationId: operationId, updatedAt: serverTimestamp() });
  });
}

test('Rules: creating a group requires an authenticated owner, its initial roster and no plaintext application fields', async () => {
  await assertFails(createGroup(db())); await assertFails(createGroup(db('outsider')));
  await assertSucceeds(createGroup(db('owner')));
  await assertFails(updateDoc(root(db('owner')), { groupName: '平文の家事', updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(root(db('owner'))));
  await assertFails(getDoc(root(db()))); await assertFails(getDoc(root(db('outsider'))));
  await assertFails(getDocs(collection(db('owner'), 'sharingGroups')));
  assert.equal((await getDoc(root(db('owner')))).data().memberIds[0], 'owner');
});

test('Rules: event delivery positions are consecutive and atomic, immutable and bound to the authenticated device', async () => {
  const owner = db('owner'); await createGroup(owner); await approve(owner);
  const member = db('member'); await assertSucceeds(send(member, 'member'));
  await assertFails(send(member, 'owner', 'impersonation'));
  await assertFails(send(member, 'member', 'unknown-device', 'group-a', { authorDeviceId: 'other-device' }));
  await assertFails(send(member, 'member', 'old-key', 'group-a', { keyVersion: 1 }));
  await assertFails(send(member, 'member', 'plaintext', 'group-a', { taskName: '掃除' }));
  await assertFails(send(member, 'member', 'operation-1'));
  await assertFails(setDoc(doc(root(owner), 'events', 'missing-head'), { schemaVersion: 1, authorUserId: 'owner',
    authorDeviceId: 'owner-device', keyVersion: 2, uploadSequence: 2, envelopeJson: 'cipher', createdAt: serverTimestamp() }));
  await assertFails(updateDoc(root(owner), { headSequence: 2, lastOperationId: 'nonexistent', updatedAt: serverTimestamp() }));
  await assertSucceeds(send(owner, 'owner', 'operation-2'));
  const events = await getDocs(query(collection(root(member), 'events'), orderBy('uploadSequence')));
  assert.deepEqual(events.docs.map((event) => event.data().uploadSequence), [1, 2]);
  await assertFails(getDocs(collection(root(db('outsider')), 'events')));
  await assertFails(deleteDoc(events.docs[0].ref));
});

test('Rules: only the owner approves membership and each change rotates the key and records its roster', async () => {
  const owner = db('owner'); await createGroup(owner); await approve(owner);
  await assertFails(approve(db('member'), ['owner', 'member', 'outsider']));
  await assertFails(updateDoc(root(owner), { memberIds: ['owner'], deviceOwners: { 'owner-device': 'owner' }, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(root(owner), { keyVersion: 3, rosterRevision: 3, rosterJson: 'unsigned', updatedAt: serverTimestamp() }));
  await assertSucceeds(approve(owner, ['owner', 'member', 'third']));
  assert.equal((await getDoc(root(db('third')))).data().keyVersion, 3);
  const membership = await getDoc(doc(db('third'), 'sharingUsers', 'third', 'memberships', 'current'));
  assert.equal(membership.data().groupId, 'group-a');
  await assertFails(getDocs(collection(db('third'), 'sharingUsers', 'owner', 'memberships')));
});

test('Rules: leaving immediately denies all group reads and freezes sending until the owner rotates away the old key', async () => {
  const owner = db('owner'); await createGroup(owner); await approve(owner); const member = db('member');
  await assertSucceeds(updateDoc(root(member), { revokedUserIds: ['member'], rotationRequired: true, updatedAt: serverTimestamp() }));
  await assertFails(getDoc(root(member))); await assertFails(getDocs(collection(root(member), 'events')));
  await assertFails(getDoc(doc(root(member), 'keyEnvelopes', '2_member-device')));
  await assertFails(send(owner, 'owner')); await assertFails(send(member, 'member'));
  await assertSucceeds(approve(owner, ['owner'])); await assertSucceeds(send(owner, 'owner'));
  await assertFails(getDoc(root(member)));
});

test('Rules: member removal blocks old ciphertexts and key envelopes; recipients can read only their own encrypted keys', async () => {
  const owner = db('owner'); await createGroup(owner); await approve(owner);
  const member = db('member'); await assertSucceeds(getDoc(doc(root(member), 'keyEnvelopes', '2_member-device')));
  await assertFails(getDoc(doc(root(member), 'keyEnvelopes', '2_owner-device')));
  assert.equal((await getDocs(query(collection(root(member), 'keyEnvelopes'), where('userId', '==', 'member')))).size, 1);
  await approve(owner, ['owner']);
  await assertFails(getDoc(doc(root(member), 'keyEnvelopes', '2_member-device')));
  await assertFails(createGroup(owner, 'group-b'));
  await assertFails(send(member, 'member', 'cross-group', 'group-b'));
  await assertFails(setDoc(doc(root(owner), 'keyEnvelopes', '3_stranger-device'), { userId: 'outsider', deviceId: 'stranger-device',
    keyVersion: 3, wrappedKeyJson: 'key', createdAt: serverTimestamp() }));
});

test('Rules: an owner cannot repoint the same snapshot floor to a previous key epoch', async () => {
  const owner = db('owner'); await createGroup(owner); await approve(owner); await approve(owner);
  assert.equal((await getDoc(root(owner))).data().snapshotId, 'membership-snapshot-3');
  await assertFails(updateDoc(root(owner), { snapshotId: 'membership-snapshot-2', snapshotThroughSequence: 0, updatedAt: serverTimestamp() }));
  assert.equal((await getDoc(root(owner))).data().snapshotId, 'membership-snapshot-3');
});

test('Rules: invites expire, require explicit owner approval and cannot be consumed by a requester', async () => {
  const owner = db('owner'); await createGroup(owner);
  const invitation = { groupId: 'group-a', ownerUserId: 'owner', invitationPublicKey: 'ab'.repeat(32), pinJson: 'public-key-pin',
    expiresAt: Timestamp.fromMillis(Date.now() + 60_000), status: 'open', usedBy: null, createdAt: serverTimestamp() };
  const invite = doc(owner, 'sharingInvites', 'invite-a'); await assertSucceeds(setDoc(invite, invitation));
  await assertFails(setDoc(doc(owner, 'sharingInvites', 'too-long'), { ...invitation, expiresAt: Timestamp.fromMillis(Date.now() + 25 * 3600_000) }));
  await assertFails(getDoc(doc(db(), 'sharingInvites', 'invite-a')));
  const applicant = db('member'); const requestRef = doc(applicant, 'sharingInvites', 'invite-a', 'requests', 'member');
  const join = writeBatch(applicant);
  join.set(doc(applicant, 'sharingUsers', 'member', 'memberships', 'current'), { groupId: 'group-a', invitationId: 'invite-a', createdAt: serverTimestamp() });
  join.set(requestRef, { userId: 'member', deviceId: 'member-device', requestJson: 'signed-invitation-proof', createdAt: serverTimestamp() });
  await assertSucceeds(join.commit());
  await assertFails(getDoc(root(applicant))); await assertFails(updateDoc(doc(applicant, 'sharingInvites', 'invite-a'), { status: 'used', usedBy: 'member' }));
  await assertFails(setDoc(doc(applicant, 'sharingInvites', 'invite-a', 'requests', 'owner'), { userId: 'owner', deviceId: 'member-device', requestJson: 'impersonation', createdAt: serverTimestamp() }));
  await assertFails(getDoc(doc(db('outsider'), 'sharingInvites', 'invite-a', 'requests', 'member')));
  await approve(owner); await assertSucceeds(updateDoc(invite, { status: 'used', usedBy: 'member' }));
  await assertFails(setDoc(doc(db('third'), 'sharingInvites', 'invite-a', 'requests', 'third'), { userId: 'third', deviceId: 'third-device', requestJson: 'proof', createdAt: serverTimestamp() }));
  await env.withSecurityRulesDisabled(async (context) => { await setDoc(doc(context.firestore(), 'sharingInvites', 'expired'),
    { ...invitation, expiresAt: Timestamp.fromMillis(Date.now() - 1_000) }); });
  await assertFails(setDoc(doc(applicant, 'sharingInvites', 'expired', 'requests', 'member'),
    { userId: 'member', deviceId: 'member-device', requestJson: 'proof', createdAt: serverTimestamp() }));
});

test('Rules: acknowledgements cannot skip unpublished changes or move backward and snapshots gate compaction', async () => {
  const owner = db('owner'); await createGroup(owner); await approve(owner); await send(owner, 'owner');
  const member = db('member'); const ack = doc(root(member), 'acknowledgements', 'member-device');
  await assertFails(setDoc(ack, { userId: 'member', sequence: 2, updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(ack, { userId: 'member', sequence: 1, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ack, { sequence: 0, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(root(member), 'acknowledgements', 'owner-device'), { userId: 'member', sequence: 1, updatedAt: serverTimestamp() }));
  const snapshot = { keyVersion: 2, throughSequence: 1, manifestJson: 'authenticated-manifest', createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(root(member), 'snapshots', 'snapshot-a'), snapshot));
  await assertSucceeds(setDoc(doc(root(owner), 'snapshotChunks', 'snapshot-a-0'), { snapshotId: 'snapshot-a', keyVersion: 2, envelopeJson: 'cipher', createdAt: serverTimestamp() }));
  const batch = writeBatch(owner); batch.set(doc(root(owner), 'snapshots', 'snapshot-a'), snapshot);
  batch.update(root(owner), { snapshotId: 'snapshot-a', snapshotThroughSequence: 1, updatedAt: serverTimestamp() }); await batch.commit();
  await assertSucceeds(deleteDoc(doc(root(owner), 'events', 'operation-1')));
  await assertFails(deleteDoc(doc(root(owner), 'snapshots', 'snapshot-a')));
  await assertFails(deleteDoc(doc(root(owner), 'snapshotChunks', 'snapshot-a-0')));
});
