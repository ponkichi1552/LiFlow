import type { AdaptiveAllowedBand } from './adaptive-input';

export interface DayCapacity { maximumMinutes?: number; allowedBands?: readonly AdaptiveAllowedBand[] }
export interface DayTypeCapacity { workday: DayCapacity; holiday: DayCapacity }
export type DayType = keyof DayTypeCapacity;
const defaults = {
  workday: Object.freeze([Object.freeze({ startMinute: 1140, endMinute: 1260 })]),
  holiday: Object.freeze([Object.freeze({ startMinute: 540, endMinute: 1140 })]),
};
/** User-approved initial hours; date and saved weekly/type overrides take precedence. */
export const defaultDayTypeBands = (kind: DayType): readonly AdaptiveAllowedBand[] => defaults[kind];

/** An omitted band inherits the existing weekday setting; [] explicitly allows no time. */
export function snapshotDayTypeCapacity(value: unknown): DayTypeCapacity {
  const record = (raw: unknown, keys: string[]): raw is Record<string, unknown> => Boolean(raw && typeof raw === 'object'
    && !Array.isArray(raw) && Object.keys(raw).every(key => keys.includes(key)));
  if (!record(value, ['workday', 'holiday']) || !Object.hasOwn(value, 'workday') || !Object.hasOwn(value, 'holiday')) throw new Error('平日・休日の時間設定を確認してください。');
  const copy = (raw: unknown): DayCapacity => {
    if (!record(raw, ['maximumMinutes', 'allowedBands']) || raw.maximumMinutes !== undefined
      && (!Number.isSafeInteger(raw.maximumMinutes) || Number(raw.maximumMinutes) < 0)) throw new Error('合計時間は0以上の分数で入力してください。');
    let allowedBands: AdaptiveAllowedBand[] | undefined;
    if (raw.allowedBands !== undefined) {
      if (!Array.isArray(raw.allowedBands) || raw.allowedBands.length > 8) throw new Error('時間帯は1日8つまで設定できます。');
      const sorted = raw.allowedBands.map(band => {
        if (!record(band, ['startMinute', 'endMinute']) || !Number.isSafeInteger(band.startMinute) || !Number.isSafeInteger(band.endMinute)
          || Number(band.startMinute) < 0 || Number(band.endMinute) > 1440 || Number(band.startMinute) >= Number(band.endMinute)) throw new Error('開始より後の終了時刻を設定してください。');
        return { startMinute: Number(band.startMinute), endMinute: Number(band.endMinute) };
      }).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
      allowedBands = [];
      for (const band of sorted) {
        const prior = allowedBands.at(-1);
        if (prior && band.startMinute <= prior.endMinute) prior.endMinute = Math.max(prior.endMinute, band.endMinute);
        else allowedBands.push(band);
      }
    }
    return { ...(raw.maximumMinutes !== undefined ? { maximumMinutes: Number(raw.maximumMinutes) } : {}), ...(allowedBands !== undefined ? { allowedBands } : {}) };
  };
  return { workday: copy(value.workday), holiday: copy(value.holiday) };
}
