import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateCalendarRuntimeFixture } from './helpers/private-calendar-runtime.mjs';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarSourceBinding } from '../src/features/sharing/private-calendar/source-controller.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { PRIVATE_CALENDAR_ACQUISITION_LEASE_MS } from '../src/platform/storage/private-calendar-acquisition.ts';
const { createPrivateCalendarCapture } = await import('../src/features/sharing/private-calendar/calendar-capture.ts');
const { createCalendarQueryRange } = await import('../src/features/google-sync/calendar-availability.ts');

const range = createCalendarQueryRange('2026-10-28', '2026-11-27', 'Asia/Tokyo');
async function configured(t, storageOptions) {
  const f = privateCalendarRuntimeFixture(t, undefined, storageOptions); await f.devices.initializeFirstDevice(); await f.connect();
  return { ...f, openCapture: () => createPrivateCalendarCapture(f.port) };
}
async function read(f) {
  const authority = await f.f.secrets.authority(f.userId); const accountKey = await f.f.secrets.currentKey(f.userId, authority);
  try { return await f.f.cache.read({ authority, accountKey, calendarBinding: privateCalendarSourceBinding(authority) }); }
  finally { accountKey.fill(0); }
}

test('private Calendar acquisition persists pre-query failure backoff across runtime restart without storing provider content', async t => {
  const f = await configured(t); const head = f.port.cloud.readHead; let broken = true;
  f.port.cloud.readHead = async () => { if (broken) throw Object.assign(new Error('private-provider-message'), { code: 'unavailable' }); return head(); };
  await assert.rejects(() => f.openCapture().capture({ range }), /private-provider-message/u);
  assert.equal(f.state.googleReads, 0); broken = false;
  const waiting = await f.openCapture().capture({ range }); assert.equal(waiting.kind, 'waiting');
  assert.ok(waiting.retryAt > f.state.now); assert.equal(f.state.googleReads, 0);
  const rows = JSON.stringify(f.f.connection.prepare('SELECT * FROM private_calendar_acquisition').all());
  for (const value of ['private-provider-message', f.googleSubject, 'Asia/Tokyo', range.timeMin]) assert.equal(rows.includes(value), false);
  f.state.now = waiting.retryAt; assert.equal((await f.openCapture().capture({ range })).kind, 'published'); assert.equal(f.state.googleReads, 1);
});

test('private Calendar acquisition serializes separate runtime instances before Google and preserves the one winning snapshot', async t => {
  const f = await configured(t); let release; let enter; let first = true; let queries = 0;
  const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; }); const query = f.port.queryGoogle;
  f.port.queryGoogle = async (...args) => { queries++; if (first) { first = false; enter(); await gate; } return query(...args); };
  const older = f.openCapture().capture({ range }); await entered;
  try { assert.equal((await f.openCapture().capture({ range, force: true })).kind, 'inProgress'); assert.equal(queries, 1); }
  finally { release(); await older; }
  assert.equal(f.state.uploads, 1); assert.equal((await read(f)).fetchedAt, new Date(f.state.now).toISOString());
});

test('private Calendar acquisition fences a late expired query so it cannot replace a newer successful snapshot', async t => {
  const f = await configured(t); let release; let enter; let first = true;
  const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; }); const query = f.port.queryGoogle;
  const oldBusy = structuredClone(f.state.busy);
  f.port.queryGoogle = async (...args) => { if (first) { first = false; enter(); await gate; return oldBusy; } return query(...args); };
  const older = f.openCapture().capture({ range }); const observed = older.then(value => ({ value }), error => ({ error })); await entered;
  f.state.now += 10 * 60 * 1000; f.state.busy = [{ start: '2026-10-28T03:00:00.000Z', end: '2026-10-28T04:00:00.000Z' }];
  try { assert.equal((await f.openCapture().capture({ range, force: true })).kind, 'published'); }
  finally { release(); }
  const late = await observed; assert.ok(late.error, 'A superseded query must be refused');
  assert.deepEqual((await read(f)).intervals, f.state.busy); assert.equal(f.state.uploads, 1);
});

test('private Calendar automatic acquisition skips a fresh identical horizon but an explicit manual refresh still obtains new data', async t => {
  const f = await configured(t); assert.equal((await f.openCapture().capture({ range, automatic: true })).kind, 'published');
  assert.equal((await f.openCapture().capture({ range, automatic: true })).kind, 'fresh'); assert.equal(f.state.googleReads, 1);
  assert.equal((await f.openCapture().capture({ range, force: true })).kind, 'published'); assert.equal(f.state.googleReads, 2);
  f.state.now += 10 * 60 * 1000; assert.equal((await f.openCapture().capture({ range, automatic: true })).kind, 'fresh');
  assert.equal(f.state.googleReads, 3); assert.equal(f.state.uploads, 2);
  f.state.now += 24 * 60 * 60 * 1000;
  assert.equal((await f.openCapture().capture({ range, automatic: true })).kind, 'published');
  assert.equal(f.state.uploads, 3);
});

test('private Calendar acquisition is exclusive across independent SQLite connections and a manual force cannot steal live work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-private-acquisition-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'private.db'); const f = await configured(t, { path });
  const other = privateCalendarSetupFixture(t, { path, userId: f.userId, values: f.f.values, state: f.f.state });
  const authority = await f.f.secrets.authority(f.userId); const before = f.f.state.generations;
  const options = { rangeDigest: sharedDocumentDigest(range), now: f.state.now, force: true, automatic: true, randomFraction: 0.5 };
  const claims = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? other.cache : f.f.cache).beginAcquisition(authority, options)));
  assert.equal(claims.filter(value => value.kind === 'acquired').length, 1); assert.equal(claims.filter(value => value.kind === 'inProgress').length, 39);
  assert.equal(f.f.state.generations - before, 1); assert.equal(f.state.googleReads, 0);
});

test('private Calendar a crashed acquisition expires and a stale failure cannot delay the replacement lease', async t => {
  const f = await configured(t); const authority = await f.f.secrets.authority(f.userId);
  const options = { rangeDigest: sharedDocumentDigest(range), now: f.state.now, randomFraction: 0.5 };
  const first = await f.f.cache.beginAcquisition(authority, options); assert.equal(first.kind, 'acquired');
  assert.equal((await f.f.cache.beginAcquisition(authority, { ...options, now: options.now + PRIVATE_CALENDAR_ACQUISITION_LEASE_MS - 1, force: true })).kind, 'inProgress');
  const second = await f.f.cache.beginAcquisition(authority, { ...options, now: first.lease.expiresAt }); assert.equal(second.kind, 'acquired');
  assert.notEqual(second.lease.token, first.lease.token);
  const before = f.f.connection.prepare('SELECT * FROM private_calendar_acquisition').get();
  assert.equal(await f.f.cache.failAcquisition(authority, first.lease, second.lease.startedAt, 'temporary', 0.5), false);
  assert.deepEqual(f.f.connection.prepare('SELECT * FROM private_calendar_acquisition').get(), before);
  assert.equal(await f.f.cache.status(authority), null);
});

test('private Calendar cache and acquisition success roll back together if SQL fails after the new ciphertext write', async t => {
  const f = await configured(t); await f.openCapture().capture({ range }); const authority = await f.f.secrets.authority(f.userId);
  const originalDigest = (await f.f.cache.status(authority)).cursor.manifestDigest; const run = f.f.database.runAsync; let breakWrite = true;
  f.f.database.runAsync = async (sql, ...params) => { const result = await run(sql, ...params);
    if (breakWrite && sql.includes('INSERT INTO private_calendar_cache')) { breakWrite = false; throw new Error('synthetic write failure'); } return result; };
  await assert.rejects(() => f.openCapture().capture({ range, force: true }), /synthetic write failure/u);
  assert.equal((await f.f.cache.status(authority)).cursor.manifestDigest, originalDigest);
  const acquisition = f.f.connection.prepare('SELECT * FROM private_calendar_acquisition').get();
  assert.equal(acquisition.success_at, null); assert.equal(acquisition.manifest_digest, null); assert.ok(acquisition.retry_at > f.state.now);
  assert.equal((await f.openCapture().capture({ range, automatic: true })).kind, 'waiting');
  assert.equal((await f.openCapture().capture({ range, force: true })).sequence, 2);
});

test('private Calendar fresh acquisition metadata cannot cover a different horizon or survive a missing complete cache', async t => {
  const f = await configured(t); await f.openCapture().capture({ range, automatic: true });
  const longer = createCalendarQueryRange('2026-10-28', '2026-12-27', 'Asia/Tokyo');
  assert.equal((await f.openCapture().capture({ range: longer, automatic: true })).kind, 'published'); assert.equal(f.state.googleReads, 2);
  f.f.connection.exec('DELETE FROM private_calendar_cache');
  assert.equal((await f.openCapture().capture({ range: longer, automatic: true })).kind, 'published'); assert.equal(f.state.googleReads, 3);
});

test('private Calendar acquisition rejects corrupt retained retry metadata without erasing the current encrypted cache', async t => {
  const f = await configured(t); await f.openCapture().capture({ range }); const authority = await f.f.secrets.authority(f.userId);
  const before = (await f.f.cache.status(authority)).cursor.manifestDigest;
  f.f.connection.exec('UPDATE private_calendar_acquisition SET attempts = -1');
  await assert.rejects(() => f.openCapture().capture({ range, force: true }), /取得履歴/u);
  assert.equal((await f.f.cache.status(authority)).cursor.manifestDigest, before); assert.equal(f.state.googleReads, 1);
});
