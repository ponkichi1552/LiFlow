import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegionalWeatherStore, weatherRegionKey, weatherRegion } from '../server/appliance-care-api/src/weather/regional-store.mjs';
import { createMetWeatherService, identifyingMetUserAgent } from '../server/appliance-care-api/src/weather/met-service.mjs';
import { parseMetForecast, validMetForecast, metWeatherForWindow, weatherCacheFreshness } from '../server/appliance-care-api/src/weather/forecast.mjs';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
const HOUR = 3_600_000; const now = Date.parse('2026-11-05T03:00:00Z');
const userAgent = 'LiFlow/unit-test https://weather.liflow.app/contact'; // Mock transport only; never an operator setting or real MET request.
const id = 'jp-municipal.13104';
const iso = stamp => new Date(stamp).toISOString();
function body({ start = now, count = 24, mm = 0, probability, hours = [1, 6, 12] } = {}) {
  return { properties: { meta: { updated_at: iso(start), units: { precipitation_amount: 'mm' } }, timeseries: Array.from({ length: count }, (_, i) => ({ time: iso(start + i * HOUR),
    data: Object.fromEntries(hours.map(h => [`next_${h}_hours`, { summary: { symbol_code: 'clearsky_day' },
      details: { precipitation_amount: mm, ...(probability === undefined ? {} : { probability_of_precipitation: probability }) } }])) })) } };
}
const response = (data = body(), headers = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', expires: new Date(now + HOUR).toUTCString(),
  'last-modified': new Date(now).toUTCString(), ...headers } });
function fixture(clock = () => now) {
  const records = new Map(); let global = null; let tail = Promise.resolve(); let writes = 0; let reads = 0;
  const atomic = (key, fn) => {
    const result = tail.then(() => {
      const value = fn(structuredClone(records.get(key) ?? null), structuredClone(global));
      if (Object.hasOwn(value, 'region')) { records.set(key, structuredClone(value.region)); writes++; }
      if (Object.hasOwn(value, 'global')) { global = structuredClone(value.global); writes++; }
      return structuredClone(value.result);
    }); tail = result.catch(() => {}); return result;
  };
  const store = createRegionalWeatherStore({ now: clock, atomic, read: async key => { reads++; return structuredClone(records.get(key) ?? null); },
    due: async stamp => [...records].filter(([, row]) => row.nextAttemptAt !== null && row.nextAttemptAt <= stamp).sort((a, b) => a[1].nextAttemptAt - b[1].nextAttemptAt).slice(0, 32).map(([key]) => key) });
  return { store, records, global: () => global, counts: () => ({ reads, writes }), service: (fetcher, extra = {}) => createMetWeatherService({ store, now: clock, userAgent, fetcher, ...extra }) };
}
test('MET interval conversion retains absent probability and chooses finest complete cover without double counting coarse totals', () => {
  const forecast = parseMetForecast(body({ mm: 0.1 })); assert.equal(validMetForecast(forecast), true);
  const result = metWeatherForWindow(forecast, now + HOUR / 2, now + HOUR * 2.5);
  assert.equal(result.coveredIntervals, 3); assert.ok(Math.abs(result.precipitationMm - 0.3) < 1e-9);
  assert.equal(result.precipitationProbability, null); assert.equal(result.suitable, true);
  assert.equal(metWeatherForWindow(forecast, now - HOUR, now).suitable, null);
  assert.equal(metWeatherForWindow(forecast, now + 40 * HOUR, now + 41 * HOUR).known, false);
  const noHourly = parseMetForecast(body({ count: 2, hours: [6, 12], mm: 1 }));
  assert.equal(metWeatherForWindow(noHourly, now, now + 3 * HOUR).precipitationMm, 1);
  assert.equal(metWeatherForWindow(noHourly, now, now + 3 * HOUR).suitable, false);
  const gap = parseMetForecast(body({ count: 2, hours: [1] })); gap.intervals[1].start += HOUR; gap.intervals[1].end += HOUR;
  assert.equal(metWeatherForWindow(gap, now, now + 3 * HOUR).known, false);
});
test('MET parser rejects invalid units measurements dates order and malformed intervals instead of fabricating dry weather', () => {
  for (const modify of [b => { b.properties.meta.units.precipitation_amount = 'inch'; },
    b => { b.properties.timeseries[0].time = '2026-02-31T00:00:00Z'; }, b => { b.properties.timeseries.reverse(); },
    b => { b.properties.timeseries[0].data.next_1_hours.details.precipitation_amount = -1; },
    b => { b.properties.timeseries[0].data.next_1_hours.details.probability_of_precipitation = 101; }]) {
    const value = body(); modify(value); assert.throws(() => parseMetForecast(value));
  }
  const value = parseMetForecast(body()); delete value.intervals[0].precipitationMm; assert.equal(validMetForecast(value), false);
});
test('weather freshness separately gates 36-hour check 48-hour generation and 72-hour display with clock reversal fail closed', () => {
  const cache = { checkedAt: iso(now), forecast: parseMetForecast(body()) };
  assert.deepEqual(weatherCacheFreshness(cache, now + 36 * HOUR), { placement: true, display: true });
  assert.deepEqual(weatherCacheFreshness(cache, now + 36 * HOUR + 1), { placement: false, display: true });
  assert.deepEqual(weatherCacheFreshness({ ...cache, checkedAt: iso(now + 20 * HOUR) }, now + 49 * HOUR), { placement: false, display: true });
  assert.deepEqual(weatherCacheFreshness(cache, now + 72 * HOUR + 1), { placement: false, display: false });
  assert.deepEqual(weatherCacheFreshness(cache, now - 1), { placement: false, display: false });
});
test('first region requests only coalesce a durable job and repeated reads never call MET or rewrite hourly references', async () => {
  const h = fixture(); let calls = 0; const service = h.service(async () => { calls++; return response(); });
  await Promise.all(Array.from({ length: 100 }, () => service.read(id)));
  assert.equal(h.records.size, 1); assert.equal(calls, 0);
  await service.tick(); assert.equal(calls, 1); const result = await service.read(id); assert.equal(result.status, 200);
  const before = h.counts().writes;
  for (let i = 0; i < 100; i++) assert.equal((await service.read(id)).value.revision, result.value.revision);
  assert.equal(h.counts().writes, before); assert.equal(await service.tick(), 0);
  assert.equal(calls, 1); assert.equal((await service.read('https://attacker.invalid/')).status, 404);
});
test('regional 304 preserves original body generated time fetched time and exact Last-Modified while advancing checked time and revision', async () => {
  let stamp = now; const h = fixture(() => stamp); const requests = [];
  const service = h.service(async (url, options) => { requests.push({ url, options }); return requests.length === 1 ? response() : new Response(null, { status: 304,
    headers: { expires: new Date(stamp + HOUR).toUTCString() } }); });
  await service.read(id); await service.tick(); const prior = (await service.read(id)).value;
  stamp = now + 26 * HOUR; await service.tick(); const current = (await service.read(id)).value;
  assert.equal(requests[1].options.headers['If-Modified-Since'], new Date(now).toUTCString());
  assert.equal(current.fetchedAt, prior.fetchedAt); assert.equal(current.forecast.generatedAt, prior.forecast.generatedAt);
  assert.deepEqual(current.forecast.intervals, prior.forecast.intervals); assert.equal(current.checkedAt, iso(stamp)); assert.notEqual(current.revision, prior.revision);
  assert.equal(new URL(requests[0].url).hostname, 'api.met.no');
  for (const name of ['lat', 'lon']) assert.match(new URL(requests[0].url).searchParams.get(name), /^-?\d+\.\d{4}$/u);
});
test('Expires prevents early regional fetch even beyond the normal daily check and a week without references suspends fetching', async () => {
  let stamp = now; const h = fixture(() => stamp); let calls = 0;
  const service = h.service(async () => { calls++; return response(body(), { expires: new Date(now + 30 * HOUR).toUTCString() }); });
  await service.read(id); await service.tick(); stamp += 27 * HOUR; assert.equal(await service.tick(), 0);
  stamp = now + 30 * HOUR; assert.equal(await service.tick(), 1); assert.equal(calls, 2);
  stamp = now + 8 * 24 * HOUR; assert.equal(await service.tick(), 0);
  const row = h.records.get(weatherRegionKey(weatherRegion(id))); assert.equal(row.status, 'inactive');
  await service.read(id); assert.equal(await service.tick(), 1, 'a new reference reactivates the same cache key');
});
test('global durable weather gates apply across concurrent workers and retries with two starts per second and four leases', async () => {
  let stamp = now; const h = fixture(() => stamp); const resolvers = []; let calls = 0;
  const serviceA = h.service(async () => { calls++; return new Promise(resolve => resolvers.push(resolve)); });
  const serviceB = h.service(async () => { calls++; return new Promise(resolve => resolvers.push(resolve)); });
  for (const key of ['jp-municipal.13104', 'jp-municipal.13103', 'jp-municipal.13102', 'jp-municipal.13101', 'jp-municipal.13105']) await serviceA.read(key);
  const pending = [serviceA.tick(), serviceB.tick()]; await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  stamp += 1000; pending.push(serviceB.tick()); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 4);
  stamp += 1000; assert.equal(await serviceA.tick(), 0); assert.equal(Object.keys(h.global().leases).length, 4);
  for (const resolve of resolvers) resolve(response()); await Promise.all(pending); assert.equal(Object.keys(h.global().leases).length, 0);
  const final = serviceA.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 5); for (const resolve of resolvers.slice(4)) resolve(response()); assert.equal(await final, 1);
  assert.ok([...h.records.values()].every(row => row.cache && row.error === null));
});
test('403 halts automatic fetching and records operator attention while 429 Retry-After slows all regions', async () => {
  let stamp = now; const h = fixture(() => stamp); const alerts = [];
  const forbidden = h.service(async () => new Response(null, { status: 403 }), { onOperatorAlert: value => alerts.push(value) });
  await forbidden.read(id); await forbidden.tick(); assert.equal(h.global().halted, true); assert.deepEqual(alerts, [{ code: 'met_forbidden' }]);
  stamp += 30 * 24 * HOUR; await forbidden.read(id); assert.equal(await forbidden.tick(), 0);
  const g = fixture(() => stamp); let calls = 0; const limited = g.service(async () => { calls++; return new Response(null, { status: 429, headers: { 'retry-after': '3600' } }); });
  await limited.read(id); await limited.tick(); await limited.read('jp-municipal.13103');
  stamp += 1001; assert.equal(await limited.tick(), 0); assert.equal(calls, 1); assert.ok(g.global().notBefore > stamp);
});
test('15-second MET deadline settles ignored abort without committing late bodies or releasing an unsettled transport slot', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const h = fixture(Date.now); let resolveFetch; const service = h.service(async () => new Promise(resolve => { resolveFetch = resolve; }));
  await service.read(id); const run = service.tick(); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15_000); assert.equal(await run, 1);
  const row = h.records.get(weatherRegionKey(weatherRegion(id))); assert.equal(row.cache, null); assert.equal(row.error, 'met_timeout');
  assert.equal(Object.keys(h.global().leases).length, 1);
  resolveFetch(response()); await new Promise(resolve => setImmediate(resolve)); assert.equal(row.cache, null);
  assert.equal(h.records.get(row.key).cache, null); assert.equal(Object.keys(h.global().leases).length, 0);
});
test('MET failures follow bounded jittered retries then normal daily cadence without replacing a successful forecast', async () => {
  let stamp = now; const h = fixture(() => stamp); let fail = false; let calls = 0;
  const alerts = [];
  const service = h.service(async () => { calls++; return fail ? new Response('private provider diagnostics', { status: 503 }) : response(); }, { onOperatorAlert: alert => alerts.push(alert) });
  await service.read(id); await service.tick(); const before = (await service.read(id)).value; fail = true;
  const delays = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 24 * 3_600_000];
  for (let i = 0; i < delays.length; i++) {
    stamp = h.records.get(weatherRegionKey(weatherRegion(id))).nextAttemptAt;
    await service.read(id); await service.tick(); const current = h.records.get(weatherRegionKey(weatherRegion(id)));
    assert.equal(current.retryCount, i + 1); const delay = current.nextAttemptAt - stamp;
    assert.ok(Math.abs(delay - delays[i]) <= (i === 3 ? 30 * 60_000 : 60_000));
    assert.equal(current.cache.revision, before.revision); assert.deepEqual(current.cache.forecast, before.forecast);
  }
  assert.equal(calls, 5);
  assert.deepEqual(alerts, Array.from({ length: 4 }, () => ({ code: 'met_http_error', httpStatus: 503 })));
});
test('MET malformed oversized and unexpected redirect responses remain retryable and never follow an unbudgeted URL', async () => {
  for (const responseFactory of [() => new Response('{bad'), () => new Response('too large', { headers: { 'content-length': String(513 * 1024) } }),
    () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }), () => new Response(null, { status: 304 })]) {
    const h = fixture(); let calls = 0; const service = h.service(async (_url, options) => { calls++; assert.equal(options.redirect, 'manual'); return responseFactory(); });
    await service.read(id); await service.tick(); const row = h.records.get(weatherRegionKey(weatherRegion(id)));
    assert.equal(row.cache, null); assert.equal(row.status, 'retry'); assert.equal(calls, 1);
  }
});
test('deprecated MET data remains available even when operator logging fails and probability-free measurements remain usable', async () => {
  const h = fixture(); const service = h.service(async () => new Response(JSON.stringify(body()), { status: 203 }),
    { onOperatorAlert: () => { throw new Error('logging unavailable'); } });
  await service.read(id); await service.tick(); const value = (await service.read(id)).value;
  assert.equal(value.forecast.intervals[0].precipitationProbability, null); assert.equal(weatherCacheFreshness(value, now).placement, true);
});
test('missing contact configuration refuses MET work and public cache HTTP uses conditional versions without requiring an AI login', async t => {
  assert.equal(identifyingMetUserAgent('LiFlow'), false); assert.equal(identifyingMetUserAgent('LiFlow example@example.com'), false);
  const h = fixture(); let calls = 0; const disabled = h.service(async () => { calls++; return response(); }, { userAgent: undefined });
  assert.equal((await disabled.read(id)).status, 503); assert.equal(await disabled.tick(), 0); assert.equal(calls, 0); assert.equal(h.records.size, 0);
  const service = h.service(async () => response()); await service.read(id); await service.tick();
  const server = createApplianceCareHttpServer({ dependencies: {}, weather: service, manualUploadsOnly: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/weather/regions/${id}`;
  const first = await fetch(url); assert.equal(first.status, 200); const value = await first.json(); assert.equal(value.regionId, id);
  const second = await fetch(url, { headers: { 'if-none-match': first.headers.get('etag') } }); assert.equal(second.status, 304); assert.equal(await second.text(), '');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});
