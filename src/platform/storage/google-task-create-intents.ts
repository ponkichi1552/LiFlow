import type { SQLiteDatabase } from 'expo-sqlite';
import type { GoogleTaskCreateIdentity, GoogleTaskCreateIntent, GoogleTaskCreateJournal, GoogleTaskCreateResult } from '../../features/google-sync/task-create-intent';

export async function initializeGoogleTaskCreateIntentsInside(database: SQLiteDatabase) {
  await database.execAsync(`CREATE TABLE IF NOT EXISTS private_google_task_create_intents (
    account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, occurrence_marker TEXT NOT NULL,
    attempt_id TEXT NOT NULL, started_at TEXT NOT NULL, remote_task_id TEXT,
    PRIMARY KEY(account_subject, task_list_id, occurrence_marker));
    CREATE TABLE IF NOT EXISTS private_google_task_create_results (
      account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, occurrence_marker TEXT NOT NULL,
      attempt_id TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(account_subject, task_list_id, occurrence_marker, attempt_id));`);
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
/** One HTTP chunk reserves atomically; the aligned result grants only newly inserted attempts. */
export async function reserveGoogleTaskCreatesInside(database: SQLiteDatabase, intents: readonly GoogleTaskCreateIntent[]): Promise<(GoogleTaskCreateIntent | null)[]> {
  if (!intents.length || intents.length > 100) throw new Error('Google家事は100件以内に分けて送信してください。');
  const captured = intents.map(intent => {
    const key = values(intent);
    if (typeof intent.attemptId !== 'string' || !intent.attemptId || intent.attemptId.length > 512 || !Number.isFinite(Date.parse(intent.startedAt))) throw new Error('Google家事の作成記録を確認してください。');
    return [...key, intent.attemptId, intent.startedAt];
  });
  // RETURNING provides the actual winners, including repeated identities in
  // this input. It never grants an earlier, unresolved attempt another POST.
  const rows = await database.getAllAsync<{ account_subject: string; task_list_id: string; occurrence_marker: string; attempt_id: string; started_at: string }>(
    `INSERT INTO private_google_task_create_intents(account_subject,task_list_id,occurrence_marker,attempt_id,started_at)
      VALUES${captured.map(() => '(?,?,?,?,?)').join(',')} ON CONFLICT(account_subject,task_list_id,occurrence_marker) DO NOTHING
      RETURNING account_subject,task_list_id,occurrence_marker,attempt_id,started_at`, ...captured.flat());
  const inserted = new Set(rows.map(row => JSON.stringify([row.account_subject,row.task_list_id,row.occurrence_marker,row.attempt_id,row.started_at])));
  return intents.map((intent, index) => inserted.delete(JSON.stringify(captured[index])) ? { ...intent } : null);
}
export async function rejectGoogleTaskCreateInside(database: SQLiteDatabase, intent: GoogleTaskCreateIntent): Promise<void> {
  return rejectGoogleTaskCreatesInside(database, [intent]);
}
/** Exact attempt fencing also applies to a batch; linked/newer reservations survive. */
export async function rejectGoogleTaskCreatesInside(database: SQLiteDatabase, intents: readonly GoogleTaskCreateIntent[]): Promise<void> {
  const rows = intents.map(intent => [...values(intent), intent.attemptId, intent.startedAt]);
  for (let offset = 0; offset < rows.length; offset += 100) {
    const page = rows.slice(offset, offset + 100);
    await database.runAsync(`DELETE FROM private_google_task_create_intents WHERE remote_task_id IS NULL AND
      (account_subject,task_list_id,occurrence_marker,attempt_id,started_at) IN (VALUES ${page.map(() => '(?,?,?,?,?)').join(',')})`, ...page.flat());
  }
}
export async function linkGoogleTaskCreateInside(database: SQLiteDatabase, identity: GoogleTaskCreateIdentity, taskId: string, intent?: GoogleTaskCreateIntent): Promise<void> {
  const key = values(identity);
  if (!taskId || taskId.length > 2048 || taskId.includes('\0')) throw new Error('Google家事の作成結果を確認してください。');
  const previous = await readGoogleTaskCreateInside(database, identity);
  if (intent && (!previous || previous.intent.attemptId !== intent.attemptId || previous.intent.startedAt !== intent.startedAt)
    || previous?.taskId && previous.taskId !== taskId) throw new Error('Google家事の作成試行が変わりました。');
  await database.runAsync(`INSERT INTO private_google_task_create_intents VALUES(?,?,?,?,?,?)
    ON CONFLICT(account_subject,task_list_id,occurrence_marker) DO UPDATE SET remote_task_id=excluded.remote_task_id`,
  ...key, 'observed', new Date().toISOString(), taskId);
}
export async function readGoogleTaskCreateInside(database: SQLiteDatabase, identity: GoogleTaskCreateIdentity) {
  const row = await database.getFirstAsync<{ attempt_id: string; started_at: string; remote_task_id: string | null }>(
    'SELECT attempt_id,started_at,remote_task_id FROM private_google_task_create_intents WHERE account_subject=? AND task_list_id=? AND occurrence_marker=?', ...values(identity));
  return row ? { intent: { ...identity, attemptId: row.attempt_id, startedAt: row.started_at }, taskId: row.remote_task_id } : null;
}

/** One authorized transaction persists all known HTTP outcomes before any Cloud
 * acknowledgement or business-link write can fail. Unknown outcomes stay reserved. */
export function createGoogleTaskCreateJournal(transaction: <T>(work: (database: SQLiteDatabase) => Promise<T>) => Promise<T>,
  makeId: () => string, now: () => Date): GoogleTaskCreateJournal {
  const rejectBatch = (intents: readonly GoogleTaskCreateIntent[]) => transaction(async database => {
    await rejectGoogleTaskCreatesInside(database, intents);
  });
  return {
    reserve: identity => transaction(database => reserveGoogleTaskCreateInside(database, { ...identity, attemptId: makeId(), startedAt: now().toISOString() })),
    reserveBatch: (identities, beforeCommit) => {
      const intents = identities.map(identity => ({ ...identity, attemptId: makeId(), startedAt: now().toISOString() }));
      return transaction(async database => {
        beforeCommit?.(); const result = await reserveGoogleTaskCreatesInside(database, intents); beforeCommit?.(); return result;
      });
    },
    reject: intent => rejectBatch([intent]), rejectBatch,
    read: identity => transaction(database => readGoogleTaskCreateInside(database, identity)),
    linked: (identity, taskId, intent) => transaction(database => linkGoogleTaskCreateInside(database, identity, taskId, intent)),
    deleted: (identity, taskId) => transaction(database => deleteGoogleTaskCreateInside(database, identity, taskId)),
    received: results => transaction(async database => {
      if (!results.length || results.length > 100) throw new Error('Google家事は100件以内に分けて記録してください。');
      const keys = results.map(result => values(result.intent));
      const rows = await database.getAllAsync<{ account_subject: string; task_list_id: string; occurrence_marker: string;
        attempt_id: string; started_at: string; result_json: string | null }>(`SELECT i.*,r.result_json
        FROM private_google_task_create_intents i LEFT JOIN private_google_task_create_results r
          ON r.account_subject=i.account_subject AND r.task_list_id=i.task_list_id AND r.occurrence_marker=i.occurrence_marker AND r.attempt_id=i.attempt_id
        WHERE (i.account_subject,i.task_list_id,i.occurrence_marker) IN (VALUES ${keys.map(() => '(?,?,?)').join(',')})`, ...keys.flat());
      const storedByKey = new Map(rows.map(row => [JSON.stringify([row.account_subject,row.task_list_id,row.occurrence_marker]),row]));
      const payloads: string[] = [];
      for (const result of results) {
        const stored = storedByKey.get(JSON.stringify(values(result.intent)));
        if (!stored || stored.attempt_id !== result.intent.attemptId || stored.started_at !== result.intent.startedAt
          || !['created', 'rejected'].includes(result.kind)
          || result.kind === 'created' && (!result.taskId || typeof result.taskId !== 'string' || result.taskId.length > 2048 || result.taskId.includes('\0'))) throw new Error('Google家事の受信結果が作成試行と一致しません。');
        const payload = JSON.stringify(result);
        if (stored.result_json && stored.result_json !== payload) throw new Error('同じGoogle家事の作成結果が異なります。');
        stored.result_json = payload; payloads.push(payload);
      }
      await database.runAsync(`INSERT INTO private_google_task_create_results VALUES${results.map(() => '(?,?,?,?,?)').join(',')} ON CONFLICT DO NOTHING`,
        ...results.flatMap((result,index) => [...keys[index],result.intent.attemptId,payloads[index]]));
    }),
    pending: scope => transaction(async database => {
      const rows = await database.getAllAsync<{ result_json: string }>(`SELECT result_json FROM private_google_task_create_results
        WHERE account_subject=? AND task_list_id=? ORDER BY rowid LIMIT 100`, scope.accountSubject, scope.taskListId);
      return rows.map(row => {
        const result = JSON.parse(row.result_json) as GoogleTaskCreateResult;
        values(result.intent);
        if (result.intent.accountSubject !== scope.accountSubject || result.intent.taskListId !== scope.taskListId
          || !['created', 'rejected'].includes(result.kind)) throw new Error('Google家事の受信記録を確認してください。');
        return result;
      });
    }),
    settled: results => transaction(async database => {
      for (let offset = 0; offset < results.length; offset += 100) {
        const batch = results.slice(offset, offset + 100);
        await database.runAsync(`DELETE FROM private_google_task_create_results WHERE
          (account_subject,task_list_id,occurrence_marker,attempt_id,result_json) IN (VALUES ${batch.map(() => '(?,?,?,?,?)').join(',')})`,
        ...batch.flatMap(result => [...values(result.intent), result.intent.attemptId, JSON.stringify(result)]));
      }
    }),
  };
}
export async function deleteGoogleTaskCreateInside(database: SQLiteDatabase, identity: GoogleTaskCreateIdentity, taskId: string): Promise<void> {
  const key = values(identity);
  await database.runAsync(`DELETE FROM private_google_task_create_intents WHERE account_subject=? AND task_list_id=?
    AND occurrence_marker=? AND remote_task_id=?`, ...key, taskId);
}
