import type { AdaptiveLocalPreferences, AdaptiveAllowedBand, AdaptiveDayOverride } from './adaptive-input';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';
import { snapshotDayTypeCapacity } from './day-type-capacity.ts';

export type PersonalPlacementPreferences = Pick<AdaptiveLocalPreferences, 'allowedBands' | 'dayOverrides' | 'maximumMinutes' | 'dayTypes'>;
const record = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => Boolean(value
  && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
const minutes = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
function bands(values: unknown): AdaptiveAllowedBand[] {
  if (!Array.isArray(values) || values.length > 56) throw new Error('家事の実施可能時間帯を確認してください。');
  const result: AdaptiveAllowedBand[] = [];
  const sorted = values.map(value => {
    if (!record(value, ['startMinute', 'endMinute']) || !Number.isSafeInteger(value.startMinute) || !Number.isSafeInteger(value.endMinute)
      || Number(value.startMinute) < 0 || Number(value.endMinute) > 1440 || Number(value.startMinute) >= Number(value.endMinute)) throw new Error('開始より後の終了時刻を設定してください。');
    return { startMinute: Number(value.startMinute), endMinute: Number(value.endMinute) };
  }).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  for (const band of sorted) {
    const prior = result.at(-1);
    if (prior && band.startMinute <= prior.endMinute) prior.endMinute = Math.max(prior.endMinute, band.endMinute);
    else result.push(band);
  }
  return result;
}

/** Canonical device/private settings; an explicit zero or empty date band is preserved. */
export function snapshotPersonalPlacementPreferences(value: PersonalPlacementPreferences): PersonalPlacementPreferences {
  if (!record(value, ['allowedBands', 'dayOverrides'], ['maximumMinutes', 'dayTypes']) || value.maximumMinutes !== undefined && !minutes(value.maximumMinutes)
    || !Array.isArray(value.allowedBands) || value.allowedBands.length > 56 || !Array.isArray(value.dayOverrides) || value.dayOverrides.length > 3660) throw new Error('家事の時間上限・日別設定を確認してください。');
  const weekly = new Map<number, AdaptiveAllowedBand[]>();
  for (const band of value.allowedBands) {
    if (!record(band, ['weekday', 'startMinute', 'endMinute']) || !Number.isInteger(band.weekday) || Number(band.weekday) < 1 || Number(band.weekday) > 7) throw new Error('実施可能時間帯の曜日を確認してください。');
    const day = Number(band.weekday); weekly.set(day, [...weekly.get(day) ?? [], ...bands([{ startMinute: band.startMinute, endMinute: band.endMinute }])]);
  }
  const seen = new Set<string>();
  const dayOverrides: AdaptiveDayOverride[] = value.dayOverrides.map(day => {
    if (!record(day, ['date'], ['holiday', 'maximumMinutes', 'allowedBands']) || typeof day.date !== 'string'
      || seen.has(day.date) || day.holiday !== undefined && typeof day.holiday !== 'boolean'
      || day.maximumMinutes !== undefined && !minutes(day.maximumMinutes)) throw new Error('日別の休日・時間上限を確認してください。');
    const date = day.date as LocalDate; parseLocalDate(date); seen.add(date);
    return { date, ...(day.holiday !== undefined ? { holiday: day.holiday } : {}),
      ...(day.maximumMinutes !== undefined ? { maximumMinutes: Number(day.maximumMinutes) } : {}),
      ...(day.allowedBands !== undefined ? { allowedBands: bands(day.allowedBands) } : {}) };
  }).filter(day => Object.keys(day).length > 1).sort((a, b) => a.date.localeCompare(b.date));
  return { allowedBands: [...weekly].sort(([a], [b]) => a - b).flatMap(([weekday, values]) => bands(values)
    .map(band => ({ weekday: weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7, ...band }))), dayOverrides,
    ...(value.maximumMinutes !== undefined ? { maximumMinutes: value.maximumMinutes } : {}),
    ...(value.dayTypes !== undefined ? { dayTypes: snapshotDayTypeCapacity(value.dayTypes) } : {}) };
}
