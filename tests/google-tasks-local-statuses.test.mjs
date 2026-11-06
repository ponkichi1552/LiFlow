import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { now } from './helpers/sharing-v2-repository-fixture.mjs';
const { createV2GoogleTaskRuntime } = await import('../src/features/sharing/v2/google-tasks-runtime.ts');
const { withGoogleSyncOperation } = await import('../src/features/google-sync/operation-lock.ts');
const { reconcileLocalGoogleTaskStatuses } = await import('../src/features/google-sync/reconcile-google-tasks.ts');
const { GoogleTaskNotFoundError } = await import('../src/platform/google-tasks/google-tasks-api.ts');

function runtimeFor(h, extra = {}) {
  return createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('No account selection during automatic sync'); },
    authorizeTasks: async () => { throw new Error('No consent during automatic sync'); },
    verifyTaskListForLocalChanges: async state => state.taskListId === 'v2-private-list', createApi: () => h.api, ...extra });
}

test('an existing shared completion and Undo fit the worker without re-reading Google list metadata or remote pages', async () => {
  const h = await googleFixture(); const runtime = runtimeFor(h); let reads = 0;
  try {
    await h.connect(); assert.equal((await runtime.synchronize({ force: true })).kind, 'success');
    const originalIds = [...h.tasks.keys()]; const oldFullSuccess = (await h.store.readControl()).state.lastSuccessfulSyncAt;
    h.api.listTaskLists = async () => { reads++; throw new Error('A full remote scan cannot fit the remaining worker budget'); };
    h.api.listTasks = async () => { reads++; throw new Error('A status-only push must not scan remote tasks'); };
    const item = (await h.entries())[0]; const [done] = await h.actions.complete(item.target);
    const completed = await runtime.synchronize({ localChange: true, budgetMs: 15_000, deltaOnly: true });
    assert.equal(completed.kind, 'success'); assert.equal(completed.localStatusesOnly, true); assert.equal(completed.updated, 1);
    let link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(h.tasks.get(link.googleTaskId).status, 'completed'); assert.equal(link.pendingStatus, undefined);
    await h.actions.undo(done.operationId);
    const undone = await runtime.synchronize({ localChange: true, budgetMs: 15_000, deltaOnly: true });
    assert.equal(undone.kind, 'success'); assert.equal(undone.localStatusesOnly, true); assert.equal(undone.updated, 1);
    link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(h.tasks.get(link.googleTaskId).status, 'needsAction'); assert.equal(link.pendingStatus, undefined);
    assert.equal(reads, 0); assert.deepEqual([...h.tasks.keys()], originalIds);
    assert.equal((await h.store.readControl()).state.lastSuccessfulSyncAt, oldFullSuccess, 'A push cannot postpone the regular remote pull');
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

for (const reason of ['manual', 'full-period', 'canonical-changed', 'renamed']) test(`status pushes retain the normal reconciliation boundary: ${reason}`, async () => {
  const h = await googleFixture(); let clock = now(); let verified = true; let reads = 0; let patches = 0;
  const runtime = runtimeFor(h, { now: () => clock, verifyTaskListForLocalChanges: async () => verified });
  try {
    await h.connect(); assert.equal((await runtime.synchronize({ force: true })).kind, 'success');
    const item = (await h.entries())[0]; await h.actions.complete(item.target);
    const oldPatch = h.api.patchTask;
    h.api.patchTask = async (...args) => { patches++; return oldPatch(...args); };
    h.api.listTaskLists = async () => { reads++; throw new Error('Full reconciliation boundary observed'); };
    if (reason === 'full-period') clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    if (reason === 'canonical-changed') verified = false;
    if (reason === 'renamed') {
      const previous = h.store.port.readLocalStatusSnapshot;
      h.store.port.readLocalStatusSnapshot = async (...args) => { const value = await previous(...args); value.entries[0].choreName += ' changed'; return value; };
    }
    const result = await runtime.synchronize({ ...(reason === 'manual' ? { force: true } : { localChange: true }) });
    assert.notEqual(result.localStatusesOnly, true); assert.equal(reads, 1); assert.equal(patches, 0);
    assert.ok((await h.links()).some(link => link.pendingStatus), 'Deferred/failed reconciliation retains the local intention');
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

for (const status of ['authRequired', 'retryPending']) test(`a narrow push cannot bypass ${status}`, async () => {
  const h = await googleFixture(); let calls = 0; const runtime = runtimeFor(h, { verifyTaskListForLocalChanges: async () => { calls++; return true; } });
  try {
    await h.connect(); await runtime.synchronize({ force: true }); const item = (await h.entries())[0]; await h.actions.complete(item.target);
    const control = await h.store.readControl(); await h.store.saveSyncState({ ...control.state, status, nextRetryAt: new Date(now().getTime() + 60_000).toISOString() }, control.revision);
    const result = await runtime.synchronize({ localChange: true });
    assert.equal(result.skipped, true); assert.equal(calls, 0); assert.equal((await h.store.readControl()).state.status, status);
    assert.ok((await h.links()).some(link => link.pendingStatus));
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('an Undo committed during a status PATCH remains pending until the newer revision is acknowledged', async () => {
  const h = await googleFixture(); const runtime = runtimeFor(h);
  try {
    await h.connect(); await runtime.synchronize({ force: true }); const ids = [...h.tasks.keys()];
    const item = (await h.entries())[0]; const [done] = await h.actions.complete(item.target); let undone = false;
    h.hooks.afterPatch = async (_id, patch) => { if (!undone && patch.status === 'completed') { undone = true; await h.actions.undo(done.operationId); } };
    assert.equal((await runtime.synchronize({ localChange: true })).kind, 'success');
    let link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(link.pendingStatus, 'needsAction');
    assert.equal((await runtime.synchronize({ localChange: true })).kind, 'success');
    link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(link.pendingStatus, undefined); assert.equal(h.tasks.get(link.googleTaskId).status, 'needsAction'); assert.deepEqual([...h.tasks.keys()], ids);
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('a rejected or mismatched status response never acknowledges the local change', async () => {
  const h = await googleFixture(); const runtime = runtimeFor(h);
  try {
    await h.connect(); await runtime.synchronize({ force: true }); const item = (await h.entries())[0]; await h.actions.complete(item.target);
    h.api.patchTasksBatch = async (_token, _list, changes) => changes.map(change => ({ ok: true, task: { id: change.taskId, status: 'needsAction' } }));
    const result = await runtime.synchronize({ localChange: true }); assert.equal(result.kind, 'retry');
    assert.equal(result.code, 'mismatched_batch_task_status'); assert.ok((await h.links()).some(link => link.pendingStatus === 'completed'));
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('a partial status batch acknowledges only successful exact revisions and retries the remaining item without an inventory read', async () => {
  const h = await googleFixture(); let clock = now(); const runtime = runtimeFor(h, { now: () => clock });
  try {
    await h.connect(); await runtime.synchronize({ force: true }); const ids = [...h.tasks.keys()];
    for (const item of await h.entries()) await h.actions.complete(item.target);
    const originalBatch = h.api.patchTasksBatch;
    h.api.patchTasksBatch = async (token, list, changes) => Promise.all(changes.map((change, index) => index === 1
      ? { ok: false, status: 429, code: 'quota', retryAfter: null }
      : h.api.patchTask(token, list, change.taskId, change.patch).then(task => ({ ok: true, task }))));
    h.api.listTaskLists = h.api.listTasks = async () => { throw new Error('A retry must use the retained mapping'); };
    assert.deepEqual(await runtime.synchronize({ deltaOnly: true, localChange: true }), { kind: 'retry', code: 'quota' });
    assert.equal((await h.links()).filter(link => link.pendingStatus).length, 1);
    h.api.patchTasksBatch = originalBatch; clock = new Date(clock.getTime() + 3_600_001);
    const retry = await runtime.synchronize({ deltaOnly: true });
    assert.equal(retry.kind, 'success'); assert.equal(retry.localStatusesOnly, true); assert.equal(retry.updated, 1);
    assert.equal((await h.links()).some(link => link.pendingStatus), false);
    assert.deepEqual([...h.tasks.keys()], ids); assert.ok([...h.tasks.values()].every(task => task.status === 'completed'));
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('a status-only backlog is sent in batches of at most100 and retains every stable provider ID', async () => {
  const state = { taskListId: 'known-list', householdId: 'synthetic-private', accountSubject: 'synthetic-owner' };
  const entries = Array.from({ length: 225 }, (_, index) => ({ entry: { id: `round-${index}`, suggestedDate: '2026-10-27' },
    choreName: `家事${index}`, localRevision: `revision-${index}`, completedAt: '2026-10-27T01:00:00.000Z' }));
  const links = entries.map(item => ({ scheduleEntryId: item.entry.id, googleTaskListId: state.taskListId, googleTaskId: `provider-${item.entry.id}`,
    lastSyncedTitle: item.choreName, lastSyncedDueDate: item.entry.suggestedDate, lastSyncedStatus: 'needsAction',
    pendingStatus: 'completed', pendingStatusRevision: item.localRevision, observedLocalRevision: item.localRevision }));
  const batches = []; const acknowledged = [];
  const result = await reconcileLocalGoogleTaskStatuses({ state, today: '2026-10-27', accessToken: 'synthetic-token',
    repository: { readLocalStatusSnapshot: async () => ({ entries, links }), verifyTaskListForLocalChanges: async () => true,
      acknowledgeGoogleTaskStatus: async (link, status) => { acknowledged.push([link.googleTaskId, status]); } },
    api: { patchTasksBatch: async (_token, list, changes) => {
      assert.equal(list, state.taskListId); assert.ok(changes.length <= 100); batches.push(changes.length);
      assert.ok(changes.every(change => Object.keys(change.patch).sort().join(',') === 'completed,status'));
      return changes.map(change => ({ ok: true, task: { id: change.taskId, ...change.patch } }));
    } },
  });
  assert.deepEqual(batches, [100, 100, 25]); assert.equal(result.updated, 225); assert.equal(result.remoteTasksRead, 0);
  assert.deepEqual(acknowledged.map(row => row[0]), links.map(link => link.googleTaskId));
  assert.ok(acknowledged.every(row => row[1] === 'completed'));
});

for (const transport of ['batch', 'individual']) test(`a Google-deleted task defers its ${transport} status push and an automatic foreground retry repairs only the explicit Undo`, async () => {
  const h = await googleFixture(); const runtime = runtimeFor(h);
  try {
    await h.connect(); await runtime.synchronize({ force: true }); const item = (await h.entries())[0];
    const [done] = await h.actions.complete(item.target); await runtime.synchronize({ force: true });
    const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    h.tasks.get(link.googleTaskId).deleted = true; await h.actions.undo(done.operationId);
    const originalBatch = h.api.patchTasksBatch; const originalPatch = h.api.patchTask;
    if (transport === 'batch') h.api.patchTasksBatch = async () => [{ ok: false, status: 404, code: 'notFound', retryAfter: null }];
    else { h.api.patchTasksBatch = undefined; h.api.patchTask = async () => { throw new GoogleTaskNotFoundError(); }; }
    const deferred = await runtime.synchronize({ localChange: true, deltaOnly: true });
    assert.deepEqual(deferred, { kind: 'success', skipped: true, skipReason: 'foregroundRequired', foregroundRequired: true }); assert.equal(h.tasks.size, 3);
    assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).pendingStatus, 'needsAction');
    h.api.patchTasksBatch = originalBatch; h.api.patchTask = originalPatch;
    const resumed = await runtime.synchronize();
    assert.equal(resumed.kind, 'success'); assert.equal(resumed.created, 1); assert.equal(resumed.foregroundRequired, undefined);
    const replacement = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.notEqual(replacement.googleTaskId, link.googleTaskId); assert.equal(h.tasks.get(replacement.googleTaskId).status, 'needsAction');
    await runtime.synchronize({ force: true }); assert.equal(h.tasks.size, 4);
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});
