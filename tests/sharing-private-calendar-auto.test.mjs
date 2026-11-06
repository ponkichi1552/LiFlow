import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateCalendarRuntimeFixture } from './helpers/private-calendar-runtime.mjs';
import { advancePrivateCalendarAuthority } from '../src/features/sharing/private-calendar/authority.ts';

async function configured(t) {
  const f = privateCalendarRuntimeFixture(t); await f.devices.initializeFirstDevice(); const runtime = f.open(); await f.connect(runtime); return { ...f, runtime };
}

test('a timed out automatic device refresh stops a 201 revision authority scan before its next page and does not delay source disabling', async t => {
  const f = await configured(t); const identity = await f.f.secrets.identity(f.userId);
  let authority = await f.f.secrets.authority(f.userId);
  while (authority.signed.body.revision < 201) {
    const body = authority.signed.body;
    const next = advancePrivateCalendarAuthority(authority, { devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: body.keyVersion + 1 }, identity);
    await f.cloud.commitAuthority(authority, next); await f.f.secrets.acceptAuthorityUpdate(f.userId, next.signed); authority = next;
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const read = f.cloud.authorityPage; const pages = []; let first; let second;
  const enteredFirst = new Promise(resolve => { first = resolve; }); const enteredSecond = new Promise(resolve => { second = resolve; });
  f.cloud.authorityPage = async (after, checkBudget) => {
    if (checkBudget) {
      checkBudget(); pages.push(after); if (after === 0) first(); if (after === 100) second();
      await new Promise(resolve => setTimeout(resolve, 20_000)); checkBudget();
    }
    return read(after);
  };
  const runtime = f.open(); const updating = runtime.synchronizeAutomatically();
  const rejected = assert.rejects(updating, error => error.code === 'deadline-exceeded');
  await enteredFirst; f.state.now += 20_000; t.mock.timers.tick(20_000); await enteredSecond;
  f.state.now += 5000; t.mock.timers.tick(5000); await rejected;
  const stopped = await runtime.disableSource(authority.digest); assert.equal(stopped.kind, 'ready');
  assert.equal((await runtime.readSettings()).connected, false); assert.deepEqual(pages, [0, 100]);
  f.state.now += 20_000; t.mock.timers.tick(20_000); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(pages, [0, 100]); assert.equal((await f.f.secrets.authority(f.userId)).digest, stopped.authorityDigest);
  assert.equal(f.state.googleReads, 0); assert.equal(f.state.uploads, 0);
  f.cloud.authorityPage = read;
  assert.equal((await runtime.synchronizeAutomatically()).kind, 'disabled');
});
test('private Calendar automatic synchronization does not initialize trust restore login or request scopes on an unconfigured device', async t => {
  const f = privateCalendarRuntimeFixture(t); const runtime = f.open();
  assert.deepEqual(await runtime.synchronizeAutomatically(), { kind: 'unavailable' });
  assert.equal(f.f.state.generations, 0); assert.equal(f.state.googleReads, 0); assert.equal(f.state.restores, 0); assert.deepEqual(f.state.consents, []);
});
test('private Calendar automatic synchronization coalesces one hundred triggers and reuses fresh data while keeping manual updates explicit', async t => {
  const f = await configured(t); const calls = Array.from({ length: 100 }, () => f.runtime.synchronizeAutomatically());
  assert.equal(new Set(calls).size, 1); assert.ok((await Promise.all(calls)).every(result => result.kind === 'published'));
  assert.equal((await f.runtime.synchronizeAutomatically()).kind, 'fresh'); assert.equal(f.state.googleReads, 1);
  assert.equal((await f.runtime.refreshData()).kind, 'published'); assert.equal(f.state.googleReads, 2);
  assert.equal(f.state.restores, 0); assert.equal(f.state.consents.length, 1);
});
test('private Calendar automatic synchronization retains saved envelope backoff on restart and retries without a new Google acquisition', async t => {
  const f = await configured(t); const upload = f.port.cloud.uploadCache; let lost = true;
  f.port.cloud.uploadCache = async (...args) => { const result = await upload(...args); if (lost) { lost = false; throw Object.assign(new Error('synthetic reply loss'), { code: 'unavailable' }); } return result; };
  await assert.rejects(() => f.runtime.synchronizeAutomatically(), /synthetic reply loss/u); const allocations = f.f.state.generations;
  const restarted = f.open(); const waiting = await restarted.synchronizeAutomatically(); assert.equal(waiting.kind, 'waiting'); assert.equal(f.state.googleReads, 1);
  f.state.now = waiting.retryAt; assert.equal((await restarted.synchronizeAutomatically()).kind, 'published');
  assert.equal(f.state.googleReads, 1); assert.equal(f.f.state.generations, allocations); assert.equal(f.state.uploads, 2);
});
test('private Calendar automatic follower receives one complete snapshot and skips another download when the head is unchanged', async t => {
  const a = privateCalendarRuntimeFixture(t); const b = privateCalendarRuntimeFixture(t, a.transport); const first = await a.devices.initializeFirstDevice();
  const request = await b.devices.prepareConfirmedReference(first.reference); await a.devices.approveConfirmedRequest(request.request); await b.devices.acceptApproval();
  const left = a.open(); await a.connect(left); await left.refreshData(); let reads = 0; const read = b.port.cloud.readCache;
  b.port.cloud.readCache = async (...args) => { reads++; return read(...args); }; b.state.account = null; const right = b.open();
  assert.equal((await right.synchronizeAutomatically()).kind, 'received'); assert.equal((await right.synchronizeAutomatically()).kind, 'unchanged');
  assert.equal(reads, 1); assert.equal(b.state.googleReads, 0); assert.equal(b.state.restores, 0); assert.deepEqual(b.state.consents, []);
  b.state.now += 36 * 3600_000 + 1; assert.equal((await right.synchronizeAutomatically()).kind, 'unchanged');
  assert.deepEqual(await right.readOwnCalendar({ precision: 'interval', start: '2026-10-28T00:10:00.000Z', end: '2026-10-28T00:20:00.000Z' }), { kind: 'unknown', reason: 'stale' });
  assert.equal(reads, 1);
});
test('private Calendar automatic synchronization preserves key-delivery retry policy rather than using a manual forced device refresh', async t => {
  const f = await configured(t); const observed = []; const sync = f.port.devices.synchronizeDevices;
  f.port.devices = { ...f.port.devices, synchronizeDevices: options => { observed.push(options); return sync(options); } }; const runtime = f.open();
  await runtime.synchronizeAutomatically(); await runtime.refreshData(); assert.deepEqual(observed.map(({ force }) => ({ force })), [{ force: false }, { force: true }]);
  assert.ok(observed.every(options => typeof options.assertBudget === 'function' && options.signal instanceof AbortSignal));
});
test('private Calendar automatic synchronization returns within its budget and never queries Google when a delayed control read resumes later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = await configured(t); let release; let enter;
  const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; }); const sync = f.port.devices.synchronizeDevices;
  f.port.devices = { ...f.port.devices, synchronizeDevices: async options => { enter(); await gate; return sync(options); } }; const runtime = f.open();
  const pending = runtime.synchronizeAutomatically({ budgetMs: 100 }); await entered; f.state.now += 100; t.mock.timers.tick(100);
  await assert.rejects(() => pending, error => error.code === 'deadline-exceeded'); release(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.state.googleReads, 0); assert.equal(f.state.restores, 0); assert.deepEqual(f.state.consents, [f.googleSubject]);
});

test('private Calendar an expired automatic attempt stays expired after the wall clock moves backwards', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = await configured(t); let release; let enter;
  const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; }); const sync = f.port.devices.synchronizeDevices;
  f.port.devices = { ...f.port.devices, synchronizeDevices: async options => { enter(); await gate; return sync(options); } }; const runtime = f.open();
  const pending = runtime.synchronizeAutomatically({ budgetMs: 100 }); await entered; f.state.now -= 3_600_000; t.mock.timers.tick(100);
  await assert.rejects(() => pending, error => error.code === 'deadline-exceeded'); release(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.state.googleReads, 0); assert.equal(f.state.uploads, 0);
});

for (const reason of ['source-stop', 'logout']) {
  test(`private Calendar ${reason} aborts an active automatic Google acquisition and never commits its obsolete result`, async t => {
    const f = await configured(t); const expected = (await f.runtime.readSettings()).device.authorityDigest; let enter; let signal;
    const entered = new Promise(done => { enter = done; });
    f.port.queryGoogle = async (_subject, _range, options) => { f.state.googleReads++; signal = options.signal; enter();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('synthetic cancellation'), { code: 'aborted' })), { once: true })); };
    const runtime = f.open(); const pending = runtime.synchronizeAutomatically(); const rejected = assert.rejects(() => pending); await entered;
    if (reason === 'source-stop') { assert.equal((await runtime.disableSource(expected)).kind, 'ready'); assert.equal((await runtime.readSettings()).connected, false); }
    else { f.f.state.currentUser = 'foreign-user'; runtime.invalidatePlaintext(); }
    await rejected; assert.equal(signal.aborted, true); assert.equal(f.state.googleReads, 1); assert.equal(f.state.uploads, 0);
    f.f.state.currentUser = f.userId; assert.equal((await f.f.readProtected()).hasStoredKeys, true); assert.equal(await runtime.readForPlan(), null);
  });
}
