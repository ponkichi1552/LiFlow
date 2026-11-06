import type { LocalDate } from '../../shared/types';
import { addDays, parseLocalDate } from '../local-date.ts';

export type ClothingSeasonalWork = 'winterStorage' | 'summerStorage';
export type ClothingRegion = 'nationalFallback' | 'hokkaido' | 'tohoku' | 'eastPacific' | 'eastInland' | 'southwest' | 'okinawa' | 'amami';
export const CLOTHING_SEASONAL_TABLE_VERSION = 'clothing-storage-2026-11-04';
const table: Record<ClothingRegion, { warm: string; cold: string; scope: string; sources: readonly string[] }> = {
  nationalFallback: { warm: '05-15', cold: '10-15', scope: '地域未設定・判定不能時の全国代替初期値', sources: [] },
  hokkaido: { warm: '05-15', cold: '09-25', scope: '北海道の春5月・秋9月下旬の代表日',
    sources: ['https://livejapan.com/ja/in-hokkaido/in-pref-hokkaido/in-sapporo_chitose/article-a1000111/', 'https://www.irisohyama.co.jp/plusoneday/lifestyle/375'] },
  tohoku: { warm: '05-15', cold: '10-01', scope: '東北6県の公表時期からの代表日', sources: ['https://stylehaus.jp/articles/29564/'] },
  eastPacific: { warm: '05-01', cold: '10-15', scope: '関東・東海・近畿の広域目安', sources: ['https://stylehaus.jp/articles/29564/', 'https://www.naturias.jp/column/change-of-clothes/'] },
  eastInland: { warm: '05-01', cold: '10-15', scope: '甲信・北陸への東日本広域代替値', sources: ['https://www.naturias.jp/column/change-of-clothes/'] },
  southwest: { warm: '04-15', cold: '10-25', scope: '中国・四国・九州の奄美以外の広域目安', sources: ['https://stylehaus.jp/articles/29564/'] },
  okinawa: { warm: '03-25', cold: '11-01', scope: '那覇の春の時期を県全域へ代替し、秋の資料と組み合わせた初期値',
    sources: ['https://familycleaning.jp/koromogae-march-timing-15degree-rule/', 'https://dime.jp/genre/913003/'] },
  amami: { warm: '04-15', cold: '11-01', scope: '春は九州、秋は沖縄の広域代替値', sources: ['https://stylehaus.jp/articles/29564/', 'https://dime.jp/genre/913003/'] },
};

/** Use verified structured location identity only, never a fuzzy address or device GPS inference. */
export function clothingRegionFor(location: { countryCode?: string; prefectureCode?: string; islandGroup?: 'amami' | 'mainland' | 'nonAmami' } | null | undefined): ClothingRegion {
  if (!location || location.countryCode !== 'JP' || !/^JP-(?:0[1-9]|[1-3]\d|4[0-7])$/u.test(location.prefectureCode ?? '')) return 'nationalFallback';
  const code = Number(location.prefectureCode!.slice(3));
  if (code === 1) return 'hokkaido'; if (code <= 7) return 'tohoku';
  if (code <= 14 || code >= 21 && code <= 30) return 'eastPacific';
  if (code <= 20) return 'eastInland'; if (code === 47) return 'okinawa';
  if (code === 46) return location.islandGroup === 'amami' ? 'amami' : location.islandGroup === 'mainland' || location.islandGroup === 'nonAmami' ? 'southwest' : 'nationalFallback';
  return 'southwest';
}
export function clothingFixedDay(region: ClothingRegion, work: ClothingSeasonalWork, year: number) {
  if (!Object.hasOwn(table, region) || !['winterStorage', 'summerStorage'].includes(work)
    || !Number.isSafeInteger(year) || year < 1 || year > 9999) throw new Error('季節家事の日付表を確認してください。');
  const row = table[region]; const special = region === 'amami' && work === 'summerStorage' && year === 2026;
  const date = `${String(year).padStart(4, '0')}-${special ? '11-15' : work === 'winterStorage' ? row.warm : row.cold}` as LocalDate;
  parseLocalDate(date);
  return { date, region, work, year, version: CLOTHING_SEASONAL_TABLE_VERSION, verifiedOn: '2026-11-04' as LocalDate,
    scope: special ? '2026年の奄美限定の年別初期値。翌年へ持ち越さない。' : row.scope,
    editorialApproximation: true, sources: special ? ['https://weathernews.jp/news/202609/010271/'] : [...row.sources] };
}
export interface PersonalSeasonalRound {
  id: string; choreId: string; work: ClothingSeasonalWork; year: number; season: 'spring' | 'autumn';
  region: ClothingRegion; date: LocalDate; tableVersion: string;
}
export function personalSeasonalRound(choreId: string, work: ClothingSeasonalWork, year: number, region: ClothingRegion,
  fingerprint: (value: unknown) => string): PersonalSeasonalRound {
  if (!choreId) throw new Error('季節家事の識別子を確認してください。');
  const day = clothingFixedDay(region, work, year); const season = work === 'winterStorage' ? 'spring' : 'autumn';
  return { id: `seasonal-round.${fingerprint(['seasonal-round-v1', choreId, work, year, season])}`, choreId, work, year, season,
    region, date: day.date, tableVersion: day.version };
}
export function nextPersonalSeasonalRound(input: { choreId: string; work: ClothingSeasonalWork; region: ClothingRegion;
  after: LocalDate; inclusive: boolean; fingerprint(value: unknown): string }): PersonalSeasonalRound {
  const year = parseLocalDate(input.after).getUTCFullYear();
  let round = personalSeasonalRound(input.choreId, input.work, year, input.region, input.fingerprint);
  if (round.date < input.after || !input.inclusive && round.date === input.after) round = personalSeasonalRound(input.choreId, input.work, year + 1, input.region, input.fingerprint);
  return round;
}
/** One pending round per meaning. Weather, mode and workload are not arguments to this fixed-date policy. */
export function initializePersonalSeasonalRounds(input: { choreId: string; region: ClothingRegion; today: LocalDate; fingerprint(value: unknown): string }) {
  return (['winterStorage', 'summerStorage'] as const).map(work => nextPersonalSeasonalRound({ ...input, work, after: input.today, inclusive: true }));
}
export function updatePersonalSeasonalRegion(round: PersonalSeasonalRound, input: { region: ClothingRegion; today: LocalDate;
  completedRoundIds: ReadonlySet<string>; fingerprint(value: unknown): string }): PersonalSeasonalRound {
  if (input.completedRoundIds.has(round.id) || round.date <= addDays(input.today, 1)) return round;
  const next = personalSeasonalRound(round.choreId, round.work, round.year, input.region, input.fingerprint);
  return next.date >= input.today ? next : round;
}
/** Closing an old spring job advances that meaning alone; autumn is never silently completed with it. */
export function completePersonalSeasonalRound(round: PersonalSeasonalRound, input: { completedDate: LocalDate; region: ClothingRegion; fingerprint(value: unknown): string }) {
  const after = input.completedDate > round.date ? input.completedDate : round.date;
  return nextPersonalSeasonalRound({ choreId: round.choreId, work: round.work, region: input.region, after, inclusive: false, fingerprint: input.fingerprint });
}
