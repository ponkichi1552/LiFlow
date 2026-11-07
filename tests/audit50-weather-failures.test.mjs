import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetWeatherService } from '../server/appliance-care-api/src/weather/met-service.mjs';
import { createWeatherHttpHandler } from '../server/appliance-care-api/src/weather/http-handler.mjs';
const stamp = Date.parse('2026-11-07T00:00:00Z');
const claim = { region: { latitude: 35, longitude: 139 }, cache: null };

test('audit50 weather workers finish already leased work even when a later claim fails', async () => {
  let claims = 0; let finished = 0; let calls = 0;
  const service = createMetWeatherService({ userAgent: 'LiFlow/test https://weather.liflow.app/contact', now: () => stamp, store: {
    claim: async () => { if (++claims === 1) return claim; throw new Error('temporary claim failure'); },
    finish: async () => { finished++; return true; }
  }, fetcher: async () => { calls++; return new Response(null, { status: 503 }); } });
  await assert.rejects(service.tick(), /temporary claim failure/u);
  assert.equal(calls, 1); assert.equal(finished, 1, 'a held lease must not wait for expiry just because the next claim failed');
});

test('audit50 weather batch failure waits for every issued claim to settle before the scheduled request ends', async () => {
  let count = 0; let release; const gate = new Promise(done => { release = done; }); let settled = false;
  const service = createMetWeatherService({ userAgent: 'LiFlow/test https://weather.liflow.app/contact', now: () => stamp, store: {
    claim: async () => ++count <= 2 ? { ...claim, n: count } : null,
    finish: async value => { if (value.n === 1) throw new Error('first commit failure'); await gate; }
  }, fetcher: async () => new Response(null, { status: 503 }) });
  const work = service.tick().then(() => { settled = true; }, () => { settled = true; });
  await new Promise(setImmediate); assert.equal(settled, false, 'do not release the scheduler while another region commit is still pending'); release(); await work;
});

test('audit50 a stalled regional cache read cannot leave public weather requests waiting indefinitely', async () => {
  const handler = createWeatherHttpHandler({ weather: { read: () => new Promise(() => {}) }, readTimeoutMs: 5 });
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  const result = await Promise.race([handler({ method: 'GET', socket: { remoteAddress: 'local' }, headers: {} }, response, new URL('https://local/v1/weather/regions/jp-municipal.13101')), new Promise(resolve => setTimeout(() => resolve('timed out'), 60))]);
  assert.equal(result, true); assert.equal(response.status, 503); assert.equal(JSON.parse(response.body).code, 'weather_unavailable');
});
