import type { WeatherLocation } from '../../domain/shared/types';
import { resolveWeatherMunicipality } from './municipality-search';
import { validMetForecast, weatherCacheFreshness } from '../../../server/appliance-care-api/src/weather/forecast.mjs';
import type { MetForecast } from '../../../server/appliance-care-api/src/weather/forecast.mjs';

export interface RegionalWeatherCache {
  schemaVersion: 1; regionId: string; revision: string; fetchedAt: string; checkedAt: string;
  expiresAt: string | null; lastModified: string | null; forecast: MetForecast;
}
export function isRegionalWeatherCache(value: unknown, regionId: string): value is RegionalWeatherCache {
  if (!value || typeof value !== 'object') return false;
  const row = value as RegionalWeatherCache;
  return row.schemaVersion === 1 && row.regionId === regionId && /^[a-f0-9]{64}$/u.test(row.revision)
    && typeof row.fetchedAt === 'string' && Number.isFinite(Date.parse(row.fetchedAt))
    && typeof row.checkedAt === 'string' && Number.isFinite(Date.parse(row.checkedAt))
    && (row.expiresAt === null || typeof row.expiresAt === 'string' && Number.isFinite(Date.parse(row.expiresAt)))
    && (row.lastModified === null || typeof row.lastModified === 'string' && row.lastModified.length <= 100 && Number.isFinite(Date.parse(row.lastModified)))
    && validMetForecast(row.forecast);
}
function copyCache(value: RegionalWeatherCache | null): RegionalWeatherCache | null {
  return value ? { schemaVersion: 1, regionId: value.regionId, revision: value.revision, fetchedAt: value.fetchedAt, checkedAt: value.checkedAt,
    expiresAt: value.expiresAt, lastModified: value.lastModified, forecast: { transformVersion: value.forecast.transformVersion,
      generatedAt: value.forecast.generatedAt, from: value.forecast.from, through: value.forecast.through,
      intervals: value.forecast.intervals.map(row => ({ start: row.start, end: row.end, precipitationMm: row.precipitationMm,
        precipitationProbability: row.precipitationProbability, symbol: row.symbol })) } } : null;
}
function newestCache(a: RegionalWeatherCache | null, b: RegionalWeatherCache | null) {
  return copyCache(!a || b && Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a);
}
const MAX_FORECAST_BYTES = 512 * 1024;
async function forecastJson(response: Response, signal: AbortSignal): Promise<unknown> {
  // Streaming is optional on native Fetch implementations. The text fallback
  // still enforces the actual UTF-8 payload limit before parsing JSON.
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (signal.aborted || text.length > MAX_FORECAST_BYTES || new TextEncoder().encode(text).length > MAX_FORECAST_BYTES) throw new Error('Forecast body too large or expired');
    return JSON.parse(text);
  }
  const parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('Forecast expired');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FORECAST_BYTES) throw new Error('Forecast body too large');
      parts.push(value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder().decode(body));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
interface ProviderOptions { baseUrl?: string; fetcher?: FetchLike; now?: () => number; timeoutMs?: number }
export class MetServerForecastProvider {
  private readonly pending = new Map<string, Promise<RegionalWeatherCache | null>>();
  private readonly attempts = new Map<string, { at: number; retryAt: number; value: RegionalWeatherCache | null }>();
  private readonly options: ProviderOptions;
  constructor(options: ProviderOptions = {}) { this.options = options; }
  /** Called by the existing lifecycle refresh, never by a display/cache read. */
  async refresh(location: WeatherLocation, cached: RegionalWeatherCache | null): Promise<RegionalWeatherCache | null> {
    const region = resolveWeatherMunicipality(location); if (!region) return null;
    const saved = cached && isRegionalWeatherCache(cached, region.id) ? copyCache(cached) : null;
    const now = this.options.now?.() ?? Date.now();
    const configured = this.options.baseUrl ?? process.env.EXPO_PUBLIC_WEATHER_API_URL ?? process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL;
    let base: URL;
    try { base = new URL(configured?.trim() ?? ''); } catch { return saved; }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return saved;
    const key = `${base.href}:${region.id}`;
    const prior = this.attempts.get(key);
    if (prior && now >= prior.at && now < prior.retryAt) return newestCache(prior.value, saved);
    const existing = this.pending.get(key); if (existing) return newestCache(await existing, saved);
    const request = this.request(new URL(`${base.pathname.replace(/\/$/u, '')}/v1/weather/regions/${region.id}`, base).href,
      region.id, saved).then(value => {
      const stamp = this.options.now?.() ?? Date.now();
      this.attempts.set(key, { at: stamp, retryAt: stamp + (value && weatherCacheFreshness(value, stamp).placement ? 15 * 60_000 : 60_000), value });
      if (this.attempts.size > 8) this.attempts.delete(this.attempts.keys().next().value!);
      return value;
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    this.pending.set(key, request); return copyCache(await request);
  }
  private async request(url: string, regionId: string, cached: RegionalWeatherCache | null) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      const response = await (this.options.fetcher ?? globalThis.fetch)(url, { signal: controller.signal,
        headers: { Accept: 'application/json', ...(cached ? { 'If-None-Match': `"${cached.revision}"` } : {}) } });
      if (controller.signal.aborted) return cached;
      if (response.status === 304) return cached;
      if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > MAX_FORECAST_BYTES) return cached;
      const value: unknown = await forecastJson(response, controller.signal);
      if (controller.signal.aborted || !isRegionalWeatherCache(value, regionId)) return cached;
      return copyCache(value);
    })();
    const deadline = new Promise<RegionalWeatherCache | null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(cached); }, this.options.timeoutMs ?? 15_000); });
    try { return await Promise.race([work.catch(() => cached), deadline]); }
    finally { clearTimeout(timer); }
  }
}
export { weatherCacheFreshness };
