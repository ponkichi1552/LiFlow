import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDocFromServer, getDocsFromServer, serverTimestamp, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';

if (!/^(127\.0\.0\.1|localhost):\d+$/u.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
  throw new Error('Security attack tests require an explicitly configured local Firestore emulator.');
}
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId: 'demo-liflow-security-audit',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { await environment?.cleanup(); });
const db = uid => uid ? environment.authenticatedContext(uid).firestore() : environment.unauthenticatedContext().firestore();
const root = (store, group = 'target') => doc(store, 'sharingGroups', group);

// Synthetic pre-existing documents isolate the Rules authorization boundary.
// Ciphertext/signature validity is exercised independently by the crypto suite.
async function seed(schemaVersion) {
  await environment.withSecurityRulesDisabled(async context => {
    const store = context.firestore(); const batch = writeBatch(store);
    for (const [group, owner, member] of [['target', 'owner-a', 'member-a'], ['other', 'owner-b', 'member-b']]) {
      const ref = root(store, group); const time = new Date();
      batch.set(ref, { schemaVersion, ownerUserId: owner, ownerDeviceId: `${owner}-device`, memberIds: [owner, member],
        deviceOwners: { [`${owner}-device`]: owner, [`${member}-device`]: member }, keyVersion: 1, rosterRevision: 1,
        rosterJson: 'synthetic-public-roster', revokedUserIds: [], rotationRequired: false, closed: false,
        headSequence: 1, lastOperationId: 'one', snapshotId: 'snapshot', snapshotThroughSequence: 1, createdAt: time, updatedAt: time });
      const event = { schemaVersion, authorUserId: owner, authorDeviceId: `${owner}-device`, keyVersion: 1,
        uploadSequence: 1, createdAt: time, ...(schemaVersion === 2 ? { authorProofDigest: 'a'.repeat(64) } : {}) };
      batch.set(doc(ref, 'events', 'one'), { ...event, envelopeJson: 'synthetic-ciphertext' });
      if (schemaVersion === 2) batch.set(doc(ref, 'receipts', 'one'), event);
      batch.set(doc(ref, 'rosters', '1'), { rosterJson: 'synthetic-public-roster', createdAt: time });
      batch.set(doc(ref, 'snapshots', 'snapshot'), { keyVersion: 1, throughSequence: 1, manifestJson: 'synthetic-signed-manifest', createdAt: time });
      batch.set(doc(ref, 'snapshotChunks', 'snapshot-0'), { snapshotId: 'snapshot', keyVersion: 1, envelopeJson: 'synthetic-ciphertext', createdAt: time });
      for (const uid of [owner, member]) {
        batch.set(doc(ref, 'keyEnvelopes', `1_${uid}-device`), { userId: uid, deviceId: `${uid}-device`, keyVersion: 1, wrappedKeyJson: 'synthetic-wrapped-key', createdAt: time });
        batch.set(doc(ref, 'acknowledgements', `${uid}-device`), { userId: uid, sequence: 1, updatedAt: time });
        batch.set(doc(store, 'sharingUsers', uid, 'memberships', 'current'), { groupId: group, invitationId: null, createdAt: time });
      }
    }
    await batch.commit();
  });
}

for (const schemaVersion of [1, 2]) {
  test(`security Rules v${schemaVersion}: another groups owner, members and unauthenticated clients cannot enumerate or read any protected path`, async () => {
    await seed(schemaVersion);
    const paths = [[], ['events', 'one'], ['rosters', '1'], ['snapshots', 'snapshot'], ['snapshotChunks', 'snapshot-0'],
      ['acknowledgements', 'owner-a-device'], ...(schemaVersion === 2 ? [['receipts', 'one']] : [])];
    for (const uid of ['owner-a', 'member-a', 'owner-b', 'member-b', 'outsider', undefined]) {
      const store = db(uid); const allowed = ['owner-a', 'member-a'].includes(uid);
      for (const path of paths) {
        const ref = path.length ? doc(root(store), ...path) : root(store);
        const pending = getDocFromServer(ref);
        if (allowed) assert.equal((await assertSucceeds(pending)).exists(), true);
        else await assertFails(pending);
      }
      await assertFails(getDocsFromServer(collection(store, 'sharingGroups')));
      if (!allowed) await assertFails(getDocsFromServer(collection(root(store), 'events')));
      const membership = getDocFromServer(doc(store, 'sharingUsers', 'owner-b', 'memberships', 'current'));
      if (uid === 'owner-b') assert.equal((await assertSucceeds(membership)).exists(), true);
      else await assertFails(membership);
    }
  });

  test(`security Rules v${schemaVersion}: a legitimate member cannot rewrite roles, device ownership, keys or another users acknowledgement`, async () => {
    await seed(schemaVersion); const store = db('member-a'); const ref = root(store);
    for (const patch of [{ ownerUserId: 'member-a', ownerDeviceId: 'member-a-device' },
      { deviceOwners: { 'owner-a-device': 'member-a', 'member-a-device': 'member-a' } },
      { memberIds: ['owner-a', 'member-a', 'outsider'] }, { keyVersion: 2, rosterRevision: 2 },
      { schemaVersion: schemaVersion === 1 ? 2 : 1 }, { closed: true, memberIds: [], deviceOwners: {} },
      { headSequence: 99, lastOperationId: 'nonexistent' }]) {
      await assertFails(updateDoc(ref, { ...patch, updatedAt: serverTimestamp() }));
    }
    await assertFails(getDocFromServer(doc(ref, 'keyEnvelopes', '1_owner-a-device')));
    assert.equal((await assertSucceeds(getDocFromServer(doc(ref, 'keyEnvelopes', '1_member-a-device')))).exists(), true);
    await assertFails(setDoc(doc(ref, 'keyEnvelopes', '1_outsider-device'), { userId: 'outsider', deviceId: 'outsider-device', keyVersion: 1, wrappedKeyJson: 'forged', createdAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ref, 'acknowledgements', 'owner-a-device'), { sequence: 1, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(ref, 'rosters', '1')));
    assert.equal((await getDocFromServer(ref)).data().ownerUserId, 'owner-a');
  });

  test(`security Rules v${schemaVersion}: revocation immediately rejects every protected read, queued write and stale access attempt`, async () => {
    await seed(schemaVersion); const store = db('member-a'); const ref = root(store);
    await assertSucceeds(updateDoc(ref, { revokedUserIds: ['member-a'], rotationRequired: true, updatedAt: serverTimestamp() }));
    const paths = [[], ['events', 'one'], ['rosters', '1'], ['snapshots', 'snapshot'], ['snapshotChunks', 'snapshot-0'],
      ['keyEnvelopes', '1_member-a-device'], ['acknowledgements', 'member-a-device'], ...(schemaVersion === 2 ? [['receipts', 'one']] : [])];
    for (const path of paths) await assertFails(getDocFromServer(path.length ? doc(ref, ...path) : ref));
    await assertFails(updateDoc(ref, { revokedUserIds: [], rotationRequired: false, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(ref, 'acknowledgements', 'member-a-device'), { userId: 'member-a', sequence: 1, updatedAt: serverTimestamp() }));
    const event = { schemaVersion, authorUserId: 'member-a', authorDeviceId: 'member-a-device', keyVersion: 1,
      uploadSequence: 2, createdAt: serverTimestamp(), ...(schemaVersion === 2 ? { authorProofDigest: 'b'.repeat(64) } : {}) };
    const batch = writeBatch(store); batch.set(doc(ref, 'events', 'queued-before-revocation'), { ...event, envelopeJson: 'synthetic-ciphertext' });
    if (schemaVersion === 2) batch.set(doc(ref, 'receipts', 'queued-before-revocation'), event);
    batch.update(ref, { headSequence: 2, lastOperationId: 'queued-before-revocation', updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    assert.equal((await getDocFromServer(root(db('owner-a')))).data().headSequence, 1);
  });
}

for (const schemaVersion of [1, 2]) test(`single membership Rules v${schemaVersion}: another owner cannot claim an already joined user by changing or omitting the singleton pointer`, async () => {
  await seed(schemaVersion); const store = db('owner-b'); const ref = root(store, 'other');
  for (const changePointer of [false, true]) {
    const batch = writeBatch(store); const snapshotId = `claim-${changePointer}`;
    batch.update(ref, { memberIds: ['owner-b', 'member-b', 'member-a'],
      deviceOwners: { 'owner-b-device': 'owner-b', 'member-b-device': 'member-b', 'member-a-device': 'member-a' },
      keyVersion: 2, rosterRevision: 2, rosterJson: 'owner-signed-attempt', snapshotId, snapshotThroughSequence: 1, updatedAt: serverTimestamp() });
    batch.set(doc(ref, 'rosters', '2'), { rosterJson: 'owner-signed-attempt', createdAt: serverTimestamp() });
    batch.set(doc(ref, 'snapshots', snapshotId), { keyVersion: 2, throughSequence: 1, manifestJson: 'owner-signed-snapshot', createdAt: serverTimestamp() });
    if (changePointer) batch.set(doc(store, 'sharingUsers', 'member-a', 'memberships', 'current'), { groupId: 'other', invitationId: null, createdAt: serverTimestamp() });
    await assertFails(batch.commit());
    assert.equal((await getDocFromServer(ref)).data().keyVersion, 1);
    assert.equal((await getDocFromServer(doc(db('member-a'), 'sharingUsers', 'member-a', 'memberships', 'current'))).data().groupId, 'target');
  }
});
