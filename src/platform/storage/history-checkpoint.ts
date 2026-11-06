import type { SQLiteDatabase } from 'expo-sqlite';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';

const pending = new WeakMap<SQLiteDatabase, Promise<unknown>>();
export function checkpointRetainedHistory(database: SQLiteDatabase, groupId: string, digest: string): Promise<{ complete: boolean; busy: number }> {
  assertSharedIdentifier(groupId);
  if (!/^[a-f0-9]{64}$/u.test(digest)) return Promise.reject(new Error('Invalid local history-retention checkpoint'));
  const task = (pending.get(database) ?? Promise.resolve()).then(async () => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS sharing_history_cleanup (
      group_id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL, pending INTEGER NOT NULL,
      busy INTEGER, log_pages INTEGER, checkpointed_pages INTEGER
    )`);
    const saved = await database.getFirstAsync<{ digest: string; pending: number }>('SELECT digest,pending FROM sharing_history_cleanup WHERE group_id=?', groupId);
    if (saved?.digest === digest && saved.pending === 0) return { complete: true, busy: 0 };
    await database.runAsync(`INSERT INTO sharing_history_cleanup(group_id,digest,pending) VALUES(?,?,1)
      ON CONFLICT(group_id) DO UPDATE SET digest=excluded.digest,pending=1 WHERE digest<>excluded.digest`, groupId, digest);
    const result = await database.getFirstAsync<{ busy: number; log: number; checkpointed: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
    if (!result || ![result.busy, result.log, result.checkpointed].every(Number.isInteger)
      || result.busy < 0 || result.log < -1 || result.checkpointed < -1) throw new Error('履歴ファイルの整理結果を確認できません。次回同期で再試行します。');
    const complete = result.busy === 0 && result.log === result.checkpointed;
    await database.runAsync(`UPDATE sharing_history_cleanup SET pending=?,busy=?,log_pages=?,checkpointed_pages=? WHERE group_id=? AND digest=?`,
      complete ? 0 : 1, result.busy, result.log, result.checkpointed, groupId, digest);
    return { complete, busy: result.busy };
  });
  pending.set(database, task.catch(() => undefined));
  return task;
}
