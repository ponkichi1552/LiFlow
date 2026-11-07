import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';

const { syncGoogleTasksWithDependencies } = await import('../src/features/google-sync/coordinator.ts');
const { GoogleTasksApiError } = await import('../src/platform/google-tasks/google-tasks-api.ts');

const now = new Date('2026-10-25T12:00:00.000Z');

function setup(state = {}) {
  const currentState = {
    householdId: 'local-household',
    enabled: true,
    taskListId: 'list-1',
    status: 'idle',
    retryCount: 0,
    updatedAt: now.toISOString(),
    ...state,
  };
  const counters = { api: 0, entries: 0 };
  const dependencies = {
    async loadState() { return { ...currentState }; },
    async saveState(next) { Object.assign(currentState, next); },
    async getAccessToken() { return 'access-token'; },
    async listEntriesForGoogleSync() { counters.entries += 1; return []; },
    async listGoogleTaskLinks() { return []; },
    async upsertGoogleTaskLink() {},
    async deleteGoogleTaskLink() {},
    async importGoogleTaskChanges() { return 0; },
    async acknowledgeGoogleTaskStatus(link, status) {
      if (!this.links) return;
      this.links = this.links.map((item) => item.scheduleEntryId === link.scheduleEntryId
        ? { ...item, lastSyncedStatus: status, pendingStatus: undefined, pendingStatusRevision: undefined } : item);
    },
    api: {
      async listTaskLists() { counters.api += 1; return [{ id: 'list-1', title: '家事Planner' }]; },
      async listTasks() { counters.api += 1; return []; },
      async createTaskList() { throw new Error('unexpected createTaskList'); },
      async getTask() { throw new Error('unexpected getTask'); },
      async createTask() { throw new Error('unexpected createTask'); },
      async patchTask() { throw new Error('unexpected patchTask'); },
      async deleteTask() { throw new Error('unexpected deleteTask'); },
    },
  };
  return { currentState, dependencies, counters };
}

test('disabled, not-due, and retry-not-due syncs make no API calls', async () => {
  const disabled = setup({ enabled: false });
  assert.deepEqual(await syncGoogleTasksWithDependencies(disabled.dependencies, { now, force: true }), { kind: 'success', skipped: true });

  const notDue = setup({ lastSuccessfulSyncAt: new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString() });
  assert.deepEqual(await syncGoogleTasksWithDependencies(notDue.dependencies, { now }), { kind: 'success', skipped: true, skipReason: 'notDue' });

  const retryNotDue = setup({ status: 'retryPending', nextRetryAt: new Date(now.getTime() + 60_000).toISOString() });
  assert.deepEqual(await syncGoogleTasksWithDependencies(retryNotDue.dependencies, { now }), { kind: 'success', skipped: true });
  assert.equal(disabled.counters.api + notDue.counters.api + retryNotDue.counters.api, 0);
});

test('a future-clock success marker cannot suppress the next Tasks pass after a clock correction', async () => {
  const h = setup({ lastSuccessfulSyncAt: new Date(now.getTime() + 60_000).toISOString() });
  const result = await syncGoogleTasksWithDependencies(h.dependencies, { now });
  assert.equal(result.kind, 'success'); assert.equal(result.skipped, undefined);
  assert.equal(h.counters.api, 2); assert.equal(h.currentState.lastSuccessfulSyncAt, now.toISOString());
});

test('successful manual sync bypasses the 24-hour interval and clears retry state', async () => {
  const harness = setup({
    lastSuccessfulSyncAt: new Date(now.getTime() - 60_000).toISOString(),
    status: 'retryPending',
    nextRetryAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    retryCount: 3,
  });
  const result = await syncGoogleTasksWithDependencies(harness.dependencies, { now, force: true });
  assert.equal(result.kind, 'success');
  assert.equal(harness.counters.api, 2);
  assert.equal(harness.currentState.status, 'idle');
  assert.equal(harness.currentState.retryCount, 0);
  assert.equal(harness.currentState.nextRetryAt, undefined);
  assert.equal(harness.currentState.lastSuccessfulSyncAt, now.toISOString());
});

test('a background Tasks full-read deferral preserves its checkpoint and is automatically resumed in foreground', async () => {
  const h = setup({ lastSuccessfulSyncAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() });
  const previousSuccess = h.currentState.lastSuccessfulSyncAt;
  const first = await syncGoogleTasksWithDependencies(h.dependencies, { now, deltaOnly: true });
  assert.deepEqual(first, { kind: 'success', skipped: true, skipReason: 'foregroundRequired', foregroundRequired: true });
  assert.equal(h.counters.api, 0); assert.equal(h.currentState.status, 'idle');
  assert.equal(h.currentState.lastSuccessfulSyncAt, previousSuccess); assert.equal(h.currentState.lastErrorCode, 'task_foreground_scan_required');
  const before = h.counters.api;
  assert.equal((await syncGoogleTasksWithDependencies(h.dependencies, { now, deltaOnly: true })).foregroundRequired, true);
  assert.equal(h.counters.api, before);
  const resumed = await syncGoogleTasksWithDependencies(h.dependencies, { now });
  assert.equal(resumed.kind, 'success'); assert.equal(resumed.skipped, undefined); assert.equal(h.counters.api, 2);
  assert.equal(h.currentState.lastErrorCode, undefined); assert.equal(h.currentState.lastSuccessfulSyncAt, now.toISOString());
});

test('a recent background Tasks deferral cannot be mistaken for healthy not-due work before foreground recovery', async () => {
  const h = setup({ lastSuccessfulSyncAt: new Date(now.getTime() - 60_000).toISOString(), lastErrorCode: 'task_foreground_scan_required' });
  assert.deepEqual(await syncGoogleTasksWithDependencies(h.dependencies, { now, deltaOnly: true }), {
    kind: 'success', skipped: true, skipReason: 'foregroundRequired', foregroundRequired: true,
  });
  assert.equal(h.counters.api, 0);
  assert.equal((await syncGoogleTasksWithDependencies(h.dependencies, { now })).skipped, undefined);
  assert.equal(h.counters.api, 2); assert.equal(h.currentState.lastErrorCode, undefined);
});

test('transient API failures persist an hourly retry and 401 asks for reconnection', async () => {
  const transient = setup();
  transient.dependencies.api.listTaskLists = async () => { throw new GoogleTasksApiError(503, 'backend_error', null); };
  const transientResult = await syncGoogleTasksWithDependencies(transient.dependencies, { now });
  assert.deepEqual(transientResult, { kind: 'retry', code: 'backend_error' });
  assert.equal(transient.currentState.status, 'retryPending');
  assert.equal(transient.currentState.nextRetryAt, new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  assert.equal(transient.currentState.retryCount, 1);

  const unauthorized = setup();
  unauthorized.dependencies.getAccessToken = async () => {
    const error = new Error('Google sign-in required');
    error.name = 'GoogleSignInRequiredError';
    throw error;
  };
  const unauthorizedResult = await syncGoogleTasksWithDependencies(unauthorized.dependencies, { now });
  assert.deepEqual(unauthorizedResult, { kind: 'authRequired', code: 'sign_in_required' });
  assert.equal(unauthorized.currentState.status, 'authRequired');
});

test('failure to persist the syncing marker is converted to a saved failure state instead of leaving syncing forever', async () => {
  const harness = setup();
  const saveState = harness.dependencies.saveState.bind(harness.dependencies);
  let failStartSave = true;
  harness.dependencies.saveState = async (state) => {
    if (state.status === 'syncing' && failStartSave) {
      failStartSave = false;
      throw new Error('temporary storage failure');
    }
    await saveState(state);
  };

  const result = await syncGoogleTasksWithDependencies(harness.dependencies, { now, force: true });

  assert.deepEqual(result, { kind: 'error', code: 'error' });
  assert.equal(harness.currentState.status, 'error');
  assert.equal(harness.currentState.lastErrorCode, 'error');
  assert.equal(harness.counters.api, 0);
});

test('failure to persist both the syncing marker and failure state returns a stable error result', async () => {
  const harness = setup();
  harness.dependencies.saveState = async (state) => {
    if (state.status === 'syncing' || state.status === 'error') throw new Error('storage unavailable');
  };

  const result = await syncGoogleTasksWithDependencies(harness.dependencies, { now, force: true });

  assert.deepEqual(result, { kind: 'error', code: 'sync_state_persist_failed' });
  assert.equal(harness.counters.api, 0);
});

test('the coordinator does not start an overlapping attempt while the saved state is fresh-syncing', async () => {
  const active = setup({ status: 'syncing', lastAttemptAt: now.toISOString() });
  const result = await syncGoogleTasksWithDependencies(active.dependencies, { now, force: true });
  assert.deepEqual(result, { kind: 'success', skipped: true });
  assert.equal(active.counters.api, 0);
});

test('a syncing state older than the stale threshold is recovered on the next due check', async () => {
  const stale = setup({ status: 'syncing', lastAttemptAt: new Date(now.getTime() - 11 * 60 * 1000).toISOString() });
  const result = await syncGoogleTasksWithDependencies(stale.dependencies, { now });
  assert.equal(result.kind, 'success');
  assert.equal(stale.counters.api, 2);
  assert.equal(stale.currentState.status, 'idle');
});

test('manual recovery resumes an interrupted attempt while a live promise is still shared', async () => {
  const interrupted = setup({ status: 'syncing', lastAttemptAt: now.toISOString() });
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  interrupted.dependencies.api.listTasks = async () => { interrupted.counters.api += 1; await paused; return []; };
  const first = syncGoogleTasksWithDependencies(interrupted.dependencies, { now, force: true, recoverInterruptedAttempt: true });
  await new Promise((resolve) => setImmediate(resolve));
  const second = syncGoogleTasksWithDependencies(interrupted.dependencies, { now, force: true, recoverInterruptedAttempt: true });
  release();
  assert.deepEqual(await first, await second);
  assert.equal(interrupted.counters.api, 2);
  assert.equal(interrupted.currentState.status, 'idle');
});

test('different workspace syncs retain independent results while the native operation queue serializes them', async () => {
  const a = setup(); const b = setup(); let release; let bStarted = false;
  const gate = new Promise((resolve) => { release = resolve; });
  a.dependencies.api.listTasks = async () => { a.counters.api++; await gate; return []; };
  const read = b.dependencies.api.listTaskLists;
  b.dependencies.api.listTaskLists = async () => { bStarted = true; return read(); };
  const first = syncGoogleTasksWithDependencies(a.dependencies, { now, force: true });
  await new Promise((resolve) => setImmediate(resolve));
  const second = syncGoogleTasksWithDependencies(b.dependencies, { now, force: true });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(bStarted, false);
  release(); const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.kind === 'success' && !result.skipped));
  assert.equal(a.counters.api, 2); assert.equal(b.counters.api, 2);
});

test('new dependency wrappers for the same SQLite scope still coalesce one hundred concurrent requests', async () => {
  const h = setup(); const scope = {};
  const pending = Array.from({ length: 100 }, () => syncGoogleTasksWithDependencies({ ...h.dependencies, syncScope: scope }, { now, force: true }));
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.kind === 'success')); assert.equal(h.counters.api, 2);
});

test('audit100 Calendar replanning cannot bypass Tasks authentication failure or its retry deadline', async () => {
  for (const state of [{ status: 'authRequired' }, { status: 'error' }, { status: 'retryPending', nextRetryAt: new Date(now.getTime() + 3600_000).toISOString() }]) {
    const h = setup(state); h.dependencies.refreshCalendar = async () => ({ plannerChanged: true });
    const result = await syncGoogleTasksWithDependencies(h.dependencies, { now });
    assert.equal(result.skipped, true, state.status); assert.equal(h.counters.api, 0); assert.equal(h.currentState.status, state.status);
  }
});
