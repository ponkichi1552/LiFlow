import type { SQLiteDatabase } from 'expo-sqlite';
import type { GoogleTaskStatus } from '../../features/google-sync/contracts.ts';

/** Caller supplies the transaction and revision; completion storage and Google queue staging stay atomic. */
export async function stagePendingGoogleTaskStatus(database: SQLiteDatabase, scheduleEntryId: string, status: GoogleTaskStatus, revision: string): Promise<void> {
  await database.runAsync('UPDATE google_task_links SET pending_status = ?, pending_status_revision = ? WHERE schedule_entry_id = ?', status, revision, scheduleEntryId);
  // Account archives retain provider identities, not a frozen copy of the user's
  // completion state. Stage the same new operation there, even when the active
  // account has not created its own mapping yet. Caller owns the transaction.
  if (await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_google_account_archive_rows'")) {
    await database.runAsync(`UPDATE personal_google_account_archive_rows
      SET value_json=json_set(value_json,'$.pending_status',?,'$.pending_status_revision',?)
      WHERE table_name='google_task_links' AND json_extract(value_json,'$.schedule_entry_id')=?`, status, revision, scheduleEntryId);
  }
}
