import type { SQLiteDatabase } from 'expo-sqlite';
import { readPersonalGoogleCalendarControl } from '../../platform/storage/personal-google-calendar.ts';
import { listPersonalGoogleItems } from '../../platform/storage/personal-google-store.ts';
import { withPlannerDatabaseOperation } from '../../platform/storage/repository.ts';
import { withIsolatedSqliteTransaction } from '../../platform/storage/isolated-transaction.ts';

/** OS wakeups inspect local durable work. Elapsed time alone never causes a remote calendar scan. */
export async function personalCalendarHasPendingWork(database: SQLiteDatabase, now = Date.now()): Promise<boolean> {
  const control = await readPersonalGoogleCalendarControl(database);
  if (!control.enabled || !control.subject || control.authRequired || control.retryAt > now) return false;
  if (!control.lastSyncAt || control.error) return true;
  return withPlannerDatabaseOperation(database, () => withIsolatedSqliteTransaction(database, async transaction => {
    const progress = await transaction.getFirstAsync('SELECT 1 FROM calendar_google_progress WHERE subject=? LIMIT 1', control.subject);
    if (progress) return true;
    const inbox = await transaction.getFirstAsync('SELECT 1 FROM calendar_google_inbox WHERE subject=? AND dirty=1 LIMIT 1', control.subject);
    if (inbox) return true;
    const items = await listPersonalGoogleItems(transaction, control);
    return items.some(item => !item.link?.read_only && !item.link?.conflict_json
      && (Boolean(item.link?.pending_json) || item.link?.local_revision !== item.revision));
  }));
}
