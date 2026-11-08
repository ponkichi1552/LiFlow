import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';
import { createPrivateCalendarKeyDelivery } from '../src/features/sharing/private-calendar/key-delivery.ts';
import { createPrivateCalendarPairingController } from '../src/features/sharing/private-calendar/pairing-controller.ts';
import { privateCalendarPairingReference, verifyPrivateCalendarPairingRequest } from '../src/features/sharing/private-calendar/pairing.ts';
import { privateCalendarCloudFields } from '../src/features/sharing/private-calendar/cloud-contract.ts';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';

const userId = 'same-person-pairing-owner';
function paths(t) { const dir = mkdtempSync(join(tmpdir(), 'liflow-pairing-')); t.after(() => rmSync(dir, { force: true, recursive: true })); return { owner: join(dir, 'owner.db'), recipient: join(dir, 'recipient.db') }; }
async function fixture(t) {
  const path = paths(t); const owner = privateCalendarSetupFixture(t, { userId, path: path.owner }); const recipient = privateCalendarSetupFixture(t, { userId, path: path.recipient });
  const { cloud, history, packets, flags, pages } = privateCalendarMemoryCloud();
  await owner.controller(cloud).prepareAndResume(); const root = await owner.secrets.authority(userId);
  function services(h, transport = cloud) {
    const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets: h.secrets, intents: h.changes, cloud: transport });
    const delivery = createPrivateCalendarKeyDelivery({ userId, secrets: h.secrets, outbox: h.keyOutbox, cloud: transport, now: () => 1_000, randomFraction: () => 0.5 });
    return { authoritySync, delivery, pair: createPrivateCalendarPairingController({ userId, secrets: h.secrets, candidates: h.pairing, intents: h.changes, authoritySync, delivery, cloud: transport }) };
  }
  return { owner, recipient, path, cloud, services, root, reference: privateCalendarPairingReference(root), history, packets, flags, pages };
}

test('private Calendar explicit pairing retains an untrusted protected candidate until signed approval and then imports the same key', async t => {
  const h = await fixture(t); const before = h.pages.length;
  const candidate = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference);
  assert.equal(h.pages.length - before, 1, 'the first page is reused after pin verification');
  assert.equal(candidate.status, 'prepared'); assert.equal(h.history.length, 1); assert.equal(h.packets.size, 0);
  assert.equal((await h.recipient.readProtected()).authority, null); assert.equal((await h.recipient.readProtected()).hasStoredKeys, false);
  await assert.rejects(() => h.services(h.recipient).pair.join(), /承認/u); assert.equal((await h.recipient.readProtected()).authority, null);
  const approved = await h.services(h.owner).pair.approve(candidate.request); assert.equal(approved.kind, 'approved'); assert.equal(h.history.length, 2);
  const joined = await h.services(h.recipient).pair.join(); assert.equal(joined.kind, 'ready'); assert.equal((await h.recipient.pairing.read()).status, 'approved');
  const authority = await h.owner.secrets.authority(userId); const left = await h.owner.secrets.currentKey(userId, authority); const right = await h.recipient.secrets.currentKey(userId, authority);
  assert.deepEqual(left, right); assert.equal(h.packets.size, 1); left.fill(0); right.fill(0);
});

test('private Calendar pairing candidate and nonce survive SQLite and runtime reconstruction without storing a trust pin in SQL', async t => {
  const h = await fixture(t); const first = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference); const generations = h.recipient.state.generations;
  const restarted = privateCalendarSetupFixture(t, { userId, path: h.path.recipient, values: h.recipient.values, state: h.recipient.state });
  const again = await h.services(restarted).pair.prepareConfirmedReference(h.reference); assert.deepEqual(again, first); assert.equal(h.recipient.state.generations, generations);
  const table = restarted.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%pairing%'").all(); assert.equal(table.length, 0);
  await h.services(h.owner).pair.approve(again.request); assert.equal((await h.services(restarted).pair.join()).kind, 'ready');
  const cold = privateCalendarSetupFixture(t, { userId, path: h.path.recipient, values: restarted.values, state: restarted.state });
  const before = cold.state.generations; assert.equal((await h.services(cold).pair.join()).kind, 'ready'); assert.equal(cold.state.generations, before);
  assert.equal((await cold.pairing.read()).request.signature, first.request.signature);
});

test('private Calendar unconfirmed substituted stale and foreign account references cannot generate an identity or formal trust', async t => {
  const h = await fixture(t);
  for (const reference of [{ ...h.reference, anchor: { ...h.reference.anchor, rootDigest: 'a'.repeat(64) } },
    { ...h.reference, authorityDigest: 'b'.repeat(64) }, { ...h.reference, authorityRevision: 2 },
    { ...h.reference, anchor: { ...h.reference.anchor, ownerUserId: 'foreign-account' } }]) {
    await assert.rejects(() => h.services(h.recipient).pair.prepareConfirmedReference(reference)); assert.equal(h.recipient.state.generations, 0); assert.equal(h.recipient.values.size, 0);
  }
  assert.equal(await h.recipient.pairing.read(), null); assert.equal(h.history.length, 1);
});

test('private Calendar tampered pairing proof and stale requests after revocation cannot approve or restore a removed device', async t => {
  const h = await fixture(t); const candidate = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference);
  const bad = structuredClone(candidate.request); bad.body.requestNonce = 'a'.repeat(64); assert.throws(() => verifyPrivateCalendarPairingRequest(bad));
  await assert.rejects(() => h.services(h.owner).pair.approve(bad)); assert.equal(h.history.length, 1);
  await h.services(h.owner).pair.approve(candidate.request); await h.services(h.recipient).pair.join();
  const identity = await h.owner.secrets.identity(userId); await h.services(h.owner).authoritySync.change({ devices: [identity], mainDeviceId: identity.deviceId, keyVersion: 2 });
  const after = h.history.length; await assert.rejects(() => h.services(h.owner).pair.approve(candidate.request), /更新/u);
  await assert.rejects(() => h.services(h.recipient).pair.join(), /解除/u); assert.equal(h.history.length, after); assert.equal(await h.owner.changes.readPending(), null);
  assert.equal((await h.recipient.readProtected()).hasStoredKeys, true); assert.equal((await h.recipient.readProtected()).hasCurrentKey, false);
});

test('private Calendar intervening authority changes require a renewed explicit request and never silently rebase an old approval', async t => {
  const h = await fixture(t); const candidate = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference); const identity = await h.owner.secrets.identity(userId);
  const changed = await h.services(h.owner).authoritySync.change({ devices: [identity], mainDeviceId: identity.deviceId, keyVersion: 2 });
  await assert.rejects(() => h.services(h.owner).pair.approve(candidate.request), /更新/u); assert.equal(h.history.length, 2);
  const renewed = await h.services(h.recipient).pair.prepareConfirmedReference(privateCalendarPairingReference(changed.authority));
  assert.notEqual(renewed.request.body.requestNonce, candidate.request.body.requestNonce); assert.equal(renewed.request.body.rootDigest, candidate.request.body.rootDigest);
  await h.services(h.owner).pair.approve(renewed.request); assert.equal((await h.services(h.recipient).pair.join()).kind, 'ready');
});

test('private Calendar lost approval and key replies recover fixed intents without creating another device or envelope', async t => {
  const h = await fixture(t); const candidate = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference);
  h.flags.controlReplyLost = true; await assert.rejects(() => h.services(h.owner).pair.approve(candidate.request), /lost approval/u);
  assert.equal(h.history.length, 2); assert.ok(await h.owner.changes.readPending()); assert.equal((await h.owner.secrets.authority(userId)).digest, h.root.digest);
  h.flags.keyReplyLost = true; const recovered = await h.services(h.owner).pair.approve(candidate.request); assert.equal(recovered.kind, 'approved'); assert.equal(recovered.delivery.kind, 'deferred');
  assert.equal((await h.services(h.recipient).pair.join()).kind, 'ready'); const packets = [...h.packets.values()]; const generations = h.owner.state.generations;
  assert.equal((await h.services(h.owner).pair.approve(candidate.request)).delivery.kind, 'sent');
  assert.equal(h.history.length, 2); assert.deepEqual([...h.packets.values()], packets); assert.equal(h.owner.state.generations, generations);
});

test('private Calendar approval receipt recovers after another runtime already advanced the protected authority', async t => {
  const h = await fixture(t); const candidate = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference);
  h.flags.controlReplyLost = true; await assert.rejects(h.services(h.owner).pair.approve(candidate.request), /lost approval/u);
  await h.services(h.owner).authoritySync.refresh(); assert.ok(await h.owner.changes.readPending());
  assert.equal((await h.owner.secrets.authority(userId)).signed.body.revision, 2);
  assert.equal((await h.services(h.owner).pair.approve(candidate.request)).kind, 'approved');
  assert.equal((await h.services(h.recipient).pair.join()).kind, 'ready');
  assert.equal(await h.owner.changes.readPending(), null); assert.equal(h.history.length, 2);
});

test('private Calendar corrupt protected pairing candidates fail closed and cannot replace the original identity or pin', async t => {
  const h = await fixture(t); const candidate = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference); const identity = await h.recipient.secrets.identity(userId);
  const raw = await h.recipient.vault.getItem(`private-calendar-pairing:${userId}`); await h.recipient.vault.setItem(`private-calendar-pairing:${userId}`, '{corrupt'); const generations = h.recipient.state.generations;
  await assert.rejects(() => h.recipient.pairing.read()); await assert.rejects(() => h.services(h.recipient).pair.prepareConfirmedReference(h.reference));
  assert.equal(h.recipient.state.generations, generations); assert.equal((await h.recipient.secrets.identity(userId)).deviceId, identity.deviceId);
  await h.recipient.vault.setItem(`private-calendar-pairing:${userId}`, raw); assert.equal(sharedDocumentDigest((await h.recipient.pairing.read()).request), sharedDocumentDigest(candidate.request));
  const foreign = { ...h.reference, anchor: { ...h.reference.anchor, rootDigest: 'f'.repeat(64) } };
  await assert.rejects(() => h.recipient.pairing.prepare(foreign, identity), /置き換えません/u); assert.equal((await h.recipient.pairing.read()).request.signature, candidate.request.signature);
});

test('private Calendar prepared out-of-band reference is copied before asynchronous reads and remains recoverable after an owner switch', async t => {
  const h = await fixture(t); const mutable = structuredClone(h.reference); let release; let entered;
  const gate = new Promise(done => { release = done; }); const pendingRead = new Promise(done => { entered = done; });
  const cloud = { ...h.cloud, async authorityPage(after) { const value = await h.cloud.authorityPage(after); entered(); await gate; return value; } };
  const work = h.services(h.recipient, cloud).pair.prepareConfirmedReference(mutable); await pendingRead; mutable.anchor.rootDigest = 'a'.repeat(64); release();
  const first = await work; assert.equal(first.request.body.rootDigest, h.root.digest);
  h.recipient.state.currentUser = 'other-owner'; await assert.rejects(() => h.recipient.pairing.read(), /account changed/u);
  h.recipient.state.currentUser = userId; assert.deepEqual(await h.recipient.pairing.read(), first);
});

test('private Calendar an unapproved signer in a substituted Cloud approval cannot create a formal pin or fetch a key', async t => {
  const h = await fixture(t); const candidate = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference);
  const ownerIdentity = await h.owner.secrets.identity(userId); const recipientIdentity = await h.recipient.secrets.identity(userId);
  const pending = await h.owner.changes.prepare({ devices: [ownerIdentity, candidate.request.body.device], mainDeviceId: ownerIdentity.deviceId, keyVersion: 1 }, ownerIdentity);
  const bad = { body: pending.signed.body, signature: signSharedDocument(pending.signed.body, recipientIdentity) };
  const substituted = { ...h.root, signed: bad, digest: sharedDocumentDigest(bad) }; let keyReads = 0;
  const cloud = { ...h.cloud, async authorityPage() { return { head: privateCalendarCloudFields(substituted), authorities: [h.root.signed, bad] }; }, async readKey() { keyReads++; throw new Error('must not read a key'); } };
  await assert.rejects(() => h.services(h.recipient, cloud).pair.join());
  assert.equal((await h.recipient.readProtected()).authority, null); assert.equal((await h.recipient.readProtected()).hasStoredKeys, false); assert.equal(keyReads, 0);
});

test('private Calendar a protected candidate committed just before an owner switch recovers the exact request and nonce', async t => {
  const h = await fixture(t);
  h.recipient.state.afterCommit = async () => { if (await h.recipient.vault.getItem(`private-calendar-pairing:${userId}`)) h.recipient.state.currentUser = 'other-owner'; };
  await assert.rejects(() => h.services(h.recipient).pair.prepareConfirmedReference(h.reference), /account changed/u);
  h.recipient.state.afterCommit = null; h.recipient.state.currentUser = userId;
  const saved = await h.recipient.pairing.read(); assert.equal(saved.status, 'prepared'); const generations = h.recipient.state.generations;
  assert.deepEqual(await h.services(h.recipient).pair.prepareConfirmedReference(h.reference), saved); assert.equal(h.recipient.state.generations, generations);
  assert.equal((await h.recipient.readProtected()).authority, null);
});

test('private Calendar a revoked device can rejoin only through a fresh confirmed reference and new approval while retaining its original identity and old keys', async t => {
  const h = await fixture(t); const original = await h.services(h.recipient).pair.prepareConfirmedReference(h.reference);
  await h.services(h.owner).pair.approve(original.request); await h.services(h.recipient).pair.join();
  const oldIdentity = await h.recipient.secrets.identity(userId); const owner = await h.owner.secrets.identity(userId);
  const removed = await h.services(h.owner).authoritySync.change({ devices: [owner], mainDeviceId: owner.deviceId, keyVersion: 2 });
  await assert.rejects(() => h.services(h.owner).pair.approve(original.request), /更新/u);
  // prepare refreshes the old local checkpoint before considering an explicitly confirmed renewal.
  const renewed = await h.services(h.recipient).pair.prepareConfirmedReference(privateCalendarPairingReference(removed.authority));
  assert.equal(renewed.request.body.device.deviceId, oldIdentity.deviceId); assert.notEqual(renewed.request.body.requestNonce, original.request.body.requestNonce);
  await h.services(h.owner).pair.approve(renewed.request); assert.equal((await h.services(h.recipient).pair.join()).kind, 'ready');
  assert.deepEqual(await h.recipient.secrets.identity(userId), oldIdentity);
  assert.equal(JSON.parse(await h.recipient.vault.getItem(`private-calendar-state:${userId}`)).keys.length, 2);
});
