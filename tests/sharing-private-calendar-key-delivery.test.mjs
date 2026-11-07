import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { advancePrivateCalendarAuthority } from '../src/features/sharing/private-calendar/authority.ts';
import { privateCalendarCloudFields } from '../src/features/sharing/private-calendar/cloud-contract.ts';
import { unwrapPrivateCalendarKey, wrapPrivateCalendarKey } from '../src/features/sharing/private-calendar/key-envelope.ts';
import { createPrivateCalendarKeyDelivery } from '../src/features/sharing/private-calendar/key-delivery.ts';
import { privateCalendarDeliveryRetry } from '../src/features/sharing/private-calendar/delivery-retry.ts';

function file(t) { const dir = mkdtempSync(join(tmpdir(), 'liflow-fixed-keys-')); t.after(() => rmSync(dir, { force: true, recursive: true })); return join(dir, 'keys.db'); }
async function fixture(t, options = {}) {
  const f = privateCalendarSetupFixture(t, options);
  await f.controller({ async createRoot(root) { return { head: privateCalendarCloudFields(root) }; } }).prepareAndResume();
  const identity = await f.secrets.identity(f.userId); const root = await f.secrets.authority(f.userId); const other = await createDeviceIdentity(crypto);
  const authority = advancePrivateCalendarAuthority(root, { mainDeviceId: identity.deviceId, keyVersion: 1, devices: [identity, other] }, identity);
  await f.secrets.acceptAuthorityUpdate(f.userId, authority.signed);
  return { f, identity, other, authority };
}
const delivery = (f, cloud, options = {}) => createPrivateCalendarKeyDelivery({ userId: f.userId, secrets: f.secrets, outbox: f.keyOutbox, cloud, ...options });

test('audit100 one recipient key delivery failure cannot block an independent approved recipient', async t => {
  const { f, identity, other, authority: before } = await fixture(t); const third = await createDeviceIdentity(crypto);
  const authority = advancePrivateCalendarAuthority(before, { devices: [identity, other, third], mainDeviceId: identity.deviceId, keyVersion: 1 }, identity);
  await f.secrets.acceptAuthorityUpdate(f.userId, authority.signed);
  const attempts = [];
  const sender = delivery(f, { sendKey: async (_authority, wrapped) => { attempts.push(wrapped.body.recipientDeviceId); if (attempts.length === 1) throw Object.assign(new Error('recipient permission failure'), { code: 'permission-denied' }); } }, { now: () => 1000, randomFraction: () => .5 });
  await sender.queueApprovedDevices(); const result = await sender.flush();
  assert.equal(attempts.length, 2); assert.equal(new Set(attempts).size, 2);
  assert.equal(result.kind, 'deferred'); assert.equal(result.sent, 1);
  assert.equal((await f.keyOutbox.status(authority)).pending, 1);
});

test('private Calendar observed key availability rejects tampering wrong candidates and same-sender forks while retaining the original ciphertext', async t => {
  const { f, identity, other, authority: before } = await fixture(t); const third = await createDeviceIdentity(crypto);
  const authority = advancePrivateCalendarAuthority(before, { devices: [identity, other, third], mainDeviceId: identity.deviceId, keyVersion: 1 }, identity);
  await f.secrets.acceptAuthorityUpdate(f.userId, authority.signed); const key = await f.secrets.currentKey(f.userId, authority);
  try {
    const candidate = await f.keyOutbox.prepare(authority, other.deviceId, identity, key); const existing = await wrapPrivateCalendarKey(crypto, key, authority, third, other.deviceId);
    const bad = structuredClone(existing); bad.signature = '00'.repeat(64);
    await assert.rejects(() => f.keyOutbox.observeAvailable(authority, other.deviceId, candidate.envelopeDigest, bad));
    assert.equal(await f.keyOutbox.observeAvailable(authority, other.deviceId, 'a'.repeat(64), existing), false);
    const fork = await wrapPrivateCalendarKey(crypto, key, authority, identity, other.deviceId);
    await assert.rejects(() => f.keyOutbox.observeAvailable(authority, other.deviceId, candidate.envelopeDigest, fork), /同じ送信端末/u);
    assert.equal((await f.keyOutbox.status(authority)).pending, 1);
    const accepted = f.keyOutbox.observeAvailable(authority, other.deviceId, candidate.envelopeDigest, existing); existing.body.nonce = '00'.repeat(12);
    assert.equal(await accepted, true); const after = await f.keyOutbox.prepare(authority, other.deviceId, identity, key);
    assert.equal(after.pending, false); assert.equal(after.envelopeDigest, candidate.envelopeDigest); assert.deepEqual(after.wrapped, candidate.wrapped);
  } finally { key.fill(0); }
});

test('private Calendar observed recipient delivery cannot acknowledge after an authority or account change', async t => {
  const { f, identity, other, authority } = await fixture(t); const key = await f.secrets.currentKey(f.userId, authority);
  const candidate = await f.keyOutbox.prepare(authority, other.deviceId, identity, key); key.fill(0);
  f.state.currentUser = 'foreign-owner'; await assert.rejects(() => f.keyOutbox.observeAvailable(authority, other.deviceId, candidate.envelopeDigest, candidate.wrapped), /account changed/u);
  f.state.currentUser = f.userId; const changed = advancePrivateCalendarAuthority(authority, { devices: [identity, other], mainDeviceId: identity.deviceId, keyVersion: 2 }, identity);
  await f.secrets.acceptAuthorityUpdate(f.userId, changed.signed);
  await assert.rejects(() => f.keyOutbox.observeAvailable(authority, other.deviceId, candidate.envelopeDigest, candidate.wrapped), /変わりました/u);
  assert.equal(f.connection.prepare('SELECT pending FROM private_calendar_key_outbox').get().pending, 1);
});

test('private Calendar key outbox persists the exact signed ciphertext across SQL reconstruction without rewrapping or exposing keys', async t => {
  const path = file(t); const { f, identity, other, authority } = await fixture(t, { path });
  const key = await f.secrets.currentKey(f.userId, authority); const first = await f.keyOutbox.prepare(authority, other.deviceId, identity, key);
  const generations = f.state.generations;
  const restored = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state });
  const again = await restored.keyOutbox.prepare(authority, other.deviceId, identity, key);
  assert.deepEqual(again, first); assert.equal(f.state.generations, generations);
  assert.deepEqual(await unwrapPrivateCalendarKey(crypto, again.wrapped, authority, other), key);
  const row = JSON.stringify(f.connection.prepare('SELECT * FROM private_calendar_key_outbox').all());
  for (const value of [identity.signingSecretKey, identity.agreementSecretKey, Buffer.from(key).toString('hex')]) assert.equal(row.includes(value), false);
  assert.equal(await restored.keyOutbox.acknowledge(authority, other.deviceId, 'a'.repeat(64)), false);
  assert.equal(await restored.keyOutbox.acknowledge(authority, other.deviceId, first.envelopeDigest), true);
  const acknowledged = await restored.keyOutbox.prepare(authority, other.deviceId, identity, key);
  assert.equal(acknowledged.pending, false); assert.equal(acknowledged.envelopeDigest, first.envelopeDigest); assert.equal(f.state.generations, generations);
  assert.deepEqual(await restored.keyOutbox.pending(authority, 0), []); key.fill(0);
});

test('private Calendar ambiguous key delivery keeps fixed bytes and backoff across restart and reports waiting rather than synchronization success', async t => {
  const path = file(t); const { f } = await fixture(t, { path }); let time = 1_000; let calls = 0; let accepted; const sent = [];
  const cloud = { async sendKey(authority, wrapped) {
    calls++; const json = JSON.stringify(wrapped); accepted ??= json; assert.equal(json, accepted); sent.push(json);
    if (calls === 1) throw Object.assign(new Error('reply lost after immutable write'), { code: 'unavailable' });
  } };
  const options = { now: () => time, randomFraction: () => 0.5 }; const first = delivery(f, cloud, options);
  assert.deepEqual(await first.queueApprovedDevices(), { kind: 'queued', count: 1 });
  assert.deepEqual(await first.flush(), { kind: 'deferred', sent: 0, code: 'temporary' });
  const authority = await f.secrets.authority(f.userId); assert.deepEqual(await f.keyOutbox.status(authority), { pending: 1, retryAt: 31_000 });
  const restored = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state }); const resumed = delivery(restored, cloud, options); const generations = f.state.generations;
  await resumed.queueApprovedDevices(); assert.equal(f.state.generations, generations);
  assert.deepEqual(await resumed.flush(), { kind: 'waiting', sent: 0, pending: 1, nextRetryAt: 31_000 }); assert.equal(calls, 1);
  time = 31_000; assert.deepEqual(await resumed.flush(), { kind: 'sent', sent: 1, pending: 0 }); assert.equal(calls, 2); assert.equal(sent[0], sent[1]);
  await resumed.queueApprovedDevices(); assert.deepEqual(await resumed.flush(), { kind: 'sent', sent: 0, pending: 0 }); assert.equal(calls, 2);
});

test('private Calendar two SQL runtimes prepare one recipient envelope with one nonce allocation', async t => {
  const path = file(t); const { f, identity, other, authority } = await fixture(t, { path });
  const second = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state }); const key = await f.secrets.currentKey(f.userId, authority);
  const before = f.state.generations;
  const [left, right] = await Promise.all([f.keyOutbox.prepare(authority, other.deviceId, identity, key), second.keyOutbox.prepare(authority, other.deviceId, identity, key)]);
  assert.deepEqual(left, right); assert.equal(f.state.generations - before, 3); assert.equal(f.connection.prepare('SELECT count(*) AS n FROM private_calendar_key_outbox').get().n, 1); key.fill(0);
});

test('private Calendar new authority retires only obsolete wrapped copies and stale replies cannot acknowledge the new delivery', async t => {
  const { f, identity, other, authority } = await fixture(t); const oldKey = await f.secrets.currentKey(f.userId, authority);
  const old = await f.keyOutbox.prepare(authority, other.deviceId, identity, oldKey);
  const next = advancePrivateCalendarAuthority(authority, { devices: [identity, other], mainDeviceId: identity.deviceId, keyVersion: 2 }, identity);
  await f.secrets.acceptAuthorityUpdate(f.userId, next.signed); const key = await f.secrets.createCurrentKey(f.userId, next);
  const fresh = await f.keyOutbox.prepare(next, other.deviceId, identity, key); assert.notEqual(fresh.envelopeDigest, old.envelopeDigest);
  await assert.rejects(() => f.keyOutbox.acknowledge(authority, other.deviceId, old.envelopeDigest), /世代/u);
  assert.equal(await f.keyOutbox.acknowledge(next, other.deviceId, old.envelopeDigest), false);
  const rows = f.connection.prepare('SELECT * FROM private_calendar_key_outbox').all(); assert.equal(rows.length, 1); assert.equal(rows[0].authority_digest, next.digest);
  const saved = JSON.parse(await f.vault.getItem(`private-calendar-state:${f.userId}`)); assert.equal(saved.keys.length, 2); assert.equal(saved.keys[0].value, Buffer.from(oldKey).toString('hex'));
  assert.equal((await f.keyOutbox.status(next)).pending, 1); assert.deepEqual(await unwrapPrivateCalendarKey(crypto, fresh.wrapped, next, other), key); oldKey.fill(0); key.fill(0);
});

test('private Calendar key preparation snapshots caller bytes before awaits and wipes unreturned plaintext on encryption failure', async t => {
  const { f, identity, other, authority } = await fixture(t); const key = await f.secrets.currentKey(f.userId, authority); const original = key.slice();
  f.state.beforeRandom = () => { key.fill(99); };
  const prepared = await f.keyOutbox.prepare(authority, other.deviceId, identity, key);
  assert.deepEqual(await unwrapPrivateCalendarKey(crypto, prepared.wrapped, authority, other), original);
  const next = advancePrivateCalendarAuthority(authority, { devices: [identity, other], mainDeviceId: identity.deviceId, keyVersion: 2 }, identity);
  f.state.beforeRandom = null; await f.secrets.acceptAuthorityUpdate(f.userId, next.signed); const nextKey = await f.secrets.createCurrentKey(f.userId, next); let temporary;
  f.gateway.encrypt = async (_key, _nonce, plaintext) => { temporary = plaintext; throw new Error('Native encryption failed'); };
  await assert.rejects(() => f.keyOutbox.prepare(next, other.deviceId, identity, nextKey), /encryption failed/u);
  assert.ok(temporary.every(byte => byte === 0)); assert.equal(f.connection.prepare('SELECT count(*) AS n FROM private_calendar_key_outbox').get().n, 1);
  key.fill(0); original.fill(0); nextKey.fill(0);
});

test('private Calendar corrupt wrapped SQL and account changes fail closed without overwriting the queued ciphertext', async t => {
  const { f, identity, other, authority } = await fixture(t); const key = await f.secrets.currentKey(f.userId, authority);
  const prepared = await f.keyOutbox.prepare(authority, other.deviceId, identity, key); const row = f.connection.prepare('SELECT * FROM private_calendar_key_outbox').get();
  f.connection.prepare('UPDATE private_calendar_key_outbox SET envelope_json = ?').run('{broken');
  const generations = f.state.generations; await assert.rejects(() => f.keyOutbox.prepare(authority, other.deviceId, identity, key)); assert.equal(f.state.generations, generations);
  f.connection.prepare('UPDATE private_calendar_key_outbox SET envelope_json = ?').run(row.envelope_json); f.state.currentUser = 'another-owner';
  await assert.rejects(() => f.keyOutbox.pending(authority, 0), /account changed/u); f.state.currentUser = f.userId;
  assert.equal((await f.keyOutbox.pending(authority, 0))[0].envelopeDigest, prepared.envelopeDigest); key.fill(0);
});

test('private Calendar a new main without its generation key waits for delivery while the original approved issuer may finish distribution', async t => {
  const { f, identity, other, authority } = await fixture(t); const waiting = privateCalendarSetupFixture(t, { userId: f.userId });
  // Install the actual recipient identity into its own protected fixture before explicit pairing.
  const deviceState = { schemaVersion: 1, ownerUserId: f.userId, identity: other, anchor: null, checkpoint: null, origin: null, keys: [] };
  await waiting.vault.setItem(`private-calendar-state:${f.userId}`, JSON.stringify(deviceState));
  await waiting.secrets.confirmTrust(f.userId, authority, 'approvedPairing');
  const rotated = advancePrivateCalendarAuthority(authority, { devices: [identity, other], mainDeviceId: identity.deviceId, keyVersion: 2 }, identity);
  const switched = advancePrivateCalendarAuthority(rotated, { devices: [identity, other], mainDeviceId: other.deviceId, keyVersion: 2 }, identity);
  for (const h of [f, waiting]) { await h.secrets.acceptAuthorityUpdate(f.userId, rotated.signed); await h.secrets.acceptAuthorityUpdate(f.userId, switched.signed); }
  const before = waiting.state.generations; assert.deepEqual(await delivery(waiting, {}).queueApprovedDevices(), { kind: 'awaitingKey', count: 0 }); assert.equal(waiting.state.generations, before);
  assert.equal((await delivery(f, {}).queueApprovedDevices()).count, 1);
  const packet = (await f.keyOutbox.pending(switched, 0))[0]; await waiting.secrets.receiveCurrentKey(f.userId, switched, packet.wrapped);
  const left = await f.secrets.currentKey(f.userId, switched); const right = await waiting.secrets.currentKey(f.userId, switched); assert.deepEqual(left, right); left.fill(0); right.fill(0);
});

test('private Calendar fifteen approved recipient deliveries are bounded and one hundred concurrent flushes share one send attempt', async t => {
  const { f, identity, authority, other } = await fixture(t); const devices = [identity, other];
  while (devices.length < 16) devices.push(await createDeviceIdentity(crypto));
  const next = advancePrivateCalendarAuthority(authority, { devices, mainDeviceId: identity.deviceId, keyVersion: 1 }, identity); await f.secrets.acceptAuthorityUpdate(f.userId, next.signed);
  let calls = 0; const recipients = new Set(); const service = delivery(f, { async sendKey(expected, wrapped) { assert.equal(expected.digest, next.digest); calls++; recipients.add(wrapped.body.recipientDeviceId); } });
  assert.deepEqual(await service.queueApprovedDevices(), { kind: 'queued', count: 15 });
  const results = await Promise.all(Array.from({ length: 100 }, () => service.flush())); assert.ok(results.every(result => result.kind === 'sent' && result.sent === 15));
  assert.equal(calls, 15); assert.equal(recipients.size, 15); assert.equal((await f.keyOutbox.status(next)).pending, 0);
  await service.queueApprovedDevices(); assert.equal((await service.flush()).sent, 0); assert.equal(calls, 15);
});

test('private Calendar shared retry policy preserves jitter and cap and refuses unsafe timestamps before saving', () => {
  assert.deepEqual(privateCalendarDeliveryRetry(0, 1000, 0), { attempts: 1, retryAt: 25_000 });
  assert.deepEqual(privateCalendarDeliveryRetry(0, 1000, 1), { attempts: 1, retryAt: 37_000 });
  assert.equal(privateCalendarDeliveryRetry(100, 0, 1).retryAt, 6 * 60 * 60 * 1000);
  assert.equal(privateCalendarDeliveryRetry(1_000_000, 0, 0.5).attempts, 1_000_000);
  for (const args of [[-1, 0, 0], [0, Number.MAX_SAFE_INTEGER, 0.5], [0, -1, 0], [0, 0, NaN], [0, 0, 1.01]]) assert.throws(() => privateCalendarDeliveryRetry(...args));
});

test('private Calendar explicit manual key retry bypasses backoff with the same envelope while automatic retries keep waiting', async t => {
  const { f } = await fixture(t); let available = false; const packets = [];
  const service = delivery(f, { async sendKey(_authority, packet) {
    packets.push(JSON.stringify(packet)); if (!available) throw Object.assign(new Error('offline'), { code: 'unavailable' });
  } }, { now: () => 10, randomFraction: () => 0.5 });
  await service.queueApprovedDevices(); assert.equal((await service.flush()).kind, 'deferred');
  assert.equal((await service.flush()).kind, 'waiting'); available = true;
  const [background, manual] = await Promise.all([service.flush(), service.flush({ force: true })]);
  assert.equal(background.kind, 'waiting'); assert.equal(manual.kind, 'sent'); assert.equal(packets.length, 2); assert.equal(packets[0], packets[1]);
});
