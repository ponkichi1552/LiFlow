import type { SQLiteDatabase } from 'expo-sqlite';
import { withIsolatedSqliteTransaction } from './isolated-transaction';
import { LOCAL_HOUSEHOLD_ID, invalidateLocalCalendarPlan, withPlannerDatabaseOperation } from './repository';
import { sharedRepositoryAdapter } from './shared-repository-adapter';
import { activatePersonalGoogleCalendarAccountInside } from './personal-google-calendar';
import { notifyCalendarSyncStatusChanged } from './calendar-events';

const tables = ['google_sync_state', 'calendar_availability_state', 'calendar_availability_days', 'google_task_links'] as const;
type Row = Record<string, string | number | null>;

/** Explicit account changes retain the old mappings locally and never delete anything at Google. */
export async function activatePersonalGoogleTaskAccount(database: SQLiteDatabase, subject: string, assertCurrent: () => Promise<void>) {
  if (!subject || subject.length > 512 || subject.includes('\0') || sharedRepositoryAdapter(database)) throw new Error('個人用のGoogleアカウントを確認してください。');
  let calendarChanged = false;
  const changed = await withPlannerDatabaseOperation(database, () => withIsolatedSqliteTransaction(database, async tx => {
    await assertCurrent();
    const previous = await tx.getFirstAsync<{ account_subject: string | null }>('SELECT account_subject FROM google_sync_state WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
    calendarChanged = await activatePersonalGoogleCalendarAccountInside(tx, subject);
    if (previous?.account_subject === subject) { await assertCurrent(); return calendarChanged; }
    await tx.execAsync(`CREATE TABLE IF NOT EXISTS personal_google_account_archives (
      household_id TEXT NOT NULL, account_key TEXT NOT NULL, schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(household_id,account_key));
      CREATE TABLE IF NOT EXISTS personal_google_account_archive_rows (
      household_id TEXT NOT NULL, account_key TEXT NOT NULL, table_name TEXT NOT NULL,
      ordinal INTEGER NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(household_id,account_key,table_name,ordinal));`);
    const oldKey = JSON.stringify(previous?.account_subject ? ['google', previous.account_subject] : ['unbound']);
    const key = JSON.stringify(['google', subject]); const now = new Date().toISOString();
    const incoming = await tx.getFirstAsync<{ schema_version: number }>('SELECT schema_version FROM personal_google_account_archives WHERE household_id=? AND account_key=?', LOCAL_HOUSEHOLD_ID, key);
    if (incoming && incoming.schema_version !== 1) throw new Error('保存済みのGoogle連携を確認できません。');
    await tx.runAsync('DELETE FROM personal_google_account_archive_rows WHERE household_id=? AND account_key=?', LOCAL_HOUSEHOLD_ID, oldKey);
    for (const table of tables) {
      let after: number | null = null; let ordinal = 0;
      for (;;) {
        const page: (Row & { archive_rowid: number })[] = after === null
          ? await tx.getAllAsync(`SELECT rowid AS archive_rowid,* FROM ${table} WHERE household_id=? ORDER BY rowid LIMIT 100`, LOCAL_HOUSEHOLD_ID)
          : await tx.getAllAsync(`SELECT rowid AS archive_rowid,* FROM ${table} WHERE household_id=? AND rowid>? ORDER BY rowid LIMIT 100`, LOCAL_HOUSEHOLD_ID, after);
        if (!page.length) break;
        const values = page.flatMap(item => {
          const { archive_rowid, ...row } = item; after = archive_rowid;
          return [LOCAL_HOUSEHOLD_ID, oldKey, table, ordinal++, JSON.stringify(row)];
        });
        await tx.runAsync(`INSERT INTO personal_google_account_archive_rows VALUES${page.map(() => '(?,?,?,?,?)').join(',')}`, ...values);
      }
    }
    await tx.runAsync(`INSERT INTO personal_google_account_archives VALUES(?,?,1,?)
      ON CONFLICT(household_id,account_key) DO UPDATE SET schema_version=1,updated_at=excluded.updated_at`, LOCAL_HOUSEHOLD_ID, oldKey, now);
    for (const table of [...tables].reverse()) await tx.runAsync(`DELETE FROM ${table} WHERE household_id=?`, LOCAL_HOUSEHOLD_ID);
    if (incoming) {
      for (const table of tables) {
        const columns = new Set((await tx.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map(row => row.name));
        let ordinal = -1;
        for (;;) {
          const rows = await tx.getAllAsync<{ ordinal: number; value_json: string }>(`SELECT ordinal,value_json FROM personal_google_account_archive_rows
            WHERE household_id=? AND account_key=? AND table_name=? AND ordinal>? ORDER BY ordinal LIMIT 100`, LOCAL_HOUSEHOLD_ID, key, table, ordinal);
          if (!rows.length) break;
          const groups = new Map<string, { names: string[]; rows: Row[] }>();
          for (const saved of rows) {
            ordinal = saved.ordinal; const row: Row = JSON.parse(saved.value_json); const names = Object.keys(row);
            if (row.household_id !== LOCAL_HOUSEHOLD_ID || !names.length || names.some(name => !columns.has(name) || !/^[a-z_]+$/.test(name))
              || Object.values(row).some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))
              || table === 'google_sync_state' && row.account_subject !== subject) throw new Error('保存済みのGoogle連携が一致しません。');
            const key = names.join(','); const group = groups.get(key) ?? { names, rows: [] };
            group.rows.push(row); groups.set(key, group);
          }
          for (const group of groups.values()) {
            // Keep each statement below old SQLite parameter limits and avoid one native call per mapping.
            const size = Math.max(1, Math.floor(900 / group.names.length));
            for (let offset = 0; offset < group.rows.length; offset += size) {
              const batch = group.rows.slice(offset, offset + size);
              const placeholders = `(${group.names.map(() => '?').join(',')})`;
              await tx.runAsync(`INSERT INTO ${table}(${group.names.map(name => `"${name}"`).join(',')}) VALUES${batch.map(() => placeholders).join(',')}`,
                ...batch.flatMap(row => group.names.map(name => row[name])));
            }
          }
        }
      }
      const restored = await tx.getFirstAsync<{ account_subject: string }>('SELECT account_subject FROM google_sync_state WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
      if (restored?.account_subject !== subject) throw new Error('保存済みのGoogleアカウントを確認できません。');
    } else {
      await tx.runAsync(`INSERT INTO google_sync_state(household_id,enabled,account_subject,connection_active,status,retry_count,updated_at)
        VALUES(?,0,?,0,'idle',0,?)`, LOCAL_HOUSEHOLD_ID, subject, now);
    }
    await assertCurrent(); return true;
  }));
  if (changed) invalidateLocalCalendarPlan(database);
  if (calendarChanged) notifyCalendarSyncStatusChanged(database);
  return changed;
}
