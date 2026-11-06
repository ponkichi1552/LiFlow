import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { probeConditionalTasksDelete } from './native/google-tasks/conditional-delete-probe.mjs';
const { createGoogleTasksApi } = await import('../src/platform/google-tasks/google-tasks-api.ts');
const nonce = '00000000-0000-4000-8000-000000000001';
function service({ enforce = true, renameList = false } = {}) {
  let list; let task; const calls = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname; const method = init.method ?? 'GET'; calls.push([path, method]);
    if (path === '/tasks/v1/users/@me/lists' && method === 'POST') { list = { id: 'isolated-qa-list', ...JSON.parse(init.body) }; return Response.json(list); }
    if (path === '/tasks/v1/users/@me/lists/isolated-qa-list') {
      if (method === 'DELETE') { list = null; return new Response(null, { status: 204 }); }
      return Response.json({ ...list, ...(renameList ? { title: 'do not delete this renamed list' } : {}) });
    }
    if (path === '/tasks/v1/lists/isolated-qa-list/tasks' && method === 'POST') { task = { ...JSON.parse(init.body), id: 'qa-task', etag: '"v1"', status: 'needsAction' }; return Response.json(task); }
    if (path === '/tasks/v1/lists/isolated-qa-list/tasks/qa-task') {
      if (!task) return new Response(null, { status: 404 });
      if (method === 'PATCH') { Object.assign(task, JSON.parse(init.body), { etag: '"v2"' }); return Response.json(task); }
      if (method === 'DELETE') {
        if (enforce && init.headers['If-Match'] !== task.etag) return Response.json({ error: { status: 'conditionNotMet' } }, { status: 412 });
        task = null; return new Response(null, { status: 204 });
      }
      return Response.json(task);
    }
    throw new Error('unexpected resource');
  };
  return { fetcher, calls, read: () => ({ list, task }) };
}

test('conditional-delete probe distinguishes enforcement from an ignored header and uses only its newly created synthetic list', async () => {
  for (const enforce of [true, false]) {
    const h = service({ enforce }); const api = createGoogleTasksApi(h.fetcher);
    const evidence = await probeConditionalTasksDelete({ api, fetcher: h.fetcher, accessToken: 'synthetic-token', nonce });
    assert.equal(evidence.passed, enforce); assert.equal(evidence.staleDeleteStatus, enforce ? 412 : 204); assert.equal(evidence.cleanupSucceeded, true);
    assert.equal(h.read().list, null); assert.ok(!JSON.stringify(evidence).includes('synthetic-token'));
    assert.ok(h.calls.every(([path]) => path === '/tasks/v1/users/@me/lists' || path.includes('/isolated-qa-list')));
  }
});

test('conditional-delete probe refuses uncertain cleanup after its synthetic list identity changes', async () => {
  const h = service({ renameList: true }); const api = createGoogleTasksApi(h.fetcher);
  const evidence = await probeConditionalTasksDelete({ api, fetcher: h.fetcher, accessToken: 'synthetic-token', nonce });
  assert.equal(evidence.passed, false); assert.equal(evidence.cleanupSucceeded, false); assert.ok(h.read().list);
  assert.equal(h.calls.filter(([path, method]) => path.includes('/users/@me/lists/') && method === 'DELETE').length, 0);
  await assert.rejects(probeConditionalTasksDelete({ api, nonce: 'not-unique', accessToken: 'synthetic-token' }), /nonce/);
});
