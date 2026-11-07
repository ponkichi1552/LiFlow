import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const { createGoogleTaskReadCache, initializeGoogleTaskReadCacheInside } = await import('../src/platform/storage/google-task-read-cache.ts');
const { readGoogleTasksCheckpointed, GoogleTaskFullSyncRequiredError } = await import('../src/features/google-sync/task-read-cache.ts');
const scope = { accountSubject: 'account', taskListId: 'list' };
const now = new Date('2026-11-07T03:00:00Z');
const task = (id, extra = {}) => ({ id, title: '家事', status: 'needsAction', updated: '2026-11-07T02:00:00Z', ...extra });

async function setup(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeGoogleTaskReadCacheInside(h.database);
  const cache = createGoogleTaskReadCache(async work => { let value; await h.database.withTransactionAsync(async () => { value = await work(h.database); }); return value; });
  return { ...h, cache, async full(tasks, at = now) {
    let state = await cache.start(scope, await cache.read(scope), at.toISOString());
    for (let offset = 0; offset < tasks.length || offset === 0; offset += 100) state = await cache.page(scope, state,
      { items: tasks.slice(offset, offset + 100), ...(offset + 100 < tasks.length ? { nextPageToken: `page-${offset + 100}` } : {}), serverDate: at.toUTCString() }, at.toISOString());
    return cache.tasks(scope);
  } };
}

test('audit100 a corrupt delta checkpoint cannot silently become a background full scan', async t => {
  const h = await setup(t); await h.full([task('one')]);
  const state = await h.cache.read(scope);
  state.scan = { mode: 'delta', updatedMin: null, pageToken: null, visitedTokens: [], cutoff: null, pages: 0 };
  h.connection.prepare('UPDATE private_google_task_read_control SET state_json=?').run(JSON.stringify(state));
  let requests = 0;
  await assert.rejects(readGoogleTasksCheckpointed({ cache: h.cache, scope, accessToken: 'test-token', now, deltaOnly: true,
    api: { listTaskPage: async () => { requests++; return { items: [], serverDate: now.toUTCString() }; } } }), GoogleTaskFullSyncRequiredError);
  assert.equal(requests, 0);
});

test('audit100 late older Tasks pages and acknowledgements cannot replace a newer observed provider version', async t => {
  const h = await setup(t); const newer = task('one', { status: 'completed', completed: '2026-11-07T02:30:00Z', updated: '2026-11-07T02:31:00Z' });
  let state = await h.cache.start(scope, await h.cache.read(scope), now.toISOString());
  state = await h.cache.page(scope, state, { items: [newer], nextPageToken: 'next', serverDate: now.toUTCString() }, now.toISOString());
  await h.cache.page(scope, state, { items: [task('one')], serverDate: now.toUTCString() }, now.toISOString());
  assert.equal((await h.cache.tasks(scope))[0].status, 'completed');
  await h.cache.written(scope, [task('one')]);
  assert.equal((await h.cache.tasks(scope))[0].updated, newer.updated);
});

test('audit100 unchanged acknowledgements and a periodic full inventory do not rewrite cached Tasks or invalidate row reuse', async t => {
  const h = await setup(t); const tasks = Array.from({ length: 500 }, (_, i) => task(`task-${i}`));
  await h.full(tasks);
  const revision = () => h.connection.prepare('SELECT revision FROM private_google_task_item_revisions WHERE account_subject=? AND task_list_id=?').get(scope.accountSubject, scope.taskListId).revision;
  const original = revision();
  await h.cache.written(scope, [tasks[0]]);
  assert.equal(revision(), original, 'an identical confirmed write must not invalidate the entire inventory');
  await h.full(tasks, new Date(now.getTime() + 8 * 86400_000));
  assert.equal(revision(), original, 'a periodic scan must replace only changed or absent rows');
  assert.equal((await h.cache.tasks(scope)).length, 500);
});

test('audit100 a rejected first delta page in foreground clears its cursor so the next attempt can rebuild instead of repeating it forever',async t=>{
 const h=await setup(t);await h.full([task('one')]);const {GoogleTasksApiError}=await import('../src/platform/google-tasks/google-tasks-api.ts');
 let queries=[];const api={listTaskPage:async(_token,_list,query)=>{queries.push(query);if(query.updatedMin)throw new GoogleTasksApiError(410,'expired_cursor',null);return{items:[task('two')],serverDate:now.toUTCString()};}};
 const input={cache:h.cache,scope,accessToken:'test-token',now,api};await assert.rejects(readGoogleTasksCheckpointed(input));
 assert.equal((await h.cache.read(scope)).scan,null);assert.equal((await h.cache.tasks(scope))[0].id,'one');
 assert.equal((await readGoogleTasksCheckpointed(input))[0].id,'two');assert.equal(queries.length,2);assert.equal(queries[1].updatedMin,undefined);
});
