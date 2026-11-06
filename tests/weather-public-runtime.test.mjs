import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWeatherHttpServer } from '../server/appliance-care-api/src/weather-http-server.mjs';
import { weatherRuntimeConfig } from '../server/appliance-care-api/src/weather/runtime-config.mjs';
import { createWeatherWorkerHttpServer } from '../server/appliance-care-api/src/weather/worker-http-handler.mjs';

const start = Date.parse('2026-11-05T03:00:00Z');
const ids = ['jp-municipal.13101', 'jp-municipal.13102', 'jp-municipal.13103'];
function ready(id, stamp = start) { return { status: 200, value: { regionId: id, revision: 'revision-one', checkedAt: new Date(stamp).toISOString(),
  forecast: { generatedAt: new Date(stamp).toISOString(), intervals: [] } } }; }
async function host(t, options) {
  const server = createWeatherHttpServer(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: (id = ids[0], init) => fetch(`${base}/v1/weather/regions/${id}`, init), base };
}
test('weather-only HTTP coalesces concurrent regional reads and keeps conditional replies independent of AI authentication', async t => {
  let reads = 0; let release; const wait = new Promise(resolve => { release = resolve; });
  const h = await host(t, { now: () => start, weather: { async read(id) { reads++; await wait; return ready(id); } } });
  const requests = Array.from({ length: 16 }, () => h.get()); await new Promise(resolve => setImmediate(resolve)); release();
  const responses = await Promise.all(requests); assert.ok(responses.every(value => value.status === 200)); assert.equal(reads, 1);
  const etag = responses[0].headers.get('etag'); const unchanged = await h.get(ids[0], { headers: { 'if-none-match': etag } });
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), ''); assert.equal(reads, 1);
  for (const path of ['/api/appliance-care/jobs', '/api/appliance-care/analyze', '/api/subscriptions/verify', '/v1/users']) {
    assert.equal((await fetch(h.base + path, { method: 'POST', body: 'untrusted' })).status, 404);
  }
  assert.deepEqual(await (await fetch(h.base + '/health')).json(), { status: 'ok' });
});
test('weather HTTP rejects unknown regions and writes before cloud reads and forged proxy identities cannot reset admission', async t => {
  let reads = 0;
  const h = await host(t, { now: () => start, perAddress: 3, weather: { async read(id) { reads++; return ready(id); } } });
  assert.equal((await h.get('arbitrary-user-document')).status, 404);
  assert.equal((await h.get(ids[0], { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await h.get(ids[0])).status, 200);
  assert.equal((await h.get(ids[0], { headers: { 'x-forwarded-for': '10.0.0.2' } })).status, 200);
  const denied = await h.get(ids[0], { headers: { 'x-forwarded-for': '10.0.0.3' } });
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '60'); assert.equal(reads, 1);
});
test('weather HTTP never serves expired or clock-reversed cached forecasts and pending jobs become visible promptly', async t => {
  let stamp = start; let reads = 0; let result = ready(ids[0], start - 72 * 3_600_000 + 1);
  const h = await host(t, { now: () => stamp, weather: { async read() { reads++; return result; } } });
  assert.equal((await h.get()).status, 200);
  stamp++; result = { status: 202, code: 'weather_pending' };
  assert.equal((await h.get()).status, 200); // The documented inclusive boundary still permits display.
  stamp++; assert.equal((await h.get()).status, 202); assert.equal(reads, 2);
  stamp += 5000; result = ready(ids[0], stamp);
  assert.equal((await h.get()).status, 200); assert.equal(reads, 3);
  stamp--; result = { status: 202, code: 'weather_pending' };
  assert.equal((await h.get()).status, 202); assert.equal(reads, 4);
});
test('weather HTTP bounds cached regions and recovers a failed read without poisoning later requests', async t => {
  let reads = 0; let fail = true;
  const h = await host(t, { now: () => start, maximumKeys: 2, weather: { async read(id) { reads++; if (fail) throw new Error('private storage diagnostics'); return ready(id); } } });
  const failed = await h.get(); assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { code: 'weather_unavailable' });
  fail = false;
  for (const id of [...ids, ids[0]]) assert.equal((await h.get(id)).status, 200);
  assert.equal(reads, 5);
});
test('public weather runtime requires its named database valid operator and bounded port instead of inheriting private or emulator data', () => {
  const good = { APPLIANCE_CARE_FIREBASE_PROJECT_ID: 'liflow-test-project', LIFLOW_WEATHER_FIRESTORE_DATABASE_ID: 'liflow-weather',
    MET_WEATHER_USER_AGENT: 'LiFlow/unit-test https://weather.liflow.app/contact', PORT: '8080' };
  assert.deepEqual(weatherRuntimeConfig(good), { projectId: 'liflow-test-project', databaseId: 'liflow-weather', port: 8080 });
  for (const change of [{ LIFLOW_WEATHER_FIRESTORE_DATABASE_ID: '(default)' }, { LIFLOW_WEATHER_FIRESTORE_DATABASE_ID: '' },
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, { MET_WEATHER_USER_AGENT: 'LiFlow' }, { PORT: '0' }, { PORT: '65536' },
    { APPLIANCE_CARE_FIREBASE_PROJECT_ID: 'different/project' }]) assert.throws(() => weatherRuntimeConfig({ ...good, ...change }));
});
test('scheduled weather request awaits its finite batch refuses overlap and stops new work after termination', async t => {
  const controller = new AbortController(); let calls = 0; let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const service = {};
  const server = createWeatherWorkerHttpServer({ service, signal: controller.signal, runBatch: async (input, options) => {
    calls++; assert.equal(input, service); assert.equal(options.maximum, 32); assert.equal(options.signal, controller.signal);
    entered(); await waiting; return { attempted: 1 };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/internal/weather/run`; let responded = false;
  const first = fetch(url, { method: 'POST' }).then(value => { responded = true; return value; }); await started;
  assert.equal(responded, false); assert.equal((await fetch(url, { method: 'POST' })).status, 409);
  assert.equal((await fetch(url)).status, 404); assert.equal(calls, 1);
  release(); assert.deepEqual(await (await first).json(), { attempted: 1 });
  controller.abort(); assert.equal((await fetch(url, { method: 'POST' })).status, 409); assert.equal(calls, 1);
});
