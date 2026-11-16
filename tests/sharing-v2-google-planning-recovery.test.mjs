import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { withGoogleSyncOperation } from '../src/features/google-sync/operation-lock.ts';
import { GoogleTasksApiError } from '../src/platform/google-tasks/google-tasks-api.ts';
import { GoogleTaskFullSyncRequiredError } from '../src/features/google-sync/task-read-cache.ts';

const { initializeLocalDatabase, readPersonalPlannerOverlaySnapshot } = await import('../src/platform/storage/repository.ts');
const { createV2GoogleTaskRuntime } = await import('../src/features/sharing/v2/google-tasks-runtime.ts');

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceName = 'src/platform/sharing/v2-local-planning.ts';
const ts = createRequire(import.meta.url)('typescript');
const compiled = ts.transpileModule(readFileSync(resolve(root, sourceName), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const planningDependencies = {};
for (const match of compiled.matchAll(/require\(["']([^"']+)["']\)/g)) {
  const name = match[1];
  if (['expo-sqlite', '../storage/repository', './private-calendar-runtime'].includes(name)) continue;
  let path = resolve(root, dirname(sourceName), name); if (!existsSync(path)) path += '.ts';
  planningDependencies[name] = await import(pathToFileURL(path));
}

/** Real protected revision, local planner, signed repository and private Google store; no network or native account. */
async function fixture(options = {}) {
  let instant = Date.parse('2026-10-27T01:00:00Z'); const clock = () => new Date(instant);
  const h = await googleFixture({ clock }); const directory = mkdtempSync(join(tmpdir(), 'liflow-tasks-planning-recovery-'));
  const personalPath = join(directory, 'personal.db'); const personal = createDatabase(personalPath);
  await initializeLocalDatabase(personal.database); personal.database.closeAsync = async () => {};
  const writer = new DatabaseSync(personalPath);
  const counts = { taskInventories: 0, listInventories: 0, tokens: 0, preparations: 0, commits: 0 };
  let local, runtime, subject = 'synthetic-google-subject', elapsed = 0;
  const context = { counts, h, personal,
    invalidate() { writer.exec('UPDATE personal_planning_input_revision SET revision=revision+1 WHERE singleton=1'); },
    account(value) { subject = value; }, expire() { elapsed = 1001; },
    request(force = false) { return runtime.synchronize(force ? { force: true } : { localChange: true }); },
    requestPull() { return runtime.synchronize({ force: true, localChange: true }); } };
  const localModule = loadNativeModule(sourceName, { ...planningDependencies,
    'expo-sqlite': { openDatabaseAsync: async () => personal.database },
    '../storage/repository': { readPersonalPlannerOverlaySnapshot },
    './private-calendar-runtime': { openPrivateCalendarRuntime: () => ({ subscribe: () => () => {},
      readPlannerPreferences: async () => null, readForPlan: async () => { await options.duringCalendarRead?.(context); return null; }, readOwnCalendar: async () => null }) },
  });
  await h.connect(); await h.sync(); instant += 1000;
  const item = (await h.entries())[0]; const original = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
  const initialOps = new Set((await h.d.repository.readState()).assessment.view.ready.map(row => row.operationId));
  const api = { ...h.api,
    listTaskLists: async (...args) => { counts.listInventories++; return h.api.listTaskLists(...args); },
    listTasks: async (...args) => {
      counts.taskInventories++; const failure = typeof options.readFailure === 'function' ? options.readFailure(context) : options.readFailure;
      if (failure) throw failure; return h.api.listTasks(...args);
    },
  };
  const saveState = h.store.saveSyncState;
  h.store.saveSyncState = async (...args) => { await saveState(...args); await options.afterSaveState?.(args[0], context); };
  runtime = createV2GoogleTaskRuntime({ store: h.store, assertAccess: h.scope.assertAccess, now: clock, budgetNow: () => elapsed,
    verifyTaskListForLocalChanges: async state => {
      assert.equal(state.accountSubject, 'synthetic-google-subject'); assert.equal(state.taskListId, original.googleTaskListId); return true;
    },
    currentSubject: async () => subject, token: async () => { counts.tokens++; await options.onToken?.(context); return 'synthetic-token'; },
    restoreAccount: async () => assert.fail('recovery cannot select an account'), authorizeTasks: async () => assert.fail('recovery cannot request consent'),
    createApi: () => api,
    preparePlan: async () => {
      counts.preparations++; local?.dispose?.();
      local = await localModule.readV2LocalPlanning({ userId: 'owner', assertAccess: h.scope.assertAccess }, clock());
      instant += 1700; await options.onPrepared?.(context);
    },
    assertPlanningCurrent: async () => local?.assertCurrent(), finishPlan: () => local?.dispose?.(),
  });
  h.d.options.afterCommit = () => { counts.commits++; if (options.followCommits) void runtime.synchronize({ localChange: true }).catch(() => {}); };
  return { ...context, runtime, item, original, clock,
    async target() { return (await h.links()).find(row => row.scheduleEntryId === original.scheduleEntryId); },
    async newOperations() { return (await h.d.repository.readState()).assessment.view.ready.filter(row => !initialOps.has(row.operationId)); },
    async close() { h.d.options.afterCommit = undefined; await withGoogleSyncOperation(async () => {}); local?.dispose?.(); h.close(); writer.close(); personal.connection.close(); rmSync(directory, { recursive: true }); },
  };
}

test('a shared Google import consumes manual force once and its local follow-up does not repeat the remote inventory', async t => {
  const f = await fixture({ followCommits: true });
  try {
    Object.assign(f.h.tasks.get(f.original.googleTaskId), { status: 'completed', completed: f.clock().toISOString() });
    const result = await f.runtime.synchronize({ force: true });
    assert.equal(result.kind, 'success'); assert.equal(f.counts.preparations, 2);
    assert.equal(result.skipped, undefined); assert.equal(result.skipReason, undefined);
    assert.equal(result.imported, 1); assert.equal(result.remoteTasksRead, f.h.tasks.size);
    assert.equal(f.counts.taskInventories, 1); assert.equal(f.counts.listInventories, 1);
    const target = await f.target(); assert.equal(target.googleTaskId, f.original.googleTaskId);
    assert.equal(target.lastSyncedStatus, 'completed'); assert.equal(target.pendingStatus, undefined);
    assert.equal((await f.runtime.readControl()).state.status, 'idle');
    const added = await f.newOperations(); assert.equal(added.length, 1); assert.equal(added[0].operationType, 'complete');
  } finally { await f.close(); }
  await t.test('a later foreground deferral retains performed imports without counting its failed read', async () => {
    const f = await fixture({ followCommits: true,
      afterSaveState: (state, { counts, requestPull }) => { if (state.status === 'idle' && counts.preparations === 1) void requestPull().catch(() => {}); },
      readFailure: ({ counts }) => counts.preparations === 2 ? new GoogleTaskFullSyncRequiredError() : undefined });
    try {
      Object.assign(f.h.tasks.get(f.original.googleTaskId), { status: 'completed', completed: f.clock().toISOString() });
      const result = await f.runtime.synchronize({ force: true });
      assert.equal(result.kind, 'success'); assert.equal(result.skipped, undefined);
      assert.equal(result.imported, 1); assert.equal(result.remoteTasksRead, f.h.tasks.size);
      assert.equal(result.foregroundRequired, true); assert.equal(result.skipReason, 'foregroundRequired');
      assert.equal(f.counts.preparations, 2); assert.equal(f.counts.taskInventories, 2);
      assert.equal((await f.newOperations()).length, 1); assert.equal((await f.target()).lastSyncedStatus, 'completed');
      assert.equal((await f.runtime.readControl()).state.lastErrorCode, 'task_foreground_scan_required');
    } finally { await f.close(); }
  });
});

test('a real protected planning revision change refreshes shared Tasks input and recovers without replacing its mapped task', async () => {
  const f = await fixture({ onToken: ({ counts, invalidate }) => { if (counts.tokens === 1) invalidate(); } });
  try {
    const result = await f.runtime.synchronize({ force: true });
    assert.equal(result.kind, 'success'); assert.equal(f.counts.preparations, 2); assert.equal(f.counts.taskInventories, 1);
    assert.equal((await f.target()).googleTaskId, f.original.googleTaskId);
    const state = (await f.runtime.readControl()).state; assert.equal(state.status, 'idle'); assert.equal(state.lastErrorCode, undefined);
    assert.equal((await f.newOperations()).length, 0);
  } finally { await f.close(); }
});

test('a shared Google completion committed before a planning retry retains its original Task and single signed fact', async () => {
  const f = await fixture({ followCommits: true,
    duringCalendarRead: ({ counts, invalidate }) => { if (counts.preparations === 2) invalidate(); } });
  try {
    Object.assign(f.h.tasks.get(f.original.googleTaskId), { status: 'completed', completed: f.clock().toISOString() });
    assert.equal((await f.runtime.synchronize({ force: true })).kind, 'success');
    assert.equal(f.counts.preparations, 3); assert.equal(f.counts.taskInventories, 2);
    const target = await f.target(); assert.equal(target.googleTaskId, f.original.googleTaskId);
    assert.equal(target.lastSyncedStatus, 'completed'); assert.equal(target.pendingStatus, undefined);
    const added = await f.newOperations(); assert.equal(added.length, 1); assert.equal(added[0].operationType, 'complete');
    const acknowledgement = f.h.d.connection.prepare('SELECT acknowledged_ids_json FROM sharing_v2_private_google_links WHERE schedule_entry_id=?').get(target.scheduleEntryId);
    assert.deepEqual(JSON.parse(acknowledgement.acknowledged_ids_json), [added[0].operationId]);
    assert.equal((await f.runtime.readControl()).state.status, 'idle');
  } finally { await f.close(); }
});

test('a committed shared Google completion retains its ACK when later planning preparations exhaust three attempts', async () => {
  const f = await fixture({ followCommits: true,
    duringCalendarRead: ({ counts, invalidate }) => { if (counts.preparations >= 2) invalidate(); } });
  try {
    const previousSuccess = (await f.runtime.readControl()).state.lastSuccessfulSyncAt;
    Object.assign(f.h.tasks.get(f.original.googleTaskId), { status: 'completed', completed: f.clock().toISOString() });
    assert.deepEqual(await f.runtime.synchronize({ force: true }), { kind: 'retry', code: 'planning_input_changed' });
    assert.equal(f.counts.preparations, 3); assert.equal(f.counts.taskInventories, 1); assert.equal(f.counts.listInventories, 1);
    const target = await f.target();
    for (const key of ['scheduleEntryId', 'googleTaskId', 'googleTaskListId']) assert.equal(target[key], f.original[key]);
    assert.equal(target.lastSyncedStatus, 'completed'); assert.equal(target.pendingStatus, undefined);
    const added = await f.newOperations(); assert.equal(added.length, 1); assert.equal(added[0].operationType, 'complete');
    const acknowledgement = f.h.d.connection.prepare('SELECT baseline_revision,acknowledged_ids_json FROM sharing_v2_private_google_links WHERE schedule_entry_id=?').get(target.scheduleEntryId);
    assert.deepEqual(JSON.parse(acknowledgement.acknowledged_ids_json), [added[0].operationId]);
    assert.equal(acknowledgement.baseline_revision, target.observedLocalRevision);
    const state = (await f.runtime.readControl()).state;
    assert.equal(state.status, 'retryPending'); assert.equal(state.lastErrorCode, 'planning_input_changed');
    assert.ok(Date.parse(state.lastSuccessfulSyncAt) > Date.parse(previousSuccess));
    assert.ok(Date.parse(state.lastAttemptAt) > Date.parse(state.lastSuccessfulSyncAt));
    assert.ok(Date.parse(state.nextRetryAt) > Date.parse(state.lastAttemptAt));
  } finally { await f.close(); }
});

test('a planning change during shared Tasks preparation is retried from a fresh snapshot before credentials or HTTP', async () => {
  const f = await fixture({ duringCalendarRead: ({ counts, invalidate }) => { if (counts.preparations === 1) invalidate(); } });
  try {
    const result = await f.runtime.synchronize({ force: true });
    assert.equal(result.kind, 'success'); assert.equal(f.counts.preparations, 2); assert.equal(f.counts.tokens, 1);
    assert.equal(f.counts.taskInventories, 1); assert.equal((await f.runtime.readControl()).state.status, 'idle');
  } finally { await f.close(); }
});

test('continuous protected planning changes stop after three shared Tasks attempts and retain a retry instead of permanent error', async () => {
  const f = await fixture({ onToken: ({ invalidate }) => invalidate() });
  try {
    const previousSuccess = (await f.runtime.readControl()).state.lastSuccessfulSyncAt;
    const result = await f.runtime.synchronize({ force: true });
    assert.deepEqual(result, { kind: 'retry', code: 'planning_input_changed' });
    assert.equal(f.counts.preparations, 3); assert.equal(f.counts.taskInventories, 0);
    const state = (await f.runtime.readControl()).state;
    assert.equal(state.status, 'retryPending'); assert.equal(state.lastErrorCode, 'planning_input_changed');
    assert.ok(Date.parse(state.nextRetryAt) > Date.parse(state.lastAttemptAt)); assert.equal(state.lastSuccessfulSyncAt, previousSuccess);
    assert.equal((await f.target()).googleTaskId, f.original.googleTaskId); assert.equal((await f.newOperations()).length, 0);
  } finally { await f.close(); }
});

test('planning recovery shares the original deadline and cannot restart after its budget expires', async () => {
  const f = await fixture({ onToken: ({ invalidate }) => invalidate(),
    afterSaveState: (state, { expire }) => { if (state.lastErrorCode === 'planning_input_changed') expire(); } });
  try {
    assert.deepEqual(await f.runtime.synchronize({ force: true, budgetMs: 1000 }), { kind: 'retry', code: 'timeout' });
    assert.equal(f.counts.preparations, 1); assert.equal(f.counts.taskInventories, 0);
    assert.equal((await f.runtime.readControl()).state.status, 'retryPending');
  } finally { await f.close(); }
});

test('a planning recovery still refuses a changed Google account before another remote request', async () => {
  for (const afterImport of [false, true]) {
    const f = await fixture({ followCommits: afterImport,
      onToken: ({ counts, invalidate }) => { if (!afterImport && counts.tokens === 1) invalidate(); },
      onPrepared: ({ counts, account, request }) => {
        if (afterImport && counts.preparations === 2) void request(true).catch(() => {});
        if (counts.preparations === (afterImport ? 3 : 2)) account('different-subject');
      } });
    try {
      if (afterImport) Object.assign(f.h.tasks.get(f.original.googleTaskId), { status: 'completed', completed: f.clock().toISOString() });
      assert.deepEqual(await f.runtime.synchronize({ force: true }), { kind: 'authRequired', code: 'google_account_mismatch' });
      assert.equal(f.counts.preparations, afterImport ? 3 : 2); assert.equal(f.counts.taskInventories, afterImport ? 1 : 0);
      const state = (await f.runtime.readControl()).state; assert.equal(state.status, 'authRequired'); assert.equal(state.accountSubject, 'synthetic-google-subject');
      assert.equal((await f.newOperations()).length, afterImport ? 1 : 0);
    } finally { await f.close(); }
  }
});

test('an explicit force queued during a local shared Tasks follow-up gets one fresh pull while simultaneous manual joins coalesce', async () => {
  let queued;
  const f = await fixture({ followCommits: true, onPrepared: ({ counts, request }) => { if (counts.preparations === 2) queued = request(true); } });
  try {
    Object.assign(f.h.tasks.get(f.original.googleTaskId), { status: 'completed', completed: f.clock().toISOString() });
    const first = f.runtime.synchronize({ force: true }); assert.equal(f.runtime.synchronize({ force: true }), first);
    const result = await first; assert.equal(result.kind, 'success'); assert.deepEqual(await queued, result);
    assert.equal(result.imported, 1); assert.equal(result.remoteTasksRead, 2 * f.h.tasks.size);
    assert.equal(f.counts.preparations, 3); assert.equal(f.counts.taskInventories, 2); assert.equal(f.counts.listInventories, 2);
    assert.equal((await f.newOperations()).length, 1); assert.equal((await f.runtime.readControl()).state.status, 'idle');
  } finally { await f.close(); }
});

test('a local Undo queued during a manual shared Tasks PATCH is sent without replaying the full remote inventory', async () => {
  const f = await fixture();
  try {
    const [done] = await f.h.actions.complete(f.item.target);
    f.h.d.options.afterCommit = () => { void f.runtime.synchronize({ localChange: true }).catch(() => {}); };
    f.h.hooks.afterPatch = async () => { delete f.h.hooks.afterPatch; await f.h.actions.undo(done.operationId); };
    f.h.calls.length = 0;
    const result = await f.runtime.synchronize({ force: true });
    assert.equal(result.kind, 'success');
    assert.equal(result.updated, 2); assert.equal(result.localStatusesOnly, undefined);
    const target = await f.target(); assert.equal(target.googleTaskId, f.original.googleTaskId);
    assert.equal(target.lastSyncedStatus, 'needsAction'); assert.equal(target.pendingStatus, undefined);
    assert.equal(f.h.tasks.get(target.googleTaskId).status, 'needsAction');
    assert.equal(f.counts.taskInventories, 1); assert.equal(f.h.calls.filter(row => row[0] === 'patch').length, 2);
  } finally { await f.close(); }
});

for (const [label, failure, kind, code] of [
  ['provider', new GoogleTasksApiError(503, 'backend_error', null), 'retry', 'backend_error'],
  ['integrity', new Error('synthetic integrity failure'), 'error', 'error'],
]) test(`planning recovery does not hide or immediately repeat a real ${label} failure`, async () => {
  for (const afterImport of [false, true]) {
    const f = await fixture({ followCommits: afterImport,
      onPrepared: ({ counts, request }) => { if (afterImport && counts.preparations === 2) void request(true).catch(() => {}); },
      readFailure: ({ counts }) => !afterImport || counts.preparations === 3 ? failure : undefined });
    try {
      if (afterImport) Object.assign(f.h.tasks.get(f.original.googleTaskId), { status: 'completed', completed: f.clock().toISOString() });
      assert.deepEqual(await f.runtime.synchronize({ force: true }), { kind, code });
      assert.equal(f.counts.preparations, afterImport ? 3 : 1); assert.equal(f.counts.taskInventories, afterImport ? 2 : 1);
      assert.equal((await f.runtime.readControl()).state.status, kind === 'retry' ? 'retryPending' : 'error');
      assert.equal((await f.newOperations()).length, afterImport ? 1 : 0);
    } finally { await f.close(); }
  }
});
