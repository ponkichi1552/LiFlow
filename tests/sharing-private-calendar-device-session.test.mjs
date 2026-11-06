import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarDeviceSession } from '../src/features/sharing/private-calendar/device-session.ts';

const userId = 'device-settings-owner';
function session(f, cloud) {
  return createPrivateCalendarDeviceSession({ userId, assertOwner: () => assert.equal(f.state.currentUser, userId, 'owner changed'),
    secrets: f.secrets, roots: f.roots, intents: f.changes, candidates: f.pairing, outbox: f.keyOutbox, cache: f.cache, cloud });
}
function fixture(t) {
  const transport = privateCalendarMemoryCloud(); const owner = privateCalendarSetupFixture(t, { userId }); const recipient = privateCalendarSetupFixture(t, { userId });
  return { ...transport, owner, recipient, a: session(owner, transport.cloud), b: session(recipient, transport.cloud) };
}
async function paired(t) {
  const f = fixture(t); const first = await f.a.initializeFirstDevice(); const request = await f.b.prepareConfirmedReference(first.reference);
  await f.a.approveConfirmedRequest(request.request); await f.b.acceptApproval(); return f;
}

test('a conflicting unaccepted first-device proposal can use the existing reviewed pairing flow without deleting trust or generating a second identity', async t => {
  const f = fixture(t); const first = await f.a.initializeFirstDevice();
  await assert.rejects(() => f.b.initializeFirstDevice(), { code: 'private-calendar/conflict' });
  const intent = await f.recipient.roots.read(); const identity = await f.recipient.secrets.identity(userId);
  assert.equal((await f.b.read()).phase, 'firstPending'); assert.equal((await f.recipient.readProtected()).hasStoredKeys, false);
  const restarted = session(f.recipient, f.cloud);
  const prepared = await restarted.prepareConfirmedReference(first.reference);
  assert.equal(prepared.phase, 'pairing'); assert.equal(prepared.deviceId, identity.deviceId); assert.ok(prepared.request);
  assert.equal(await f.recipient.roots.read(), null); assert.equal((await f.recipient.readProtected()).authority, null);
  assert.equal(await f.recipient.roots.discardUnaccepted(intent.digest), false);
  await f.a.approveConfirmedRequest(prepared.request); const approved = await restarted.acceptApproval();
  assert.equal(approved.phase, 'approved'); assert.equal(approved.keyReady, true);
});

test('unaccepted first-device recovery preserves proposals on an unknown server stale reference account switch or protected cache', async t => {
  const f = fixture(t); const first = await f.a.initializeFirstDevice(); await assert.rejects(() => f.b.initializeFirstDevice());
  const intent = await f.recipient.roots.read();
  for (const head of [null, { ...(await f.cloud.readHead()), rootDigest: '0'.repeat(64) }]) {
    const unknown = session(f.recipient, { ...f.cloud, readHead: async () => head });
    await assert.rejects(() => unknown.prepareConfirmedReference(first.reference)); assert.equal((await f.recipient.roots.read()).digest, intent.digest);
  }
  const switched = session(f.recipient, { ...f.cloud, async readHead() { const head = await f.cloud.readHead(); f.recipient.state.currentUser = 'other'; return head; } });
  await assert.rejects(() => switched.prepareConfirmedReference(first.reference), /owner changed/); f.recipient.state.currentUser = userId;
  assert.equal((await f.recipient.roots.read()).digest, intent.digest);
  f.recipient.connection.exec("CREATE TABLE IF NOT EXISTS private_calendar_cache (id TEXT PRIMARY KEY); INSERT INTO private_calendar_cache VALUES ('retained-ciphertext')");
  await assert.rejects(() => f.b.prepareConfirmedReference(first.reference), /復旧/u);
  assert.equal((await f.recipient.roots.read()).digest, intent.digest);
  assert.equal(f.recipient.connection.prepare('SELECT id FROM private_calendar_cache').get().id, 'retained-ciphertext');
});

test('private Calendar settings reads and unconfigured sync do not generate any identity pin key or cloud request', async t => {
  const f = fixture(t); let touched = false;
  const cloud = new Proxy(f.cloud, { get() { return () => { touched = true; throw new Error('no network'); }; } }); const screen = session(f.owner, cloud);
  assert.equal(await f.owner.secrets.publicState(userId), null);
  assert.equal((await screen.read()).phase, 'unconfigured'); assert.equal((await screen.synchronizeDevices()).phase, 'unconfigured');
  assert.equal(f.owner.state.generations, 0); assert.equal(f.owner.values.size, 0); assert.equal(touched, false); assert.equal(f.history.length, 0);
});

test('private Calendar settings explicit first device and reviewed pairing return public state without secret keys or cache plaintext', async t => {
  const f = await paired(t); const a = await f.a.read(); const b = await f.b.read();
  assert.equal(a.phase, 'approved'); assert.equal(b.phase, 'approved'); assert.equal(a.revision, 2); assert.equal(b.revision, 2);
  assert.equal(a.keyReady, true); assert.equal(b.keyReady, true); assert.equal(a.pendingKeys, 0); assert.notEqual(a.deviceId, b.deviceId);
  assert.equal(a.reference.anchor.rootDigest, b.reference.anchor.rootDigest);
  const originalLength = f.history.length; await f.a.changeMain(a.mainDeviceId, a.authorityDigest); assert.equal(f.history.length, originalLength);
  for (const state of [a,b]) for (const field of ['signingSecretKey','agreementSecretKey','encryptedPayload','intervals','calendarBinding']) assert.equal(JSON.stringify(state).includes(field), false);
  const authority = await f.owner.secrets.authority(userId); const left = await f.owner.secrets.currentKey(userId, authority); const right = await f.recipient.secrets.currentKey(userId, authority);
  assert.deepEqual(left, right); left.fill(0); right.fill(0);
  await assert.rejects(() => f.a.initializeFirstDevice(), /既に/u); assert.equal(f.history.length, 2);
});

test('private Calendar settings require a fresh displayed authority for main changes and explicit revocation before renewed pairing', async t => {
  const f = await paired(t); const before = await f.a.read(); const recipient = await f.b.read();
  const changed = await f.a.changeMain(recipient.deviceId, before.authorityDigest); assert.equal(changed.mainDeviceId, recipient.deviceId);
  await assert.rejects(() => f.a.changeMain(before.deviceId, before.authorityDigest), /表示後/u); assert.equal(f.history.length, 3);
  const revoked = await f.a.revokeDevice(recipient.deviceId, changed.authorityDigest); assert.equal(revoked.keyVersion, 2); assert.equal(revoked.mainDeviceId, before.deviceId);
  const stopped = await f.b.synchronizeDevices(); assert.equal(stopped.phase, 'revoked'); assert.equal(stopped.keyReady, false);
  await assert.rejects(() => f.b.acceptApproval(), /解除/u);
  const generations = f.recipient.state.generations; const renewal = await f.b.prepareConfirmedReference(revoked.reference);
  assert.equal(renewal.deviceId, recipient.deviceId); assert.equal(renewal.phase, 'revoked'); assert.ok(renewal.request);
  await f.a.approveConfirmedRequest(renewal.request); const joined = await f.b.acceptApproval(); assert.equal(joined.keyVersion, 2); assert.equal(joined.keyReady, true);
  assert.ok(f.recipient.state.generations >= generations); assert.equal((await f.recipient.readProtected()).hasStoredKeys, true);
  const final = await f.a.read(); await assert.rejects(() => f.a.revokeDevice(before.deviceId, final.authorityDigest), /操作中/u);
});

test('private Calendar settings retain prepared approval after a lost reply and distinguish delivery pending from sent', async t => {
  const f = fixture(t); const initial = await f.a.initializeFirstDevice(); const request = await f.b.prepareConfirmedReference(initial.reference);
  f.flags.controlReplyLost = true; await assert.rejects(() => f.a.approveConfirmedRequest(request.request), /lost approval/u);
  assert.ok((await f.a.read()).pendingChange); const historyLength = f.history.length; f.flags.keyReplyLost = true;
  const queued = await f.a.synchronizeDevices(); assert.equal(queued.phase, 'approved'); assert.equal(queued.pendingKeys, 1); assert.ok(queued.keyRetryAt);
  const generations = f.owner.state.generations; const waiting = await f.a.synchronizeDevices({ force: false });
  assert.equal(waiting.pendingKeys, 1); assert.equal(waiting.keyRetryAt, queued.keyRetryAt); assert.equal(f.owner.state.generations, generations);
  assert.equal((await f.a.synchronizeDevices()).pendingKeys, 0); assert.equal(f.history.length, historyLength);
  assert.equal((await f.b.acceptApproval()).keyReady, true); assert.equal(f.packets.size, 1);
});

test('private Calendar automatic device refresh does not emit an explicit-configuration feedback loop but manual changes still notify', async t => {
  const f = await paired(t); let changes = 0; const stop = f.a.subscribe(() => { changes++; });
  await f.a.synchronizeDevices({ force: false }); assert.equal(changes, 0);
  await f.a.synchronizeDevices(); assert.equal(changes, 1); stop(); await f.a.synchronizeDevices(); assert.equal(changes, 1);
});

test('private Calendar settings coalesce concurrent manual sync and reject another mutation until the current action ends', async t => {
  const f = await paired(t); let release; let entered;
  const gate = new Promise(done => { release = done; }); const waiting = new Promise(done => { entered = done; }); let pages = 0;
  const cloud = { ...f.cloud, async authorityPage(after) { pages++; const page = await f.cloud.authorityPage(after); entered(); await gate; return page; } };
  const screen = session(f.owner, cloud); const calls = Array.from({ length: 100 }, () => screen.synchronizeDevices()); await waiting;
  assert.equal(new Set(calls).size, 1); const target = await f.b.read(); const source = await f.a.read();
  await assert.rejects(() => screen.changeMain(target.deviceId, source.authorityDigest), /操作が終わって/u);
  release(); const states = await Promise.all(calls); assert.equal(pages, 1); assert.ok(states.every(state => state.revision === 2));
});

test('private Calendar settings reject account changes and preserve prepared data for the original account', async t => {
  const f = fixture(t); await f.a.initializeFirstDevice(); const original = [...f.owner.values]; const count = f.owner.state.generations;
  f.owner.state.currentUser = 'other-owner'; await assert.rejects(() => f.a.read(), /owner changed/u); await assert.rejects(() => f.a.synchronizeDevices(), /owner changed/u);
  assert.deepEqual([...f.owner.values], original); assert.equal(f.owner.state.generations, count);
  f.owner.state.currentUser = userId; assert.equal((await f.a.read()).keyReady, true);
});

test('private Calendar settings retain a losing device change for explicit review and never dismiss it using a stale observed authority', async t => {
  const f = await paired(t); const original = await f.a.read(); const other = await f.b.read();
  const authority = await f.owner.secrets.authority(userId); const identity = await f.owner.secrets.identity(userId);
  await f.owner.changes.prepare({ devices: authority.signed.body.devices, mainDeviceId: identity.deviceId, keyVersion: 2 }, identity);
  const changed = await f.b.changeMain(other.deviceId, other.authorityDigest); const review = await f.a.synchronizeDevices();
  assert.equal(review.mainDeviceId, other.deviceId); assert.equal(review.pendingChange.reviewRequired, true);
  await assert.rejects(() => f.a.dismissReviewed(review.pendingChange.digest, original.authorityDigest), /変わりました/u);
  assert.ok((await f.a.read()).pendingChange); assert.equal(f.history.length, 3);
  const resolved = await f.a.dismissReviewed(review.pendingChange.digest, changed.authorityDigest);
  assert.equal(resolved.pendingChange, null); assert.equal(resolved.authorityDigest, changed.authorityDigest); assert.equal(f.history.length, 3);
  assert.equal((await f.owner.readProtected()).hasStoredKeys, true);
});

test('private Calendar public settings reject corrupt protected state without replacing identity or retained keys', async t => {
  const f = await paired(t); const name = `private-calendar-state:${userId}`; const original = await f.owner.vault.getItem(name); const count = f.owner.state.generations;
  await f.owner.vault.setItem(name, '{corrupt'); await assert.rejects(() => f.a.read()); await assert.rejects(() => f.a.initializeFirstDevice());
  assert.equal(f.owner.state.generations, count); assert.equal(await f.owner.vault.getItem(name), '{corrupt');
  await f.owner.vault.setItem(name, original); assert.equal((await f.a.read()).keyReady, true);
});

test('private Calendar three approved device sessions settle an existing recipient key from another sender without endless retries', async t => {
  const f = await paired(t); const third = privateCalendarSetupFixture(t, { userId }); const c = session(third, f.cloud);
  const prepared = await c.prepareConfirmedReference((await f.a.read()).reference); await f.a.approveConfirmedRequest(prepared.request);
  await c.acceptApproval(); const second = await f.b.synchronizeDevices();
  assert.equal(second.pendingKeys, 0, 'a recipient already served by another approved sender must not remain pending');
  assert.equal((await c.synchronizeDevices()).pendingKeys, 0);
  const before = f.packets.size; const generations = f.recipient.state.generations;
  assert.equal((await f.b.synchronizeDevices()).pendingKeys, 0); assert.equal(f.packets.size, before); assert.equal(f.recipient.state.generations, generations);
  const authority = await f.owner.secrets.authority(userId); const a = await f.owner.secrets.currentKey(userId, authority); const b = await f.recipient.secrets.currentKey(userId, authority); const last = await third.secrets.currentKey(userId, authority);
  assert.deepEqual(a, b); assert.deepEqual(a, last); a.fill(0); b.fill(0); last.fill(0);
});
