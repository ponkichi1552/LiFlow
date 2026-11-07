import data from '../../../server/appliance-care-api/src/weather/municipalities-data.json';
import type { WeatherLocation } from '../../domain/shared/types';

export interface WeatherRegionCandidate {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  countryCode: 'JP';
  prefectureCode: string;
  islandGroup?: 'amami' | 'nonAmami';
}
export const MUNICIPALITY_DATA_VERSION = data.source.sha256;
type RegionRow = [string, string, string, string, string, string, number, number, 'amami' | 'nonAmami' | null, string, [number, number, number, number]];
const rows = data.regions as RegionRow[];
const prefectures = data.prefectures as Record<string, string[]>;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/gu,
  character => String.fromCharCode(character.charCodeAt(0) - 0x60)).replace(/[\s・,.'’-]/gu, '');
interface IndexedRegion { row: RegionRow; name: string; kana: string; search: string; label: string }
let indexed: IndexedRegion[] | undefined;
let byId: Map<string, RegionRow> | undefined;
function municipalityIndex() {
  return indexed ??= rows.map(row => ({ row, name: normalize(row[3]), kana: normalize(row[4]),
    label: normalize(`${row[3]}, ${row[2]}`),
    search: normalize(`${prefectures[row[1]]?.join(' ') ?? row[2]}${row[3]} ${row[4]} ${row[5]}`) }));
}
function candidate(row: RegionRow): WeatherRegionCandidate {
  return { id: row[0], name: row[3], label: `${row[3]}, ${row[2]}`, latitude: row[6], longitude: row[7],
    countryCode: 'JP', prefectureCode: row[1], ...(row[8] ? { islandGroup: row[8] } : {}) };
}
/** Local, bounded search. No geocoder network request, device GPS or personal data. */
export function searchJapaneseMunicipalities(value: string): WeatherRegionCandidate[] {
  const query = normalize(value.trim());
  if (query.length < 2 || query.length > 120) return [];
  const words = value.trim().split(/[\s,、]+/u).map(normalize).filter(Boolean);
  const rank = (row: IndexedRegion) => row.name === query || row.kana === query ? 0
    : row.name === `${query}市` || row.kana === `${query}し` ? 1
      : row.name.startsWith(query) || row.kana.startsWith(query) ? 2 : 3;
  return municipalityIndex().filter(row => words.every(word => row.search.includes(word))).sort((a, b) => rank(a) - rank(b)
    || a.row[3].length - b.row[3].length || a.row[0].localeCompare(b.row[0])).slice(0, 8).map(({ row }) => candidate(row));
}
export function municipalityById(id: string | null | undefined): WeatherRegionCandidate | null {
  if (typeof id !== 'string') return null;
  byId ??= new Map(rows.map(row => [row[0], row]));
  const row = byId.get(id);
  return row ? candidate(row) : null;
}
export function municipalityWeatherLocation(value: WeatherRegionCandidate, region: string): WeatherLocation {
  const known = municipalityById(value.id);
  if (!known) throw new Error('地域を候補から選び直してください。');
  return { municipalityId: known.id, region: region.trim(), displayName: known.label, latitude: known.latitude, longitude: known.longitude };
}
export function normalizeStoredWeatherLocation(location: WeatherLocation): WeatherLocation {
  const region = location.region.trim(); const displayName = location.displayName.trim();
  if (region.length < 2 || region.length > 120 || displayName.length < 2 || displayName.length > 200
    || !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90
    || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) throw new Error('天気を調べる地域を候補から選んでください。');
  const known = resolveWeatherMunicipality(location);
  if (location.municipalityId && !known) throw new Error('地域を候補から選び直してください。');
  return known ? municipalityWeatherLocation(known, region) : { region, displayName,
    latitude: Math.round(location.latitude * 100) / 100, longitude: Math.round(location.longitude * 100) / 100 };
}
/** Old settings never retained a geocoder ID. Upgrade only an exact unique full
 * label with a matching coarse coordinate; ambiguous/free text stays unbound. */
export function resolveWeatherMunicipality(location: WeatherLocation | null | undefined): WeatherRegionCandidate | null {
  if (!location) return null;
  if (location.municipalityId) return municipalityById(location.municipalityId);
  const label = normalize(location.displayName);
  const matches = municipalityIndex().filter(({ row, label: indexedLabel }) => indexedLabel === label
    && location.latitude >= row[10][0] - 0.015 && location.latitude <= row[10][2] + 0.015
    && location.longitude >= row[10][1] - 0.015 && location.longitude <= row[10][3] + 0.015);
  return matches.length === 1 ? candidate(matches[0].row) : null;
}
