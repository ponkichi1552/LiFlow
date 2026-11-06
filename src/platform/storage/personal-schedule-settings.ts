import type { SQLiteDatabase } from 'expo-sqlite';
import type { HouseholdPlannerSettings } from '../../domain/chores/types';
import type { Weekday } from '../../domain/shared/types';

export type PersonalScheduleSettings = Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>;

/** Read the existing private settings without starting, or waiting for, a full plan. */
export async function readPersonalScheduleSettings(database: SQLiteDatabase): Promise<PersonalScheduleSettings> {
  const row = await database.getFirstAsync<{ frequency_mode: PersonalScheduleSettings['frequencyMode']; rest_days_json: string;
    heavy_daily_limit: number; normal_daily_limit: number }>(
    'SELECT frequency_mode,rest_days_json,heavy_daily_limit,normal_daily_limit FROM household_settings WHERE household_id=?', 'local-household');
  if (!row || !['frequent', 'balanced', 'relaxed'].includes(row.frequency_mode)
    || !Number.isSafeInteger(row.heavy_daily_limit) || row.heavy_daily_limit < 0
    || !Number.isSafeInteger(row.normal_daily_limit) || row.normal_daily_limit < 0) throw new Error('本人の家事設定を確認してください。');
  const restDays: unknown = JSON.parse(row.rest_days_json);
  if (!Array.isArray(restDays) || restDays.length > 7 || restDays.some(day => !Number.isSafeInteger(day) || day < 1 || day > 7)) throw new Error('本人の休日設定を確認してください。');
  return { frequencyMode: row.frequency_mode, restDays: restDays as Weekday[], heavyDailyLimit: row.heavy_daily_limit, normalDailyLimit: row.normal_daily_limit };
}
