import { createFixedWindowRateLimit } from '../rate-limit.mjs';
import { weatherCacheFreshness } from './forecast.mjs';
import { weatherRegion } from './regional-store.mjs';

/** Shared by the appliance host and the weather-only host; never calls MET. */
export function createWeatherHttpHandler({ weather, now = Date.now, cacheMs = 30_000, maximumKeys = 256,
  perAddress = 60, total = 300 } = {}) {
  if (![cacheMs, maximumKeys].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid weather HTTP cache');
  const allowAddress = createFixedWindowRateLimit({ limit: perAddress, now });
  const allowTotal = createFixedWindowRateLimit({ limit: total, maximumKeys: 1, now });
  const saved = new Map(); const pending = new Map();
  async function read(id) {
    const stamp = now(); const cached = saved.get(id);
    if (cached && stamp >= cached.at && stamp < cached.until && (cached.result.status !== 200 || weatherCacheFreshness(cached.result.value, stamp).display)) return cached.result;
    if (pending.has(id)) return pending.get(id);
    const work = Promise.resolve().then(() => weather.read(id)).then(result => {
      if (result.status === 200 || result.status === 202) {
        // Never cache private provider errors or an unbounded list of arbitrary IDs.
        saved.delete(id);
        while (saved.size >= maximumKeys) saved.delete(saved.keys().next().value);
        saved.set(id, { at: stamp, until: stamp + Math.min(cacheMs, result.status === 202 ? 5_000 : cacheMs), result });
      }
      return result;
    }).finally(() => pending.delete(id));
    pending.set(id, work); return work;
  }
  return async (request, response, url) => {
    if (!url.pathname.startsWith('/v1/weather/regions/')) return false;
    response.setHeader('cache-control', 'private, max-age=0');
    if (request.method !== 'GET') { send(response, 405, { code: 'weather_read_only' }); return true; }
    // Do not trust client-supplied Forwarded/X-Forwarded-For to bypass limits.
    if (!allowTotal('all') || !allowAddress(request.socket.remoteAddress ?? 'unknown')) {
      response.setHeader('retry-after', '60'); send(response, 429, { code: 'weather_rate_limited' }); return true;
    }
    const id = url.pathname.slice('/v1/weather/regions/'.length);
    if (!weatherRegion(id)) { send(response, 404, { code: 'weather_region_unknown' }); return true; }
    if (!weather) { send(response, 503, { code: 'weather_not_configured' }); return true; }
    const result = await read(id);
    if (response.destroyed || response.writableEnded) return true;
    if (result.status === 200) {
      const etag = `"${result.value.revision}"`; response.setHeader('etag', etag);
      if (request.headers['if-none-match'] === etag) { response.writeHead(304); response.end(); }
      else send(response, 200, result.value);
    } else {
      if (result.status === 202) response.setHeader('retry-after', '60');
      send(response, result.status, { code: result.code });
    }
    return true;
  };
}
function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
}
