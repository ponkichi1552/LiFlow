import { openCalendarDay } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createIntegration, now as googleNow } from './helpers/google-sync-integration.mjs';
import { localDateFromDate, addDays, daysBetween, formatJapaneseDate } from '../src/domain/scheduling/local-date.ts';
import { optimizeLaundryScheduleForWeather } from '../src/features/weather/optimize-laundry-schedule.ts';
import { LaundryWeatherAdjustmentPolicy } from '../src/features/weather/laundry-policy.ts';
import { applyLaundryWeatherAdjustments, isSuitableLaundryDay } from '../src/features/weather/laundry-policy.ts';
import { recommendedChoreCounts, selectDateTasks } from '../src/domain/scheduling/date-tasks.ts';
const { getDeviceTimeZone, shouldRefreshCalendar } = await import('../src/features/google-sync/calendar-availability.ts');
const { syncGoogleTasksWithDependencies } = await import('../src/features/google-sync/coordinator.ts');

const repository = await import('../src/platform/storage/repository.ts');
const now = new Date(); const today = localDateFromDate(now);
const location = { region: '横浜市', displayName: '横浜市', latitude: 35.44, longitude: 139.64 };
const settings = { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } };
const sunny = { weatherCode: 0, precipitationProbability: 0, precipitationMm: 0 };
async function fixture() {
  const h = createDatabase(); await repository.initializeLocalDatabase(h.database);
  const initial = await repository.loadPlannerSnapshot(h.database, today, now);
  const chore = initial.chores.find((item) => item.category === '洗濯');
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
    previousDates: { [chore.id]: { date: addDays(today, -1) } }, weatherLocation: location });
  const snapshot = await repository.loadPlannerSnapshot(h.database, today, now);
  return { ...h, snapshot };
}
const shiftFirst = (input) => ({ schedule: input.schedule.map((entry, index) => index ? entry : { ...entry, suggestedDate: addDays(entry.suggestedDate, 1) }), outcome: 'adjusted', adjustmentCount: 1 });
const laundry = { id: 'laundry', category: '洗濯', enabled: true, load: 'normal', laundryDryingPreference: 'outdoors', holidayPriority: false,
  windowRadiusDays: 0, maxShiftDays: 3, frequencyDaysByMode: { frequent: 2, balanced: 2, relaxed: 2 } };
const occurrence = (offset) => ({ id: `laundry:${offset}`, choreId: 'laundry', cycleBaseDate: addDays(today, offset), suggestedDate: addDays(today, offset),
  windowStart: addDays(today, offset), windowEnd: addDays(today, offset), status: 'scheduled', assignedMemberIds: [] });
const forecastWithSun = (...offsets) => Array.from({ length: 7 }, (_, offset) => ({ date: addDays(today, offset),
  ...(offsets.includes(offset) ? sunny : { weatherCode: 61, precipitationProbability: 90, precipitationMm: 10 }) }));

test('weather does not fetch or move a completed legacy occurrence without a schedule id', async () => {
  let requests = 0;
  const schedule = [occurrence(1)];
  const completions = [{ id: 'old-completion', choreId: 'laundry', outcome: 'completed', scheduledDate: schedule[0].suggestedDate,
    completedAt: now.toISOString() }];
  const result = await optimizeLaundryScheduleForWeather({ today, location, householdId: 'home', chores: [laundry], completions,
    dependencies: [], settings, schedule }, { fetchForecast: async () => { requests++; return forecastWithSun(2); } });
  assert.deepEqual(result.schedule, schedule); assert.equal(requests, 0);
});

test('weather never merges or reverses adjacent occurrences of the same laundry chore', () => {
  const schedule = [occurrence(1), occurrence(3), occurrence(5)];
  const policy = new LaundryWeatherAdjustmentPolicy({ today, chores: [laundry], completions: [], dependencies: [], settings });
  const adjustments = policy.proposeAdjustments({ schedule, forecast: forecastWithSun(2, 4) });
  const dates = schedule.map((entry) => adjustments.find((item) => item.scheduleEntryId === entry.id)?.data.suggestedDate ?? entry.suggestedDate);
  assert.equal(new Set(dates).size, dates.length);
  assert.deepEqual(dates, [...dates].sort());
});

test('all-unknown forecast values show unavailable rather than reporting current weather', async () => {
  const schedule = [occurrence(1)];
  const result = await optimizeLaundryScheduleForWeather({ today, location, householdId: 'home', chores: [laundry], completions: [], dependencies: [], settings, schedule },
    { fetchForecast: async () => forecastWithSun().map((day) => ({ ...day, weatherCode: null, precipitationProbability: null, precipitationMm: null })) });
  assert.equal(result.outcome, 'unavailable'); assert.deepEqual(result.schedule, schedule);
});

test('sunny laundry alternatives also respect Calendar busy penalties before choosing a nearby day', async () => {
  const base = addDays(today, 2); const closer = addDays(today, 3); const available = addDays(today, 4);
  const chore = { id: 'laundry', category: '洗濯', enabled: true, load: 'normal', laundryDryingPreference: 'outdoors', holidayPriority: false,
    windowRadiusDays: 0, maxShiftDays: 3, frequencyDaysByMode: { frequent: 7, balanced: 7, relaxed: 7 } };
  const schedule = [{ id: 'laundry:one', choreId: chore.id, cycleBaseDate: base, suggestedDate: base, windowStart: base, windowEnd: base, status: 'scheduled', assignedMemberIds: [] }];
  const forecast = Array.from({ length: 7 }, (_, offset) => ({ date: addDays(today, offset), weatherCode: 61, precipitationProbability: 90, precipitationMm: 10 }));
  for (const day of forecast) if ([closer, available].includes(day.date)) Object.assign(day, sunny);
  const result = await optimizeLaundryScheduleForWeather({ today, location, householdId: 'home', chores: [chore], completions: [], dependencies: [], settings, schedule,
    externalAvailabilityByDate: { [closer]: { busyMinutes: 1440 } } }, { fetchForecast: async () => forecast });
  assert.equal(result.schedule[0].suggestedDate, available);
});

test('unchanged weather preserves snapshot identity and avoids repeated planner outputs', async () => {
  const h = await fixture();
  try {
    const count = h.writes.length;
    const result = await repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true,
      async (input) => ({ schedule: [...input.schedule], outcome: 'current', adjustmentCount: 0 }));
    assert.equal(result, h.snapshot); assert.equal(h.writes.length, count);
  } finally { h.connection.close(); }
});

test('cached weather adjustments keep their notice and do not optimize or write again during the cache lifetime', async () => {
  const h = await fixture();
  try {
    let calls = 0; const optimize = async (input) => { calls++; return shiftFirst(input); };
    const first = await repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true, optimize);
    const writes = h.writes.length;
    const again = await repository.applyWeatherToPlannerSnapshot(h.database, first, () => true, optimize);
    assert.equal(again, first); assert.equal(calls, 1); assert.equal(h.writes.length, writes);
    assert.equal(again.weatherOutcome, 'adjusted'); assert.equal(again.weatherAdjustmentCount, 1);
  } finally { h.connection.close(); }
});

test('expired forecasts are evaluated against the base plan and failure restores the same plan shown by the UI', async () => {
  const h = await fixture();
  try {
    const noon = new Date(now); noon.setHours(12, 0, 0, 0);
    let clock = noon.getTime(); let calls = 0; const received = [];
    const optimize = async (input) => { calls++; received.push(input.schedule); return calls === 1 ? shiftFirst(input) : { schedule: [...input.schedule], outcome: 'unavailable', adjustmentCount: 0 }; };
    const first = await repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true, optimize, () => new Date(clock));
    clock += 16 * 60_000;
    const after = await repository.applyWeatherToPlannerSnapshot(h.database, first, () => true, optimize, () => new Date(clock));
    assert.deepEqual(received[1], h.snapshot.scheduleEntries);
    assert.deepEqual(after.scheduleEntries, h.snapshot.scheduleEntries); assert.equal(after.weatherOutcome, 'unavailable');
    const rows = h.connection.prepare('SELECT entry_json FROM chore_schedule_entries').all().map((row) => JSON.parse(row.entry_json));
    assert.equal(rows.find((entry) => entry.id === after.scheduleEntries[0].id).suggestedDate, after.scheduleEntries[0].suggestedDate);
  } finally { h.connection.close(); }
});

test('overlapping weather refreshes share optimization while a cancelled observer cannot prevent the latest commit', async () => {
  const h = await fixture();
  try {
    let calls = 0; let resolve; const waiting = new Promise((done) => { resolve = done; });
    const optimize = async (input) => { calls++; await waiting; return shiftFirst(input); };
    let oldCanCommit = true;
    const old = repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => oldCanCommit, optimize);
    const current = repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true, optimize);
    oldCanCommit = false;
    resolve(); const results = await Promise.all([old, current]);
    assert.equal(calls, 1); assert.equal(results[0], null); assert.equal(results[1].weatherOutcome, 'adjusted');
  } finally { h.connection.close(); }
});

test('completion-triggered Tasks sync can force task changes while retaining Calendar refresh cadence', async () => {
  const h = await createIntegration();
  try {
    const requests = [];
    h.dependencies.refreshCalendar = async (options) => { requests.push(options.force); return { plannerChanged: false }; };
    await syncGoogleTasksWithDependencies(h.dependencies, { now: googleNow, force: true, forceCalendar: false });
    assert.deepEqual(requests, [false]); assert.ok(h.calls.some((call) => call.method === 'GET'));
  } finally { h.connection.close(); }
});

test('completion and queued completion use the completion trigger while explicit manual sync still forces Calendar', async () => {
  const source = readFileSync(new URL('../src/features/google-sync/coordinator.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/syncGoogleTasks\([^\n]+force: true, trigger: 'completion'/g) ?? []).length, 2);
  assert.match(source, /\.\.\.googleSyncRunOptions\(options\)/);
  const { googleSyncRunOptions } = await import('../src/features/google-sync/sync-policy.ts');
  assert.deepEqual(googleSyncRunOptions({ force: true, trigger: 'completion' }), {
    force: true, forceCalendar: false, recoverInterruptedAttempt: true,
  });
  assert.deepEqual(googleSyncRunOptions({ force: true, trigger: 'manual' }), {
    force: true, forceCalendar: true, recoverInterruptedAttempt: true,
  });
  const h = await createIntegration();
  try {
    const requests = [];
    h.dependencies.refreshCalendar = async (options) => { requests.push(options.force); return { plannerChanged: false }; };
    await syncGoogleTasksWithDependencies(h.dependencies, { now: googleNow, force: true });
    assert.deepEqual(requests, [true]);
    const state = { enabled: true, status: 'idle', lastSuccessfulSyncAt: googleNow.toISOString() };
    assert.equal(shouldRefreshCalendar(state, googleNow, false), false);
    assert.equal(shouldRefreshCalendar(state, new Date(googleNow.getTime() + 24 * 60 * 60_000), false), true);
    assert.equal(shouldRefreshCalendar({ ...state, enabled: false }, googleNow, true), false);
  } finally { h.connection.close(); }
});

test('two current weather observers commit and publish one shared snapshot', async () => {
  const h = await fixture();
  try {
    let calls = 0;
    const optimize = async (input) => { calls++; return shiftFirst(input); };
    const [first, second] = await Promise.all([
      repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true, optimize),
      repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true, optimize),
    ]);
    assert.equal(first, second); assert.equal(calls, 1);
    assert.equal(repository.readCachedPlannerSnapshot(h.database), first);
  } finally { h.connection.close(); }
});

for (const invalidation of ['day-rollover', 'new-snapshot', 'settings', 'calendar']) {
  test(`late weather cannot overwrite a plan after ${invalidation}`, async () => {
    const h = await fixture();
    try {
      let resolve; let began;
      const started = new Promise((done) => { began = done; });
      const pending = new Promise((done) => { resolve = done; });
      let clock = now;
      const result = repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true,
        async (input) => { began(); await pending; return shiftFirst(input); }, () => clock);
      await started;
      if (invalidation === 'day-rollover') clock = new Date(now.getTime() + 24 * 60 * 60_000);
      if (invalidation === 'new-snapshot') await repository.loadPlannerSnapshot(h.database, today, now);
      if (invalidation === 'settings') await repository.updateChoreSettings(h.database, h.snapshot.chores.find((chore) => chore.enabled).id, { laundryDryingPreference: 'indoors' });
      if (invalidation === 'calendar') await repository.commitCalendarAvailabilitySuccess(h.database,
        [{ localDate: today, busyMinutes: 600, timeZone: getDeviceTimeZone(), fetchedAt: now.toISOString() }],
        { householdId: h.snapshot.household.id, enabled: true, status: 'idle', retryCount: 0, lastSuccessfulSyncAt: now.toISOString(), updatedAt: now.toISOString() });
      const writes = h.writes.length;
      resolve(); assert.equal(await result, null); assert.equal(h.writes.length, writes);
    } finally { h.connection.close(); }
  });
}

test('weather expiry with the same forecast does not rewrite an already adjusted plan', async () => {
  const h = await fixture();
  try {
    const noon = new Date(now); noon.setHours(12, 0, 0, 0);
    let clock = noon.getTime(); let calls = 0;
    const optimize = async (input) => { calls++; return shiftFirst(input); };
    const first = await repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true, optimize, () => new Date(clock));
    const writes = h.writes.length;
    clock += 16 * 60_000;
    assert.equal(await repository.applyWeatherToPlannerSnapshot(h.database, first, () => true, optimize, () => new Date(clock)), first);
    assert.equal(calls, 2); assert.equal(h.writes.length, writes);
  } finally { h.connection.close(); }
});

test('a stale date or time-zone snapshot is rejected before starting a weather request', async () => {
  const h = await fixture();
  try {
    const otherZone = getDeviceTimeZone() === 'Asia/Tokyo' ? 'UTC' : 'Asia/Tokyo';
    const stale = await repository.loadPlannerSnapshot(h.database, today, now, otherZone);
    let requests = 0;
    assert.equal(await repository.applyWeatherToPlannerSnapshot(h.database, stale, () => true,
      async (input) => { requests++; return shiftFirst(input); }), null);
    assert.equal(requests, 0);
  } finally { h.connection.close(); }
});

test('completing and undoing a weather-shifted future occurrence only changes that date and retains its identity', async () => {
  const h = await fixture();
  try {
    const chore = h.snapshot.chores.find((item) => item.enabled);
    await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 3, windowRadiusDays: 0 });
    const base = await repository.loadPlannerSnapshot(h.database, today, now);
    const optimize = (input) => optimizeLaundryScheduleForWeather(input, { fetchForecast: async () => forecastWithSun(1) });
    const before = await repository.applyWeatherToPlannerSnapshot(h.database, base, () => true, optimize);
    const moved = before.scheduleEntries.find((entry) => entry.suggestedDate === addDays(today, 1));
    assert.ok(moved); const id = moved.id; const counts = recommendedChoreCounts(before.scheduleEntries, before.completions);
    assert.equal(await repository.completeChore(h.database, moved), true);
    let after = await repository.loadPlannerSnapshot(h.database, today, now);
    after = await repository.applyWeatherToPlannerSnapshot(h.database, after, () => true, optimize);
    assert.equal(recommendedChoreCounts(after.scheduleEntries, after.completions).get(moved.suggestedDate) ?? 0, 0);
    assert.equal(recommendedChoreCounts(after.scheduleEntries, after.completions).get(today), counts.get(today));
    const selected = selectDateTasks(after.scheduleEntries, after.completions, moved.suggestedDate, 0, after.chores);
    assert.equal(selected.length, 1); assert.equal(selected[0].completed, true);
    const completion = after.completions.find((item) => item.scheduleEntryId === id);
    await repository.undoCompletedChore(h.database, completion.id);
    after = await repository.loadPlannerSnapshot(h.database, today, now);
    after = await repository.applyWeatherToPlannerSnapshot(h.database, after, () => true, optimize);
    assert.equal(after.scheduleEntries.find((entry) => entry.id === id).suggestedDate, moved.suggestedDate);
    assert.equal(recommendedChoreCounts(after.scheduleEntries, after.completions).get(moved.suggestedDate), 1);
  } finally { h.connection.close(); }
});

test('weather adjustment agrees between SQLite, home notice, calendar marker and selected card', async () => {
  const h = await fixture();
  try {
    const first = h.snapshot.scheduleEntries[0];
    const adjusted = await repository.applyWeatherToPlannerSnapshot(h.database, h.snapshot, () => true, shiftFirst);
    const moved = adjusted.scheduleEntries.find((entry) => entry.id === first.id);
    const home = screenHarness('src/app/(tabs)/index.tsx', { database: h.database, snapshot: () => adjusted });
    assert.ok(home.text().includes('天気に合わせて洗濯予定を調整しました'));
    const calendar = screenHarness('src/app/(tabs)/explore.tsx', { database: h.database, snapshot: () => adjusted });
    await openCalendarDay(calendar, moved.suggestedDate);
    const chore = adjusted.chores.find((item) => item.id === moved.choreId);
    assert.ok(calendar.nodes().some((node) => node.props.accessibilityLabel === `${chore.name}を完了`));
    const row = h.connection.prepare('SELECT suggested_date FROM chore_schedule_entries WHERE id = ?').get(moved.id);
    assert.equal(row.suggested_date, moved.suggestedDate);
  } finally { h.connection.close(); }
});

test('combined weather and Calendar preserve constraints across 128 deterministic forecast and availability patterns', () => {
  for (let seed = 0; seed < 128; seed++) {
    const chores = [{ ...laundry, id: 'a', windowRadiusDays: 1, maxShiftDays: 2 }, { ...laundry, id: 'b', windowRadiusDays: 1, maxShiftDays: 2 },
      { ...laundry, id: 'before', category: 'その他', laundryDryingPreference: undefined, load: 'light' },
      { ...laundry, id: 'after', category: 'その他', laundryDryingPreference: undefined, load: 'light' }];
    const make = (choreId, offset) => ({ ...occurrence(offset), id: `${choreId}:${offset}`, choreId });
    const schedule = [make('a', 2), make('a', 5), make('b', 1), make('b', 4), make('before', 1), make('after', 5)];
    const original = JSON.stringify(schedule);
    const forecast = forecastWithSun(...Array.from({ length: 7 }, (_, day) => day).filter((day) => seed & (1 << day)));
    const availability = Object.fromEntries(forecast.map((day, index) => [day.date, { busyMinutes: ((seed * 17 + index * 193) % 5) * 240 }]));
    const dependencies = [{ predecessorChoreId: 'before', successorChoreId: 'a' }, { predecessorChoreId: 'a', successorChoreId: 'after' }];
    const completions = seed % 3 ? [] : [{ choreId: 'a', scheduleEntryId: 'a:2', outcome: 'completed' }];
    const policy = new LaundryWeatherAdjustmentPolicy({ today, chores, completions, dependencies, settings, externalAvailabilityByDate: availability });
    const changes = policy.proposeAdjustments({ schedule, forecast });
    const result = applyLaundryWeatherAdjustments(schedule, changes);
    assert.equal(JSON.stringify(schedule), original, `input mutation, seed ${seed}`);
    assert.deepEqual(result.map((entry) => entry.id).sort(), schedule.map((entry) => entry.id).sort());
    if (completions.length) assert.deepEqual(result.find((entry) => entry.id === 'a:2'), schedule[0]);
    for (const change of changes) {
      const before = schedule.find((entry) => entry.id === change.scheduleEntryId);
      assert.equal(isSuitableLaundryDay(forecast.find((day) => day.date === change.data.suggestedDate)), true);
      if (before.choreId === 'a') assert.ok(change.data.suggestedDate >= addDays(today, 1) && change.data.suggestedDate <= addDays(today, 5));
      assert.ok(change.data.suggestedDate >= change.data.windowStart && change.data.suggestedDate <= change.data.windowEnd);
      assert.ok(Math.abs(daysBetween(before.cycleBaseDate, addDays(change.data.windowStart, 1))) <= 2);
      assert.ok(change.data.suggestedDate >= today && change.data.suggestedDate <= addDays(today, 6));
    }
    for (const id of ['a', 'b']) {
      const own = result.filter((entry) => entry.choreId === id).sort((a, b) => a.cycleBaseDate.localeCompare(b.cycleBaseDate));
      assert.ok(own[0].suggestedDate < own[1].suggestedDate, `merged or reversed ${id}, seed ${seed}`);
    }
    for (const day of forecast) assert.ok(result.filter((entry) => ['a', 'b'].includes(entry.choreId) && entry.suggestedDate === day.date).length <= 2);
  }
});
