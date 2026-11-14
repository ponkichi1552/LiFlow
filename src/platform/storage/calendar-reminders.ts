import type { SQLiteDatabase } from 'expo-sqlite';
import { withPlannerDatabaseOperation } from './repository.ts';
import { sharedRepositoryAdapter } from './shared-repository-adapter.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { migrateLocalDatabase } from './migrations.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';

import { checkedReminderMinutes, type CalendarReminderRule, type CalendarReminderSettings } from '../../features/calendar/reminder-preferences.ts';
export * from '../../features/calendar/reminder-preferences.ts';
async function personalReminderDatabase(database: SQLiteDatabase) {
  const schema = await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='households'");
  if (sharedRepositoryAdapter(database) || !schema || !await database.getFirstAsync("SELECT id FROM households WHERE id='local-household'")) throw new Error('通知設定は個人の保存先で開いてください。');
}
const listeners = new WeakMap<SQLiteDatabase, Set<() => void>>();
export function notifyCalendarRemindersChanged(database: SQLiteDatabase) { for (const fn of listeners.get(database) ?? []) try { fn(); } catch { /* Saved preferences remain committed. */ } }
export function subscribeCalendarReminders(database: SQLiteDatabase, fn: () => void) {
  let set = listeners.get(database); if (!set) { set = new Set(); listeners.set(database, set); } set.add(fn);
  return () => { set!.delete(fn); };
}
export function readCalendarReminders(database: SQLiteDatabase): Promise<CalendarReminderSettings> {
  return withPlannerDatabaseOperation(database, async () => {
    await personalReminderDatabase(database); await migrateLocalDatabase(database);
    const row = await database.getFirstAsync<{ enabled: number }>('SELECT enabled FROM calendar_notification_settings WHERE singleton=1');
    const rules = await database.getAllAsync<{ scope: string; event_id: string; anchor_date: LocalDate | ''; minutes: number | null }>('SELECT * FROM calendar_notification_rules');
    return { enabled: row?.enabled === 1, rules: rules.map(row => ({ scope: row.scope, eventId: row.event_id, anchorDate: row.anchor_date || null, minutes: checkedReminderMinutes(row.minutes) })) };
  });
}
/** Called in the same personal-event transaction; reminders never become shared event fields. */
export async function saveCalendarReminderInside(database: SQLiteDatabase, rule: CalendarReminderRule) {
  const minutes = checkedReminderMinutes(rule.minutes);
  if (rule.scope !== 'personal' && !/^group:[a-f0-9]{64}$/u.test(rule.scope) || !/^[A-Za-z0-9._-]{1,192}$/u.test(rule.eventId)) throw new Error('通知の保存先を確認してください。');
  if (rule.anchorDate) parseLocalDate(rule.anchorDate);
  await database.runAsync('INSERT INTO calendar_notification_rules(scope,event_id,anchor_date,minutes) VALUES(?,?,?,?) ON CONFLICT(scope,event_id,anchor_date) DO UPDATE SET minutes=excluded.minutes', rule.scope, rule.eventId, rule.anchorDate ?? '', minutes);
}
export async function saveCalendarReminder(database: SQLiteDatabase, rule: CalendarReminderRule) {
  await withPlannerDatabaseOperation(database, async () => { await personalReminderDatabase(database); await withIsolatedSqliteTransaction(database, tx => saveCalendarReminderInside(tx, rule)); });
  notifyCalendarRemindersChanged(database);
}
export async function setCalendarNotificationsEnabled(database: SQLiteDatabase, enabled: boolean) {
  if (typeof enabled !== 'boolean') throw new Error('通知設定を確認してください。');
  await withPlannerDatabaseOperation(database, async () => { await personalReminderDatabase(database); await migrateLocalDatabase(database); await database.runAsync('UPDATE calendar_notification_settings SET enabled=? WHERE singleton=1', enabled ? 1 : 0); });
  notifyCalendarRemindersChanged(database);
}
