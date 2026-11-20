import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateCalendarRuntimeFixture } from './helpers/private-calendar-runtime.mjs';
import { CALENDAR_AVAILABILITY_MAX_AGE_MS } from '../src/features/google-sync/calendar-timing.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';

const busyTarget = { precision: 'interval', start: '2026-10-28T00:30:00.000Z', end: '2026-10-28T00:45:00.000Z' };
const clearTarget = { precision: 'interval', start: '2026-10-28T03:00:00.000Z', end: '2026-10-28T03:15:00.000Z' };
async function configured(t) {
  const f = privateCalendarRuntimeFixture(t); await f.devices.initializeFirstDevice(); const runtime = f.open(); await f.connect(runtime); return { ...f, runtime };
}

test('private Calendar runtime passive settings and recommendations never create identity query Google or request consent', async t => {
  const f = privateCalendarRuntimeFixture(t); const runtime = f.open();
  assert.equal((await runtime.readSettings()).device.phase, 'unconfigured'); assert.equal(await runtime.readForPlan(), null);
  assert.deepEqual(await runtime.readOwnCalendar(busyTarget), { kind: 'unknown', reason: 'missing' });
  assert.deepEqual(await runtime.refreshData(), { kind: 'unavailable' }); assert.equal(f.f.state.generations, 0);
  assert.equal(f.state.googleReads, 0); assert.equal(f.state.checks, 0); assert.equal(f.state.restores, 0); assert.deepEqual(f.state.consents, []);
});

test('private Calendar runtime coalesces manual capture and decrypts one immutable local snapshot for one hundred recommendation readers', { timeout: 30000 }, async t => {
  const f = await configured(t); const calls = Array.from({ length: 100 }, () => f.runtime.refreshData());
  assert.equal(new Set(calls).size, 1); assert.ok((await Promise.all(calls)).every(result => result.kind === 'published'));
  assert.equal(f.state.googleReads, 1); assert.equal(f.state.uploads, 1); const before = f.state.decrypts;
  const readers = await Promise.all(Array.from({ length: 100 }, () => f.runtime.readForPlan()));
  assert.ok(readers.every(read => read.ownerUserId === f.userId && read.cache === readers[0].cache)); assert.equal(f.state.decrypts - before, 1);
  assert.throws(() => readers[0].cache.intervals.push({ ...busyTarget }), TypeError); assert.throws(() => { readers[0].cache.intervals[0].start = clearTarget.start; }, TypeError);
  assert.deepEqual(await f.runtime.readOwnCalendar(busyTarget), { kind: 'conflict' }); assert.deepEqual(await f.runtime.readOwnCalendar(clearTarget), { kind: 'clear' });
  const publicSettings = JSON.stringify(await f.runtime.readSettings()); assert.equal(publicSettings.includes(f.googleSubject), false); assert.equal(publicSettings.includes('intervals'), false);
  assert.equal(f.state.googleReads, 1); assert.equal(f.state.decrypts - before, 1);
});

test('private Calendar runtime evaluates freshness at each check and restores ciphertext after a process restart without querying Google', async t => {
  const f = await configured(t); await f.runtime.refreshData(); assert.deepEqual(await f.runtime.readOwnCalendar(busyTarget), { kind: 'conflict' });
  f.state.now += CALENDAR_AVAILABILITY_MAX_AGE_MS; assert.deepEqual(await f.runtime.readOwnCalendar(busyTarget), { kind: 'conflict' });
  f.state.now++; assert.deepEqual(await f.runtime.readOwnCalendar(busyTarget), { kind: 'unknown', reason: 'stale' });
  const restarted = f.open(); assert.deepEqual(await restarted.readOwnCalendar(busyTarget), { kind: 'unknown', reason: 'stale' }); assert.equal(f.state.googleReads, 1);
});

test('private Calendar runtime replays an encrypted pending snapshot after reply loss without a second Google request', async t => {
  const f = await configured(t); const upload = f.port.cloud.uploadCache; let lost = true;
  f.port.cloud.uploadCache = async (...args) => { const result = await upload(...args); if (lost) { lost = false; throw Object.assign(new Error('reply lost'), { code: 'unavailable' }); } return result; };
  await assert.rejects(() => f.runtime.refreshData(), /reply lost/u); const allocations = f.f.state.generations;
  const restarted = f.open(); assert.deepEqual(await restarted.refreshData(), { kind: 'published', sequence: 1 });
  assert.equal(f.state.googleReads, 1); assert.equal(f.state.uploads, 2); assert.equal(f.f.state.generations, allocations);
  assert.deepEqual(await restarted.readOwnCalendar(busyTarget), { kind: 'conflict' });
});

test('private Calendar paired follower receives the current main ciphertext without a local Google account or source association', async t => {
  const a = privateCalendarRuntimeFixture(t); const b = privateCalendarRuntimeFixture(t, a.transport); const initial = await a.devices.initializeFirstDevice();
  const request = await b.devices.prepareConfirmedReference(initial.reference); await a.devices.approveConfirmedRequest(request.request); await b.devices.acceptApproval();
  const main = a.open(); const follower = b.open(); await a.connect(main); await main.refreshData(); b.state.account = null;
  assert.equal(await follower.readForPlan(), null); assert.deepEqual(await follower.refreshData(), { kind: 'received', sequence: 1 });
  assert.deepEqual(await follower.readOwnCalendar(busyTarget), { kind: 'conflict' }); assert.equal(b.state.googleReads, 0); assert.equal(b.state.checks, 0); assert.deepEqual(b.state.consents, []);
  const before = await main.readSettings(); await main.disableSource(before.device.authorityDigest);
  assert.equal(await main.readForPlan(), null); assert.deepEqual(await follower.refreshData(), { kind: 'missing' });
  assert.deepEqual(await follower.readOwnCalendar(busyTarget), { kind: 'unknown', reason: 'missing' });
  assert.equal(a.state.googleReads, 1); assert.equal(b.state.googleReads, 0); assert.equal((await b.f.readProtected()).hasStoredKeys, true);
});

test('a follower reports the exact saved calendar even when the server head advances during download', async t => {
  const a = privateCalendarRuntimeFixture(t), b = privateCalendarRuntimeFixture(t, a.transport);
  const initial = await a.devices.initializeFirstDevice();
  const request = await b.devices.prepareConfirmedReference(initial.reference);
  await a.devices.approveConfirmedRequest(request.request); await b.devices.acceptApproval();
  const main = a.open(); await a.connect(main); await main.refreshData();
  const first = await a.transport.cloud.readHead(); await main.refreshData();
  const second = await a.transport.cloud.readHead();
  b.port.cloud.readHead = async () => first;
  let recorded;
  b.port.cloud.confirmCacheDelivery = async (authority, digest, readSaved) => { recorded = { digest, copy: await readSaved() }; return true; };
  assert.deepEqual(await b.open().refreshData(), { kind: 'received', sequence: 2 });
  await t.waitFor(() => assert.ok(recorded));
  assert.equal(recorded.digest, second.cacheHead.manifestDigest);
  assert.equal(sharedDocumentDigest(recorded.copy.manifest), recorded.digest);
});

test('the main device can enroll its already saved calendar without another acquisition or upload', async t => {
  const f = await configured(t); await f.runtime.refreshData();
  const head = await f.transport.cloud.readHead(); let recorded;
  f.port.cloud.confirmCacheDelivery = async (authority, digest, readSaved) => { recorded = { digest, copy: await readSaved() }; return true; };
  assert.deepEqual(await f.open().synchronizeAutomatically(), { kind: 'fresh' });
  await t.waitFor(() => assert.ok(recorded));
  assert.equal(recorded.digest, head.cacheHead.manifestDigest);
  assert.equal(sharedDocumentDigest(recorded.copy.manifest), recorded.digest);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.googleReads, 1);
});

test('private Calendar returning to a former main cannot silently restore its old source after another main changed or disabled acquisition', async t => {
  const a = privateCalendarRuntimeFixture(t); const b = privateCalendarRuntimeFixture(t, a.transport); const initial = await a.devices.initializeFirstDevice();
  const request = await b.devices.prepareConfirmedReference(initial.reference); await a.devices.approveConfirmedRequest(request.request); await b.devices.acceptApproval();
  const left = a.open(); const right = b.open(); await a.connect(left); await left.refreshData();
  await a.devices.changeMain(request.deviceId, (await a.devices.read()).authorityDigest); await b.devices.synchronizeDevices(); await b.connect(right);
  await right.disableSource((await right.readSettings()).device.authorityDigest);
  await b.devices.changeMain(initial.deviceId, (await b.devices.read()).authorityDigest); const before = a.state.googleReads;
  assert.deepEqual(await left.refreshData(), { kind: 'sourceReview' }); assert.equal(a.state.googleReads, before);
  assert.equal((await left.readSettings()).requiresSourceReview, true); assert.equal((await left.readSettings()).connected, false);
  assert.equal(await left.readForPlan(), null); const stale = (await left.readSettings()).device.authorityDigest;
  await left.connectCurrentSource(a.googleSubject, stale); assert.notEqual((await left.readSettings()).device.authorityDigest, stale);
  assert.equal((await left.refreshData()).kind, 'published'); assert.equal(a.state.googleReads, before + 1);
});

test('private Calendar adding an approved device preserves the current main source and does not manufacture an unnecessary source epoch', async t => {
  const a = privateCalendarRuntimeFixture(t); const b = privateCalendarRuntimeFixture(t, a.transport); await a.devices.initializeFirstDevice(); const main = a.open(); await a.connect(main);
  const first = await a.devices.read(); const pending = await b.devices.prepareConfirmedReference(first.reference); await a.devices.approveConfirmedRequest(pending.request); await b.devices.acceptApproval();
  const before = await a.devices.read(); await main.connectCurrentSource(a.googleSubject, before.authorityDigest);
  assert.equal((await a.devices.read()).authorityDigest, before.authorityDigest); assert.equal((await main.refreshData()).kind, 'published');
  assert.equal(a.state.googleReads, 1); assert.equal(a.transport.history.length, 3);
});

test('private Calendar source consent uses the reviewed Google subject and rejects substitution before changing the signed source', async t => {
  const f = await configured(t); const before = await f.runtime.readSettings(); f.state.account = { subject: 'different-google-subject', label: 'Other account' };
  await assert.rejects(() => f.runtime.connectCurrentSource(f.googleSubject, before.device.authorityDigest), /Google account changed/u);
  assert.equal((await f.runtime.readSettings()).device.authorityDigest, before.device.authorityDigest); assert.equal(f.state.googleReads, 0);
  f.f.state.currentUser = 'foreign-user'; await assert.rejects(() => f.runtime.readForPlan(), /owner changed/u); await assert.rejects(() => f.runtime.restoreCurrentGoogleAccount(), /owner changed/u);
  assert.equal(f.state.restores, 0); f.f.state.currentUser = f.userId; assert.equal((await f.runtime.readSettings()).connected, true);
});

test('private Calendar invalidation while decrypting cannot return an old account snapshot and clears only its own memo', { timeout: 30000 }, async t => {
  const f = await configured(t); await f.runtime.refreshData(); let release; let enter;
  const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; }); const read = f.port.cache.read; let hold = true;
  f.port.cache.read = async (...args) => { const body = await read(...args); if (hold) { hold = false; enter(); await gate; } return body; };
  const runtime = f.open(); const old = runtime.readForPlan(); await entered; runtime.invalidatePlaintext(); const current = await runtime.readForPlan();
  assert.equal(current.ownerUserId, f.userId); release(); assert.equal(await old, null); const count = f.state.decrypts;
  assert.equal((await runtime.readForPlan()).cache, current.cache); assert.equal(f.state.decrypts, count);
});
