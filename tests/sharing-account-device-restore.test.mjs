import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedDocument, validateDevicePublicIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, approveOwnSharedDevice, createSharedRoster, removeSharedDevice, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { createAccountDeviceRestoreRequest, verifyAccountDeviceRestoreRequest, createAccountDeviceRestoreGrant,
  verifyAccountDeviceRestoreGrant, openAccountDeviceRestoreGrant } from '../src/features/sharing/account-device-restore.ts';

async function fixture() {
  const owner = await createDeviceIdentity(crypto), phone = await createDeviceIdentity(crypto), tablet = await createDeviceIdentity(crypto);
  const root = createSharedRoster('account-restore-group', 'owner-user', owner, { schemaVersion: 2 });
  const current = approveSharedDevice(root, owner, 'member-user', phone);
  const keys = new Map([[2, await crypto.randomBytes(32)]]);
  const request = createAccountDeviceRestoreRequest(current, 'member-user', tablet, 'restore-nonce-1');
  const input = { crypto, previous: current, request, sponsor: phone, userId: 'member-user', minimumKeyVersion: 2,
    readKey: async version => keys.get(version) ?? null, archive: [root, current] };
  return { owner, phone, tablet, root, current, keys, request, input };
}
function resign(grant, sponsor, change) {
  const body = structuredClone(grant.body); change(body);
  return { body, signature: signSharedDocument({ domain: 'liflow-account-device-grant-v1', body }, sponsor) };
}

test('same-account restoration wraps the existing snapshot keys and its continuous transport epoch key without sharing either device private key', async () => {
  const h = await fixture(), original = h.keys.get(2).slice();
  const temporary = [];
  const { grant, next, nextKeys } = await createAccountDeviceRestoreGrant({ ...h.input, crypto: { ...crypto,
    async encrypt(key, nonce, plaintext, aad) { temporary.push(plaintext); return crypto.encrypt(key, nonce, plaintext, aad); } } });
  assert.deepEqual(h.keys.get(2), original, 'Protected/cached source keys must not be mutated');
  assert.equal(temporary.length, 2); assert.ok(temporary.every(key => key.every(byte => byte === 0)), 'Temporary key copies must be cleared');
  assert.equal(nextKeys.length, 1); assert.equal(next.body.members.length, 2);
  assert.equal(grant.body.keys.length, 2);
  for (const secret of [h.phone.signingSecretKey, h.phone.agreementSecretKey, h.tablet.signingSecretKey, h.tablet.agreementSecretKey, Buffer.from(original).toString('hex')]) {
    assert.equal(JSON.stringify(grant).includes(secret), false);
  }
  const opened = await openAccountDeviceRestoreGrant({ crypto, grant, request: h.request, previous: h.current, identity: h.tablet, minimumKeyVersion: 2 });
  assert.deepEqual(opened.keys.get(2), original); assert.equal(opened.keys.get(3).length, 32);
  assert.equal(sharedRosterDigest(opened.roster), sharedRosterDigest(next));
  for (const key of opened.keys.values()) key.fill(0);
});

test('restoration requests prove possession of the new public key and are scoped to an existing account and group', async () => {
  const h = await fixture();
  assert.throws(() => createAccountDeviceRestoreRequest(h.current, 'not-a-member', h.tablet, 'restore-new'));
  assert.throws(() => verifyAccountDeviceRestoreRequest(h.request, 'other-user', h.current.body.groupId));
  assert.throws(() => verifyAccountDeviceRestoreRequest(h.request, 'member-user', 'other-group'));
  const tampered = structuredClone(h.request); tampered.body.identity = validateDevicePublicIdentity(h.phone);
  assert.throws(() => verifyAccountDeviceRestoreRequest(tampered, 'member-user', h.current.body.groupId));
  assert.throws(() => verifyAccountDeviceRestoreRequest({ ...h.request, secret: h.tablet.signingSecretKey }, 'member-user', h.current.body.groupId));
  assert.equal(JSON.stringify(h.request).includes(h.tablet.signingSecretKey), false);
});

test('a restore grant cannot be transplanted to another request, account, device, group or epoch', async () => {
  const h = await fixture(); const { grant } = await createAccountDeviceRestoreGrant(h.input);
  const otherRequest = createAccountDeviceRestoreRequest(h.current, 'member-user', h.tablet, 'restore-newer-nonce');
  assert.throws(() => verifyAccountDeviceRestoreGrant(grant, otherRequest, h.current, 2));
  await assert.rejects(() => openAccountDeviceRestoreGrant({ crypto, grant, request: h.request, previous: h.current, identity: h.phone, minimumKeyVersion: 2 }));
  for (const change of [
    body => { body.userId = 'owner-user'; }, body => { body.groupId = 'another-group'; },
    body => { body.requestDigest = '0'.repeat(64); }, body => { body.previousDigest = '0'.repeat(64); },
    body => { body.minimumKeyVersion = 1; }, body => { body.sponsorDeviceId = h.owner.deviceId; },
    body => { body.keys[0].recipientDeviceId = h.phone.deviceId; },
    body => { body.keys[0].recipientUserId = 'owner-user'; },
    body => { body.keys[0].keyVersion = 1; }, body => { body.keys.push(body.keys[0]); },
    body => { body.keys[1] = body.keys[0]; }, body => { body.keys.pop(); },
  ]) assert.throws(() => verifyAccountDeviceRestoreGrant(resign(grant, h.phone, change), h.request, h.current, 2));
});

test('ciphertext tampering fails authenticated decryption and clears keys already opened in the interrupted grant', async () => {
  const h = await fixture(); const { grant } = await createAccountDeviceRestoreGrant(h.input);
  const changed = resign(grant, h.phone, body => { body.keys[1].encryptedKey = '00'.repeat(48); });
  // The inner key envelope signature rejects this before it can be used as a valid AES key.
  const opened = [];
  const checked = { ...crypto, async decrypt(...args) { const bytes = await crypto.decrypt(...args); opened.push(bytes); return bytes; } };
  await assert.rejects(() => openAccountDeviceRestoreGrant({ crypto: checked, grant: changed, request: h.request, previous: h.current, identity: h.tablet, minimumKeyVersion: 2 }));
  assert.equal(opened.length, 1); assert.ok(opened[0].every(byte => byte === 0));
});

test('new-group admission and administrative changes cannot be smuggled into an account restoration grant even by an owner signer', async () => {
  const h = await fixture();
  const request = createAccountDeviceRestoreRequest(h.current, 'owner-user', h.tablet, 'owner-restore');
  const input = { ...h.input, userId: 'owner-user', request, sponsor: h.owner, minimumKeyVersion: 2 };
  const { grant } = await createAccountDeviceRestoreGrant(input);
  const different = await createDeviceIdentity(crypto);
  const malicious = resign(grant, h.owner, body => { body.roster = approveSharedDevice(h.current, h.owner, 'other-user', different); });
  assert.throws(() => verifyAccountDeviceRestoreGrant(malicious, request, h.current, 2));
});

test('an already approved device receives keys without another membership revision or another key rotation', async () => {
  const h = await fixture(); const next = approveOwnSharedDevice(h.current, h.phone, 'member-user', h.tablet, 'a'.repeat(64));
  h.keys.set(3, await crypto.randomBytes(32));
  const request = createAccountDeviceRestoreRequest(next, 'member-user', h.tablet, 'existing-device-recovery');
  const { grant, nextKeys, next: retained } = await createAccountDeviceRestoreGrant({ ...h.input, request, previous: next, archive: [h.root, h.current, next] });
  assert.deepEqual(retained, next); assert.deepEqual(nextKeys, []);
  assert.deepEqual(verifyAccountDeviceRestoreGrant(grant, request, next, 2), next);
});

test('a removed device cannot reapprove itself automatically and a missing historical key never produces partial success', async () => {
  const h = await fixture(), joined = approveOwnSharedDevice(h.current, h.phone, 'member-user', h.tablet, 'a'.repeat(64));
  const removed = removeSharedDevice(joined, h.owner, h.tablet.deviceId);
  const request = createAccountDeviceRestoreRequest(removed, 'member-user', h.tablet, 'revoked-device-request');
  await assert.rejects(() => createAccountDeviceRestoreGrant({ ...h.input, request, previous: removed, archive: [h.root, h.current, joined, removed] }), /removed device/);
  await assert.rejects(() => createAccountDeviceRestoreGrant({ ...h.input, readKey: async () => null }), /not available/);
  assert.equal(h.keys.size, 1, 'Missing historical keys must not change protected source keys');
  await assert.rejects(() => createAccountDeviceRestoreGrant({ ...h.input, minimumKeyVersion: 1 }), /snapshot/);
  await assert.rejects(() => createAccountDeviceRestoreGrant({ ...h.input, previous: joined }), /Group changed/);
});
