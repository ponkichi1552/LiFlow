import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarDeviceSession } from '../src/features/sharing/private-calendar/device-session.ts';
import { decodeConnectionCode, verifyConnectionGrant, verifyConnectionClaim, CONNECTION_CODE_LIFETIME_MS } from '../src/features/sharing/private-calendar/connection-code.ts';

function device(t, h, options = {}) {
  const f = privateCalendarSetupFixture(t, { userId: 'code-owner', ...options });
  const port = { userId: f.userId, assertOwner: () => assert.equal(f.state.currentUser, f.userId), secrets: f.secrets, roots: f.roots, intents: f.changes,
    candidates: f.pairing, outbox: f.keyOutbox, cache: f.cache, cloud: h.cloud,
    connections: { store: f.connections, cloud: h.connectionCloud, crypto: f.gateway, ...(options.now ? { now: options.now } : {}) } };
  return { ...f, session: createPrivateCalendarDeviceSession(port), reopen: () => createPrivateCalendarDeviceSession(port) };
}
async function until(testValue) {
  for (let n = 0; n < 100; n++) {
    try { if (await testValue()) return; }
    catch (error) { if (!/設定が読込中に変わりました/u.test(error.message)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('expected the automatic handshake to finish');
}

test('connection codes authorize one same-account device automatically without exporting private keys or a bearer secret to Cloud', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h);
  await a.session.initializeFirstDevice(); const stopA = a.session.observeConnections(), stopB = b.session.observeConnections(); t.after(stopA); t.after(stopB);
  const text = await a.session.issueConnectionCode(), code = decodeConnectionCode(text);
  assert.equal(text.startsWith('LFS1.'), true); assert.equal(code.grant.body.expiresAt - code.grant.body.issuedAt, CONNECTION_CODE_LIFETIME_MS);
  assert.equal(JSON.stringify(h.codes.get(code.grant.body.codeId)).includes(code.secret), false);
  assert.equal(JSON.stringify(code).includes('SecretKey'), false);
  await b.session.connectWithCode(text); await until(async () => (await b.session.read()).keyReady);
  assert.equal(h.codes.get(code.grant.body.codeId).state, 'complete'); assert.equal(h.history.length, 2);
  assert.equal((await b.session.read()).phase, 'approved'); assert.equal((await b.connections.read()).state.joining, null);
  await until(() => h.watchers() === 0);
  const reads = h.codeReads(); await a.session.synchronizeDevices({ force: false }); await b.session.synchronizeDevices({ force: false });
  assert.equal(h.codeReads(), reads, 'ordinary background work must not read handoff documents');
});

test('connection codes cannot be used by a second device or with a forged proof, modified signature, expired grant or foreign account', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h), c = device(t, h);
  await a.session.initializeFirstDevice(); const text = await a.session.issueConnectionCode(), code = decodeConnectionCode(text);
  const initial = await a.secrets.authority(a.userId), bad = structuredClone(code.grant); bad.signature = '00'.repeat(64);
  assert.throws(() => verifyConnectionGrant(bad, initial, a.userId, Date.now()), /signature|署名/u);
  assert.throws(() => verifyConnectionGrant(code.grant, initial, 'another-account', Date.now()));
  assert.throws(() => verifyConnectionGrant(code.grant, initial, a.userId, code.grant.body.expiresAt));
  await b.session.connectWithCode(text); await assert.rejects(c.session.connectWithCode(text), /used code/u);
  const row = h.codes.get(code.grant.body.codeId); const original = structuredClone(row.claim);
  row.claim.proof = '00'.repeat(32); await assert.rejects(a.session.synchronizeDevices(), /受け取り/u); assert.equal(h.history.length, 1);
  row.claim = original; await a.session.synchronizeDevices(); await b.session.synchronizeDevices();
  assert.equal((await b.session.read()).keyReady, true); assert.equal(h.history.length, 2);
  assert.throws(() => decodeConnectionCode('{"reference":"legacy-or-invalid"}'));
  assert.throws(() => decodeConnectionCode('LFS1.' + 'A'.repeat(8000)));
  assert.throws(() => verifyConnectionClaim(code, { ...original, proof: '00'.repeat(32) }));
});

test('a valid connection code recovers a conflicting unaccepted first setup without replacing protected trust', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h);
  await a.session.initializeFirstDevice(); await assert.rejects(b.session.initializeFirstDevice());
  const pending = await b.roots.read(); assert.equal(pending.status, 'pending'); assert.equal((await b.session.read()).phase, 'firstPending');
  const text = await a.session.issueConnectionCode(), code = decodeConnectionCode(text);
  const malformed = structuredClone(code); malformed.grant.signature = '00'.repeat(64);
  const invalid = 'LFS1.' + Buffer.from(JSON.stringify(malformed)).toString('base64url');
  await assert.rejects(b.session.connectWithCode(invalid)); assert.equal((await b.roots.read()).digest, pending.digest);
  await b.session.connectWithCode(text); await a.session.synchronizeDevices(); await b.session.synchronizeDevices();
  assert.equal((await b.session.read()).keyReady, true); assert.equal(await b.roots.read(), null);
  assert.equal(h.history.length, 2);
});

test('foreground observation resumes a completed connection after code expiry and detaches its watches', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h);
  await a.session.initializeFirstDevice(); const text = await a.session.issueConnectionCode(), code = decodeConnectionCode(text);
  await b.session.connectWithCode(text); await a.session.synchronizeDevices();
  t.mock.method(Date, 'now', () => code.grant.body.expiresAt + 1);
  const resumed = b.reopen(), stop = resumed.observeConnections(); t.after(stop);
  await until(async () => (await resumed.read()).keyReady);
  await until(async () => (await b.connections.read()).state.joining === null);
  assert.equal(h.watchers(), 0); assert.equal(h.history.length, 2);
});

test('connection observation waits for ordinary in-flight sync without losing the server change', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h);
  await a.session.initializeFirstDevice(); const text = await a.session.issueConnectionCode(); await b.session.connectWithCode(text);
  const originalPage = h.cloud.authorityPage; let unblock; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  h.cloud.authorityPage = async (...args) => { entered(); await new Promise(resolve => { unblock = resolve; }); return originalPage(...args); };
  const background = a.session.synchronizeDevices({ force: false }); await ready;
  const stop = a.session.observeConnections(); t.after(stop); await new Promise(resolve => setTimeout(resolve, 20));
  h.cloud.authorityPage = originalPage; unblock(); await background;
  await until(() => h.history.length === 2); await b.session.synchronizeDevices();
  assert.equal((await b.session.read()).keyReady, true);
});

test('simultaneous one-use handoffs retain both recipients when unrelated device additions advance authority', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h), c = device(t, h), d = device(t, h);
  await a.session.initializeFirstDevice(); const setup = await a.session.issueConnectionCode();
  await b.session.connectWithCode(setup); await a.session.synchronizeDevices(); await b.session.synchronizeDevices();
  const codeC = await a.session.issueConnectionCode(), codeD = await b.session.issueConnectionCode();
  await c.session.connectWithCode(codeC); await d.session.connectWithCode(codeD);
  const commit = h.cloud.commitAuthority; let competing = true;
  h.cloud.commitAuthority = async (...args) => { if (competing) { competing = false; await b.session.synchronizeDevices(); } return commit(...args); };
  await a.session.synchronizeDevices(); await b.session.synchronizeDevices();
  await c.session.synchronizeDevices(); await d.session.synchronizeDevices();
  assert.equal(h.history.length, 4); assert.equal(h.history.at(-1).body.devices.length, 4);
  assert.equal((await c.session.read()).keyReady, true); assert.equal((await d.session.read()).keyReady, true);
});

test('an accepted handoff cannot reapprove its recipient after another device revokes it', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h), c = device(t, h);
  await a.session.initializeFirstDevice(); const setup = await a.session.issueConnectionCode();
  await b.session.connectWithCode(setup); await a.session.synchronizeDevices(); await b.session.synchronizeDevices();
  const text = await a.session.issueConnectionCode(); await c.session.connectWithCode(text);
  h.flags.keyBlocked = true; await a.session.synchronizeDevices(); assert.ok((await a.connections.read()).state.issued.acceptedRequestDigest);
  h.flags.keyBlocked = false; await b.session.synchronizeDevices(); const before = await b.session.read();
  await b.session.revokeDevice((await c.session.read()).deviceId, before.authorityDigest);
  const count = h.history.length; await assert.rejects(a.session.synchronizeDevices(), /解除/u);
  assert.equal(h.history.length, count); assert.equal(h.history.at(-1).body.devices.length, 2);
});

test('an aborted connection retry makes no cloud reads or approvals and retains its exact encrypted request', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h);
  await a.session.initializeFirstDevice(); const text = await a.session.issueConnectionCode(); await b.session.connectWithCode(text);
  const saved = await b.connections.read(), reads = h.codeReads(), controller = new AbortController(); controller.abort();
  await assert.rejects(b.session.synchronizeDevices({ signal: controller.signal }));
  assert.equal(h.codeReads(), reads); assert.deepEqual(await b.connections.read(), saved); assert.equal(h.history.length, 1);
});

test('connection handoff recovers the same claim after recreation and a lost key-delivery reply without a manual approval', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h), b = device(t, h);
  await a.session.initializeFirstDevice(); const text = await a.session.issueConnectionCode();
  await b.session.connectWithCode(text); h.flags.keyReplyLost = true;
  await a.session.synchronizeDevices(); assert.equal(h.history.length, 2);
  const resumedA = a.reopen(), resumedB = b.reopen();
  await resumedA.synchronizeDevices(); await resumedB.synchronizeDevices();
  assert.equal((await resumedB.read()).keyReady, true); assert.equal(h.history.length, 2);
  assert.equal((await a.connections.read()).state.issued, null); assert.equal((await b.connections.read()).state.joining, null);
});

test('connection-code setup is read-only until explicit actions and rejects account changes and stale vault updates', async t => {
  const h = privateCalendarMemoryCloud(), a = device(t, h);
  await a.session.read(); const stop = a.session.observeConnections(); await new Promise(setImmediate); stop();
  assert.equal(a.values.size, 0); assert.equal(h.codes.size, 0); assert.equal(h.codeReads(), 0);
  await a.session.initializeFirstDevice(); const text = await a.session.issueConnectionCode();
  const before = await a.connections.read(); await a.connections.save(before.revision, before.state);
  await assert.rejects(a.connections.save(before.revision, before.state), /更新/u);
  a.state.currentUser = 'another'; await assert.rejects(a.session.connectWithCode(text)); await assert.rejects(a.session.issueConnectionCode());
  assert.equal(h.history.length, 1);
});
