import type { SQLiteDatabase } from 'expo-sqlite';
import { GoogleTasksApiError } from '../google-tasks/google-tasks-api.ts';
import type { GoogleTask, GoogleTasksPage } from '../google-tasks/google-tasks-api';
import { canReadGoogleTaskDelta, GoogleTaskFullSyncRequiredError, googleTaskFullReadRequired } from '../../features/google-sync/task-read-cache.ts';
import type { GoogleTaskReadCache, GoogleTaskReadScope, GoogleTaskReadState } from '../../features/google-sync/task-read-cache';

export async function initializeGoogleTaskReadCacheInside(database: SQLiteDatabase) {
  let schema = `CREATE TABLE IF NOT EXISTS private_google_task_read_control (
    account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
    PRIMARY KEY(account_subject,task_list_id));
    CREATE TABLE IF NOT EXISTS private_google_task_read_items (
      account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, task_id TEXT NOT NULL, task_json TEXT NOT NULL,
      PRIMARY KEY(account_subject,task_list_id,task_id));
    CREATE TABLE IF NOT EXISTS private_google_task_read_staging (
      account_subject TEXT NOT NULL, task_list_id TEXT NOT NULL, task_id TEXT NOT NULL, task_json TEXT NOT NULL,
      PRIMARY KEY(account_subject,task_list_id,task_id));`;
  schema += `CREATE TABLE IF NOT EXISTS private_google_task_item_revisions(account_subject TEXT NOT NULL,task_list_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(account_subject,task_list_id));`;
  for (const action of ['INSERT','UPDATE','DELETE']) {
    const row=action==='DELETE'?'OLD':'NEW';
    schema += `CREATE TRIGGER IF NOT EXISTS google_task_items_${action.toLowerCase()} AFTER ${action} ON private_google_task_read_items BEGIN
      INSERT INTO private_google_task_item_revisions VALUES(${row}.account_subject,${row}.task_list_id,1)
      ON CONFLICT(account_subject,task_list_id) DO UPDATE SET revision=revision+1; END;`;
  }
  await database.execAsync(schema);
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
    if (name === 'completed' && task[name] === null && task.status === 'needsAction') continue;
    if (typeof task[name] !== 'string' || task[name]!.length > (name === 'notes' ? 8192 : 2048)) throw new GoogleTasksApiError(502, 'task_read_invalid_item', null);
    result[name] = task[name]!;
  }
  for (const name of ['hidden', 'deleted'] as const) if (task[name] !== undefined) {
    if (typeof task[name] !== 'boolean') throw new GoogleTasksApiError(502, 'task_read_invalid_item', null);
    result[name] = task[name]!;
  }
  return result as unknown as GoogleTask;
}

async function writeTaskBatch(database: SQLiteDatabase, table: 'staging' | 'items', scope: GoogleTaskReadScope, tasks: readonly GoogleTask[]) {
  // Four bound values per row; remain below old Android SQLite parameter limits.
  for (let offset = 0; offset < tasks.length; offset += 100) {
    const page = tasks.slice(offset, offset + 100);
    await database.runAsync(`INSERT INTO private_google_task_read_${table} VALUES${page.map(() => '(?,?,?,?)').join(',')}
      ON CONFLICT(account_subject,task_list_id,task_id) DO UPDATE SET task_json=excluded.task_json
      WHERE ${taskUpdateCondition(`private_google_task_read_${table}`)}`,
    ...page.flatMap(task => [...key(scope), task.id, JSON.stringify(task)]));
  }
}

function taskUpdateCondition(table: string) {
  // Google timestamps may use different UTC offsets. Unknown timestamps retain
  // the old compatibility behavior; known older replies cannot roll state back.
  return `${table}.task_json<>excluded.task_json AND COALESCE(
    julianday(json_extract(excluded.task_json,'$.updated')) >= julianday(json_extract(${table}.task_json,'$.updated')),1)`;
}

function readableState(value: unknown, revision: number): value is GoogleTaskReadState {
  if (!value || typeof value !== 'object') return false;
  const state = value as GoogleTaskReadState;
  const stamp = (text: unknown) => text === null || typeof text === 'string' && Number.isFinite(Date.parse(text));
  const token = (text: unknown) => text === null || typeof text === 'string' && text.length > 0 && text.length <= 8192;
  const scan = state.scan;
  return state.revision === revision && Number.isSafeInteger(revision) && revision > 0 && revision < Number.MAX_SAFE_INTEGER
    && typeof state.complete === 'boolean' && stamp(state.watermark) && stamp(state.lastFullAt)
    && (scan === null || Boolean(scan && ['full', 'delta'].includes(scan.mode) && stamp(scan.updatedMin)
      && (scan.mode === 'full' ? scan.updatedMin === null : state.complete && state.watermark !== null && scan.updatedMin === state.watermark)
      && stamp(scan.cutoff) && token(scan.pageToken) && Number.isSafeInteger(scan.pages) && scan.pages >= 0
      && Array.isArray(scan.visitedTokens) && scan.visitedTokens.every(value => typeof value === 'string' && token(value))
      && new Set(scan.visitedTokens).size === scan.visitedTokens.length
      && (scan.pages === 0 ? scan.pageToken === null && scan.cutoff === null && scan.visitedTokens.length === 0
        : scan.pages === scan.visitedTokens.length && scan.pageToken === scan.visitedTokens.at(-1))));
}

/** Every callback runs in the existing personal/v2 authorized SQLite transaction; no HTTP is performed while it is open. */
export function createGoogleTaskReadCache(transaction: <T>(work: (database: SQLiteDatabase) => Promise<T>) => Promise<T>): GoogleTaskReadCache {
  const inventories = new Map<string, { revision: number; tasks: GoogleTask[] }>();
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
      await writeTaskBatch(database, 'staging', scope, tasks);
      if (!page.nextPageToken) {
        if (scan.mode === 'full') await database.runAsync(`DELETE FROM private_google_task_read_items
          WHERE account_subject=? AND task_list_id=? AND NOT EXISTS(SELECT 1 FROM private_google_task_read_staging AS staged
            WHERE staged.account_subject=private_google_task_read_items.account_subject
              AND staged.task_list_id=private_google_task_read_items.task_list_id AND staged.task_id=private_google_task_read_items.task_id)`, ...key(scope));
        await database.runAsync(`INSERT INTO private_google_task_read_items SELECT * FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?
          ON CONFLICT(account_subject,task_list_id,task_id) DO UPDATE SET task_json=excluded.task_json
          WHERE ${taskUpdateCondition('private_google_task_read_items')}`, ...key(scope));
        await database.runAsync('DELETE FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?', ...key(scope));
      }
      return next;
    }),
    reset: (scope, expected) => transaction(async database => {
      await save(database, scope, expected, { ...expected, watermark: null, scan: null });
      await database.runAsync('DELETE FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?', ...key(scope));
    }),
    async tasks(scope) {
      const result = await transaction(async database => {
      const state = await readInside(database, scope); if (!state.complete || state.scan) throw conflict();
      const inventoryKey=JSON.stringify(key(scope));
      const revision=(await database.getFirstAsync<{ revision: number }>('SELECT revision FROM private_google_task_item_revisions WHERE account_subject=? AND task_list_id=?',...key(scope)))?.revision ?? 0;
      const saved=inventories.get(inventoryKey); if (saved?.revision===revision) return [...saved.tasks];
      const rows = await database.getAllAsync<{ task_json: string }>(
        'SELECT task_json FROM private_google_task_read_items WHERE account_subject=? AND task_list_id=? ORDER BY task_id', ...key(scope));
      try { const tasks=rows.map(row => Object.freeze(sanitize(JSON.parse(row.task_json))));
        if (inventories.size>=4) inventories.delete(inventories.keys().next().value!);
        inventories.set(inventoryKey,{revision,tasks}); return [...tasks]; }
      catch {
        // Commit the cache-only invalidation before reporting the need to read
        // again. Throwing inside this transaction would roll the repair back.
        await save(database, scope, state, { ...state, complete: false, watermark: null, lastFullAt: null, scan: null });
        for (const table of ['items', 'staging']) await database.runAsync(
          `DELETE FROM private_google_task_read_${table} WHERE account_subject=? AND task_list_id=?`, ...key(scope));
        return null;
      }
      });
      if (result === null) throw new GoogleTaskFullSyncRequiredError();
      return result;
    },
    written: (scope, values) => transaction(async database => {
      const tasks = values.map(sanitize); const state = await readInside(database, scope);
      // Keep the last committed watermark. Restart only the unfinished scan so
      // its old staging rows and late HTTP replies cannot undo this known write.
      await save(database, scope, state, { ...state, scan: null });
      await database.runAsync('DELETE FROM private_google_task_read_staging WHERE account_subject=? AND task_list_id=?', ...key(scope));
      await writeTaskBatch(database, 'items', scope, tasks);
    }),
  };
}
