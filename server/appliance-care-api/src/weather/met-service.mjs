import { parseMetForecast, validMetForecast, weatherCacheFreshness } from './forecast.mjs';
import { weatherRegion } from './regional-store.mjs';
import { Buffer } from 'node:buffer';
const ROOT = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const MAX_BODY = 512 * 1024;
export function identifyingMetUserAgent(value) {
  return typeof value === 'string' && value.length <= 200 && /LiFlow/iu.test(value) && !/[\r\n]|example\.|localhost|your[-_ ]?(?:email|domain)/iu.test(value)
    && /(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/|\b))/iu.test(value);
}
export function createMetWeatherService({ store, userAgent, fetcher = fetch, now = Date.now, timeoutMs = 15_000, onOperatorAlert = () => {} }) {
  const configured = identifyingMetUserAgent(userAgent);
  const alert = value => { try { onOperatorAlert(value); } catch { /* Logging cannot corrupt the received cache. */ } };
  async function request(claim) {
    const controller = new AbortController(); let timedOut = false; let settled = false; let timer;
    const work = (async () => {
      const initial = new URL(ROOT); initial.searchParams.set('lat', claim.region.latitude.toFixed(4)); initial.searchParams.set('lon', claim.region.longitude.toFixed(4));
      const headers = { 'User-Agent': userAgent, Accept: 'application/json' };
      if (claim.cache?.lastModified) headers['If-Modified-Since'] = claim.cache.lastModified;
      const response = await fetcher(initial.toString(), { headers, signal: controller.signal, redirect: 'manual' });
      if (controller.signal.aborted) { discard(response); throw new Error('met_timeout'); }
      // The canonical endpoint is pinned. An unexpected redirect is not a
      // license to make an unbudgeted extra HTTP request or contact another host.
      if ([301, 302, 303, 307, 308].includes(response.status)) { discard(response); return { code: 'met_redirect' }; }
      const stamp = now();
      if (response.status === 403) { discard(response); return { code: 'met_forbidden' }; }
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const retryAt = /^\d+$/u.test(retry ?? '') ? stamp + Math.min(Number(retry), 7 * 86400) * 1000 : Date.parse(retry);
        discard(response); return { code: 'met_rate_limited', ...(Number.isFinite(retryAt) ? { retryAt } : {}) };
      }
      if (response.status !== 304 && response.status !== 200 && response.status !== 203) { discard(response); return { code: 'met_http_error', httpStatus: response.status }; }
      const expiresHeader = response.headers.get('expires'); const lastModifiedHeader = response.headers.get('last-modified');
      const expiresAt = Number.isFinite(Date.parse(expiresHeader)) ? new Date(Date.parse(expiresHeader)).toISOString() : null;
      const lastModified = Number.isFinite(Date.parse(lastModifiedHeader)) && Date.parse(lastModifiedHeader) <= stamp ? lastModifiedHeader : null;
      if (response.status === 304) {
        if (!claim.cache || !validMetForecast(claim.cache.forecast)) return { code: 'met_invalid_not_modified' };
        return { cache: { ...claim.cache, checkedAt: new Date(stamp).toISOString(), expiresAt: expiresAt ?? claim.cache.expiresAt,
          lastModified: lastModified ?? claim.cache.lastModified } };
      }
      const body = await limitedJson(response, controller.signal);
      if (controller.signal.aborted) throw new Error('met_timeout');
      const forecast = parseMetForecast(body);
      if (!validMetForecast(forecast) || Date.parse(forecast.generatedAt) > now() + 5 * 60_000) return { code: 'met_invalid_forecast' };
      if (response.status === 203) alert({ code: 'met_deprecated' });
      return { cache: { forecast, body, fetchedAt: new Date(stamp).toISOString(), checkedAt: new Date(stamp).toISOString(),
        expiresAt, lastModified } };
    })();
    work.finally(() => { settled = true; if (timedOut) void store.releaseTransport(claim).catch(() => {}); }).catch(() => {});
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('met_timeout')); }, timeoutMs); });
    try { return await Promise.race([work, deadline]); }
    catch { return { code: timedOut ? 'met_timeout' : 'met_unavailable', transportUnsettled: !settled }; }
    finally { clearTimeout(timer); }
  }
  return {
    configured,
    async read(id) {
      if (!weatherRegion(id)) return { status: 404, code: 'weather_region_unknown' };
      if (!configured) return { status: 503, code: 'weather_not_configured' };
      const value = await store.reference(id); const cache = value?.cache;
      if (!cache || !validMetForecast(cache.forecast) || !weatherCacheFreshness(cache, now()).display) return { status: 202, code: 'weather_pending' };
      return { status: 200, value: { schemaVersion: 1, regionId: id, revision: cache.revision, fetchedAt: cache.fetchedAt,
        checkedAt: cache.checkedAt, expiresAt: cache.expiresAt, lastModified: cache.lastModified, forecast: cache.forecast } };
    },
    async tick(maximum = 4) {
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4) throw new Error('Invalid weather concurrency budget');
      if (!configured) return 0;
      const claims = [];
      for (let index = 0; index < maximum; index++) { const claim = await store.claim(); if (!claim) break; claims.push(claim); }
      await Promise.all(claims.map(async claim => {
        const outcome = await request(claim); const committed = await store.finish(claim, outcome);
        if (committed && outcome.code === 'met_forbidden') alert({ code: 'met_forbidden' });
        if (committed && outcome.code === 'met_http_error') alert({ code: outcome.code, httpStatus: outcome.httpStatus });
      }));
      return claims.length;
    },
  };
}
async function limitedJson(response, signal) {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY) { discard(response); throw new Error('met_body_too_large'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('met_body_missing');
  const parts = []; let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('met_timeout');
      const { value, done } = await reader.read(); if (signal.aborted) throw new Error('met_timeout'); if (done) break;
      bytes += value.byteLength; if (bytes > MAX_BODY) throw new Error('met_body_too_large'); parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { if (signal.aborted || bytes > MAX_BODY) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function discard(response) { try { void response.body?.cancel().catch(() => {}); } catch { /* Preserve the actual HTTP result. */ } }
