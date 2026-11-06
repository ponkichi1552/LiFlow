import type { SQLiteDatabase } from 'expo-sqlite';
import type { GoogleTaskCreateIdentity, GoogleTaskCreateIntent } from '../../features/google-sync/task-create-intent';

export async function initializeGoogleTaskCreateIntentsInside(database: SQLiteDatabase) {
  await database.execAsync(`CREATE TABLE IF NOT EXISTS private_google_task_create_intents (
    account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, occurrence_marker TEXT NOT NULL,
    attempt_id TEXT NOT NULL, started_at TEXT NOT NULL, remote_task_id TEXT,
    PRIMARY KEY(account_subject, task_list_id, occurrence_marker));`);
}
function values(identity: GoogleTaskCreateIdentity): [string, string, string] {
  const result: [string, string, string] = [identity.accountSubject, identity.taskListId, identity.occurrenceMarker];
  if (result.some(value => typeof value !== 'string' || !value.length || value.length > 2048 || value.includes('\0'))) {
    throw new Error('Google家事の作成先を確認してください。');
  }
  return result;
}
/** Caller uses its existing serialized personal operation or authorized v2 transaction. */
export async function reserveGoogleTaskCreateInside(database: SQLiteDatabase, intent: GoogleTaskCreateIntent): Promise<GoogleTaskCreateIntent | null> {
  const key = values(intent);
  if (!intent.attemptId || intent.attemptId.length > 512 || !Number.isFinite(Date.parse(intent.startedAt))) throw new Error('Google家事の作成記録を確認してください。');
  const result = await database.runAsync(`INSERT INTO private_google_task_create_intents
    (account_subject,task_list_id,occurrence_marker,attempt_id,started_at) VALUES(?,?,?,?,?)
    ON CONFLICT(account_subject, task_list_id, occurrence_marker) DO NOTHING`, ...key, intent.attemptId, intent.startedAt);
  return result.changes === 1 ? { ...intent } : null;
}
export async function rejectGoogleTaskCreateInside(database: SQLiteDatabase, intent: GoogleTaskCreateIntent): Promise<void> {
  const key = values(intent);
  await database.runAsync(`DELETE FROM private_google_task_create_intents WHERE account_subject=? AND task_list_id=?
    AND occurrence_marker=? AND attempt_id=? AND started_at=? AND remote_task_id IS NULL`, ...key, intent.attemptId, intent.startedAt);
}
export async function linkGoogleTaskCreateInside(database: SQLiteDatabase, identity: GoogleTaskCreateIdentity, taskId: string): Promise<void> {
  const key = values(identity);
  if (!taskId || taskId.length > 2048 || taskId.includes('\0')) throw new Error('Google家事の作成結果を確認してください。');
  await database.runAsync(`INSERT INTO private_google_task_create_intents VALUES(?,?,?,?,?,?)
    ON CONFLICT(account_subject,task_list_id,occurrence_marker) DO UPDATE SET remote_task_id=excluded.remote_task_id`,
  ...key, 'observed', new Date().toISOString(), taskId);
}
export async function deleteGoogleTaskCreateInside(database: SQLiteDatabase, identity: GoogleTaskCreateIdentity, taskId: string): Promise<void> {
  const key = values(identity);
  await database.runAsync(`DELETE FROM private_google_task_create_intents WHERE account_subject=? AND task_list_id=?
    AND occurrence_marker=? AND remote_task_id=?`, ...key, taskId);
}
