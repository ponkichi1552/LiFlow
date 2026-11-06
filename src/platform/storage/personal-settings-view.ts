import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChoreDefinition, HouseholdPlannerSettings, FrequencyMode } from '../../domain/chores/types';
import { compareBuiltInChoreOrder } from '../../domain/chores/catalog';
import { comparePersonalChoreOrder } from '../../domain/chores/personal-catalog.ts';
import { parseCalendarCountColors } from '../../domain/calendar/count-colors';
import { PERSONAL_HOUSEHOLD_ID } from '../../domain/chores/cycle-policy.ts';
import type { PlannerSnapshot } from './repository';

export type PersonalSettingsView = Pick<PlannerSnapshot, 'settings' | 'chores' | 'today' | 'timeZone' | 'sharing'>;
export interface HouseholdSettingsRow {
  frequency_mode: FrequencyMode; rest_days_json: string; heavy_daily_limit: number; normal_daily_limit: number;
  notification_hour: number; notification_minute: number; notifications_enabled: number; setup_completed: number;
  weather_municipality_id: string | null; weather_region: string | null; weather_region_name: string | null;
  weather_latitude: number | null; weather_longitude: number | null; calendar_count_colors_json: string;
  calendar_count_display_mode: string; planner_calendar_signature: string | null;
}
export function householdSettingsFromRow(householdId: string, row: HouseholdSettingsRow): HouseholdPlannerSettings {
  let restDays: number[];
  try { restDays = JSON.parse(row.rest_days_json); } catch { restDays = [6, 7]; }
  return {
    householdId, frequencyMode: row.frequency_mode, restDays, heavyDailyLimit: row.heavy_daily_limit,
    normalDailyLimit: row.normal_daily_limit, notificationHour: row.notification_hour, notificationMinute: row.notification_minute,
    notificationsEnabled: Boolean(row.notifications_enabled), setupCompleted: Boolean(row.setup_completed),
    calendarCountColors: parseCalendarCountColors(row.calendar_count_colors_json), calendarCountDisplayMode: 'dots',
    weatherLocation: row.weather_region !== null && row.weather_region_name !== null && row.weather_latitude !== null && row.weather_longitude !== null
      ? { ...(row.weather_municipality_id ? { municipalityId: row.weather_municipality_id } : {}), region: row.weather_region,
        displayName: row.weather_region_name, latitude: row.weather_latitude, longitude: row.weather_longitude } : undefined,
  };
}

/** Committed settings and definitions only: no history, plan generation, OAuth or shared replay. */
export async function readPersonalSettingsView(database: SQLiteDatabase): Promise<PersonalSettingsView> {
  const read = async (connection: SQLiteDatabase) => {
    // One statement gives settings and enabled flags from the same read snapshot.
    const rows = await connection.getAllAsync<HouseholdSettingsRow & { chore_id: string | null; chore_enabled: number | null; definition_json: string | null }>(
      `SELECT s.*,d.id AS chore_id,d.enabled AS chore_enabled,d.definition_json FROM household_settings s
       LEFT JOIN chore_definitions d ON d.household_id=s.household_id WHERE s.household_id=?`, PERSONAL_HOUSEHOLD_ID);
    if (!rows.length) throw new Error('個人設定を読み込めませんでした。');
    const chores = rows.filter(row => row.chore_id !== null).map(row => ({ ...JSON.parse(row.definition_json!) as ChoreDefinition, enabled: Boolean(row.chore_enabled) }))
      .sort((a, b) => comparePersonalChoreOrder(a, b) || compareBuiltInChoreOrder(a, b));
    return { settings: householdSettingsFromRow(PERSONAL_HOUSEHOLD_ID, rows[0]), chores };
  };
  if (!database.withExclusiveTransactionAsync) return read(database); // Injected non-native ports own their read isolation.
  let value!: PersonalSettingsView;
  // Expo's transaction uses a separate connection. Its deferred, read-only WAL
  // snapshot neither joins an unfinished planner write nor waits for its replay.
  await database.withExclusiveTransactionAsync(async connection => {
    await connection.execAsync('PRAGMA query_only=ON');
    value = await read(connection);
  });
  return value;
}
