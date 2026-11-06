import type { SQLiteDatabase } from 'expo-sqlite';
import { isRegionalWeatherCache } from '../../features/weather/met-server-provider.ts';
import type { RegionalWeatherCache } from '../../features/weather/met-server-provider';

/** Disposable public forecast data only. No user coordinates, history or tokens. */
export async function readRegionalWeatherInside(database: SQLiteDatabase, regionId: string | null | undefined): Promise<RegionalWeatherCache | null> {
  if (!regionId) return null;
  const row = await database.getFirstAsync<{ cache_json: string }>('SELECT cache_json FROM private_weather_cache WHERE region_id=?', regionId);
  if (!row) return null;
  try { const value: unknown = JSON.parse(row.cache_json); return isRegionalWeatherCache(value, regionId) ? value : null; }
  catch { return null; }
}
export async function saveRegionalWeatherInside(database: SQLiteDatabase, value: RegionalWeatherCache): Promise<boolean> {
  if (!isRegionalWeatherCache(value, value.regionId)) throw new Error('天気の応答を確認できませんでした。');
  const prior = await readRegionalWeatherInside(database, value.regionId);
  if (prior?.revision === value.revision) return false;
  if (prior && Date.parse(prior.checkedAt) > Date.parse(value.checkedAt)) return false;
  await database.runAsync(`INSERT INTO private_weather_cache(region_id,revision,cache_json) VALUES(?,?,?)
    ON CONFLICT(region_id) DO UPDATE SET revision=excluded.revision,cache_json=excluded.cache_json`, value.regionId, value.revision, JSON.stringify(value));
  return true;
}
