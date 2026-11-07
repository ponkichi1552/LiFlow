import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { reconcileGoogleTasks } = await import('../src/features/google-sync/reconcile-google-tasks.ts');
const { GoogleTaskNotFoundError, GoogleTasksApiError } = await import('../src/platform/google-tasks/google-tasks-api.ts');
const { personalGoogleOccurrenceNote, sharedGoogleOccurrenceNote } = await import('../src/features/google-sync/workspace-policy.ts');
const intents = await import('../src/platform/storage/google-task-create-intents.ts');
const { createGoogleOperationBudget } = await import('../src/features/google-sync/operation-budget.ts');
const { createGoogleTasksApi } = await import('../src/platform/google-tasks/google-tasks-api.ts');
const householdId = 'local-household';
const taskListId = 'list-1';
const now = new Date('2026-10-25T12:00:00.000Z');

async function attachDurableCreates(h, database) {
  await intents.initializeGoogleTaskCreateIntentsInside(database);
  let sequence = 0;
  h.repository.taskCreateJournal = {
    reserve: identity => intents.reserveGoogleTaskCreateInside(database, { ...identity, attemptId: `attempt-${++sequence}`, startedAt: now.toISOString() }),
    reject: intent => intents.rejectGoogleTaskCreateInside(database, intent),
    linked: (identity, taskId) => intents.linkGoogleTaskCreateInside(database, identity, taskId),
    deleted: (identity, taskId) => intents.deleteGoogleTaskCreateInside(database, identity, taskId),
  };
}

test('a durable Tasks insert intent survives restart and a temporarily missing response without another POST', async () => {
  const { database, connection } = createDatabase();
  try {
    const h = createHarness({ entries: [entry('durable')] }); await attachDurableCreates(h, database);
    const send = h.api.createTasksBatch.bind(h.api);
    h.api.createTasksBatch = async (...args) => {
      assert.equal(connection.prepare('SELECT count(*) n FROM private_google_task_create_intents WHERE remote_task_id IS NULL').get().n, 1);
      await send(...args); throw new Error('connection lost after commit');
    };
    await assert.rejects(reconcile(h), /connection lost/);
    // New adapter, same durable database; emulate a stale remote page before its new ID becomes visible.
    await attachDurableCreates(h, database);
    const read = h.api.listTasks.bind(h.api); h.api.listTasks = async () => [];
    h.api.createTasksBatch = send;
    await assert.rejects(reconcile(h), error => error.code === 'task_create_result_pending');
    assert.equal(h.api.calls.create, 1);
    h.api.listTasks = read;
    h.repository.entries[0] = entry('durable', { choreName: '変更した家事' });
    await reconcile(h);
    assert.equal(h.api.calls.create, 1); assert.equal(h.repository.links[0].googleTaskId, 'task-1');
    assert.equal(connection.prepare('SELECT remote_task_id FROM private_google_task_create_intents').get().remote_task_id, 'task-1');
  } finally { connection.close(); }
});

test('an uncertain Tasks insert leaves other occurrences synchronizable and a definitive rejection permits retry', async () => {
  const { database, connection } = createDatabase();
  try {
    const h = createHarness({ entries: [entry('pending')] }); await attachDurableCreates(h, database);
    const send = h.api.createTasksBatch.bind(h.api);
    h.api.createTasksBatch = async () => [{ requestId: 'request-0', ok: false, status: 503, code: 'unknown_commit' }];
    await assert.rejects(reconcile(h));
    h.repository.entries.push(entry('independent'));
    h.api.createTasksBatch = send;
    await assert.rejects(reconcile(h), error => error.code === 'task_create_result_pending');
    assert.equal(h.api.calls.create, 1); assert.equal(h.repository.links[0].scheduleEntryId, 'independent');
    const h2 = createHarness({ entries: [entry('rejected')] }); await attachDurableCreates(h2, database);
    h2.api.createTasksBatch = async () => [{ requestId: 'request-0', ok: false, status: 429, code: 'quota' }];
    await assert.rejects(reconcile(h2));
    h2.api.createTasksBatch = send;
    await reconcile(h2); assert.equal(h2.repository.links.length, 1);
  } finally { connection.close(); }
});

for (const batch of [true, false]) test(`a budget exhausted before ${batch ? 'batch' : 'individual'} Tasks transport releases only unsent reservations for a normal retry`, async () => {
  const { database, connection } = createDatabase(); const budget = createGoogleOperationBudget(1000); let sent = 0;
  try {
    const h = createHarness({ entries: [entry('one'), entry('two')] }); await attachDurableCreates(h, database);
    const reserve = h.repository.taskCreateJournal.reserve; let reservations = 0;
    h.repository.taskCreateJournal.reserve = async identity => {
      const result = await reserve(identity); if (++reservations === 2) budget.cancel(); return result;
    };
    const raw = createGoogleTasksApi(async () => { sent++; throw new Error('must not send'); }, undefined, { budget });
    const batchCreate = h.api.createTasksBatch; const create = h.api.createTask;
    h.api.createTasksBatch = batch ? raw.createTasksBatch : undefined; h.api.createTask = raw.createTask;
    await assert.rejects(reconcile(h)); assert.equal(sent, 0);
    assert.equal(connection.prepare('SELECT count(*) AS n FROM private_google_task_create_intents').get().n, 0);
    h.api.createTasksBatch = batchCreate; h.api.createTask = create; h.repository.taskCreateJournal.reserve = reserve;
    assert.equal((await reconcile(h)).created, 2); assert.equal(h.repository.links.length, 2);
  } finally { budget.close(); connection.close(); }
});

test('a later failed local Tasks reservation releases earlier unissued intents without marking a lost HTTP reply as safe', async () => {
  const { database, connection } = createDatabase();
  try {
    const h = createHarness({ entries: [entry('one'), entry('two')] }); await attachDurableCreates(h, database);
    const reserve = h.repository.taskCreateJournal.reserve; let reservations = 0;
    h.repository.taskCreateJournal.reserve = async identity => { if (++reservations === 2) throw new Error('fixture reservation failure'); return reserve(identity); };
    await assert.rejects(reconcile(h), /fixture reservation failure/);
    assert.equal(h.api.calls.create, 0);
    assert.equal(connection.prepare('SELECT count(*) AS n FROM private_google_task_create_intents').get().n, 0);
    h.repository.taskCreateJournal.reserve = reserve; assert.equal((await reconcile(h)).created, 2);
  } finally { connection.close(); }
});

test('confirmed deletion repairs a journaled task while a stale absence cannot duplicate an already linked insert', async () => {
  const { database, connection } = createDatabase();
  try {
    const h = createHarness({ entries: [entry('repair')] }); await attachDurableCreates(h, database);
    await reconcile(h);
    const saved = { ...h.repository.links[0] };
    h.repository.links = []; const read = h.api.listTasks.bind(h.api); h.api.listTasks = async () => [];
    await assert.rejects(reconcile(h), error => error.code === 'task_create_result_pending');
    assert.equal(h.api.calls.create, 1);
    h.repository.links = [saved]; h.api.listTasks = read;
    h.api.tasks.get(`${taskListId}/task-1`).deleted = true;
    await reconcile(h); assert.equal(h.api.calls.create, 2); assert.equal(h.repository.links[0].googleTaskId, 'task-2');
  } finally { connection.close(); }
});

test('Tasks create receipts fence independent SQLite connections, survive reopening and isolate account and list scopes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-task-create-')); const path = join(directory, 'private.sqlite');
  const a = createDatabase(path); const b = createDatabase(path); let reopened;
  try {
    await intents.initializeGoogleTaskCreateIntentsInside(a.database);
    const identity = { accountSubject: 'account-a', taskListId: 'list-a', occurrenceMarker: 'stable-marker' };
    const first = { ...identity, attemptId: 'first', startedAt: now.toISOString() };
    assert.deepEqual(await intents.reserveGoogleTaskCreateInside(a.database, first), first);
    assert.equal(await intents.reserveGoogleTaskCreateInside(b.database, { ...first, attemptId: 'second' }), null);
    await intents.linkGoogleTaskCreateInside(b.database, identity, 'confirmed-task');
    await intents.rejectGoogleTaskCreateInside(a.database, first);
    assert.equal(a.connection.prepare('SELECT remote_task_id FROM private_google_task_create_intents').get().remote_task_id, 'confirmed-task');
    a.connection.close(); b.connection.close(); reopened = createDatabase(path);
    assert.equal(await intents.reserveGoogleTaskCreateInside(reopened.database, first), null);
    for (const other of [{ ...first, accountSubject: 'account-b' }, { ...first, taskListId: 'list-b' }]) {
      assert.ok(await intents.reserveGoogleTaskCreateInside(reopened.database, other));
    }
    await intents.deleteGoogleTaskCreateInside(reopened.database, identity, 'wrong-task');
    assert.equal(await intents.reserveGoogleTaskCreateInside(reopened.database, first), null);
    await intents.deleteGoogleTaskCreateInside(reopened.database, identity, 'confirmed-task');
    assert.ok(await intents.reserveGoogleTaskCreateInside(reopened.database, { ...first, attemptId: 'repair' }));
  } finally {
    if (a.connection.isOpen) a.connection.close(); if (b.connection.isOpen) b.connection.close(); reopened?.connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a durable Tasks repair never patches an old-list task ID through the new list', async () => {
  const { database, connection } = createDatabase();
  try {
    const h = createHarness({ entries: [entry('relocated')] }); await attachDurableCreates(h, database);
    await reconcile(h);
    const previous = { ...h.repository.links[0] };
    h.api.taskLists = [{ id: 'replacement-list', title: '家事Planner' }];
    const patch = h.api.patchTasksBatch.bind(h.api);
    h.api.patchTasksBatch = async (_token, listId, rows) => {
      assert.equal(listId, 'replacement-list'); assert.ok(rows.every(row => row.taskId !== previous.googleTaskId));
      return patch(_token, listId, rows);
    };
    const result = await reconcile(h); assert.equal(result.created, 1);
    assert.equal(h.repository.links[0].googleTaskListId, 'replacement-list');
    assert.notEqual(h.repository.links[0].googleTaskId, previous.googleTaskId);
  } finally { connection.close(); }
});

function entry(id, overrides = {}) {
  return {
    entry: {
      id,
      householdId,
      choreId: `chore-${id}`,
      cycleBaseDate: '2026-10-26',
      windowStart: '2026-10-25',
      windowEnd: '2026-10-27',
      suggestedDate: '2026-10-26',
      status: 'scheduled',
      assignedMemberIds: [],
    },
    choreName: `家事 ${id}`,
    ...overrides,
  };
}

function createHarness({ entries = [], links = [], tasks = [], taskLists = [{ id: taskListId, title: '家事Planner' }] } = {}) {
  const repository = {
    entries: [...entries],
    links: [...links],
    async listEntriesForGoogleSync() { return [...this.entries]; },
    async listGoogleTaskLinks() { return [...this.links]; },
    async upsertGoogleTaskLink(link) {
      this.links = [...this.links.filter((item) => item.scheduleEntryId !== link.scheduleEntryId), link];
    },
    async deleteGoogleTaskLink(scheduleEntryId) {
      this.links = this.links.filter((item) => item.scheduleEntryId !== scheduleEntryId);
    },
    async importGoogleTaskChanges() { return 0; },
    async acknowledgeGoogleTaskStatus(link, status) {
      if (!this.links) return;
      this.links = this.links.map((item) => item.scheduleEntryId === link.scheduleEntryId
        ? { ...item, lastSyncedStatus: status, pendingStatus: undefined, pendingStatusRevision: undefined } : item);
    },
  };
  const state = { householdId, enabled: true, taskListId, status: 'idle', retryCount: 0, updatedAt: now.toISOString() };
  const api = {
    taskLists: [...taskLists],
    tasks: new Map(tasks.map((task) => [`${task.taskListId}/${task.id}`, { etag: `"${task.id}-version-1"`, ...task }])),
    calls: { createList: 0, create: 0, batchSizes: [], patchBatchSizes: [], patch: [], deleted: [], get: 0, list: 0 },
    async listTaskLists() { return [...this.taskLists]; },
    async listTasks(_token, listId) {
      this.calls.list += 1;
      return [...this.tasks.values()].filter((task) => task.taskListId === listId).map((task) => ({ ...task }));
    },
    async createTaskList(_token, title) {
      this.calls.createList += 1;
      const created = { id: `new-list-${this.calls.createList}`, title };
      this.taskLists.push(created);
      return created;
    },
    async getTask(_token, listId, id) {
      this.calls.get += 1;
      const task = this.tasks.get(`${listId}/${id}`);
      if (!task) throw new GoogleTaskNotFoundError();
      return { ...task };
    },
    async createTask(_token, listId, draft) {
      this.calls.create += 1;
      const task = { id: `task-${this.calls.create}`, ...draft, taskListId: listId, status: 'needsAction' };
      this.tasks.set(`${listId}/${task.id}`, task);
      return { ...task };
    },
    async createTasksBatch(_token, listId, drafts) {
      this.calls.batchSizes.push(drafts.length);
      const results = [];
      for (const [index, draft] of drafts.entries()) {
        const task = await this.createTask('token', listId, draft);
        results.push({ requestId: `request-${index}`, ok: true, task });
      }
      return results;
    },
    async patchTask(_token, listId, id, patch) {
      this.calls.patch.push({ id, patch: { ...patch } });
      const key = `${listId}/${id}`;
      const task = { ...this.tasks.get(key), ...patch };
      this.tasks.set(key, task);
      return { ...task };
    },
    async patchTasksBatch(_token, listId, updates) {
      this.calls.patchBatchSizes.push(updates.length);
      return Promise.all(updates.map(async ({ taskId, patch }, index) => ({
        requestId: `request-${index}`, ok: true, task: await this.patchTask('token', listId, taskId, patch),
      })));
    },
    async deleteTask(_token, listId, id) {
      this.calls.deleted.push(id);
      this.tasks.delete(`${listId}/${id}`);
    },
  };
  return { repository, api, state };
}

function link(scheduleEntryId, googleTaskId, overrides = {}) {
  return {
    scheduleEntryId,
    householdId,
    choreId: `chore-${scheduleEntryId}`,
    googleTaskListId: taskListId,
    googleTaskId,
    lastSyncedTitle: `家事 ${scheduleEntryId}`,
    lastSyncedDueDate: '2026-10-26',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

async function reconcile(harness, time = now) {
  return reconcileGoogleTasks({
    accessToken: 'access-token',
    state: harness.state,
    repository: harness.repository,
    api: harness.api,
    now: time,
    today: '2026-10-25',
  });
}

test('reconciliation creates once, then updates the same Google Task for title, due date, and app completion', async () => {
  const harness = createHarness({ entries: [entry('entry-1')] });
  await reconcile(harness);
  const savedLink = harness.repository.links[0];
  const taskKey = `${taskListId}/${savedLink.googleTaskId}`;
  assert.equal(harness.api.calls.create, 1);
  assert.deepEqual(harness.api.tasks.get(taskKey), {
    id: savedLink.googleTaskId,
    title: '家事 entry-1',
    due: '2026-10-26T00:00:00.000Z',
    notes: personalGoogleOccurrenceNote(householdId, householdId, 'entry-1'),
    taskListId,
    status: 'needsAction',
  });

  harness.repository.entries = [entry('entry-1', {
    choreName: '新しい家事名',
    entry: { ...entry('entry-1').entry, suggestedDate: '2026-10-28' },
  })];
  await reconcile(harness, new Date(now.getTime() + 1000));
  assert.equal(harness.api.calls.create, 1);
  assert.deepEqual(harness.api.calls.patch.at(-1), {
    id: savedLink.googleTaskId,
    patch: { title: '新しい家事名', due: '2026-10-28T00:00:00.000Z' },
  });

  harness.repository.entries = [entry('entry-1', {
    choreName: '新しい家事名',
    completedAt: '2026-10-25T11:30:00.000Z',
    entry: { ...entry('entry-1').entry, suggestedDate: '2026-10-28' },
  })];
  await reconcile(harness, new Date(now.getTime() + 2000));
  assert.deepEqual(harness.api.calls.patch.at(-1), {
    id: savedLink.googleTaskId,
    patch: { status: 'completed', completed: '2026-10-25T11:30:00.000Z' },
  });
});

test('new tasks are created only through the rolling two-week window', async () => {
  const harness = createHarness({ entries: [
    entry('near-window'),
    entry('outside-window', { entry: { ...entry('outside-window').entry, suggestedDate: '2026-11-09' } }),
  ] });

  await reconcile(harness);

  assert.equal(harness.api.calls.create, 1);
  assert.deepEqual(harness.repository.links.map((item) => item.scheduleEntryId), ['near-window']);
  assert.equal(harness.api.tasks.size, 1);
});

test('new task creation is split into batches of at most 100 requests', async () => {
  const harness = createHarness({ entries: Array.from({ length: 205 }, (_, index) => entry(`batch-${index}`)) });

  await reconcile(harness);

  assert.deepEqual(harness.api.calls.batchSizes, [100, 100, 5]);
  assert.equal(harness.api.calls.batchSizes.every((size) => size <= 100), true);
  assert.equal(harness.api.calls.create, 205);
  assert.equal(harness.repository.links.length, 205);
});

test('205 linked tasks moved beyond the creation window keep their IDs and update in batches of 100, 100, 5', async () => {
  const entries = Array.from({ length: 205 }, (_, index) => entry(`moved-${index}`, {
    entry: { ...entry(`moved-${index}`).entry, suggestedDate: '2026-11-30' },
  }));
  const links = entries.map(({ entry }) => link(entry.id, `existing-${entry.id}`));
  const tasks = links.map((link) => ({ id: link.googleTaskId, taskListId, title: link.lastSyncedTitle,
    due: '2026-10-26T00:00:00.000Z', status: 'needsAction' }));
  const harness = createHarness({ entries, links, tasks });

  const result = await reconcile(harness);
  assert.equal(result.updated, 205);
  assert.deepEqual(harness.api.calls.patchBatchSizes, [100, 100, 5]);
  assert.equal(harness.api.calls.create, 0);
  assert.equal(harness.api.calls.deleted.length, 0);
  assert.deepEqual(harness.repository.links.map((link) => link.googleTaskId), links.map((link) => link.googleTaskId));
  assert.ok([...harness.api.tasks.values()].every((task) => task.due === '2026-11-30T00:00:00.000Z'));

  assert.equal((await reconcile(harness)).updated, 0);
  assert.deepEqual(harness.api.calls.patchBatchSizes, [100, 100, 5]);
});

test('partial update failures acknowledge successes and retry only the failed linked task', async () => {
  const entries = ['one', 'two', 'three'].map((id) => entry(id, {
    entry: { ...entry(id).entry, suggestedDate: '2026-10-28' },
  }));
  const links = entries.map(({ entry }) => link(entry.id, `existing-${entry.id}`));
  const tasks = links.map((link) => ({ id: link.googleTaskId, taskListId, title: link.lastSyncedTitle,
    due: '2026-10-26T00:00:00.000Z', status: 'needsAction' }));
  const harness = createHarness({ entries, links, tasks });
  let failOnce = true;
  harness.api.patchTasksBatch = async (_token, listId, updates) => {
    harness.api.calls.patchBatchSizes.push(updates.length);
    const results = [];
    for (const [index, update] of updates.entries()) {
      results.push(failOnce && index === 1
        ? { requestId: `request-${index}`, ok: false, status: 429, code: 'RESOURCE_EXHAUSTED', retryAfter: '3600' }
        : { requestId: `request-${index}`, ok: true,
          task: await harness.api.patchTask('token', listId, update.taskId, update.patch) });
    }
    failOnce = false;
    return results;
  };

  await assert.rejects(reconcile(harness), (error) => error.status === 429 && Date.parse(error.retryAfter) >= Date.now() + 3_590_000);
  assert.equal(harness.repository.links.find((link) => link.scheduleEntryId === 'one').lastSyncedDueDate, '2026-10-28');
  assert.equal(harness.repository.links.find((link) => link.scheduleEntryId === 'two').lastSyncedDueDate, '2026-10-26');
  assert.equal(harness.repository.links.find((link) => link.scheduleEntryId === 'three').lastSyncedDueDate, '2026-10-28');
  assert.equal((await reconcile(harness)).updated, 1);
  assert.deepEqual(harness.api.calls.patchBatchSizes, [3, 1]);
  assert.equal(harness.api.calls.patch.length, 3);
  assert.equal(harness.api.calls.create, 0);
});

test('a partial batch failure saves successful mappings and retry adopts already-created remote tasks', async () => {
  const harness = createHarness({ entries: [entry('partial-1'), entry('partial-2'), entry('partial-3')] });
  const createBatch = harness.api.createTasksBatch.bind(harness.api);
  let failOnce = true;
  harness.api.createTasksBatch = async (...args) => {
    const results = await createBatch(...args);
    if (failOnce) {
      failOnce = false;
      results[1] = { requestId: 'request-1', ok: false, status: 503, code: 'backend_error' };
    }
    return results;
  };

  await assert.rejects(reconcile(harness), /Google Tasks request failed/u);
  assert.equal(harness.repository.links.length, 2);
  assert.equal(harness.api.tasks.size, 3);

  await reconcile(harness, new Date(now.getTime() + 1000));
  assert.equal(harness.api.tasks.size, 3);
  assert.equal(harness.repository.links.length, 3);
  assert.equal(harness.api.calls.create, 3);
});

test('reinitializing local storage adopts its exact personal occurrence marker instead of mutable names and dates', async () => {
  const existingTask = {
    id: 'existing-task', taskListId, title: '以前の名前', due: '2026-10-24T00:00:00.000Z', status: 'needsAction',
    notes: personalGoogleOccurrenceNote(householdId, householdId, 'new-local-entry-id'),
  };
  const reinitializedEntry = entry('new-local-entry-id', { choreName: '食器を洗う' });
  const harness = createHarness({ entries: [reinitializedEntry], tasks: [existingTask] });

  await reconcile(harness);
  assert.equal(harness.api.calls.create, 0);
  assert.equal(harness.repository.links[0].googleTaskId, existingTask.id);

  // Simulate app data being initialized again while the Google list survives.
  harness.repository.links = [];
  await reconcile(harness);
  assert.equal(harness.api.calls.create, 0);
  assert.equal(harness.api.tasks.size, 1);
  assert.equal(harness.repository.links[0].googleTaskId, existingTask.id);
});

test('a personal lost-create response recovers its original task after a name and recommendation change without adopting a matching manual task', async () => {
  const h = createHarness({ entries: [entry('round')] }); const createBatch = h.api.createTasksBatch.bind(h.api);
  h.api.createTasksBatch = async (...args) => { const result = await createBatch(...args); h.api.createTasksBatch = createBatch; return result.map(row => ({ requestId: row.requestId, ok: false, status: 503, code: 'lost_response' })); };
  await assert.rejects(reconcile(h));
  h.repository.entries[0] = { ...entry('round'), choreName: '後から変えた名前', entry: { ...entry('round').entry, suggestedDate: '2026-10-28' } };
  h.api.tasks.set(`${taskListId}/manual`, { id: 'manual', taskListId, title: '後から変えた名前', due: '2026-10-28T00:00:00.000Z', status: 'completed', completed: now.toISOString() });
  await reconcile(h);
  assert.equal(h.api.calls.create, 1); assert.equal(h.repository.links[0].googleTaskId, 'task-1');
  assert.equal(h.api.tasks.get(`${taskListId}/task-1`).title, '後から変えた名前');
  assert.equal(h.api.tasks.get(`${taskListId}/task-1`).due, '2026-10-28T00:00:00.000Z');
  assert.equal(h.api.tasks.get(`${taskListId}/manual`).status, 'completed');
});

test('same-name same-date unmarked Tasks are never silently adopted as personal completions', async () => {
  const item = entry('round'); const h = createHarness({ entries: [item], tasks: [{ id: 'manual', taskListId,
    title: item.choreName, due: '2026-10-26T00:00:00.000Z', status: 'completed', completed: now.toISOString() }] });
  await reconcile(h); assert.equal(h.api.calls.create, 1); assert.notEqual(h.repository.links[0].googleTaskId, 'manual');
});

test('linked tasks outside the creation window still receive completion changes', async () => {
  const futureEntry = entry('future-linked', {
    completedAt: '2026-10-25T11:30:00.000Z',
    entry: { ...entry('future-linked').entry, suggestedDate: '2026-11-30' },
  });
  const existingLink = link('future-linked', 'future-task', { lastSyncedStatus: 'needsAction' });
  const harness = createHarness({
    entries: [futureEntry],
    links: [existingLink],
    tasks: [{ id: 'future-task', taskListId, title: '家事 future-linked', due: '2026-11-30T00:00:00.000Z', status: 'needsAction' }],
  });

  await reconcile(harness);

  assert.deepEqual(harness.api.calls.patch, [{
    id: 'future-task', patch: { status: 'completed', completed: '2026-10-25T11:30:00.000Z', notes: personalGoogleOccurrenceNote(householdId, householdId, 'future-linked') },
  }]);
  assert.equal(harness.api.calls.create, 0);
});

test('unvalidated remote completion is not reverted; obsolete open tasks are deleted and completed history is preserved', async () => {
  const harness = createHarness({
    links: [link('obsolete-open', 'task-open'), link('obsolete-done', 'task-done')],
    tasks: [
      { id: 'task-open', taskListId, title: '古い未完了', status: 'needsAction' },
      { id: 'task-done', taskListId, title: '完了済み', status: 'completed' },
      { id: 'task-remote-done', taskListId, title: 'Google側で完了', due: '2026-10-26T00:00:00.000Z', status: 'completed' },
    ],
    entries: [entry('remote-done')],
  });
  harness.repository.links.push(link('remote-done', 'task-remote-done'));

  await reconcile(harness);
  assert.deepEqual(harness.api.calls.deleted, ['task-open']);
  assert.equal(harness.repository.links.some((item) => item.scheduleEntryId === 'obsolete-open'), false);
  assert.equal(harness.repository.links.some((item) => item.scheduleEntryId === 'obsolete-done'), true, 'retain the exact link until its invalid completion timestamp can be recovered');
  assert.equal(harness.api.tasks.get(`${taskListId}/task-done`).status, 'completed');
  assert.equal(harness.api.tasks.get(`${taskListId}/task-remote-done`).status, 'completed');
  assert.equal(harness.api.calls.patch.some(({ patch }) => patch.status === 'needsAction'), false);
});

test('a manually deleted Google Task is recreated with a fresh stable mapping', async () => {
  const harness = createHarness({ entries: [entry('entry-1')], links: [link('entry-1', 'missing-task')] });
  await reconcile(harness);
  assert.equal(harness.api.calls.create, 1);
  assert.notEqual(harness.repository.links[0].googleTaskId, 'missing-task');
});

test('an obsolete task completed after the list snapshot is reread and preserved instead of deleted', async () => {
  const h = createHarness({ links: [link('obsolete', 'remote')], tasks: [{ id: 'remote', taskListId, title: '掃除', status: 'needsAction' }] });
  const get = h.api.getTask.bind(h.api);
  h.api.getTask = async (...args) => {
    Object.assign(h.api.tasks.get(`${taskListId}/remote`), { status: 'completed', completed: now.toISOString() });
    return get(...args);
  };
  await reconcile(h); assert.equal(h.api.calls.get, 1); assert.deepEqual(h.api.calls.deleted, []);
  assert.equal(h.api.tasks.get(`${taskListId}/remote`).status, 'completed');
});

test('missing dedicated task list is created once and persisted by the coordinator result', async () => {
  const harness = createHarness({ entries: [], taskLists: [] });
  const result = await reconcile(harness);
  assert.equal(harness.api.calls.createList, 1);
  assert.equal(result.taskListId, 'new-list-1');
});

test('moving an active entry to the current list cleans the old task without deleting the new mapping', async () => {
  const harness = createHarness({ entries: [entry('entry-1')],
    links: [link('entry-1', 'old-task', { googleTaskListId: 'old-list' })],
    tasks: [{ id: 'old-task', taskListId: 'old-list', title: '家事 entry-1', status: 'needsAction' }],
  });
  await reconcile(harness);
  assert.equal(harness.repository.links.length, 1);
  assert.equal(harness.repository.links[0].googleTaskListId, taskListId);
  assert.notEqual(harness.repository.links[0].googleTaskId, 'old-task');
  assert.deepEqual(harness.api.calls.deleted, ['old-task']);
});

test('an obsolete task changed after the fresh GET is held on conditional-delete conflict while independent cleanup continues', async () => {
  const h = createHarness({ links: [link('obsolete-race', 'remote-race'), link('obsolete-other', 'remote-other')], tasks: [
    { id: 'remote-race', taskListId, title: '直前に完了', status: 'needsAction' }, { id: 'remote-other', taskListId, title: '古い未完了', status: 'needsAction' },
  ] });
  const remove = h.api.deleteTask.bind(h.api);
  h.api.deleteTask = async (token, list, id, etag) => {
    assert.equal(etag, `"${id}-version-1"`);
    if (id === 'remote-race') {
      Object.assign(h.api.tasks.get(`${list}/${id}`), { status: 'completed', etag: '"version-2"', completed: now.toISOString() });
      throw new GoogleTasksApiError(412, 'conditionNotMet', null);
    }
    return remove(token, list, id);
  };
  const result = await reconcile(h);
  assert.deepEqual(h.api.calls.deleted, ['remote-other']); assert.equal(result.removed, 1);
  assert.equal(h.api.tasks.get(`${taskListId}/remote-race`).status, 'completed');
  assert.equal(h.repository.links.some(row => row.scheduleEntryId === 'obsolete-race'), true);
});

for (const etag of [null, '*', 'W/"old"', '"bad\nvalue"']) test(`obsolete cleanup retains a mapping when its fresh ETag is unsafe ${JSON.stringify(etag)}`, async () => {
  const h = createHarness({ links: [link('obsolete', 'remote')], tasks: [{ id: 'remote', taskListId, title: '残す', status: 'needsAction', etag }] });
  const result = await reconcile(h); assert.equal(result.removed, 0); assert.deepEqual(h.api.calls.deleted, []); assert.equal(h.repository.links.length, 1);
});

test('shared task synchronization preserves user notes and adopts its exact marker line after local mapping recovery',async()=>{
  const namespace='group-private-namespace';const marker=sharedGoogleOccurrenceNote(namespace,'notes-round');
  const notes=`${marker}\n\nGoogle側で追記した持ち物`;
  const h=createHarness({entries:[entry('notes-round')],tasks:[{id:'old-task',taskListId,title:'家事 notes-round',due:'2026-10-26T00:00:00.000Z',status:'needsAction',notes}]});
  h.repository.taskNamespace=namespace;
  await reconcile(h);assert.equal(h.api.calls.create,0,'a private user note cannot hide the stable occurrence identity');
  assert.equal(h.repository.links[0].googleTaskId,'old-task');assert.equal(h.api.tasks.get(`${taskListId}/old-task`).notes,notes);
  h.repository.entries[0].choreName='変更した名前';await reconcile(h);
  assert.equal(h.api.tasks.get(`${taskListId}/old-task`).notes,notes);
});

test('a full user task note never makes an otherwise valid status update exceed the provider note limit',async()=>{
  const notes='a'.repeat(8192);const h=createHarness({entries:[entry('full-note',{completedAt:now.toISOString()})],
    links:[link('full-note','full-task',{lastSyncedStatus:'needsAction',pendingStatus:'completed'})],
    tasks:[{id:'full-task',taskListId,title:'家事 full-note',due:'2026-10-26T00:00:00.000Z',status:'needsAction',notes}]});
  await reconcile(h);const patched=h.api.tasks.get(`${taskListId}/full-task`);
  assert.equal(patched.notes.length,notes.length);assert.equal(patched.notes,notes);assert.equal(patched.status,'completed');
});
