import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseMetForecast } from '../server/appliance-care-api/src/weather/forecast.mjs';
import { weatherCacheRevision } from '../server/appliance-care-api/src/weather/regional-store.mjs';
const data = JSON.parse(readFileSync(new URL('../server/appliance-care-api/src/weather/municipalities-data.json', import.meta.url), 'utf8'));
const { MetServerForecastProvider } = await import('../src/features/weather/met-server-provider.ts');
const { searchJapaneseMunicipalities, municipalityWeatherLocation, municipalityById } = await import('../src/features/weather/municipality-search.ts');
const start = Date.parse('2026-11-05T00:00:00Z');
const location = municipalityWeatherLocation(searchJapaneseMunicipalities('横浜市')[0], '横浜市');
function cache(regionId, checkedAt) {
  const forecast = parseMetForecast({ properties: { meta: { updated_at: new Date(start).toISOString() }, timeseries: [{ time: new Date(start).toISOString(),
    data: { next_1_hours: { summary: { symbol_code: 'clearsky_day' }, details: { precipitation_amount: 0 } } } }] } });
  const value = { schemaVersion: 1, regionId, checkedAt: new Date(checkedAt).toISOString(), fetchedAt: new Date(checkedAt).toISOString(), expiresAt: null, lastModified: null, forecast };
  return { ...value, revision: weatherCacheRevision(value) };
}
test('forecast caching expires at the boundary and invalidates data from a clock rollback', async () => {
  let clock = start; let calls = 0;
  const provider = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', now: () => clock,
    fetcher: async () => { calls++; return new Response(JSON.stringify(cache(location.municipalityId, clock))); } });
  await provider.refresh(location, null); clock += 15 * 60_000 - 1; await provider.refresh(location, null); assert.equal(calls, 1);
  clock++; await provider.refresh(location, null); assert.equal(calls, 2);
  clock -= 1000; await provider.refresh(location, null); assert.equal(calls, 3);
});
test('changing locations bounds retained public forecast keys instead of retaining every past search', async () => {
  let clock = start; let calls = 0;
  const provider = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', now: () => clock,
    fetcher: async url => { calls++; return new Response(JSON.stringify(cache(new URL(url).pathname.split('/').at(-1), clock))); } });
  for (const row of data.regions.slice(0, 80)) {
    clock += 15 * 60_000; await provider.refresh(municipalityWeatherLocation(municipalityById(row[0]), row[3]), null);
  }
  assert.equal(calls, 80); assert.ok(provider.attempts.size <= 8);
});
for (const count of [1, 100, 500]) test(`${count} simultaneous forecast requests share failure and retry without sharing mutable results`, async () => {
  let clock = start; let calls = 0; let fail = true;
  const provider = new MetServerForecastProvider({ baseUrl: 'https://weather.liflow.invalid', now: () => clock,
    fetcher: async () => { calls++; if (fail) throw new Error('offline'); return new Response(JSON.stringify(cache(location.municipalityId, clock))); } });
  const failed = await Promise.all(Array.from({ length: count }, () => provider.refresh(location, null)));
  assert.ok(failed.every(value => value === null)); assert.equal(calls, 1);
  fail = false; clock += 60_000;
  const results = await Promise.all(Array.from({ length: count }, () => provider.refresh(location, null))); assert.equal(calls, 2);
  results[0].forecast.intervals[0].precipitationMm = 99;
  assert.equal((await provider.refresh(location, null)).forecast.intervals[0].precipitationMm, 0);
  if (count > 1) assert.equal(results[1].forecast.intervals[0].precipitationMm, 0);
  assert.equal(provider.pending.size, 0);
});
for (const [input, expected] of [['おおさかし', '大阪市'], ['ｵｵｻｶｼ', '大阪市'], ['さっぽろし', '札幌市'], ['キョウトシ', '京都市'],
  ['よこはまし', '横浜市'], ['ハママツシ', '浜松市'], ['ちゃたんちょう', '中頭郡北谷町'], ['しんじゅくく', '新宿区'], ['にっこうし', '日光市']]) {
  test(`offline municipality kana search retains ${input} as ${expected} and filters non-municipal results`, () => {
    assert.equal(searchJapaneseMunicipalities(input)[0].name, expected);
  });
}
