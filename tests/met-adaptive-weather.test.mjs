import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { parseMetForecast } from '../server/appliance-care-api/src/weather/forecast.mjs';
import { weatherCacheRevision } from '../server/appliance-care-api/src/weather/regional-store.mjs';
const { MetServerForecastProvider } = await import('../src/features/weather/met-server-provider.ts');
const { personalChoreUsesWeather } = await import('../src/features/weather/chore-weather.ts');
const { searchJapaneseMunicipalities, municipalityWeatherLocation } = await import('../src/features/weather/municipality-search.ts');
const { placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const repository = await import('../src/platform/storage/repository.ts');
const { readRegionalWeatherInside, saveRegionalWeatherInside } = await import('../src/platform/storage/regional-weather.ts');
const { readPersonalAdaptiveContextInside } = await import('../src/platform/storage/repository-adaptive.ts');
const { createPersonalChoreDefinitions } = await import('../src/domain/chores/personal-catalog.ts');
const HOUR = 3_600_000; const start = Date.parse('2026-11-05T00:00:00Z');
const location = municipalityWeatherLocation(searchJapaneseMunicipalities('新宿区')[0], '新宿');
function forecast(from = '2026-11-05', wet = () => false, days = 7) {
  const stamp = Date.parse(`${from}T00:00:00Z`);
  return parseMetForecast({ properties: { meta: { updated_at: new Date(start).toISOString(), units: { precipitation_amount: 'mm' } },
    timeseries: Array.from({ length: days * 24 }, (_, i) => ({ time: new Date(stamp + i * HOUR).toISOString(), data: {
      next_1_hours: { summary: { symbol_code: wet(i) ? 'rain' : 'clearsky_day' }, details: { precipitation_amount: wet(i) ? 1 : 0 } } } })) } });
}
function cache(value = forecast(), stamp = start) {
  const row = { schemaVersion: 1, regionId: location.municipalityId, fetchedAt: new Date(stamp).toISOString(), checkedAt: new Date(stamp).toISOString(),
    expiresAt: new Date(stamp + HOUR).toISOString(), lastModified: new Date(stamp).toUTCString(), forecast: value };
  return { ...row, revision: weatherCacheRevision(row) };
}
function geometry(date, days) {
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(date, i); const s = Date.parse(`${d}T00:00:00Z`);
    return { date: d, bounds: { start: s, end: s + 24 * HOUR }, allowed: [{ start: s + 9 * HOUR, end: s + 12 * HOUR }], holiday: true,
      heavyLimit: 2, normalLimit: 2 };
  });
}
function place(value, changes = {}) {
  return placeAdaptiveRounds({ today: '2026-11-05', now: start, tasks: [{ id: 'round', choreId: 'laundry', baseDate: '2026-11-10',
    periodDays: 8, minutes: 30, load: 'normal', fixedDaily: false, purpose: 'nextRound', weatherSensitive: true, ...changes }],
  days: geometry('2026-11-05', 12), busy: [], fixedLoads: [], holidaysConfigured: false, weatherForecast: value })[0];
}
test('adaptive weather placement evaluates actual work intervals and moves a wet-window laundry date while leaving indoor and fixed-daily work alone', () => {
  const value = forecast('2026-11-09', i => i >= 24 && i < 48);
  const outdoor = place(value); assert.notEqual(outdoor.recommendedDate, '2026-11-10'); assert.ok(outdoor.slot);
  const noWindow = place(value, { periodDays: 7 }); assert.notEqual(noWindow.recommendedDate, '2026-11-10'); assert.ok(noWindow.slot);
  assert.equal(place(value, { weatherSensitive: false }).recommendedDate, '2026-11-10');
  assert.equal(place(value, { fixedDaily: true, periodDays: 1 }).recommendedDate, '2026-11-10');
  const laterDry = place(forecast('2026-11-09', i => i === 33));
  assert.equal(laterDry.recommendedDate, '2026-11-10'); assert.equal(laterDry.slot.start, Date.parse('2026-11-10T10:00:00Z'));
  const allWet = place(forecast('2026-11-05', () => true, 12)); assert.equal(allWet.recommendedDate, '2026-11-10'); assert.equal(allWet.slot, null);
});
test('weather gaps do not make a normal chore unplaceable and automatic weather changes preserve today tomorrow and overdue rounds', () => {
  const value = forecast('2026-11-05', () => true, 1);
  const unknown = place(value); assert.equal(unknown.recommendedDate, '2026-11-10'); assert.ok(unknown.slot);
  for (const date of ['2026-11-04', '2026-11-05', '2026-11-06']) {
    const previous = { id: 'round', originalBaseDate: date, placedBaseDate: date, recommendedDate: date, basicWindow: null, displayedWindow: null, slot: null, fallback: true };
    assert.deepEqual(place(value, { baseDate: date, previous, purpose: 'automatic' }), previous);
  }
  assert.equal(personalChoreUsesWeather({ personalRecipeId: 'liflow-catalog-6.007', personalSchedulingKind: 'seasonal' }), false);
  assert.equal(personalChoreUsesWeather({ personalRecipeId: 'liflow-catalog-6.007', laundryDryingPreference: 'indoors' }), false);
  assert.equal(personalChoreUsesWeather({ personalRecipeId: 'liflow-catalog-6.032' }), false, 'filter cleaning is indoor equipment work');
});
test('a Japanese forecast evaluates a Honolulu civil-day slot by its actual instants without relabelling either date', async () => {
  const { prepareAdaptivePlacementInput } = await import('../src/features/planner/adaptive-input.ts');
  const value = forecast('2026-11-09', i => i >= 24 && i < 36);
  const run = timeZone => {
    const input = prepareAdaptivePlacementInput({ from: '2026-11-09', through: '2026-11-11', timeZone,
      preferences: { restDays: [], heavyLimit: 2, normalLimit: 2, dayOverrides: [], allowedBands: Array.from({ length: 7 }, (_, n) => ({ weekday: n + 1, startMinute: 540, endMinute: 720 })) },
      events: [], exceptions: [], fingerprint: JSON.stringify });
    return placeAdaptiveRounds({ ...input, today: '2026-11-05', now: start, weatherForecast: value, fixedLoads: [],
      tasks: [{ id: 'round', choreId: 'laundry', baseDate: '2026-11-10', periodDays: 8, minutes: 30, load: 'normal', fixedDaily: false, purpose: 'nextRound', weatherSensitive: true }] })[0];
  };
  const own = run('Pacific/Honolulu'); assert.equal(own.recommendedDate, '2026-11-10');
  assert.equal(own.slot.start, Date.parse('2026-11-10T19:00:00Z'));
  assert.notEqual(run('Asia/Tokyo').recommendedDate, '2026-11-10');
});
test('mobile MET server provider coalesces conditional reads keeps cache through failures and rejects foreign region responses', async () => {
  let stamp = start; const old = cache(); let requests = 0; const inits = [];
  const provider = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', now: () => stamp,
    fetcher: async (_url, init) => { requests++; inits.push(init); return new Response(null, { status: 304 }); } });
  const values = await Promise.all(Array.from({ length: 50 }, () => provider.refresh(location, old)));
  assert.equal(requests, 1); for (const value of values) assert.deepEqual(value, old); assert.equal(inits[0].headers['If-None-Match'], `"${old.revision}"`);
  stamp += 60_000; await provider.refresh(location, old); assert.equal(requests, 1);
  const foreign = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', fetcher: async () => new Response(JSON.stringify({ ...old, regionId: 'foreign' })) });
  assert.deepEqual(await foreign.refresh(location, old), old);
  const closed = new MetServerForecastProvider({ baseUrl: 'http://weather.liflow.invalid', fetcher: async () => { throw new Error('should not run'); } });
  assert.deepEqual(await closed.refresh(location, old), old);
});
test('mobile weather deadline keeps saved data when HTTP ignores abort and prevents late JSON from replacing it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const old = cache(); let resolve; let jsonCalls = 0;
  const provider = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', fetcher: () => new Promise(done => { resolve = done; }) });
  const run = provider.refresh(location, old); await Promise.resolve(); t.mock.timers.tick(15_000);
  assert.deepEqual(await run, old);
  resolve({ status: 200, headers: new Headers(), json: async () => { jsonCalls++; return cache(); } });
  await new Promise(done => setImmediate(done)); assert.equal(jsonCalls, 0);
});
async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const chores = createPersonalChoreDefinitions(repository.LOCAL_HOUSEHOLD_ID);
  const selected = chores.filter(chore => ['liflow-catalog-6.008', 'liflow-catalog-6.001'].includes(chore.id));
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1, 2, 3, 4, 5, 6, 7], enabledChoreIds: selected.map(chore => chore.id), previousDates: {}, weatherLocation: location });
  return { ...h, snapshot: () => repository.loadPlannerSnapshot(h.database), plans: () => h.connection.prepare('SELECT * FROM personal_adaptive_plans ORDER BY chore_id,round_id,revision').all(),
    context: () => readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, memberId: repository.LOCAL_MEMBER_ID, now: new Date(), timeZone: 'Asia/Tokyo' }) };
}
test('an actual provider failure keeps stale cache unavailable, then a successful retry refreshes adaptive planning input', async t => {
  const h = await fixture(t); const before = await h.snapshot(); const originalPlans = h.plans();
  const stale = cache(forecast(), start - 73 * HOUR);
  await h.database.withTransactionAsync(async () => { assert.equal(await saveRegionalWeatherInside(h.database, stale), true); });
  let requests = 0; let requestHeaders; let stamp = start;
  const refreshed = cache(forecast('2026-11-05', () => true, 7), start);
  const provider = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', now: () => stamp,
    fetcher: async (_url, init) => {
      requests++; requestHeaders = init.headers;
      if (requests === 1) throw new Error('synthetic transport failure');
      return new Response(JSON.stringify(refreshed), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  const writesBeforeRefresh = h.writes.length;
  const afterFailure = await repository.applyRegionalWeatherToPlannerSnapshot(h.database, before, () => true, provider, () => new Date(start));
  assert.equal(requests, 1, 'the focused test must exercise the real mobile provider request path');
  assert.equal(requestHeaders['If-None-Match'], `"${stale.revision}"`);
  assert.equal(afterFailure.weatherOutcome, 'unavailable');
  assert.deepEqual(afterFailure.scheduleEntries, before.scheduleEntries, 'an unusable stale forecast must not move saved dates');
  assert.deepEqual(h.plans(), originalPlans, 'a failed provider refresh must not replan adaptive occurrences');
  assert.deepEqual(await readRegionalWeatherInside(h.database, location.municipalityId), stale,
    'the provider failure must preserve the last persisted cache');
  assert.equal(h.writes.length, writesBeforeRefresh, 'retaining an unchanged stale cache must not write or trigger a plan update');

  const sourceBeforeRetry = (await h.context()).sourceRevision;
  stamp += 60_000; t.mock.timers.setTime(stamp);
  const afterRetry = await repository.applyRegionalWeatherToPlannerSnapshot(h.database, afterFailure, () => true, provider, () => new Date(stamp));
  assert.equal(requests, 2, 'the provider must retry after its one-minute failure backoff');
  assert.notEqual(afterRetry.weatherOutcome, 'unavailable');
  assert.equal((await readRegionalWeatherInside(h.database, location.municipalityId)).revision, refreshed.revision);
  const recoveredContext = await h.context();
  assert.notEqual(recoveredContext.sourceRevision, sourceBeforeRetry, 'the fresh forecast must enter adaptive planning input');
  assert.ok(recoveredContext.prepareGeometry().weatherForecast, 'the recovered forecast must reach repository planning geometry');
  assert.equal(afterRetry.completions.length, 0);
  assert.ok(h.plans().length >= originalPlans.length);
});
for (const failure of ['empty', 'missing-range', 'all-null']) test(`an HTTP-success ${failure} forecast recovers through the real provider optimizer and repository after the short retry TTL`, async t => {
  const h = await fixture(t); const before = await h.snapshot(); const original = h.plans(); let calls = 0;
  const valid = cache(); const broken = failure === 'empty' ? {} : structuredClone(valid);
  if (failure === 'missing-range') delete broken.forecast.from;
  if (failure === 'all-null') for (const row of broken.forecast.intervals) { row.precipitationMm = null; row.precipitationProbability = null; row.symbol = null; }
  if (failure === 'all-null') broken.revision = weatherCacheRevision(broken);
  const provider = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', fetcher: async () => {
    calls++; return new Response(JSON.stringify(calls === 1 ? broken : cache(valid.forecast, Date.now())));
  } });
  const first = await repository.applyRegionalWeatherToPlannerSnapshot(h.database, before, () => true, provider);
  assert.equal(first.weatherOutcome, 'unavailable'); assert.equal(calls, 1); assert.deepEqual(h.plans(), original);
  t.mock.timers.setTime(start + 59_999); await repository.applyRegionalWeatherToPlannerSnapshot(h.database, first, () => true, provider); assert.equal(calls, 1);
  t.mock.timers.setTime(start + 60_000);
  const resumed = await repository.applyRegionalWeatherToPlannerSnapshot(h.database, first, () => true, provider);
  assert.equal(calls, 2); assert.notEqual(resumed.weatherOutcome, 'unavailable'); assert.equal(resumed.completions.length, 0);
  assert.equal((await readRegionalWeatherInside(h.database, location.municipalityId)).forecast.intervals[0].precipitationMm, 0);
});
test('real repository atomically stores regional cache with adaptive plans and ignores metadata-only refresh and expired weather as replanning causes', async t => {
  const h = await fixture(t); const before = await h.snapshot(); const value = cache();
  const result = await repository.applyRegionalWeatherToPlannerSnapshot(h.database, before, () => true, { refresh: async () => value });
  assert.ok(result); assert.equal((await readRegionalWeatherInside(h.database, location.municipalityId)).revision, value.revision);
  assert.equal(result.completions.length, 0); const saved = h.plans(); const context = await h.context(); const source = context.sourceRevision;
  assert.ok(context.prepareGeometry().weatherForecast); assert.ok(result.scheduleEntries.every(row => before.scheduleEntries.some(prior => prior.id === row.id)));
  const checked = cache(value.forecast, start + 1); t.mock.timers.setTime(start + 1);
  await repository.applyRegionalWeatherToPlannerSnapshot(h.database, result, () => true, { refresh: async () => checked });
  assert.deepEqual(h.plans(), saved); assert.equal((await h.context()).sourceRevision, source);
  // Passage of time and lost freshness alone do not rewrite a pending plan.
  t.mock.timers.setTime(start + 80 * HOUR); const staleBefore = await h.snapshot(); const stalePlans = h.plans();
  const stale = await repository.applyRegionalWeatherToPlannerSnapshot(h.database, staleBefore, () => true, { refresh: async () => checked });
  assert.equal(stale.weatherOutcome, 'unavailable'); assert.deepEqual(h.plans(), stalePlans); assert.equal((await h.context()).prepareGeometry().weatherForecast, undefined);
});
test('late regional cache result cannot overwrite a new completion or write forecasts for an obsolete displayed snapshot', async t => {
  const h = await fixture(t); const before = await h.snapshot(); let finish;
  const run = repository.applyRegionalWeatherToPlannerSnapshot(h.database, before, () => true, { refresh: () => new Promise(resolve => { finish = resolve; }) });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const entry = before.scheduleEntries[0]; assert.ok(await repository.completeChoreWithReceipt(h.database, entry));
  const plans = h.plans(); finish(cache()); assert.equal(await run, null); assert.deepEqual(h.plans(), plans);
  assert.equal(await readRegionalWeatherInside(h.database, location.municipalityId), null);
  assert.equal((await h.snapshot()).completions.length, 1);
});
test('a regional-cache plus plan write failure rolls back the cache and retained plans together and ordinary reads never contact a weather server', async t => {
  const h = await fixture(t); const before = await h.snapshot(); const plans = h.plans();
  const run = h.database.runAsync;
  h.database.runAsync = async (sql, ...args) => { if (sql.startsWith('INSERT INTO personal_adaptive_inputs')) throw new Error('disk full'); return run(sql, ...args); };
  await assert.rejects(repository.applyRegionalWeatherToPlannerSnapshot(h.database, before, () => true, { refresh: async () => cache() }), /disk full/u);
  h.database.runAsync = run; assert.equal(await readRegionalWeatherInside(h.database, location.municipalityId), null); assert.deepEqual(h.plans(), plans);
  let calls = 0; const fetcher = globalThis.fetch; globalThis.fetch = async () => { calls++; throw new Error('display must stay offline'); };
  try { await h.snapshot(); await h.context(); assert.equal(calls, 0); } finally { globalThis.fetch = fetcher; }
  await h.database.withTransactionAsync(async () => { assert.equal(await saveRegionalWeatherInside(h.database, cache()), true); assert.equal(await saveRegionalWeatherInside(h.database, cache()), false); });
});

test('a late weather response crosses the configured owners midnight without relying on the devices unchanged civil day', async t => {
  const { bindAdaptiveOwnerReader } = await import('../src/platform/storage/adaptive-owner-inputs.ts');
  const h = await fixture(t);
  const own = { schemaVersion: 1, ownerUserId: 'owner', revision: 1, timeZone: 'Pacific/Honolulu', restDays: [1, 2, 3, 4, 5, 6, 7],
    loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 2 }, allowedBands: [] };
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: own, common: null, assertCurrent() {} })); t.after(stop);
  const before = await h.snapshot(); assert.equal(before.today, '2026-11-04'); assert.equal(before.timeZone, 'Pacific/Honolulu');
  let finish; const pending = repository.applyRegionalWeatherToPlannerSnapshot(h.database, before, () => true, { refresh: () => new Promise(resolve => { finish = resolve; }) });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.setTime(start + 10 * HOUR); finish(cache());
  assert.equal(await pending, null); assert.equal(await readRegionalWeatherInside(h.database, location.municipalityId), null);
});
