import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotPrivatePlannerPreferences, privatePlannerAllowedWindows } from '../src/features/sharing/private-planner/preferences.ts';
import { createPrivatePlannerPreferenceStore, PrivatePlannerPreferenceConflict } from '../src/features/sharing/private-planner/preference-store.ts';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';

const userId = 'private-planner-owner';
const input = () => ({ timeZone: 'Asia/Tokyo', restDays: [7, 6], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [] });
function service(f, overrides = {}) {
  return createPrivatePlannerPreferenceStore({ ownerUserId: userId, vault: f.vault, exclusive: f.exclusive,
    assertOwner: owner => assert.equal(f.state.currentUser, owner, 'account changed'), ...overrides });
}

test('private planner empty allowed times never imply all-day or guessed evening permission', () => {
  assert.deepEqual(privatePlannerAllowedWindows({ ...input(), dayTypes: { workday: { allowedBands: [] }, holiday: { allowedBands: [] } } },
    '2026-10-26', '2026-11-01'), { windows: [], unresolvedDates: [] });
});

test('private planner normalizes explicit weekly bands without mutating caller input and preserves an exact midnight end', () => {
  const draft = { ...input(), allowedBands: [
    { weekday: 1, startMinute: 1200, endMinute: 1440 }, { weekday: 1, startMinute: 1140, endMinute: 1230 },
    { weekday: 2, startMinute: 420, endMinute: 450 },
  ] }; const before = structuredClone(draft);
  const saved = snapshotPrivatePlannerPreferences(draft); assert.deepEqual(draft, before);
  assert.deepEqual(saved.restDays, [6, 7]); assert.deepEqual(saved.allowedBands, [
    { weekday: 1, startMinute: 1140, endMinute: 1440 }, { weekday: 2, startMinute: 420, endMinute: 450 },
  ]);
  assert.deepEqual(privatePlannerAllowedWindows(saved, '2026-10-26', '2026-10-27').windows, [
    { start: Date.parse('2026-10-26T10:00:00Z'), end: Date.parse('2026-10-26T15:00:00Z') },
    { start: Date.parse('2026-10-26T22:00:00Z'), end: Date.parse('2026-10-26T22:30:00Z') },
  ]);
});

test('private planner DST gap and fold boundaries require review instead of expanding or choosing a repeated time', () => {
  for (const [date, startMinute] of [['2026-03-08', 150], ['2026-11-01', 90]]) {
    const draft = { ...input(), timeZone: 'America/New_York', allowedBands: [
      { weekday: 7, startMinute, endMinute: 240 }, { weekday: 7, startMinute: 600, endMinute: 660 },
    ] };
    assert.deepEqual(privatePlannerAllowedWindows(draft, date, date), { windows: [], unresolvedDates: [date] });
  }
});

test('private planner explicit whole-day permission follows actual 23 and 25 hour days across pinned timezone data', () => {
  const draft = { ...input(), timeZone: 'America/New_York', allowedBands: [{ weekday: 7, startMinute: 0, endMinute: 1440 }] };
  for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
    const value = privatePlannerAllowedWindows(draft, date, date); assert.deepEqual(value.unresolvedDates, []);
    assert.equal(value.windows.length, 1); assert.equal(value.windows[0].end - value.windows[0].start, hours * 3600_000);
  }
});

test('private planner rejects malformed oversized foreign and secret-bearing settings without broadening permitted hours', () => {
  for (const malformed of [
    { ...input(), timeZone: 'Invalid/Zone' }, { ...input(), accessToken: 'never-store-this' },
    { ...input(), restDays: [0] }, { ...input(), loadLimits: { heavyDailyLimit: Infinity, normalDailyLimit: 2 } },
    { ...input(), loadLimits: { heavyDailyLimit: 0, normalDailyLimit: 2 } }, { ...input(), loadLimits: { heavyDailyLimit: 11, normalDailyLimit: 2 } },
    { ...input(), loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 21 } },
    { ...input(), allowedBands: [{ weekday: 1, startMinute: 1200, endMinute: 60 }] },
    { ...input(), allowedBands: [{ weekday: 1, startMinute: 1.5, endMinute: 60 }] },
    { ...input(), allowedBands: [{ weekday: 1, startMinute: -1, endMinute: 60 }] },
    { ...input(), allowedBands: [{ weekday: 1, startMinute: 0, endMinute: 1441 }] },
    { ...input(), allowedBands: Array.from({ length: 57 }, () => ({ weekday: 1, startMinute: 0, endMinute: 60 })) },
  ]) assert.throws(() => snapshotPrivatePlannerPreferences(malformed));
  assert.throws(() => privatePlannerAllowedWindows(input(), '2026-02-30', '2026-03-01'));
  assert.throws(() => privatePlannerAllowedWindows(input(), '2026-10-27', '2026-10-26'));
  assert.throws(() => privatePlannerAllowedWindows(input(), '2026-01-01', '2028-01-01'));
});

test('private planner reading an unset profile creates no identity, key, consent or protected preference value', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const store = service(f);
  assert.equal(await store.read(), null); assert.equal(f.values.size, 0); assert.equal(f.state.generations, 0);
  assert.equal(await f.secrets.publicState(userId), null);
});

test('private planner 100 duplicate saves share one protected revision and notification without changing Calendar keys', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); let notifications = 0;
  const store = service(f, { afterSave: () => notifications++ }); const results = await Promise.all(Array.from({ length: 100 }, () => store.save(0, input())));
  assert.equal(new Set(results.map(value => value.revision)).size, 1); assert.equal(results[0].revision, 1); assert.equal(notifications, 1);
  assert.equal(await f.secrets.publicState(userId), null); assert.equal(f.state.generations, 0);
  const sql = f.connection.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table'); assert.deepEqual(sql.map(row => row.name), ['private_calendar_scope']);
  assert.equal((await store.save(1, input())).revision, 1); assert.equal(notifications, 1);
});

test('private planner conflicting edits from separate stores preserve the accepted settings and require explicit reread', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const a = service(f); const b = service(f);
  await a.save(0, input()); const winner = await a.save(1, { ...input(), restDays: [1] });
  await assert.rejects(() => b.save(1, { ...input(), restDays: [2] }), PrivatePlannerPreferenceConflict);
  assert.deepEqual(await b.read(), winner); assert.equal((await b.save(2, { ...input(), restDays: [2] })).revision, 3);
  await assert.rejects(() => a.save(1, { ...input(), restDays: [2] }), PrivatePlannerPreferenceConflict);
});

test('private planner two independent SQLite writers cannot overwrite different edits from the same observed revision', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-private-preferences-writers-')); t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, 'private.db'); const f = privateCalendarSetupFixture(t, { userId, path });
  const other = privateCalendarSetupFixture(t, { userId, path, values: f.values, state: f.state });
  const results = await Promise.allSettled([service(f).save(0, { ...input(), restDays: [1] }), service(other).save(0, { ...input(), restDays: [2] })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.find(result => result.status === 'rejected').reason instanceof PrivatePlannerPreferenceConflict);
  assert.deepEqual(await service(f).read(), await service(other).read()); assert.equal((await service(f).read()).revision, 1);
});

test('private planner settings survive actual SQLite reconstruction and protected-vault reconstruction without being written as plaintext SQL', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-private-preferences-')); t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, 'private.db'); const f = privateCalendarSetupFixture(t, { userId, path });
  const draft = { ...input(), allowedBands: [{ weekday: 3, startMinute: 1133, endMinute: 1199 }] };
  const saved = await service(f).save(0, draft); const restarted = privateCalendarSetupFixture(t, { userId, path, values: f.values, state: f.state });
  assert.deepEqual(await service(restarted).read(), saved);
  assert.equal(JSON.stringify(f.writes).includes('Asia/Tokyo'), false); assert.equal(JSON.stringify([...f.values]).includes('Asia/Tokyo'), false);
  assert.equal(f.connection.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});

test('private planner recovers a committed protected write after a lost reply without repeating its value or revision', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); let writes = 0;
  const store = service(f, { vault: { getItem: key => f.vault.getItem(key), setItem: async (key, raw) => {
    writes++; await f.vault.setItem(key, raw); throw new Error('lost protected write response');
  } } });
  assert.equal((await store.save(0, input())).revision, 1); assert.equal(writes, 1);
  assert.equal((await store.save(0, input())).revision, 1); assert.equal(writes, 1);
});

test('private planner keeps prior settings after failed writes and never overwrites a corrupt or foreign-owner profile', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const first = await service(f).save(0, input());
  const failing = service(f, { vault: { getItem: key => f.vault.getItem(key), setItem: async () => { throw new Error('write refused'); } } });
  await assert.rejects(() => failing.save(1, { ...input(), restDays: [3] }), /write refused/u); assert.deepEqual(await service(f).read(), first);
  const key = `private-planner-preferences:${userId}`;
  for (const raw of ['{corrupt', JSON.stringify({ ...first, ownerUserId: 'foreign' }), ' '.repeat(16_385)]) {
    await f.vault.setItem(key, raw); await assert.rejects(() => service(f).read()); await assert.rejects(() => service(f).save(1, input())); assert.equal(await f.vault.getItem(key), raw);
  }
});

test('private planner owns a snapshot of queued edits and rechecks account changes after protected publication', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const draft = input(); const store = service(f);
  const pending = store.save(0, draft); draft.restDays.push(1); draft.allowedBands.push({ weekday: 1, startMinute: 0, endMinute: 1440 });
  const first = await pending; assert.deepEqual(first.restDays, [6, 7]); assert.deepEqual(first.allowedBands, []);
  const switched = service(f, { vault: { getItem: key => f.vault.getItem(key), setItem: async (key, raw) => {
    await f.vault.setItem(key, raw); f.state.currentUser = 'foreign';
  } } });
  await assert.rejects(() => switched.save(1, { ...input(), restDays: [5] }), /account changed/u);
  await assert.rejects(() => store.read(), /account changed/u); f.state.currentUser = userId;
  assert.deepEqual((await store.read()).restDays, [5]);
});
