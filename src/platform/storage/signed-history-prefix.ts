import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson } from '../../features/sharing/operations.ts';

/** Local optimization only. Callers reverify signed entries against their protected anchor. */
export function createSignedHistoryPrefix(database: SQLiteDatabase, scope: string, anchor: string) {
  let initialized: Promise<unknown> | undefined;
  const ready = () => initialized ??= database.execAsync(`CREATE TABLE IF NOT EXISTS signed_history_prefix (
    scope TEXT NOT NULL, anchor TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(scope,anchor,revision)
  )`).catch(error => { initialized = undefined; throw error; });
  return {
    async read(after: number, through: number): Promise<unknown[]> {
      await ready();
      const rows = await database.getAllAsync<{ record: string }>(`SELECT record FROM signed_history_prefix
        WHERE scope=? AND anchor=? AND revision>? AND revision<=? ORDER BY revision LIMIT 4096`, scope, anchor, after, through);
      return rows.map(row => JSON.parse(row.record) as unknown);
    },
    async append(first: number, entries: readonly unknown[]) {
      if (!entries.length) return;
      await ready();
      // Ignore duplicate work from another opener, including after an uncertain SQLite commit.
      const parameters = entries.flatMap((entry, index) => [scope, anchor, first + index, canonicalJson(entry)]);
      await database.runAsync(`INSERT OR IGNORE INTO signed_history_prefix(scope,anchor,revision,record) VALUES
        ${entries.map(() => '(?,?,?,?)').join(',')}`, ...parameters);
    },
    async clear() { await ready(); await database.runAsync('DELETE FROM signed_history_prefix WHERE scope=? AND anchor=?', scope, anchor); },
  };
}
