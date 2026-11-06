import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { memoryTaskClaims } from './helpers/shared-task-claims.mjs';
import { now } from './helpers/sharing-v2-repository-fixture.mjs';
import { resolveSharedGoogleTaskList, sharedTaskListIdentity, verifySharedTaskListForLocalChanges } from '../src/features/google-sync/shared-task-list.ts';
import { sharedTaskIdHash } from '../src/features/google-sync/shared-task-claim.ts';
import { sharedGoogleListTitle } from '../src/features/google-sync/workspace-policy.ts';
import { createGoogleOperationBudget } from '../src/features/google-sync/operation-budget.ts';
import { sharedTaskCreateJournal } from '../src/features/google-sync/shared-task-create-journal.ts';
import { GoogleTasksApiError } from '../src/platform/google-tasks/google-tasks-api.ts';
const { reconcileGoogleTasks } = await import('../src/features/google-sync/reconcile-google-tasks.ts');
const { createV2GoogleTaskRuntime } = await import('../src/features/sharing/v2/google-tasks-runtime.ts');

function fixture() {
  const namespace = 'synthetic-private-namespace'; const accountSubject = 'synthetic-provider-account';
  const remote = memoryTaskClaims(namespace); const lists = []; const calls = []; const budget = createGoogleOperationBudget(10_000);
  let ordinal = 0; let access = true;
  const state = { householdId: namespace, accountSubject, enabled: true, status: 'idle', retryCount: 0, updatedAt: now().toISOString() };
  const context = { budget, assertCurrent: async () => { budget.assert(); if (!access) throw new Error('account changed'); } };
  const api = {
    async listTaskLists() { calls.push('read'); return structuredClone(lists); },
    async createTaskList(_token, title) { calls.push('create'); const row = { id: `list-${++ordinal}`, title }; lists.push(row); return { ...row }; },
  };
  const title = sharedGoogleListTitle(namespace);
  const resolve = (overrides = {}, cloud = remote.cloud) => resolveSharedGoogleTaskList({ state, accessToken: 'synthetic-token', api, title, lists: structuredClone(lists), ...overrides },
    { namespace, cloud: () => cloud, makeId: () => `attempt-${++ordinal}`, context });
  return { namespace, state, remote, lists, calls, api, context, resolve, title, identity: sharedTaskListIdentity(namespace, accountSubject),
    stop: () => { access = false; }, close: () => budget.close() };
}

test('a status-only shared list check accepts only the current canonical hashed destination without provider inventory or writes', async () => {
  const h = fixture();
  const verify = (state = { ...h.state, taskListId: 'known-list' }, cloud = h.remote.cloud) => verifySharedTaskListForLocalChanges(state, {
    namespace: h.namespace, cloud: () => cloud, context: h.context,
  });
  try {
    assert.equal(await verify(), false);
    await h.remote.cloud.linked(h.identity, 'known-list');
    assert.equal(await verify(), true); assert.deepEqual(h.calls, []);
    assert.equal(await verify({ ...h.state, taskListId: 'another-list' }), false);
    assert.equal(await verify({ ...h.state, accountSubject: 'another-account', taskListId: 'known-list' }), false);
    await assert.rejects(verify(undefined, { read: async identity => { const value = await h.remote.cloud.read(identity); h.stop(); return value; } }), /account changed/u);
    assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});

test('two independent SQLite clients starting with no Google list create one list and converge on the same task IDs', async () => {
  const devices = [await googleFixture(), await googleFixture()]; const lists = []; const tasks = new Map();
  const remote = memoryTaskClaims(devices[0].namespace); const budgets = devices.map(() => createGoogleOperationBudget(10_000));
  let initialReads = 0; let release; const barrier = new Promise(resolve => { release = resolve; });
  const api = {
    async listTaskLists() {
      const snapshot = structuredClone(lists);
      if (++initialReads <= 2) { if (initialReads === 2) release(); await barrier; }
      return snapshot;
    },
    async createTaskList(_token, title) { const row = { id: `list-${lists.length + 1}`, title }; lists.push(row); return { ...row }; },
    async listTasks(_token, listId) { return structuredClone([...tasks.values()].filter(row => row.listId === listId)); },
    async createTask(_token, listId, draft) { const row = { ...draft, id: `task-${tasks.size + 1}`, listId, status: 'needsAction' }; tasks.set(row.id, row); return structuredClone(row); },
    async getTask(_token, _listId, id) { return structuredClone(tasks.get(id)); },
    async patchTask() { throw new Error('unexpected patch'); }, async deleteTask() { throw new Error('unexpected delete'); },
  };
  try {
    await Promise.all(devices.map(h => h.connect())); let ordinal = 0;
    const ports = devices.map((h, index) => {
      const context = { budget: budgets[index], assertCurrent: async () => h.scope.assertAccess() };
      return { ...h.store.port, taskReadCache: undefined,
        taskCreateJournal: sharedTaskCreateJournal(h.store.port.taskCreateJournal, remote.cloud, context),
        resolveTaskList: request => resolveSharedGoogleTaskList(request, { namespace: h.namespace, cloud: () => remote.cloud, makeId: () => `attempt-${++ordinal}`, context }) };
    });
    const sync = async index => {
      const h = devices[index]; const control = await h.store.readControl();
      const result = await reconcileGoogleTasks({ state: control.state, accessToken: 'synthetic-token', api, repository: ports[index], now: now(), today: await h.store.readToday() });
      await h.store.saveSyncState({ ...control.state, taskListId: result.taskListId }, control.revision); return result;
    };
    const results = await Promise.allSettled([sync(0), sync(1)]);
    assert.ok(results.some(row => row.status === 'fulfilled'));
    for (const row of results) if (row.status === 'rejected') assert.ok(['task_create_result_pending', 'task_list_create_result_pending'].includes(row.reason.code));
    await sync(0); await sync(1);
    assert.equal(lists.length, 1); assert.equal(tasks.size, 3);
    assert.equal(new Set([...tasks.values()].map(row => row.notes)).size, 3);
    const links = await Promise.all(devices.map(h => h.links()));
    assert.equal(links[0].length, 3); assert.deepEqual(links[0].map(row => row.googleTaskId).sort(), links[1].map(row => row.googleTaskId).sort());
    for (const row of remote.rows.values()) assert.equal(row.phase, 'linked');
    const receipts = JSON.stringify([...remote.rows.values()]);
    for (const raw of ['synthetic-token', 'synthetic-google-subject', lists[0].id, 'LiFlow occurrence:']) assert.equal(receipts.includes(raw), false);
  } finally { budgets.forEach(budget => budget.close()); devices.forEach(h => h.close()); }
});

test('a canonical shared list is recovered by hashed ID after a rename without creating or moving tasks', async () => {
  const h = fixture();
  try {
    h.lists.push({ id: 'old-list', title: h.title }); await h.resolve();
    h.lists[0].title = '本人が変更した名前';
    const result = await h.resolve(); assert.equal(result.id, 'old-list'); assert.deepEqual(h.calls, []);
    assert.equal([...h.remote.rows.values()][0].taskHash, sharedTaskIdHash('old-list'));
    assert.equal(JSON.stringify([...h.remote.rows.values()]).includes('old-list'), false);
  } finally { h.close(); }
});

test('list creation rechecks the provider after its grant and adopts an existing list instead of posting again', async () => {
  const h = fixture();
  try {
    const cloud = { ...h.remote.cloud, async reserveBatch(intents) {
      const result = await h.remote.cloud.reserveBatch(intents); h.lists.push({ id: 'appeared-list', title: h.title }); return result;
    } };
    assert.equal((await h.resolve({}, cloud)).id, 'appeared-list'); assert.deepEqual(h.calls, ['read']);
  } finally { h.close(); }
});

test('ambiguous old shared lists and conflicting saved mappings are preserved without provider writes', async () => {
  const h = fixture();
  try {
    h.lists.push({ id: 'first-list', title: h.title }, { id: 'second-list', title: h.title });
    await assert.rejects(h.resolve(), error => error.code === 'ambiguous_task_list');
    assert.equal(h.remote.rows.size, 0); assert.deepEqual(h.calls, []);
    await h.remote.cloud.linked(h.identity, 'first-list');
    await assert.rejects(h.resolve({ state: { ...h.state, taskListId: 'second-list' } }), error => error.code === 'ambiguous_task_list');
    assert.deepEqual(h.calls, []); assert.equal(h.lists.length, 2);
  } finally { h.close(); }
});

test('an uncertain list insert or creation grant never opens a second POST on another device or restart', async () => {
  for (const stage of ['grant', 'insert']) {
    const h = fixture();
    try {
      const cloud = stage === 'grant' ? { ...h.remote.cloud, async reserveBatch(intents) {
        await h.remote.cloud.reserveBatch(intents); throw new Error('lost grant response');
      } } : h.remote.cloud;
      if (stage === 'insert') h.api.createTaskList = async () => { h.calls.push('create'); throw new GoogleTasksApiError(503, 'lost_insert_response', null); };
      await assert.rejects(h.resolve({}, cloud));
      assert.equal([...h.remote.rows.values()][0].phase, 'reserved');
      for (let i = 0; i < 2; i++) await assert.rejects(h.resolve(), error => error.code === 'task_list_create_result_pending');
      assert.equal(h.calls.filter(call => call === 'create').length, stage === 'insert' ? 1 : 0);
    } finally { h.close(); }
  }
});

test('only definitive list insert rejection releases its exact grant for a fresh retry', async () => {
  const h = fixture();
  try {
    const original = h.api.createTaskList;
    h.api.createTaskList = async () => { throw new GoogleTasksApiError(429, 'quota', null); };
    await assert.rejects(h.resolve(), error => error.code === 'quota'); assert.equal([...h.remote.rows.values()][0].phase, 'released');
    h.api.createTaskList = original;
    assert.ok((await h.resolve()).id); assert.equal(h.lists.length, 1);
  } finally { h.close(); }
});

test('a failed list reread before POST releases only the known unused creation grant', async () => {
  const h = fixture();
  try {
    const original = h.api.listTaskLists;
    h.api.listTaskLists = async () => { throw new TypeError('network unavailable before POST'); };
    await assert.rejects(h.resolve(), /before POST/u);
    assert.equal([...h.remote.rows.values()][0].phase, 'released'); assert.deepEqual(h.calls, []);
    h.api.listTaskLists = original;
    assert.ok((await h.resolve()).id); assert.equal(h.lists.length, 1);
  } finally { h.close(); }
});

test('confirmed deletion of the exact canonical list permits one replacement but a lost local ID does not', async () => {
  const h = fixture();
  try {
    h.lists.push({ id: 'old-list', title: h.title }); await h.resolve(); h.lists.splice(0);
    await assert.rejects(h.resolve(), error => error.code === 'task_list_create_result_pending'); assert.deepEqual(h.calls, []);
    const restored = await h.resolve({ state: { ...h.state, taskListId: 'old-list' } });
    assert.notEqual(restored.id, 'old-list'); assert.equal(h.lists.length, 1); assert.equal(h.calls.filter(call => call === 'create').length, 1);
  } finally { h.close(); }
});

test('account changes and an exhausted budget stop list creation before a provider POST', async () => {
  const h = fixture();
  try {
    const cloud = { ...h.remote.cloud, async reserveBatch(intents) { const result = await h.remote.cloud.reserveBatch(intents); h.stop(); return result; } };
    await assert.rejects(h.resolve({}, cloud), /account changed/u); assert.deepEqual(h.calls, []);
    assert.equal([...h.remote.rows.values()][0].phase, 'reserved');
    h.context.budget.cancel(); await assert.rejects(h.resolve(), error => error.name === 'AbortError'); assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});

test('transient Firestore list-claim failures retain retry backoff and recover automatically without duplicate inserts', async () => {
  for (const code of ['unavailable', 'deadline-exceeded', 'aborted', 'resource-exhausted']) {
    const h = await googleFixture(); const remote = memoryTaskClaims(h.namespace); let clock = now(); let failures = 1; let sequence = 0;
    const cloud = { ...remote.cloud, async read(identity) {
      if (failures-- > 0) throw Object.assign(new Error('temporary Firestore failure'), { code });
      return remote.cloud.read(identity);
    } };
    const runtime = createV2GoogleTaskRuntime({ store: h.store, now: () => clock, assertAccess: h.scope.assertAccess,
      currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token', createApi: () => h.api,
      restoreAccount: async () => { throw new Error('automatic recovery cannot select accounts'); },
      authorizeTasks: async () => { throw new Error('automatic recovery cannot request consent'); },
      resolveTaskList: (request, context) => resolveSharedGoogleTaskList(request, { namespace: h.namespace, cloud: () => cloud, makeId: () => `attempt-${++sequence}`, context }),
      wrapCreateJournal: (journal, context) => sharedTaskCreateJournal(journal, cloud, context) });
    try {
      await h.connect(); assert.deepEqual(await runtime.synchronize(), { kind: 'retry', code });
      const waiting = (await h.store.readControl()).state; assert.equal(waiting.status, 'retryPending');
      assert.equal(waiting.nextRetryAt, new Date(clock.getTime() + 3_600_000).toISOString());
      assert.equal(h.tasks.size, 0); assert.equal(remote.rows.size, 0);
      assert.deepEqual(await runtime.synchronize({ localChange: true }), { kind: 'success', skipped: true });
      clock = new Date(clock.getTime() + 3_600_001);
      assert.equal((await runtime.synchronize()).kind, 'success');
      const ids = [...h.tasks.keys()]; assert.equal(ids.length, 3);
      assert.equal((await h.store.readControl()).state.status, 'idle');
      await runtime.synchronize({ force: true }); assert.deepEqual([...h.tasks.keys()], ids);
      assert.equal(h.calls.filter(row => row[0] === 'list').length, 1);
    } finally { h.close(); }
  }
});
