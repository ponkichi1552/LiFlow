import type { SQLiteDatabase } from 'expo-sqlite';

export type BackgroundDomain = 'personal' | 'personalGoogleCalendar' | 'privateCalendar' | 'sharing';
export type BackgroundOutcome = 'running' | 'success' | 'failed' | 'interrupted';
export interface BackgroundRun {
  id: number; started_at: number; finished_at: number | null; release: number; outcome: BackgroundOutcome;
  personal: string; private_calendar: string; sharing: string; personal_google_calendar: string;
}
/** The native worker can finish normally while a bounded domain retains work. */
export function backgroundRunStatus(run: BackgroundRun): BackgroundOutcome | 'pending' | 'skipped' {
  if (run.outcome === 'running' || run.outcome === 'interrupted' || run.outcome === 'failed') return run.outcome;
  const domains = [run.personal, run.private_calendar, run.sharing, run.personal_google_calendar];
  if (domains.includes('failed')) return 'failed';
  if (run.outcome !== 'success' || run.finished_at === null || domains.some(value => value !== 'success' && value !== 'skipped')) return 'pending';
  return domains.every(value => value === 'skipped') ? 'skipped' : 'success';
}
/** Metadata only. No account, operation, group, key, token or business content is stored here. */
export function createBackgroundAudit(database: SQLiteDatabase) {
  return {
    async begin(startedAt: number, release: boolean) {
      await database.execAsync(`CREATE TABLE IF NOT EXISTS background_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER,
        release INTEGER NOT NULL, outcome TEXT NOT NULL,
        personal TEXT NOT NULL DEFAULT 'pending', private_calendar TEXT NOT NULL DEFAULT 'pending', sharing TEXT NOT NULL DEFAULT 'pending');`);
      const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(background_sync_runs)');
      if (!columns.some(column => column.name === 'personal_google_calendar')) await database.execAsync("ALTER TABLE background_sync_runs ADD COLUMN personal_google_calendar TEXT NOT NULL DEFAULT 'pending'");
      // A process that disappeared cannot later be reported as a successful run.
      await database.runAsync("UPDATE background_sync_runs SET outcome='interrupted' WHERE outcome='running'");
      const row = await database.runAsync("INSERT INTO background_sync_runs (started_at,release,outcome) VALUES (?,?,'running')", startedAt, release ? 1 : 0);
      await database.runAsync('DELETE FROM background_sync_runs WHERE id NOT IN (SELECT id FROM background_sync_runs ORDER BY id DESC LIMIT 32)');
      return row.lastInsertRowId;
    },
    async domain(id: number, domain: BackgroundDomain, outcome: 'success' | 'failed' | 'skipped' | 'pending') {
      const column = { personal: 'personal', personalGoogleCalendar: 'personal_google_calendar', privateCalendar: 'private_calendar', sharing: 'sharing' }[domain];
      if (!column) throw new Error('Invalid background domain');
      await database.runAsync(`UPDATE background_sync_runs SET ${column}=? WHERE id=? AND outcome='running'`, outcome, id);
    },
    async finish(id: number, endedAt: number, failed: boolean) {
      await database.runAsync('UPDATE background_sync_runs SET finished_at=?,outcome=? WHERE id=? AND outcome=?', endedAt, failed ? 'failed' : 'success', id, 'running');
    },
  };
}
