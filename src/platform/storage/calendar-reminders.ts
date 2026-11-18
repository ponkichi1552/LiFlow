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
import type { CalendarReminderUndoProof } from '../../features/calendar/shared-recovery';

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
type StoredRule = { event_id: string; anchor_date: string; minutes: number | null };
function readForkRules(database: SQLiteDatabase, scope: string, source: string, branch: string) {
  return database.getAllAsync<StoredRule>('SELECT event_id,anchor_date,minutes FROM calendar_notification_rules WHERE scope=? AND event_id IN (?,?) ORDER BY event_id,anchor_date', scope, source, branch);
}
type PendingReminderUndo = { branch_id: string; source_id: string; intent_id: string; digest: string; before_json: string; expected_json: string };
const removePendingUndo = (tx: SQLiteDatabase, scope: string, branch: string, intentId: string, digest: string) =>
  tx.runAsync('DELETE FROM calendar_reminder_undos WHERE scope=? AND branch_id=? AND intent_id=? AND digest=?', scope, branch, intentId, digest);

/** Reconcile only rules still matching the interrupted split, using the current device's signed intent result. */
export async function recoverCalendarReminderUndos(database: SQLiteDatabase, scope: string,
  applied: (proof: CalendarReminderUndoProof) => Promise<boolean>, assertCurrent: () => void) {
  const rows = await withPlannerDatabaseOperation(database, async () => {
    assertCurrent();
    if (!await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calendar_reminder_undos'")) return [];
    await personalReminderDatabase(database);
    return database.getAllAsync<PendingReminderUndo>('SELECT branch_id,source_id,intent_id,digest,before_json,expected_json FROM calendar_reminder_undos WHERE scope=?', scope);
  });
  for (const row of rows) {
    const changed = await withPlannerDatabaseOperation(database, async () => {
      assertCurrent();
      return withIsolatedSqliteTransaction(database, async tx => {
        const removed = await removePendingUndo(tx, scope, row.branch_id, row.intent_id, row.digest);
        if (!removed.changes) return false;
        const proof = { intentId: row.intent_id, digest: row.digest, sourceId: row.source_id };
        const signed = await applied(proof); assertCurrent();
        if (!signed) return false;
        const key = (rule: StoredRule) => JSON.stringify([rule.event_id, rule.anchor_date]);
        const byKey = (rules: StoredRule[]) => new Map(rules.map(rule => [key(rule), rule]));
        const current = byKey(await readForkRules(tx, scope, row.source_id, row.branch_id));
        const before = byKey(JSON.parse(row.before_json)), expected = byKey(JSON.parse(row.expected_json));
        let updated = false;
        for (const id of new Set([...before.keys(), ...expected.keys()])) {
          const previous = before.get(id), split = expected.get(id);
          if (previous?.minutes === split?.minutes || current.get(id)?.minutes !== split?.minutes) continue;
          const rule = previous ?? split!;
          if (rule.event_id !== row.source_id && rule.event_id !== row.branch_id) throw new Error('通知の復元元を確認してください。');
          if (previous) await saveCalendarReminderInside(tx, { scope, eventId: previous.event_id, anchorDate: previous.anchor_date as LocalDate || null, minutes: previous.minutes });
          else await tx.runAsync('DELETE FROM calendar_notification_rules WHERE scope=? AND event_id=? AND anchor_date=?', scope, rule.event_id, rule.anchor_date);
          updated = true;
        }
        assertCurrent(); return updated;
      });
    });
    if (changed) notifyCalendarRemindersChanged(database);
  }
}
/** Shared calendar business operations never carry the viewer's private reminder rules. */
export async function forkCalendarReminders(database: SQLiteDatabase, input: { scope: string; sourceId: string; branchId: string; source: CalendarEvent; anchor: LocalDate; next: EventDraft; minutes?: number | null }) {
  const read = (tx: SQLiteDatabase) => readForkRules(tx, input.scope, input.sourceId, input.branchId);
  const receipt = await withPlannerDatabaseOperation(database, async () => {
    await personalReminderDatabase(database);
    return withIsolatedSqliteTransaction(database, async tx => {
      await tx.execAsync(`CREATE TABLE IF NOT EXISTS calendar_reminder_forks (
        scope TEXT NOT NULL, branch_id TEXT NOT NULL, PRIMARY KEY(scope,branch_id)
      ) WITHOUT ROWID`);
      const before = await read(tx);
      const done = await tx.getFirstAsync('SELECT 1 FROM calendar_reminder_forks WHERE scope=? AND branch_id=?', input.scope, input.branchId);
      if (done) return { before, expected: JSON.stringify(before), changed: false };
      const base = { ...calendarFutureBase(input.source, input.anchor), id: input.sourceId, revision: 1 };
      const sourceRules = before.filter(row => row.event_id === input.sourceId);
      const branchAnchors = new Set(before.filter(row => row.event_id === input.branchId).map(row => row.anchor_date));
      const seriesMinutes = input.minutes !== undefined ? input.minutes : sourceRules.find(row => !row.anchor_date)?.minutes;
      if (seriesMinutes !== undefined && !branchAnchors.has('')) {
        await saveCalendarReminderInside(tx, { scope: input.scope, eventId: input.branchId, anchorDate: null, minutes: seriesMinutes });
      }
      const next = { ...input.next, id: input.branchId, revision: 1 };
      for (const row of sourceRules) {
        if (!row.anchor_date || (row.anchor_date < input.anchor && input.anchor !== input.source.startDate)) continue;
        const anchorDate = rebasedCalendarExceptionDate(base, next, row.anchor_date as LocalDate);
        if (!branchAnchors.has(anchorDate)) {
          await saveCalendarReminderInside(tx, { scope: input.scope, eventId: input.branchId, anchorDate, minutes: row.minutes });
        }
        await tx.runAsync('DELETE FROM calendar_notification_rules WHERE scope=? AND event_id=? AND anchor_date=?', input.scope, input.sourceId, row.anchor_date);
      }
      // Receipt and preferences commit together, including a split with no rules to move.
      await tx.runAsync('INSERT INTO calendar_reminder_forks(scope,branch_id) VALUES (?,?)', input.scope, input.branchId);
      const expected = JSON.stringify(await read(tx));
      return { before, expected, changed: expected !== JSON.stringify(before) };
    });
  });
  if (receipt.changed) notifyCalendarRemindersChanged(database);
  const assertCurrent = async (tx: SQLiteDatabase) => { if (JSON.stringify(await read(tx)) !== receipt.expected) throw new Error('通知設定が更新されています。上書きせずに停止しました。'); };
  return {
    assertCurrent: () => withPlannerDatabaseOperation(database, async () => { await personalReminderDatabase(database); await assertCurrent(database); }),
    async undo(commitSharedUndo?: () => Promise<unknown>, proof?: CalendarReminderUndoProof) {
      if (proof && proof.sourceId !== input.sourceId) throw new Error('通知の復元元を確認してください。');
      await withPlannerDatabaseOperation(database, async () => {
        await personalReminderDatabase(database);
        if (receipt.changed && proof) await withIsolatedSqliteTransaction(database, async tx => {
          await assertCurrent(tx);
          await tx.execAsync(`CREATE TABLE IF NOT EXISTS calendar_reminder_undos (
            scope TEXT NOT NULL, branch_id TEXT NOT NULL, source_id TEXT NOT NULL, intent_id TEXT NOT NULL, digest TEXT NOT NULL,
            before_json TEXT NOT NULL, expected_json TEXT NOT NULL, PRIMARY KEY(scope,branch_id)) WITHOUT ROWID`);
          await tx.runAsync('INSERT OR IGNORE INTO calendar_reminder_undos VALUES(?,?,?,?,?,?,?)', input.scope, input.branchId, input.sourceId,
            proof.intentId, proof.digest, JSON.stringify(receipt.before), receipt.expected);
        });
        await withIsolatedSqliteTransaction(database, async tx => {
          if (receipt.changed && proof && !(await removePendingUndo(tx, input.scope, input.branchId, proof.intentId, proof.digest)).changes)
            throw new Error('予定の取り消し状態が変わりました。再度確認してください。');
          await assertCurrent(tx);
          if (receipt.changed) {
            await tx.runAsync('DELETE FROM calendar_notification_rules WHERE scope=? AND event_id IN (?,?)', input.scope, input.sourceId, input.branchId);
            for (const row of receipt.before) await saveCalendarReminderInside(tx, { scope: input.scope, eventId: row.event_id, anchorDate: row.anchor_date as LocalDate || null, minutes: row.minutes });
          }
          // Both SQLite files are local. A refused signature rolls back the staged rules;
          // the persisted proof survives a crash between the two commits.
          await commitSharedUndo?.();
        });
      });
      if (receipt.changed) notifyCalendarRemindersChanged(database);
    },
  };
}
export async function setCalendarNotificationsEnabled(database: SQLiteDatabase, enabled: boolean) {
  if (typeof enabled !== 'boolean') throw new Error('通知設定を確認してください。');
  await withPlannerDatabaseOperation(database, async () => { await personalReminderDatabase(database); await migrateLocalDatabase(database); await database.runAsync('UPDATE calendar_notification_settings SET enabled=? WHERE singleton=1', enabled ? 1 : 0); });
  notifyCalendarRemindersChanged(database);
}
