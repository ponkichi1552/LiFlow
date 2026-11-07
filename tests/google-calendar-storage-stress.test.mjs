import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/typescript-loader.mjs';
import { createIntegration, repository, now, today } from './helpers/google-sync-integration.mjs';
const { refreshCalendarWithDependencies } = await import('../src/features/google-sync/calendar-coordinator.ts');
const { createCalendarQueryRange, calendarAvailabilitySignature } = await import('../src/features/google-sync/calendar-availability.ts');
const { createCalendarFreeBusyClient } = await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');
const { syncGoogleTasksWithDependencies } = await import('../src/features/google-sync/coordinator.ts');
const { configureGoogleCalendarAvailability } = await import('../src/features/google-sync/calendar-settings.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');

function calendar(h) {
  let calls = 0; let busy = [];
  const result = { calls: () => calls, setBusy: (next) => { busy = next; }, client: { query: async () => { calls++; return busy; } } };
  result.refresh = async ({ force = false, now: clock = now,
    range = createCalendarQueryRange(today, addDays(today, 180), 'UTC') } = {}) => refreshCalendarWithDependencies({
    loadState: () => repository.loadCalendarAvailabilityState(h.database),
    saveState: (state) => repository.saveCalendarAvailabilityState(h.database, state),
    getAccessToken: async () => 'fixture-token', client: result.client,
    hasFreshCoverage: (coverage, at) => repository.hasFreshCalendarCoverage(h.database, coverage, at),
    commitSuccess: (days, state) => repository.commitCalendarAvailabilitySuccess(h.database, days, state),
    readPlanningSignatures: () => repository.readCalendarPlanningSignatures(h.database, clock, range.timeZone),
    regeneratePlanner: async () => { await repository.loadPlannerSnapshot(h.database, range.from, clock, range.timeZone); return true; },
  }, { now: clock, range, force });
  h.dependencies.refreshCalendar = result.refresh;
  return result;
}

for (const condition of ['time-zone change', 'next day', 'missing cache row']) {
  test(`real SQLite Calendar coverage refreshes after ${condition} within 24 hours`, async () => {
    const h = await createIntegration();
    try {
      await repository.setCalendarAvailabilityEnabled(h.database, true, now);
      const c = calendar(h); const range = createCalendarQueryRange(today, addDays(today, 180), 'UTC');
      await c.refresh({ range }); assert.equal(c.calls(), 1);
      let nextRange = range; let clock = new Date(now.getTime() + 60_000);
      if (condition === 'time-zone change') nextRange = createCalendarQueryRange(range.from, range.through, 'Asia/Tokyo');
      if (condition === 'next day') {
        nextRange = createCalendarQueryRange(addDays(range.from, 1), addDays(range.through, 1), range.timeZone);
        clock = new Date(now.getTime() + 22 * 3600_000);
      }
      if (condition === 'missing cache row') h.connection.prepare('DELETE FROM calendar_availability_days WHERE local_date = ?').run(addDays(today, 50));
      assert.equal(await repository.hasFreshCalendarCoverage(h.database, nextRange, clock), false);
      assert.equal((await c.refresh({ range: nextRange, now: clock })).kind, 'success');
      assert.equal(c.calls(), 2); assert.equal(await repository.hasFreshCalendarCoverage(h.database, nextRange, clock), true);
      const rows = await repository.listCalendarAvailabilityDays(h.database);
      assert.equal(rows.length, 181); assert.equal(rows[0].localDate, nextRange.from); assert.equal(rows.at(-1).localDate, nextRange.through);
    } finally { h.connection.close(); }
  });
}

test('200 foreground Calendar checks reuse complete fresh SQLite coverage with no writes or extra requests', async () => {
  const h = await createIntegration();
  try {
    await repository.setCalendarAvailabilityEnabled(h.database, true, now);
    const c = calendar(h); await c.refresh(); const writes = h.writes.length;
    for (let count = 0; count < 200; count++) assert.equal((await c.refresh()).kind, 'skipped');
    assert.equal(c.calls(), 1); assert.equal(h.writes.length, writes);
  } finally { h.connection.close(); }
});

test('100 concurrent Google sync requests share one Calendar fetch sequence and one Tasks reconciliation', async () => {
  const h = await createIntegration();
  try {
    await repository.setCalendarAvailabilityEnabled(h.database, true, now);
    const c = calendar(h); let requests = 0; let enter; let release;
    const entered = new Promise((resolve) => { enter = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
    c.client = createCalendarFreeBusyClient(async () => {
      requests++; if (requests === 1) { enter(); await gate; }
      return Response.json({ calendars: { primary: { busy: [] } } });
    });
    const pending = Array.from({ length: 100 }, () => syncGoogleTasksWithDependencies(h.dependencies, { now, force: true }));
    await entered; assert.equal(requests, 1); release();
    const results = await Promise.all(pending);
    assert.ok(results.every((result) => result.kind === 'success'));
    assert.ok(results.every((result) => result === results[0])); assert.equal(requests, 3);
    assert.equal(h.calls.filter(({ path, method }) => path === '/tasks/v1/lists/planner-list/tasks' && method === 'GET').length,
      Math.ceil(h.entries.length / 100));
  } finally { h.connection.close(); }
});

test('Calendar OFF queued behind a slow refresh clears the cache and cannot be overwritten by a late response', async () => {
  const h = await createIntegration();
  try {
    await repository.setCalendarAvailabilityEnabled(h.database, true, now);
    const c = calendar(h); let enter; let release;
    const entered = new Promise((resolve) => { enter = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
    c.client.query = async () => { enter(); await gate; return []; };
    const pending = syncGoogleTasksWithDependencies(h.dependencies, { now, force: true }); await entered;
    const disable = configureGoogleCalendarAvailability(h.database, false, async () => assert.fail('OFF requested permission'));
    release(); await pending; assert.equal(await disable, false);
    assert.equal((await repository.loadCalendarAvailabilityState(h.database)).enabled, false);
    assert.deepEqual(await repository.listCalendarAvailabilityDays(h.database), []);
    assert.equal((await c.refresh({ force: true })).kind, 'disabled');
  } finally { h.connection.close(); }
});

test('a failed Calendar row insert rolls back the entire 181-day replacement and success timestamp', async () => {
  const h = await createIntegration(); const original = h.database.runAsync;
  try {
    await repository.setCalendarAvailabilityEnabled(h.database, true, now);
    const c = calendar(h); await c.refresh();
    const rows = await repository.listCalendarAvailabilityDays(h.database);
    const before = await repository.loadCalendarAvailabilityState(h.database); let inserts = 0;
    h.database.runAsync = async (sql, ...params) => {
      if (sql.includes('INSERT INTO calendar_availability_days') && ++inserts === 2) throw new Error('fixture storage failure');
      return original(sql, ...params);
    };
    assert.equal((await c.refresh({ force: true, now: new Date(now.getTime() + 60_000) })).kind, 'error');
    h.database.runAsync = original;
    assert.deepEqual(await repository.listCalendarAvailabilityDays(h.database), rows);
    assert.equal((await repository.loadCalendarAvailabilityState(h.database)).lastSuccessfulSyncAt, before.lastSuccessfulSyncAt);
    assert.equal(h.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { h.database.runAsync = original; h.connection.close(); }
});

test('50 rolling Calendar refreshes replace rather than accumulate cached days and retain only aggregate data', async () => {
  const h = await createIntegration();
  try {
    await repository.setCalendarAvailabilityEnabled(h.database, true, now);
    const c = calendar(h);
    for (let offset = 0; offset < 50; offset++) {
      const from = addDays(today, offset); const coverage = createCalendarQueryRange(from, addDays(from, 180), 'UTC');
      c.setBusy([{ start: coverage.timeMin, end: new Date(Date.parse(coverage.timeMin) + 3600_000).toISOString(), title: 'private-canary', attendees: ['private-canary'] }]);
      assert.equal((await c.refresh({ force: true, range: coverage, now: new Date(now.getTime() + offset * 86400_000) })).kind, 'success');
      const rows = await repository.listCalendarAvailabilityDays(h.database);
      assert.equal(rows.length, 181); assert.equal(rows[0].localDate, from);
      assert.equal(rows[0].busyMinutes, 60); assert.equal(JSON.stringify(rows).includes('private-canary'), false);
      assert.equal(calendarAvailabilitySignature(Object.fromEntries(rows.map((row) => [row.localDate, { busyMinutes: row.busyMinutes }]))), '[]');
    }
    assert.equal(c.calls(), 50);
  } finally { h.connection.close(); }
});
