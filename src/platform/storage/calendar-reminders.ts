import type { SQLiteDatabase } from 'expo-sqlite';
import { withPlannerDatabaseOperation } from './repository.ts';
import { sharedRepositoryAdapter } from './shared-repository-adapter.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { migrateLocalDatabase } from './migrations.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';
import type { CalendarEvent, EventDraft } from '../../domain/calendar/events';
import { calendarFutureBase } from '../../domain/calendar/future-series.ts';
import { rebasedCalendarExceptionDate } from '../../domain/calendar/exception-slots.ts';

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
/** Shared calendar business operations never carry the viewer's private reminder rules. */
export async function forkCalendarReminders(database: SQLiteDatabase, input: { scope: string; sourceId: string; branchId: string; source: CalendarEvent; anchor: LocalDate; next: EventDraft; minutes?: number | null }) {
  const read = (tx: SQLiteDatabase) => tx.getAllAsync<{ event_id: string; anchor_date: string; minutes: number | null }>('SELECT event_id,anchor_date,minutes FROM calendar_notification_rules WHERE scope=? AND event_id IN (?,?) ORDER BY event_id,anchor_date', input.scope, input.sourceId, input.branchId);
  const receipt = await withPlannerDatabaseOperation(database, async () => {
    await personalReminderDatabase(database);
    return withIsolatedSqliteTransaction(database, async tx => {
      const before = await read(tx);
      if (before.some(row => row.event_id === input.branchId)) return { before, expected: JSON.stringify(before), changed: false };
      const base = { ...calendarFutureBase(input.source, input.anchor), id: input.sourceId, revision: 1 };
      for (const row of before) {
        if (!row.anchor_date) await saveCalendarReminderInside(tx, { scope: input.scope, eventId: input.branchId, anchorDate: null, minutes: row.minutes });
        else if (row.anchor_date >= input.anchor || input.anchor === input.source.startDate) {
          const anchorDate = rebasedCalendarExceptionDate(base, { ...input.next, id: input.branchId, revision: 1 }, row.anchor_date as LocalDate);
          await saveCalendarReminderInside(tx, { scope: input.scope, eventId: input.branchId, anchorDate, minutes: row.minutes });
          await tx.runAsync('DELETE FROM calendar_notification_rules WHERE scope=? AND event_id=? AND anchor_date=?', input.scope, input.sourceId, row.anchor_date);
        }
      }
      if (input.minutes !== undefined) await saveCalendarReminderInside(tx, { scope: input.scope, eventId: input.branchId, anchorDate: null, minutes: input.minutes });
      return { before, expected: JSON.stringify(await read(tx)), changed: true };
    });
  });
  notifyCalendarRemindersChanged(database);
  const assertCurrent = async (tx: SQLiteDatabase) => { if (JSON.stringify(await read(tx)) !== receipt.expected) throw new Error('通知設定が更新されています。上書きせずに停止しました。'); };
  return {
    assertCurrent: () => withPlannerDatabaseOperation(database, async () => { await personalReminderDatabase(database); await assertCurrent(database); }),
    async undo() {
      if (!receipt.changed) return;
      await withPlannerDatabaseOperation(database, async () => { await personalReminderDatabase(database); await withIsolatedSqliteTransaction(database, async tx => {
        await assertCurrent(tx); await tx.runAsync('DELETE FROM calendar_notification_rules WHERE scope=? AND event_id IN (?,?)', input.scope, input.sourceId, input.branchId);
        for (const row of receipt.before) await saveCalendarReminderInside(tx, { scope: input.scope, eventId: row.event_id, anchorDate: row.anchor_date as LocalDate || null, minutes: row.minutes });
      }); }); notifyCalendarRemindersChanged(database);
    },
  };
}
export async function setCalendarNotificationsEnabled(database: SQLiteDatabase, enabled: boolean) {
  if (typeof enabled !== 'boolean') throw new Error('通知設定を確認してください。');
  await withPlannerDatabaseOperation(database, async () => { await personalReminderDatabase(database); await migrateLocalDatabase(database); await database.runAsync('UPDATE calendar_notification_settings SET enabled=? WHERE singleton=1', enabled ? 1 : 0); });
  notifyCalendarRemindersChanged(database);
}
