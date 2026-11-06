import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers/typescript-loader.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { now as v2Now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createIntegration, repository, now as personalNow } from './helpers/google-sync-integration.mjs';
const { createGoogleTaskReadCache, initializeGoogleTaskReadCacheInside } = await import('../src/platform/storage/google-task-read-cache.ts');
const { createGoogleTasksApi, GoogleTasksApiError } = await import('../src/platform/google-tasks/google-tasks-api.ts');
const { readGoogleTasksCheckpointed } = await import('../src/features/google-sync/task-read-cache.ts');
const { migrateLocalDatabase } = await import('../src/platform/storage/migrations.ts');
const { createGoogleOperationBudget } = await import('../src/features/google-sync/operation-budget.ts');

const scope = { accountSubject: 'account-a', taskListId: 'list-a' };
const serverDate = 'Thu, 05 Nov 2026 03:00:00 GMT';
const now = new Date('2026-11-05T03:00:00Z');
const task = (id, status = 'needsAction') => ({ id, title: `家事${id}`, status, updated: '2026-11-05T02:00:00Z' });
async function setup(path) {
  const h = createDatabase(path); await initializeGoogleTaskReadCacheInside(h.database);
  const cache = createGoogleTaskReadCache(async work => {
    let result; await h.database.withTransactionAsync(async () => { result = await work(h.database); }); return result;
  });
  return { ...h, cache, read: (api, clock = now, key = scope) => readGoogleTasksCheckpointed({ api, cache, scope: key, accessToken: 'test-token', now: clock }) };
}

test('Tasks read checkpoints survive database reopening and a failed later page never reconciles a partial list', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-task-page-')); const path = join(directory, 'test.db'); let h;
  const queries = [];
  try {
    h = await setup(path);
    const api = createGoogleTasksApi(async url => {
      const params = new URL(url).searchParams; queries.push(Object.fromEntries(params));
      if (params.has('pageToken')) throw new TypeError('offline');
      return Response.json({ items: [task('one')], nextPageToken: 'page-two' }, { headers: { Date: serverDate } });
    });
    await assert.rejects(h.read(api), TypeError);
    assert.equal((await h.cache.read(scope)).scan.pageToken, 'page-two');
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM private_google_task_read_items').get().n, 0);
    await assert.rejects(h.cache.tasks(scope), { code: 'task_read_checkpoint_changed' });
    h.connection.close(); h = await setup(path);
    const finish = createGoogleTasksApi(async url => {
      const params = new URL(url).searchParams; queries.push(Object.fromEntries(params)); assert.equal(params.get('pageToken'), 'page-two');
      return Response.json({ items: [{ ...task('two', 'completed'), hidden: true, completed: '2026-11-05T02:59:00Z' }] }, { headers: { Date: serverDate } });
    });
    const rows = await h.read(finish); assert.deepEqual(rows.map(row => row.id), ['one', 'two']); assert.equal(rows[1].hidden, true);
    assert.equal((await h.cache.read(scope)).watermark, '2026-11-05T02:59:55.000Z');
    assert.equal(queries.length, 3); assert.equal(queries.at(-1).updatedMin, undefined);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM private_google_task_read_staging').get().n, 0);
  } finally { h?.connection.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Tasks delta reads use Google server time, retain unchanged tasks and import hidden completion undo and deletion', async () => {
  const h = await setup(); let pass = 0;
  try {
    const api = createGoogleTasksApi(async url => {
      const params = new URL(url).searchParams;
      assert.equal(params.get('showDeleted'), 'true'); assert.equal(params.get('showHidden'), 'true');
      if (pass++ === 0) {
        assert.equal(params.has('updatedMin'), false);
        return Response.json({ items: [task('same'), task('done'), task('undo', 'completed'), task('deleted')] }, { headers: { Date: serverDate } });
      }
      assert.equal(params.get('updatedMin'), '2026-11-05T02:59:55.000Z', 'a fast device clock must not skip genuine Google changes');
      return Response.json({ items: [
        { ...task('done', 'completed'), hidden: true, completed: '2026-11-05T03:00:01Z' }, task('undo'), { id: 'deleted', deleted: true },
      ] }, { headers: { Date: 'Thu, 05 Nov 2026 03:00:10 GMT' } });
    });
    const fastDevice = new Date('2099-01-01T00:00:00Z'); await h.read(api, fastDevice);
    const rows = await h.read(api, new Date(fastDevice.getTime() + 10_000)); const byId = new Map(rows.map(row => [row.id, row]));
    assert.equal(rows.length, 4); assert.deepEqual(byId.get('same'), task('same'));
    assert.equal(byId.get('done').hidden, true); assert.equal(byId.get('undo').status, 'needsAction'); assert.equal(byId.get('deleted').deleted, true);
    assert.equal((await h.cache.read(scope)).watermark, '2026-11-05T03:00:05.000Z');
  } finally { h.connection.close(); }
});

test('a 10000-task baseline later receives only changed tasks without rewriting unchanged cache rows', async () => {
  const h = await setup(); let requests = 0; let delta = false;
  try {
    const api = createGoogleTasksApi(async url => {
      requests++; const query = new URL(url).searchParams;
      if (delta) {
        assert.ok(query.get('updatedMin')); assert.equal(query.has('pageToken'), false);
        return Response.json({ items: [{ ...task('00000', 'completed'), completed: now.toISOString() }, { id: '09999', deleted: true }] }, { headers: { Date: serverDate } });
      }
      const start = Number(query.get('pageToken') ?? 0); const end = Math.min(start + 100, 10_000);
      return Response.json({ items: Array.from({ length: end - start }, (_, index) => task(String(start + index).padStart(5, '0'))),
        ...(end < 10_000 ? { nextPageToken: String(end) } : {}) }, { headers: { Date: serverDate } });
    });
    assert.equal((await h.read(api)).length, 10_000); assert.equal(requests, 100);
    h.connection.exec(`CREATE TABLE cache_write_audit (task_id TEXT);
      CREATE TRIGGER observe_cache_update AFTER UPDATE ON private_google_task_read_items BEGIN INSERT INTO cache_write_audit VALUES(new.task_id); END;`);
    delta = true; const rows = await h.read(api);
    assert.equal(requests, 101); assert.equal(rows.length, 10_000);
    assert.deepEqual(h.connection.prepare('SELECT task_id FROM cache_write_audit ORDER BY task_id').all().map(row => row.task_id), ['00000', '09999']);
    assert.equal(rows.find(row => row.id === '00000').status, 'completed'); assert.equal(rows.find(row => row.id === '09999').deleted, true);
  } finally { h.connection.close(); }
});

test('a real total-budget timeout keeps committed Tasks pages and the next worker starts at the saved cursor', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); const h = await setup(); const budget = createGoogleOperationBudget(1_000);
  const queries = []; let blocked;
  try {
    const api = createGoogleTasksApi(async url => {
      const query = new URL(url).searchParams; queries.push(query.get('pageToken'));
      if (query.has('pageToken')) return new Promise(resolve => { blocked = resolve; });
      return Response.json({ items: [task('first')], nextPageToken: 'next', }, { headers: { Date: serverDate } });
    }, undefined, { budget });
    const run = h.read(api); const rejection = assert.rejects(run, error => error.name === 'AbortError');
    for (let turn = 0; turn < 20 && !blocked; turn++) await new Promise(setImmediate);
    assert.equal(typeof blocked, 'function'); context.mock.timers.tick(1_000); await rejection;
    assert.equal((await h.cache.read(scope)).scan.pageToken, 'next');
    const resumed = await h.read({ listTaskPage: async (_token, _list, query) => { assert.equal(query.pageToken, 'next'); return { items: [task('second')], serverDate }; } });
    blocked(Response.json({ items: [task('stale')] }, { headers: { Date: serverDate } })); await new Promise(setImmediate);
    assert.deepEqual(resumed.map(row => row.id), ['first', 'second']); assert.deepEqual(queries, [null, 'next']);
    assert.deepEqual((await h.cache.tasks(scope)).map(row => row.id), ['first', 'second']);
  } finally { budget.close(); h.connection.close(); }
});

test('an expired Tasks cursor keeps the committed baseline and restarts a full read without assuming missing tasks were deleted', async () => {
  const h = await setup();
  try {
    await h.read({ listTaskPage: async () => ({ items: [task('old')], serverDate }) });
    const api = { listTaskPage: async (_token, _list, query) => {
      if (query.pageToken) throw new GoogleTasksApiError(400, 'invalid_page_token', null);
      return { items: [task('new')], nextPageToken: 'expired', serverDate };
    } };
    await assert.rejects(h.read(api), { code: 'task_read_restart' });
    const state = await h.cache.read(scope); assert.equal(state.scan, null); assert.equal(state.watermark, null);
    assert.deepEqual((await h.cache.tasks(scope)).map(row => row.id), ['old']);
    const rows = await h.read({ listTaskPage: async (_token, _list, query) => { assert.equal(query.updatedMin, undefined); return { items: [task('new')], serverDate }; } });
    assert.deepEqual(rows.map(row => row.id), ['new']);
  } finally { h.connection.close(); }
});

test('a failed Tasks page transaction rolls back its cursor and rows, while stale independent connections cannot append', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-task-cas-')); const path = join(directory, 'test.db'); const a = await setup(path); const b = await setup(path);
  try {
    const empty = await a.cache.read(scope); const stale = await b.cache.read(scope);
    const active = await a.cache.start(scope, empty, now.toISOString());
    await assert.rejects(b.cache.start(scope, stale, now.toISOString()), { code: 'task_read_checkpoint_changed' });
    a.connection.exec("CREATE TRIGGER reject_staged_task BEFORE INSERT ON private_google_task_read_staging BEGIN SELECT RAISE(ABORT,'fixture'); END");
    await assert.rejects(a.cache.page(scope, active, { items: [task('one')], nextPageToken: 'next', serverDate }, now.toISOString()), /fixture/);
    assert.deepEqual(await a.cache.read(scope), active);
    a.connection.exec('DROP TRIGGER reject_staged_task');
    const next = await a.cache.page(scope, active, { items: [task('one')], nextPageToken: 'next', serverDate }, now.toISOString());
    await assert.rejects(b.cache.page(scope, active, { items: [task('poison')], serverDate }, now.toISOString()), { code: 'task_read_checkpoint_changed' });
    await b.cache.page(scope, next, { items: [task('two')], serverDate }, now.toISOString());
    assert.deepEqual((await a.cache.tasks(scope)).map(row => row.id), ['one', 'two']);
  } finally { a.connection.close(); b.connection.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Tasks checkpoints isolate account and list, preserve the earliest cutoff through pages and refuse a repeated cursor', async () => {
  const h = await setup();
  try {
    await h.read({ listTaskPage: async (_token, _list, query) => query.pageToken
      ? { items: [task('second')], serverDate: 'Thu, 05 Nov 2026 03:10:00 GMT' }
      : { items: [task('first')], nextPageToken: 'next', serverDate } });
    assert.equal((await h.cache.read(scope)).watermark, '2026-11-05T02:59:55.000Z');
    for (const other of [{ ...scope, accountSubject: 'account-b' }, { ...scope, taskListId: 'list-b' }]) {
      assert.equal((await h.cache.read(other)).complete, false);
      await h.read({ listTaskPage: async () => ({ items: [task('other')], serverDate }) }, now, other);
      assert.deepEqual((await h.cache.tasks(other)).map(row => row.id), ['other']);
    }
    await assert.rejects(h.read({ listTaskPage: async () => ({ items: [], nextPageToken: 'same', serverDate }) }), { code: 'task_read_restart' });
    assert.deepEqual((await h.cache.tasks(scope)).map(row => row.id), ['first', 'second']);
  } finally { h.connection.close(); }
});

test('Tasks caches without a server clock stay on full reads and a periodic full scan removes only confirmed absent cache entries', async () => {
  const h = await setup(); let calls = 0;
  try {
    const noClock = { listTaskPage: async (_token, _list, query) => { assert.equal(query.updatedMin, undefined); calls++; return { items: [task('one')] }; } };
    await h.read(noClock); await h.read(noClock); assert.equal(calls, 2); assert.equal((await h.cache.read(scope)).watermark, null);
    await h.read({ listTaskPage: async () => ({ items: [task('one')], serverDate }) });
    const rows = await h.read({ listTaskPage: async (_token, _list, query) => { assert.equal(query.updatedMin, undefined); return { items: [], serverDate }; } }, new Date(now.getTime() + 8 * 24 * 3600_000));
    assert.deepEqual(rows, []);
  } finally { h.connection.close(); }
});

test('a corrected backward device clock forces one full Tasks check and corrupt cache metadata rebuilds only that account and list', async () => {
  const h = await setup(); const other = { ...scope, accountSubject: 'account-b' };
  try {
    const api = { listTaskPage: async () => ({ items: [task('one')], serverDate }) };
    await h.read(api, new Date('2099-01-01T00:00:00Z')); await h.read(api, now, other);
    await h.read({ listTaskPage: async (_token, _list, query) => { assert.equal(query.updatedMin, undefined); return { items: [task('rechecked')], serverDate }; } });
    h.connection.exec("CREATE TABLE protected_operation_receipt(value TEXT); INSERT INTO protected_operation_receipt VALUES('do-not-delete');");
    h.connection.prepare('UPDATE private_google_task_read_control SET state_json=? WHERE account_subject=? AND task_list_id=?').run('not-json', scope.accountSubject, scope.taskListId);
    assert.equal((await h.cache.read(scope)).complete, false);
    assert.deepEqual((await h.cache.tasks(other)).map(row => row.id), ['one']);
    assert.equal(h.connection.prepare('SELECT value FROM protected_operation_receipt').get().value, 'do-not-delete');
    const rows = await h.read(api); assert.deepEqual(rows.map(row => row.id), ['one']);
  } finally { h.connection.close(); }
});

test('schema26 adds resumable Google read caches without changing schema25 settings history or task links', async () => {
  const h = await createIntegration({ cycleDays: 30 });
  try {
    const remote = [...h.tasks.values()][0]; remote.status = 'completed'; remote.completed = personalNow.toISOString();
    await h.sync();
    const before = { links: await repository.listGoogleTaskLinks(h.database), history: h.history(),
      settings: h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all() };
    assert.ok(before.history.length);
    h.connection.exec('DROP TABLE private_google_task_read_control; DROP TABLE private_google_task_read_items; DROP TABLE private_google_task_read_staging; PRAGMA user_version=25;');
    await migrateLocalDatabase(h.database); await migrateLocalDatabase(h.database);
    assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version, 27);
    assert.deepEqual(await repository.listGoogleTaskLinks(h.database), before.links);
    assert.deepEqual(h.history(), before.history);
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all(), before.settings);
    assert.ok(h.connection.prepare("SELECT name FROM sqlite_master WHERE name='private_google_task_read_staging'").get());
    assert.deepEqual(h.connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { h.connection.close(); }
});

test('the actual v2 Tasks store uses a private paged cache and a delta completion reaches the same signed occurrence once', async () => {
  const h = await googleFixture(); const queries = [];
  try {
    h.api.listTaskPage = async (token, list, query) => {
      queries.push(query); return { items: await h.api.listTasks(token, list), serverDate: v2Now().toUTCString() };
    };
    await h.connect(); await h.sync(); const item = (await h.entries())[0]; const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    h.tasks.get(link.googleTaskId).status = 'completed'; h.tasks.get(link.googleTaskId).completed = v2Now().toISOString(); h.tasks.get(link.googleTaskId).hidden = true;
    const second = await h.sync(); assert.equal(second.imported, 1); assert.ok(queries[1].updatedMin);
    assert.equal((await h.sync()).imported, 0);
    assert.equal(h.d.connection.prepare('SELECT count(*) AS n FROM private_google_task_read_control').get().n, 1);
    assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).googleTaskId, link.googleTaskId);
  } finally { h.close(); }
});

test('the personal SQLite Tasks adapter keeps cached IDs and imports a delta without duplicating completion history', async () => {
  const h = await createIntegration({ cycleDays: 30 }); const queries = [];
  try {
    const readPage = h.dependencies.api.listTaskPage;
    h.dependencies.api.listTaskPage = async (...args) => { queries.push(args[2]); return { ...await readPage(...args), serverDate: personalNow.toUTCString() }; };
    h.dependencies.taskReadCache = repository.personalGoogleTaskReadCache(h.database);
    await h.sync(); const remote = [...h.tasks.values()][0]; remote.status = 'completed'; remote.completed = personalNow.toISOString(); remote.hidden = true;
    assert.equal((await h.sync()).imported, 1); assert.ok(queries[1].updatedMin);
    assert.equal((await h.sync()).imported, 0); assert.equal(h.history().filter(row => row.schedule_entry_id === h.entries[0].id).length, 1);
  } finally { h.connection.close(); }
});

test('a delta-only Tasks worker never starts an initial full scan or a non-paged fallback', async () => {
  const h = await setup(); let calls = 0;
  try {
    for (const api of [{ listTasks: async () => { calls++; return []; } }, { listTaskPage: async () => { calls++; return { items: [] }; } }]) {
      await assert.rejects(readGoogleTasksCheckpointed({ api, cache: h.cache, scope, accessToken: 'test-token', now, deltaOnly: true }), { name: 'GoogleTaskFullSyncRequiredError' });
    }
    assert.equal(calls, 0); assert.equal((await h.cache.read(scope)).revision, 0);
    const unfinished = await h.cache.start(scope, await h.cache.read(scope), now.toISOString());
    await assert.rejects(readGoogleTasksCheckpointed({ api: { listTaskPage: async () => { calls++; return { items: [] }; } },
      cache: h.cache, scope, accessToken: 'test-token', now, deltaOnly: true }), { name: 'GoogleTaskFullSyncRequiredError' });
    assert.deepEqual(await h.cache.read(scope), unfinished); assert.equal(calls, 0);
  } finally { h.connection.close(); }
});

test('an expired background Tasks delta cursor retains its committed baseline and never falls back to a full HTTP read', async () => {
  const h = await setup(); let mode = 'initial'; const queries = [];
  try {
    const api = createGoogleTasksApi(async url => {
      const q = new URL(url).searchParams; queries.push(Object.fromEntries(q));
      if (mode === 'initial') return Response.json({ items: [task('original')] }, { headers: { Date: serverDate } });
      assert.ok(q.get('updatedMin'));
      if (q.get('pageToken')) return Response.json({ error: { message: 'expired page', errors: [{ reason: 'invalid' }] } }, { status: 410 });
      return Response.json({ items: [task('partial')], nextPageToken: 'expired' }, { headers: { Date: serverDate } });
    });
    await h.read(api); mode = 'expire';
    const input = { api, cache: h.cache, scope, accessToken: 'test-token', now, deltaOnly: true };
    await assert.rejects(readGoogleTasksCheckpointed(input), { name: 'GoogleTaskFullSyncRequiredError' });
    assert.deepEqual((await h.cache.tasks(scope)).map(row => row.id), ['original']);
    assert.equal((await h.cache.read(scope)).scan, null); assert.equal((await h.cache.read(scope)).watermark, null);
    const before = queries.length;
    await assert.rejects(readGoogleTasksCheckpointed(input), { name: 'GoogleTaskFullSyncRequiredError' });
    assert.equal(queries.length, before);
  } finally { h.connection.close(); }
});

for (const status of [400, 404, 410]) test(`a first-page background Tasks ${status} preserves data and defers destination or cursor repair to foreground`, async () => {
  const h = await setup(); let expired = false; const queries = [];
  try {
    const api = createGoogleTasksApi(async url => {
      const query = Object.fromEntries(new URL(url).searchParams); queries.push(query);
      return expired ? Response.json({ error: { message: 'cursor or destination unavailable' } }, { status })
        : Response.json({ items: [task('kept')] }, { headers: { Date: serverDate } });
    });
    await h.read(api); expired = true;
    await assert.rejects(readGoogleTasksCheckpointed({ api, cache: h.cache, scope, accessToken: 'test-token', now, deltaOnly: true }), { name: 'GoogleTaskFullSyncRequiredError' });
    assert.ok(queries[1].updatedMin); assert.equal(queries.length, 2);
    assert.deepEqual((await h.cache.tasks(scope)).map(row => row.id), ['kept']);
    assert.equal((await h.cache.read(scope)).watermark, null);
    expired = false; await h.read(api);
    assert.equal(queries.length, 3); assert.equal(queries[2].updatedMin, undefined);
  } finally { h.connection.close(); }
});

test('a delta-only Tasks worker resumes the saved delta page and never repeats the completed page', async () => {
  const h = await setup(); const queries = []; let stage = 'initial';
  try {
    const api = createGoogleTasksApi(async url => {
      const q = new URL(url).searchParams; queries.push(Object.fromEntries(q));
      if (stage === 'initial') return Response.json({ items: [task('old')] }, { headers: { Date: serverDate } });
      assert.equal(q.get('updatedMin'), '2026-11-05T02:59:55.000Z');
      if (!q.get('pageToken')) return Response.json({ items: [task('new')], nextPageToken: 'delta-two' }, { headers: { Date: 'Thu, 05 Nov 2026 03:01:00 GMT' } });
      assert.equal(q.get('pageToken'), 'delta-two');
      if (stage === 'fail') throw new TypeError('temporary offline');
      return Response.json({ items: [task('last')] }, { headers: { Date: 'Thu, 05 Nov 2026 03:01:10 GMT' } });
    });
    await h.read(api); stage = 'fail';
    const input = { api, cache: h.cache, scope, accessToken: 'test-token', now, deltaOnly: true };
    await assert.rejects(readGoogleTasksCheckpointed(input), TypeError);
    assert.equal((await h.cache.read(scope)).scan.pageToken, 'delta-two'); stage = 'finish';
    const result = await readGoogleTasksCheckpointed(input);
    assert.deepEqual(result.map(row => row.id).sort(), ['last', 'new', 'old']);
    assert.equal(queries.length, 4); assert.equal(queries.filter(q => q.updatedMin && !q.pageToken).length, 1);
  } finally { h.connection.close(); }
});

test('an aged Tasks baseline still receives background deltas while its periodic full rebuild waits for foreground', async () => {
  const h = await setup(); const queries = [];
  try {
    const api = createGoogleTasksApi(async url => { const q = new URL(url).searchParams; queries.push(Object.fromEntries(q));
      return Response.json({ items: [task(q.has('updatedMin') ? 'changed' : 'retained')] }, { headers: { Date: serverDate } }); });
    await h.read(api); const previous = await h.cache.read(scope); const later = new Date(now.getTime() + 8 * 24 * 3600_000);
    const delta = await readGoogleTasksCheckpointed({ api, cache: h.cache, scope, accessToken: 'test-token', now: later, deltaOnly: true });
    assert.deepEqual(delta.map(row => row.id).sort(), ['changed', 'retained']);
    assert.equal(queries[1].updatedMin, previous.watermark); assert.equal((await h.cache.read(scope)).lastFullAt, previous.lastFullAt);
    await h.read(api, later); assert.equal(queries.length, 3); assert.equal(queries[2].updatedMin, undefined);
    assert.equal((await h.cache.read(scope)).lastFullAt, later.toISOString());
  } finally { h.connection.close(); }
});
