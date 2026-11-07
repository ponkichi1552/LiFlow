import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDatabase } from './helpers/sqlite.mjs';
const search = await import('../src/features/weather/municipality-search.ts');
const { clothingRegionFor } = await import('../src/domain/scheduling/adaptive/seasonal.ts');
const repository = await import('../src/platform/storage/repository.ts');
const { readPersonalAdaptiveContextInside } = await import('../src/platform/storage/repository-adaptive.ts');

test('bundled Japanese municipality index is pinned complete and uses four-decimal public representative points', () => {
  const raw = readFileSync(new URL('../server/appliance-care-api/src/weather/municipalities-data.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), '9fde6e50d80b0f6f30c29ffb0e6fc8b1ef3ef987cb2f8efac1d2b80b9ab672f5');
  const data = JSON.parse(raw); assert.equal(data.source.sha256, search.MUNICIPALITY_DATA_VERSION);
  assert.equal(data.regions.length, 1914); assert.equal(new Set(data.regions.map(row => row[0])).size, 1914);
  assert.equal(new Set(data.regions.map(row => row[1])).size, 47);
  for (const row of data.regions) {
    assert.equal(search.municipalityById(row[0]).prefectureCode, row[1]);
    for (const coordinate of row.slice(6, 8)) assert.ok(Math.abs(coordinate * 1e4 - Math.round(coordinate * 1e4)) < 1e-6);
    assert.ok(row[6] >= 20 && row[6] <= 46 && row[7] >= 122 && row[7] <= 154);
  }
});
test('offline municipality search accepts kanji kana romanization and prefecture disambiguation without network', () => {
  for (const value of ['横浜', '横浜市', 'よこはま', 'ヨコハマ', 'yokohama', '神奈川県 横浜市']) {
    assert.equal(search.searchJapaneseMunicipalities(value)[0].name, '横浜市');
  }
  assert.equal(search.searchJapaneseMunicipalities('しずおか')[0].name, '静岡市');
  assert.equal(search.searchJapaneseMunicipalities('東京 新宿')[0].name, '新宿区');
  assert.ok(search.searchJapaneseMunicipalities('府中市').length >= 2);
  assert.equal(search.searchJapaneseMunicipalities('東京都 府中市')[0].prefectureCode, 'JP-13');
  assert.deepEqual(search.searchJapaneseMunicipalities('x'), []); assert.deepEqual(search.searchJapaneseMunicipalities('a'.repeat(121)), []);
  assert.ok(search.searchJapaneseMunicipalities('市').length === 0);
});
test('municipality identity distinguishes the twelve Amami municipalities from other Kagoshima locations', () => {
  const data = JSON.parse(readFileSync(new URL('../server/appliance-care-api/src/weather/municipalities-data.json', import.meta.url)));
  const amami = data.regions.filter(row => row[8] === 'amami'); assert.equal(amami.length, 12);
  for (const row of amami) assert.equal(clothingRegionFor(search.municipalityById(row[0])), 'amami');
  assert.equal(clothingRegionFor(search.searchJapaneseMunicipalities('鹿児島市')[0]), 'southwest');
  assert.equal(clothingRegionFor(search.searchJapaneseMunicipalities('札幌市')[0]), 'hokkaido');
  assert.equal(clothingRegionFor(search.searchJapaneseMunicipalities('那覇市')[0]), 'okinawa');
  assert.equal(clothingRegionFor(search.searchJapaneseMunicipalities('新潟市')[0]), 'eastInland');
});
test('legacy municipality binding requires an exact unique label and coordinate match and rejects forged canonical ids', () => {
  const candidate = search.searchJapaneseMunicipalities('奄美市')[0];
  const legacy = { region: 'あまみ', displayName: candidate.label, latitude: 28.38, longitude: 129.53 };
  assert.equal(search.resolveWeatherMunicipality(legacy).id, candidate.id);
  const yokohama = { region: 'よこはま', displayName: '横浜市, 神奈川県', latitude: 35.44, longitude: 139.64 };
  assert.equal(search.resolveWeatherMunicipality(yokohama).name, '横浜市', 'a different town-derived representative point must not require re-entering the selected city');
  for (const value of [{ ...legacy, displayName: '鹿児島県' }, { ...legacy, latitude: 35 }, { ...legacy, municipalityId: 'forged' }]) {
    assert.equal(search.resolveWeatherMunicipality(value), null);
  }
  assert.throws(() => search.normalizeStoredWeatherLocation({ ...legacy, municipalityId: 'forged' }));
  const normalized = search.normalizeStoredWeatherLocation({ ...legacy, municipalityId: candidate.id, latitude: 35 });
  assert.equal(normalized.latitude, candidate.latitude, 'canonical identity always determines the representative coordinate');
});
test('actual repository preserves the selected municipality through setup saves and seasonal planning without inferring free text', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-05T03:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const selected = search.municipalityWeatherLocation(search.searchJapaneseMunicipalities('奄美市')[0], 'あまみ');
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [6, 7], previousDates: {}, enabledChoreIds: [], weatherLocation: selected });
  assert.deepEqual((await repository.loadPlannerSnapshot(h.database)).settings.weatherLocation, selected);
  const context = () => readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID,
    memberId: repository.LOCAL_MEMBER_ID, now: new Date(), timeZone: 'Asia/Tokyo' });
  assert.equal((await context()).clothingRegion, 'amami');
  const second = search.municipalityWeatherLocation(search.searchJapaneseMunicipalities('札幌市')[0], '札幌');
  await repository.saveWeatherLocation(h.database, second);
  assert.deepEqual((await repository.loadPlannerSnapshot(h.database)).settings.weatherLocation, second);
  assert.equal((await context()).clothingRegion, 'hokkaido');
  await repository.clearWeatherLocation(h.database); assert.equal((await context()).clothingRegion, 'nationalFallback');
});
test('schema 26 to 27 weather migration retains existing settings histories and old unbound location', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  h.connection.exec("UPDATE household_settings SET weather_region='東京',weather_region_name='東京',weather_latitude=35.6,weather_longitude=139.7,heavy_daily_limit=7");
  h.connection.exec('ALTER TABLE household_settings DROP COLUMN weather_municipality_id; DROP TABLE private_weather_cache; PRAGMA user_version=26');
  const { migrateLocalDatabase } = await import('../src/platform/storage/migrations.ts'); await migrateLocalDatabase(h.database);
  const row = h.connection.prepare('SELECT * FROM household_settings').get();
  assert.equal(row.heavy_daily_limit, 7); assert.equal(row.weather_region_name, '東京'); assert.equal(row.weather_municipality_id, null);
  assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version, 29);
  assert.equal(search.resolveWeatherMunicipality({ region: row.weather_region, displayName: row.weather_region_name, latitude: row.weather_latitude, longitude: row.weather_longitude }), null);
});
