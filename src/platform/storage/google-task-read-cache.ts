import type { SQLiteDatabase } from 'expo-sqlite';
import { GoogleTasksApiError } from '../google-tasks/google-tasks-api.ts';
import type { GoogleTask, GoogleTasksPage } from '../google-tasks/google-tasks-api';
import { canReadGoogleTaskDelta, GoogleTaskFullSyncRequiredError, googleTaskFullReadRequired } from '../../features/google-sync/task-read-cache.ts';
import type { GoogleTaskReadCache, GoogleTaskReadScope, GoogleTaskReadState } from '../../features/google-sync/task-read-cache';

export async function initializeGoogleTaskReadCacheInside(database: SQLiteDatabase) {
  await database.execAsync(`CREATE TABLE IF NOT EXISTS private_google_task_read_control (
    account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
    PRIMARY KEY(account_subject,task_list_id));
    CREATE TABLE IF NOT EXISTS private_google_task_read_items (
      account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, task_id TEXT NOT NULL, task_json TEXT NOT NULL,
      PRIMARY KEY(account_subject,task_list_id,task_id));
    CREATE TABLE IF NOT EXISTS private_google_task_read_staging (
      account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, task_id TEXT NOT NULL, task_json TEXT NOT NULL,
      PRIMARY KEY(account_subject,task_list_id,task_id));`);
}

const initial = (): GoogleTaskReadState => ({ revision: 0, complete: false, watermark: null, lastFullAt: null, scan: null });
const conflict = () => new GoogleTasksApiError(503, 'task_read_checkpoint_changed', null);
function key(scope: GoogleTaskReadScope): [string, string] {
  const result: [string, string] = [scope.accountSubject, scope.taskListId];
  if (result.some(text => typeof text !== 'string' || !text.length || text.length > 2048 || text.includes('\0'))) throw new Error('Google家事の取得先を確認してください。');
  return result;
}
function sanitize(task: GoogleTask): GoogleTask {
  if (!task || typeof task.id !== 'string' || !task.id.length || task.id.length > 2048 || task.id.includes('\0')
    || !task.deleted && (typeof task.title !== 'string' || !['needsAction', 'completed'].includes(task.status))) {
    throw new GoogleTasksApiError(502, 'task_read_invalid_item', null);
  }
  const result: Record<string, string | boolean> = { id: task.id };
  for (const name of ['title', 'notes', 'due', 'status', 'completed', 'etag', 'updated', 'parent'] as const) if (task[name] !== undefined) {
    if (typeof task[name] !== 'string' || task[name]!.length > (name === 'notes' ? 8192 : 2048)) throw new GoogleTasksApiError(502, 'task_read_invalid_item', null);
    result[name] = task[name]!;
  }
  for (const name of ['hidden', 'deleted'] as const) if (task[name] !== undefined) {
    if (typeof task[name] !== 'boolean') throw new GoogleTasksApiError(502, 'task_read_invalid_item', null);
    result[name] = task[name]!;
  }
  return result as unknown as GoogleTask;
}

function readableState(value: unknown, revision: number): value is GoogleTaskReadState {
  if (!value || typeof value !== 'object') return false;
  const state = value as GoogleTaskReadState;
  const stamp = (text: unknown) => text === null || typeof text === 'string' && Number.isFinite(Date.parse(text));
  const token = (text: unknown) => text === null || typeof text === 'string' && text.length > 0 && text.length <= 8192;
  return state.revision === revision && Number.isSafeInteger(revision) && revision > 0 && revision < Number.MAX_SAFE_INTEGER
    && typeof state.complete === 'boolean' && stamp(state.watermark) && stamp(state.lastFullAt)
    && (state.scan === null || Boolean(state.scan && ['full', 'delta'].includes(state.scan.mode) && stamp(state.scan.updatedMin)
      && stamp(state.scan.cutoff) && token(state.scan.pageToken) && Number.isSafeInteger(state.scan.pages) && state.scan.pages >= 0
      && Array.isArray(state.scan.visitedTokens) && state.scan.visitedTokens.every(value => typeof value === 'string' && token(value))
      && new Set(state.scan.visitedTokens).size === state.scan.visitedTokens.length));
}

/** Every callback runs in the existing personal/v2 authorized SQLite transaction; no HTTP is performed while it is open. */
export function createGoogleTaskReadCache(transaction: <T>(work: (database: SQLiteDatabase) => Promise<T>) => Promise<T>): GoogleTaskReadCache {
  async function readInside(database: SQLiteDatabase, scope: GoogleTaskReadScope): Promise<GoogleTaskReadState> {
    const row = await database.getFirstAsync<{ revision: number; state_json: string }>(
      'SELECT revision,state_json FROM private_google_task_read_control WHERE account_subject=? AND task_list_id=?', ...key(scope));
    if (!row) return initial();
    let state: unknown; try { state = JSON.parse(row.state_json); } catch { /* Rebuild only this disposable cache. */ }
    if (readableState(state, row.revision)) return state;
    for (const table of ['control', 'items', 'staging']) await database.runAsync(
      `DELETE FROM private_google_task_read_${table} WHERE account_subject=? AND task_list_id=?`, ...key(scope));
    return initial();
  }
  async function save(database: SQLiteDatabase, scope: GoogleTaskReadScope, previous: GoogleTaskReadState, next: GoogleTaskReadState) {
    const current = await readInside(database, scope);
    if (JSON.stringify(current) !== JSON.stringify(previous)) throw conflict();
    const value = { ...next, revision: previous.revision + 1 };
    const result = previous.revision ? await database.runAsync(`UPDATE private_google_task_read_control SET revision=?,state_json=?
      WHERE account_subject=? AND task_list_id=? AND revision=?`, value.revision, JSON.stringify(value), ...key(scope), previous.revision)
      : await database.runAsync(`INSERT INTO private_google_task_read_control VALUES(?,?,?,?)
        ON CONFLICT(account_subject,task_list_id) DO NOTHING`, ...key(scope), value.revision, JSON.stringify(value));
    if (result.changes !== 1) throw conflict(); return value;
  }
  return {
    read: scope => transaction(database => readInside(database, scope)),
    start: (scope, expected, now, options) => transaction(async database => {
      if (expected.scan || !Number.isFinite(Date.parse(now))) throw conflict();
      if (options?.deltaOnly && !canReadGoogleTaskDelta(expected, new Date(now))) throw new GoogleTaskFullSyncRequiredError();
      const full = !options?.deltaOnly && googleTaskFullReadRequired(expected, new Date(now));
      const next = await save(database, scope, expected, { ...expected, scan: { mode: full ? 'full' : 'delta',
        updatedMin: full ? null : expected.watermark, pageToken: null, visitedTokens: [], cutoff: null, pages: 0 } });
      await database.runAsync('DELETE FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?', ...key(scope));
      return next;
    }),
    page: (scope, expected, page: GoogleTasksPage, now) => transaction(async database => {
      if (!expected.scan || !Array.isArray(page.items) || page.items.length > 100 || !Number.isFinite(Date.parse(now))) throw conflict();
      if (page.nextPageToken !== undefined && (typeof page.nextPageToken !== 'string' || !page.nextPageToken.length || page.nextPageToken.length > 8192)) throw conflict();
      const tasks = page.items.map(sanitize);
      if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new GoogleTasksApiError(502, 'task_read_duplicate_item', null);
      const receivedAt = page.serverDate ? Date.parse(page.serverDate) : NaN;
      const cutoff = expected.scan.pages ? expected.scan.cutoff : Number.isFinite(receivedAt) ? new Date(receivedAt - 5000).toISOString() : null;
      const scan = { ...expected.scan, cutoff, pages: expected.scan.pages + 1,
        pageToken: page.nextPageToken ?? null, visitedTokens: [...expected.scan.visitedTokens, ...(page.nextPageToken ? [page.nextPageToken] : [])] };
      const next = await save(database, scope, expected, page.nextPageToken ? { ...expected, scan } : {
        ...expected, complete: true, watermark: cutoff, lastFullAt: scan.mode === 'full' ? now : expected.lastFullAt, scan: null,
      });
      for (const task of tasks) await database.runAsync(`INSERT INTO private_google_task_read_staging VALUES(?,?,?,?)
        ON CONFLICT(account_subject,task_list_id,task_id) DO UPDATE SET task_json=excluded.task_json`, ...key(scope), task.id, JSON.stringify(task));
      if (!page.nextPageToken) {
        if (scan.mode === 'full') await database.runAsync('DELETE FROM private_google_task_read_items WHERE account_subject=? AND task_list_id=?', ...key(scope));
        await database.runAsync(`INSERT INTO private_google_task_read_items SELECT * FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?
          ON CONFLICT(account_subject,task_list_id,task_id) DO UPDATE SET task_json=excluded.task_json`, ...key(scope));
        await database.runAsync('DELETE FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?', ...key(scope));
      }
      return next;
    }),
    reset: (scope, expected) => transaction(async database => {
      await save(database, scope, expected, { ...expected, watermark: null, scan: null });
      await database.runAsync('DELETE FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?', ...key(scope));
    }),
    tasks: scope => transaction(async database => {
      const state = await readInside(database, scope); if (!state.complete || state.scan) throw conflict();
      const rows = await database.getAllAsync<{ task_json: string }>(
        'SELECT task_json FROM private_google_task_read_items WHERE account_subject=? AND task_list_id=? ORDER BY task_id', ...key(scope));
      return rows.map(row => sanitize(JSON.parse(row.task_json)));
    }),
  };
}
