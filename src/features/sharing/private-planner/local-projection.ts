import type { HouseholdPlannerSettings } from '../../../domain/chores/types';
import { snapshotPrivatePlannerPreferences } from './preferences.ts';
import type { PrivatePlannerPreferences } from './preferences';
import { exactRecord } from '../private-calendar/validation.ts';

export type PlannerRhythm = Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>;
export interface LocalPreferenceProjection {
  expected: PlannerRhythm; value: PlannerRhythm; privateRevision: number; preferences: PrivatePlannerPreferences;
}
export function snapshotPlannerRhythm(raw: unknown): PlannerRhythm {
  exactRecord(raw, ['frequencyMode', 'restDays', 'heavyDailyLimit', 'normalDailyLimit']);
  if (!['frequent', 'balanced', 'relaxed'].includes(String(raw.frequencyMode)) || !Array.isArray(raw.restDays)
    || raw.restDays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(raw.restDays).size !== raw.restDays.length
    || !Number.isInteger(raw.heavyDailyLimit) || Number(raw.heavyDailyLimit) < 1 || Number(raw.heavyDailyLimit) > 10
    || !Number.isInteger(raw.normalDailyLimit) || Number(raw.normalDailyLimit) < 1 || Number(raw.normalDailyLimit) > 20) throw new Error('生活リズムの未反映データを確認してください。');
  return { frequencyMode: raw.frequencyMode as PlannerRhythm['frequencyMode'], restDays: [...raw.restDays], heavyDailyLimit: raw.heavyDailyLimit as number, normalDailyLimit: raw.normalDailyLimit as number };
}
/** Device-only recovery data; it never enters a shared or personal cloud envelope. */
export function snapshotLocalPreferenceProjection(raw: unknown): LocalPreferenceProjection {
  exactRecord(raw, ['expected', 'value', 'privateRevision', 'preferences']);
  if (!Number.isSafeInteger(raw.privateRevision) || Number(raw.privateRevision) < 0) throw new Error('生活リズムの保存位置を確認してください。');
  const value = snapshotPlannerRhythm(raw.value); const preferences = snapshotPrivatePlannerPreferences(raw.preferences as PrivatePlannerPreferences);
  if ([...value.restDays].sort().join() !== preferences.restDays.join()
    || value.heavyDailyLimit !== preferences.loadLimits.heavyDailyLimit
    || value.normalDailyLimit !== preferences.loadLimits.normalDailyLimit) throw new Error('生活リズムの未反映データが一致しません。');
  return { expected: snapshotPlannerRhythm(raw.expected), value, privateRevision: raw.privateRevision as number, preferences };
}
