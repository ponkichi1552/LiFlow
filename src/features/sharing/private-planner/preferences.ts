import type { LocalDate, Weekday } from '../../../domain/shared/types.ts';
import { addDays, parseLocalDate, weekdayOf, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { isSharedTimeZone } from '../group-clock.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { v2WallTimeCandidates } from '../v2/local-time.ts';
import { mergeInstantRanges } from '../v2/private-availability.ts';
import type { InstantRange } from '../v2/model.ts';
import type { AdaptiveDayOverride } from '../../planner/adaptive-input';
import { snapshotPersonalPlacementPreferences } from '../../planner/personal-placement-preferences.ts';

export interface PrivateAllowedBand { weekday: Weekday; startMinute: number; endMinute: number }
export interface PrivatePlannerPreferences {
  timeZone: string; restDays: Weekday[];
  loadLimits: { heavyDailyLimit: number; normalDailyLimit: number };
  allowedBands: PrivateAllowedBand[];
  maximumMinutes?: number;
  dayOverrides?: AdaptiveDayOverride[];
}
export interface SavedPrivatePlannerPreferences extends PrivatePlannerPreferences {
  schemaVersion: 1; ownerUserId: string; revision: number;
}
const fields = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(','));
const weekday = (value: unknown): value is Weekday => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 7;
const preferenceFields = ['timeZone', 'restDays', 'loadLimits', 'allowedBands'];
const optionalFields = ['maximumMinutes', 'dayOverrides'];
const preferenceRecord = (value: unknown, required: string[]) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optionalFields].includes(key)));

/** Select only private preference fields, retaining optional fields across old editor/rhythm paths. */
export function privatePlannerPreferenceValues(value: PrivatePlannerPreferences): PrivatePlannerPreferences {
  return snapshotPrivatePlannerPreferences({ timeZone: value.timeZone, restDays: value.restDays, loadLimits: value.loadLimits, allowedBands: value.allowedBands,
    ...(value.maximumMinutes !== undefined ? { maximumMinutes: value.maximumMinutes } : {}), ...(value.dayOverrides !== undefined ? { dayOverrides: value.dayOverrides } : {}) });
}

/** Private input only. No group operation, shared hash, token or Google account belongs here. */
export function snapshotPrivatePlannerPreferences(value: PrivatePlannerPreferences): PrivatePlannerPreferences {
  if (!preferenceRecord(value, preferenceFields) || !isSharedTimeZone(value.timeZone)
    || !Array.isArray(value.restDays) || value.restDays.length > 7 || !value.restDays.every(weekday)
    || !fields(value.loadLimits, ['heavyDailyLimit', 'normalDailyLimit'])
    || !Number.isSafeInteger(value.loadLimits.heavyDailyLimit) || Number(value.loadLimits.heavyDailyLimit) < 1 || Number(value.loadLimits.heavyDailyLimit) > 10
    || !Number.isSafeInteger(value.loadLimits.normalDailyLimit) || Number(value.loadLimits.normalDailyLimit) < 1 || Number(value.loadLimits.normalDailyLimit) > 20
    || !Array.isArray(value.allowedBands) || value.allowedBands.length > 56
    || value.dayOverrides !== undefined && !Array.isArray(value.dayOverrides)) throw new Error('本人の休日・実施可能時間帯を確認してください。');
  const bands = value.allowedBands.map(band => {
    if (!fields(band, ['weekday', 'startMinute', 'endMinute']) || !weekday(band.weekday)
      || !Number.isInteger(band.startMinute) || !Number.isInteger(band.endMinute)
      || Number(band.startMinute) < 0 || Number(band.endMinute) > 1440 || Number(band.startMinute) >= Number(band.endMinute)) throw new Error('開始より後の終了時刻を設定してください。日をまたぐ時間帯は日ごとに分けてください。');
    return { weekday: band.weekday, startMinute: Number(band.startMinute), endMinute: Number(band.endMinute) };
  }).sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  const merged: PrivateAllowedBand[] = [];
  for (const band of bands) {
    const prior = merged.at(-1);
    if (prior && prior.weekday === band.weekday && band.startMinute <= prior.endMinute) prior.endMinute = Math.max(prior.endMinute, band.endMinute);
    else merged.push({ ...band });
  }
  const placement = snapshotPersonalPlacementPreferences({ allowedBands: merged, dayOverrides: value.dayOverrides ?? [],
    ...(value.maximumMinutes !== undefined ? { maximumMinutes: value.maximumMinutes } : {}) });
  const result: PrivatePlannerPreferences = { timeZone: value.timeZone, restDays: [...new Set(value.restDays)].sort((a, b) => a - b),
    loadLimits: { heavyDailyLimit: Number(value.loadLimits.heavyDailyLimit), normalDailyLimit: Number(value.loadLimits.normalDailyLimit) }, allowedBands: merged,
    ...(placement.maximumMinutes !== undefined ? { maximumMinutes: placement.maximumMinutes } : {}),
    ...(placement.dayOverrides.length ? { dayOverrides: [...placement.dayOverrides] } : {}) };
  // Accepted local input must fit the existing authenticated envelope as well.
  if (new TextEncoder().encode(JSON.stringify(result)).length > 9000) throw new Error('日別設定が多すぎます。不要な日付を削除してください。');
  return result;
}

export function snapshotSavedPrivatePlannerPreferences(value: SavedPrivatePlannerPreferences, ownerUserId: string): SavedPrivatePlannerPreferences {
  assertSharedIdentifier(ownerUserId);
  if (!preferenceRecord(value, ['schemaVersion', 'ownerUserId', 'revision', ...preferenceFields])
    || value.schemaVersion !== 1 || value.ownerUserId !== ownerUserId || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('本人の保存済み設定を確認できません。');
  return { schemaVersion: 1, ownerUserId, revision: value.revision,
    ...privatePlannerPreferenceValues(value) };
}

/** Empty means no permission. Gap/fold boundaries remain unresolved instead of choosing an instant. */
export function privatePlannerAllowedWindows(value: PrivatePlannerPreferences, from: LocalDate, through: LocalDate): {
  windows: InstantRange[]; unresolvedDates: LocalDate[];
} {
  const own = snapshotPrivatePlannerPreferences(value); parseLocalDate(from); parseLocalDate(through);
  if (from > through || daysBetween(from, through) > 366) throw new Error('時間帯を確認する期間を確認してください。');
  const windows: InstantRange[] = []; const unresolvedDates: LocalDate[] = [];
  for (let date = from; date <= through; date = addDays(date, 1)) {
    const day = weekdayOf(date); const selected = own.dayOverrides?.find(row => row.date === date)?.allowedBands ?? own.allowedBands.filter(band => band.weekday === day); const daily: InstantRange[] = [];
    let unresolved = false;
    for (const band of selected) {
      const at = (minute: number) => v2WallTimeCandidates({ date: minute === 1440 ? addDays(date, 1) : date,
        hour: minute === 1440 ? 0 : Math.floor(minute / 60), minute: minute % 60, timeZone: own.timeZone });
      const start = at(band.startMinute); const end = at(band.endMinute);
      if (start.length !== 1 || end.length !== 1 || start[0] >= end[0]) { unresolved = true; break; }
      daily.push({ start: start[0], end: end[0] });
    }
    if (unresolved) unresolvedDates.push(date); else windows.push(...daily);
  }
  return { windows: mergeInstantRanges(windows), unresolvedDates };
}
