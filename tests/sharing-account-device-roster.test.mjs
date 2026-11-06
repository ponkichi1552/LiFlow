import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createDeviceIdentity, signSharedDocument, validateDevicePublicIdentity } from '../src/features/sharing/crypto.ts';
import { approveOwnSharedDevice, approveSharedDevice, createSharedRoster, removeSharedDevice, sameAccountDeviceAddition,
  sharedAuthorIdentity, sharedRosterDigest, verifySharedRosterArchive, verifySharedRosterTransition } from '../src/features/sharing/roster.ts';

const crypto = { async randomBytes(size) { return new Uint8Array(randomBytes(size)); } };
async function fixture() {
  const owner = await createDeviceIdentity(crypto), phone = await createDeviceIdentity(crypto), tablet = await createDeviceIdentity(crypto);
  const root = createSharedRoster('account-device-group', 'owner-user', owner, { schemaVersion: 2 });
  const current = approveSharedDevice(root, owner, 'member-user', phone);
  return { owner, phone, tablet, root, current };
}
function signed(body, identity) {
  return { body, signer: validateDevicePublicIdentity(identity), signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, identity) };
}

test('an approved member device can add a distinct device only to the same existing account, preserving the owner and every other setting', async () => {
  const h = await fixture();
  const next = approveOwnSharedDevice(h.current, h.phone, 'member-user', h.tablet, 'a'.repeat(64));
  assert.deepEqual(sameAccountDeviceAddition(h.current, next), { userId: 'member-user', deviceId: h.tablet.deviceId });
  assert.equal(next.body.ownerUserId, 'owner-user'); assert.equal(next.body.ownerDeviceId, h.owner.deviceId);
  assert.equal(next.body.members.length, h.current.body.members.length);
  assert.equal(next.body.schedulerVersion, h.current.body.schedulerVersion);
  assert.equal(next.body.keyVersion, h.current.body.keyVersion + 1);
  assert.equal(next.body.members.find(member => member.userId === 'member-user').joinedKeyVersion, 2);
  assert.equal(next.body.members.find(member => member.userId === 'member-user').devices.find(device => device.identity.deviceId === h.phone.deviceId).joinedKeyVersion, 2);
  assert.equal(next.body.members.find(member => member.userId === 'member-user').devices.find(device => device.identity.deviceId === h.tablet.deviceId).joinedKeyVersion, 3);
  assert.deepEqual(verifySharedRosterArchive(h.root, [h.root, h.current, next]).at(-1), next);
  assert.equal(JSON.stringify(next).includes(h.phone.signingSecretKey), false);
  assert.equal(JSON.stringify(next).includes(h.tablet.agreementSecretKey), false);
});

test('automatic device authorization cannot add another account or elevate the member to owner', async () => {
  const h = await fixture();
  assert.throws(() => approveOwnSharedDevice(h.current, h.phone, 'owner-user', h.tablet, 'a'.repeat(64)));
  assert.throws(() => approveOwnSharedDevice(h.current, h.phone, 'new-user', h.tablet, 'a'.repeat(64)));
  const next = approveOwnSharedDevice(h.current, h.phone, 'member-user', h.tablet, 'a'.repeat(64));
  for (const change of [
    body => { body.ownerUserId = 'member-user'; body.ownerDeviceId = h.phone.deviceId; },
    body => { body.members.push({ userId: 'new-user', joinedKeyVersion: body.keyVersion, devices: [{ identity: validateDevicePublicIdentity(h.owner), joinedKeyVersion: body.keyVersion }] }); },
    body => { body.members = body.members.filter(member => member.userId !== 'owner-user'); body.ownerUserId = 'member-user'; body.ownerDeviceId = h.phone.deviceId; },
    body => { body.schedulerVersion += '-changed'; },
    body => { body.groupId = 'other-group'; },
    body => { body.members.find(member => member.userId === 'member-user').devices = [{ identity: validateDevicePublicIdentity(h.tablet), joinedKeyVersion: 3 }]; },
    body => { body.members.find(member => member.userId === 'member-user').joinedKeyVersion = 3; },
  ]) {
    const body = structuredClone(next.body); change(body);
    assert.throws(() => verifySharedRosterTransition(h.current, signed(body, h.phone)));
  }
});

test('a new device cannot authenticate its own approval or sign another members expansion', async () => {
  const h = await fixture(); const next = approveOwnSharedDevice(h.current, h.phone, 'member-user', h.tablet, 'a'.repeat(64));
  assert.throws(() => verifySharedRosterTransition(h.current, signed(next.body, h.tablet)));
  const stranger = await createDeviceIdentity(crypto);
  assert.throws(() => approveOwnSharedDevice(h.current, stranger, 'member-user', h.tablet, 'a'.repeat(64)));
  const forged = structuredClone(next); forged.signature = '00'.repeat(64);
  assert.throws(() => verifySharedRosterTransition(h.current, forged));
  assert.throws(() => verifySharedRosterTransition(next, h.current));
  const skipped = structuredClone(next.body); skipped.revision++; skipped.keyVersion++;
  assert.throws(() => verifySharedRosterTransition(h.current, signed(skipped, h.phone)));
});

test('same-account enrollment preserves independent device authorship and cannot manufacture earlier operations', async () => {
  const h = await fixture(); const next = approveOwnSharedDevice(h.current, h.phone, 'member-user', h.tablet, 'a'.repeat(64));
  assert.deepEqual(sharedAuthorIdentity(next, 'member-user', h.tablet.deviceId, 3), validateDevicePublicIdentity(h.tablet));
  assert.throws(() => sharedAuthorIdentity(next, 'member-user', h.tablet.deviceId, 2));
  assert.throws(() => sharedAuthorIdentity(next, 'owner-user', h.tablet.deviceId, 3));
  assert.throws(() => approveSharedDevice(next, h.tablet, 'another-user', validateDevicePublicIdentity(h.phone)));
});

test('automatic authorization is bounded to four devices and a removed sponsor cannot authorize a new device', async () => {
  const h = await fixture(); const third = await createDeviceIdentity(crypto), fourth = await createDeviceIdentity(crypto), fifth = await createDeviceIdentity(crypto);
  const next = approveOwnSharedDevice(h.current, h.phone, 'member-user', h.tablet, 'a'.repeat(64));
  const three = approveOwnSharedDevice(next, h.tablet, 'member-user', third, 'a'.repeat(64));
  const four = approveOwnSharedDevice(three, h.phone, 'member-user', fourth, 'a'.repeat(64));
  assert.equal(four.body.members.find(member => member.userId === 'member-user').devices.length, 4);
  assert.throws(() => approveOwnSharedDevice(four, h.phone, 'member-user', fifth, 'a'.repeat(64)), /member devices/);
  const removed = removeSharedDevice(next, h.owner, h.phone.deviceId);
  assert.throws(() => approveOwnSharedDevice(removed, h.phone, 'member-user', third, 'a'.repeat(64)), /approved device/);
  assert.throws(() => approveOwnSharedDevice(next, h.phone, 'member-user', h.tablet, 'a'.repeat(64)), /already approved/);
});

test('legacy groups still require the existing owner-mediated approval and cannot opt into automatic enrollment implicitly', async () => {
  const h = await fixture(); const legacy = createSharedRoster('legacy-account-device-group', 'member-user', h.phone);
  assert.throws(() => approveOwnSharedDevice(legacy, h.phone, 'member-user', h.tablet, 'a'.repeat(64)));
  const ownerAdded = approveSharedDevice(legacy, h.phone, 'member-user', h.tablet);
  assert.equal(sameAccountDeviceAddition(legacy, ownerAdded), null);
  assert.equal(sharedRosterDigest(verifySharedRosterTransition(legacy, ownerAdded)), sharedRosterDigest(ownerAdded));
});
