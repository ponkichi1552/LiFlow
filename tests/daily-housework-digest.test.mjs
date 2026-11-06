import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { createDailyHouseworkDigestRequests, syncDailyHouseworkDigest } = await import('../src/features/notifications/daily-housework-digest.ts');

const now = new Date(2026, 9, 24, 8);
const entry = {
  id: 'entry', householdId: 'home', choreId: 'one', cycleBaseDate: '2026-10-25',
  windowStart: '2026-10-24', windowEnd: '2026-10-26', suggestedDate: '2026-10-25',
  status: 'inWindow', assignedMemberIds: [],
};
function snapshot(overrides = {}) {
  return {
    scheduleEntries: [entry], chores: [{ id: 'one', name: '掃除' }], completions: [],
    settings: { notificationHour: 9, notificationMinute: 0, notificationsEnabled: true, setupCompleted: true },
    ...overrides,
  };
}
function gateway() {
  const requests = new Map();
  const scheduled = [];
  const cancelled = [];
  return {
    requests, scheduled, cancelled,
    async hasPermission() { return true; },
    async getScheduledRequests() { return [...requests.values()]; },
    async schedule(request) { scheduled.push(request.key); requests.set(request.key, request); return request.key; },
    async cancel(key) { cancelled.push(key); requests.delete(key); },
  };
}

test('only the start, last, and following day notify, and completed chores never notify', () => {
  assert.deepEqual(createDailyHouseworkDigestRequests(snapshot(), now).map((request) => request.data.date), [
    '2026-10-24', '2026-10-26', '2026-10-27',
  ]);
  assert.deepEqual(createDailyHouseworkDigestRequests(snapshot({ completions: [{
    id: 'done', choreId: 'one', outcome: 'completed', completedAt: now.toISOString(), scheduleEntryId: entry.id,
  }] }), now), []);
  assert.deepEqual(createDailyHouseworkDigestRequests(snapshot(), new Date(2026, 9, 28, 8)), []);
});

test('unchanged notifications are retained and only changed or removed requests are touched', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  assert.equal(client.scheduled.length, 3);
  client.scheduled.length = 0;
  await syncDailyHouseworkDigest(client, snapshot(), now);
  assert.deepEqual(client.scheduled, []);
  assert.deepEqual(client.cancelled, []);
  await syncDailyHouseworkDigest(client, snapshot({ chores: [{ id: 'one', name: '新しい見出し' }] }), now);
  assert.equal(client.scheduled.length, 3);
  const unrelated = { key: 'other-feature', title: 'Other', body: '', fireAt: now.toISOString() };
  client.requests.set(unrelated.key, unrelated);
  await syncDailyHouseworkDigest(client, snapshot({ completions: [{
    id: 'done', choreId: 'one', outcome: 'completed', completedAt: now.toISOString(), scheduleEntryId: entry.id,
  }] }), now);
  assert.equal(client.cancelled.length, 3);
  assert.ok(client.requests.has(unrelated.key));
});

test('disabling notifications cancels this feature only', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  await syncDailyHouseworkDigest(client, snapshot({ settings: { ...snapshot().settings, notificationsEnabled: false } }), now);
  assert.equal(client.requests.size, 0);
  assert.equal(client.cancelled.length, 3);
});

test('a scheduling failure does not remove all existing reminders', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  client.schedule = async () => { throw new Error('OS unavailable'); };
  await assert.rejects(syncDailyHouseworkDigest(client, snapshot({ chores: [{ id: 'one', name: '変更' }] }), now), error => error.result.failed === 3 && /OS unavailable/.test(error.cause.message));
  assert.equal(client.requests.size, 3);
  assert.deepEqual(client.cancelled, []);
});

test('a failed new reminder still reconciles other dates and cancels obsolete reminders', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  const oldKeys = [...client.requests.keys()];
  const schedule = client.schedule.bind(client); const attempted = [];
  client.schedule = async (request) => {
    attempted.push(request.key);
    if (attempted.length === 1) throw new Error('OS rejected one reminder');
    return schedule(request);
  };
  const moved = { ...entry, windowStart: '2026-11-01', windowEnd: '2026-11-03', suggestedDate: '2026-11-02', cycleBaseDate: '2026-11-02' };
  await assert.rejects(syncDailyHouseworkDigest(client, snapshot({ scheduleEntries: [moved] }), now), error => error.result.failed === 1 && /OS rejected/.test(error.cause.message));
  assert.equal(attempted.length, 3);
  assert.deepEqual(client.cancelled, oldKeys);
  assert.equal(client.requests.size, 2);
  assert.ok(oldKeys.every((key) => !client.requests.has(key)));
  await syncDailyHouseworkDigest(client, snapshot({ scheduleEntries: [moved] }), now);
  assert.equal(client.requests.size, 3, 'the failed date is retried without duplicating successful dates');
  assert.equal(attempted.length, 4);
});

test('one cancellation failure does not retain every obsolete reminder or poison the next sync', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  const cancel = client.cancel.bind(client); const attempted = []; let fail = true;
  client.cancel = async (key) => {
    attempted.push(key);
    if (fail) { fail = false; throw new Error('OS cancellation failed'); }
    await cancel(key);
  };
  const disabled = snapshot({ settings: { ...snapshot().settings, notificationsEnabled: false } });
  await assert.rejects(syncDailyHouseworkDigest(client, disabled, now), error => error.result.failed === 1 && /OS cancellation failed/.test(error.cause.message));
  assert.equal(attempted.length, 3);
  assert.equal(client.requests.size, 1);
  await syncDailyHouseworkDigest(client, disabled, now);
  assert.equal(client.requests.size, 0);
  assert.equal(attempted.length, 4);
});

test('daily cycles notify each chore once and skip a day already completed', () => {
  const entries = ['2026-10-23', '2026-10-24', '2026-10-25'].map((date) => ({
    ...entry, id: `daily:${date}`, choreId: 'one', cycleBaseDate: date,
    windowStart: date, windowEnd: date, suggestedDate: date,
  }));
  const requests = createDailyHouseworkDigestRequests(snapshot({ scheduleEntries: entries }), now);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.subtitle === '1件の未完了タスク' && request.body === '掃除'));
  const done = { id: 'done', choreId: 'one', outcome: 'completed', completedAt: now.toISOString(),
    scheduleEntryId: 'daily:2026-10-24', scheduledDate: '2026-10-24',
    scheduledWindowStart: '2026-10-24', scheduledWindowEnd: '2026-10-24' };
  const after = createDailyHouseworkDigestRequests(snapshot({ scheduleEntries: entries, completions: [done] }), now);
  assert.equal(after.some((request) => request.data.date === '2026-10-24'), false);
  assert.equal(after.some((request) => request.data.date === '2026-10-25'), true);
});

test('digest indexing leaves reminders identical while old schedule rows are not rescanned for every future date', () => {
  const expected = createDailyHouseworkDigestRequests(snapshot(), now); let reads = 0;
  const old = Array.from({ length: 1000 }, (_, index) => ({ ...entry, id: `old-${index}`, choreId: `old-${index}`,
    get windowStart() { reads++; return '2020-01-01'; }, windowEnd: '2020-01-02', suggestedDate: '2020-01-01' }));
  const actual = createDailyHouseworkDigestRequests(snapshot({ scheduleEntries: [...old, entry],
    chores: [...old.map(row => ({ id: row.choreId, name: row.id })), ...snapshot().chores],
    completions: old.map(row => ({ id: `done-${row.id}`, choreId: row.choreId, completedAt: '2020-01-01T00:00:00Z', outcome: 'completed', scheduleEntryId: row.id })) }), now);
  assert.deepEqual(actual, expected); assert.ok(reads < 5000, 'the 31-day digest must not walk every historic schedule entry for each date');
});
