import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { createBackgroundAudit } from '../src/features/google-sync/background-audit.ts';
import { loadNativeModule } from './helpers/native-module.mjs';

for (const enabled of [true, false]) test(`registering the OS worker defers all application synchronization modules and loads Tasks only when enabled=${enabled}`, async () => {
  const loaded = []; const ran = []; let worker;
  const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    loadNativeModule('src/features/google-sync/background-task.ts', {
      'expo-background-task': { BackgroundTaskResult: { Success: 'success', Failed: 'failed' } },
      'expo-task-manager': { defineTask: (_name, callback) => { worker = callback; } },
      'expo-sqlite': { openDatabaseAsync: async () => ({ closeAsync: async () => {} }) },
      get '@/platform/subscription/runtime'() { loaded.push('billing'); return { subscriptionRequired: false }; },
      get './background-audit'() { loaded.push('audit'); return { createBackgroundAudit: () => ({ begin: async () => 1, domain: async () => {}, finish: async () => {} }) }; },
      get '@/platform/storage/repository'() { loaded.push('repository'); return { initializeLocalDatabase: async () => {}, loadGoogleSyncState: async () => ({ enabled }), LOCAL_HOUSEHOLD_ID: 'local' }; },
      get './coordinator'() { loaded.push('tasks'); return { syncGoogleTasks: async () => { ran.push('tasks'); return { kind: 'success' }; } }; },
      '@/platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => ({ sync: async () => { ran.push('calendar'); return { kind: 'success' }; } }) },
      '@/platform/sharing/private-calendar-sync': { syncKnownPrivateCalendar: async () => { ran.push('private'); } },
      '@/platform/sharing/workspaces': { syncSharingWorkspace: async () => { ran.push('sharing'); } },
    });
    assert.equal(typeof worker, 'function', 'registration must remain synchronous before Router mounts');
    assert.deepEqual(loaded, [], 'a normal app launch must not initialize the worker application runtime');
    assert.equal(await worker({}), 'success');
    assert.deepEqual(loaded, enabled ? ['billing', 'audit', 'repository', 'tasks'] : ['billing', 'audit', 'repository']);
    assert.deepEqual(ran, [...(enabled ? ['tasks'] : []), 'calendar', 'private', 'sharing']);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});

test('background evidence distinguishes interrupted and failed runs and retains only bounded metadata', async () => {
  const h = createDatabase(); const audit = createBackgroundAudit(h.database);
  try {
    const first = await audit.begin(10, true); await audit.domain(first, 'personal', 'success');
    const second = await audit.begin(20, true); await audit.domain(second, 'sharing', 'failed'); await audit.finish(second, 30, true);
    const rows = h.connection.prepare('SELECT * FROM background_sync_runs ORDER BY id').all();
    assert.equal(rows[0].outcome, 'interrupted'); assert.equal(rows[0].finished_at, null);
    assert.equal(rows[1].outcome, 'failed'); assert.equal(rows[1].sharing, 'failed'); assert.equal(rows[1].private_calendar, 'pending');
    for (let i = 0; i < 40; i++) { const id = await audit.begin(100 + i, false); await audit.finish(id, 200 + i, false); }
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM background_sync_runs').get().n, 32);
    const columns = h.connection.prepare('PRAGMA table_info(background_sync_runs)').all().map(row => row.name);
    assert.deepEqual(columns, ['id', 'started_at', 'finished_at', 'release', 'outcome', 'personal', 'private_calendar', 'sharing', 'personal_google_calendar']);
  } finally { h.connection.close(); }
});

test('only the OS worker callback creates release evidence and one domain failure does not skip later domains', async () => {
  const h = createDatabase(); let callback; const calls = []; const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    loadNativeModule('src/features/google-sync/background-task.ts', {
      './background-audit': { createBackgroundAudit },
      'expo-background-task': { BackgroundTaskResult: { Success: 'success', Failed: 'failed' } },
      'expo-task-manager': { defineTask: (_name, run) => { callback = run; } },
      'expo-sqlite': { openDatabaseAsync: async name => name === 'background-sync-audit.db' ? { ...h.database, closeAsync: async () => {} } : { closeAsync: async () => {} } },
      '@/platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => ({ sync: async () => ({ kind: 'skipped' }) }) },
      './coordinator': { syncGoogleTasks: async () => { calls.push('personal'); throw new Error('transient transport failure'); } },
      '@/platform/storage/repository': { LOCAL_HOUSEHOLD_ID: 'local', initializeLocalDatabase: async () => {}, loadGoogleSyncState: async () => ({ enabled: true }) },
      '@/platform/sharing/private-calendar-sync': { syncKnownPrivateCalendar: async () => { calls.push('private'); } },
      '@/platform/sharing/workspaces': { syncSharingWorkspace: async () => { calls.push('sharing'); } },
    });
    assert.equal(h.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='background_sync_runs'").get().n, 0);
    assert.equal(await callback({}), 'failed'); assert.deepEqual(calls, ['personal', 'private', 'sharing']);
    const row = h.connection.prepare('SELECT * FROM background_sync_runs').get();
    assert.equal(row.release, 1); assert.equal(row.outcome, 'failed'); assert.equal(row.personal, 'failed');
    assert.equal(row.private_calendar, 'success'); assert.equal(row.sharing, 'success'); assert.ok(row.finished_at >= row.started_at);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; h.connection.close(); }
});

for (const kind of ['retry', 'authRequired', 'error', 'success']) {
  test(`a resolved personal Google result ${kind} is reported accurately without skipping independent background domains`, async () => {
    const h = createDatabase(); let callback; const calls = []; const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
    try {
      loadNativeModule('src/features/google-sync/background-task.ts', {
        './background-audit': { createBackgroundAudit },
        'expo-background-task': { BackgroundTaskResult: { Success: 'success', Failed: 'failed' } },
        'expo-task-manager': { defineTask: (_name, run) => { callback = run; } },
        'expo-sqlite': { openDatabaseAsync: async name => name === 'background-sync-audit.db' ? { ...h.database, closeAsync: async () => {} } : { closeAsync: async () => {} } },
        '@/platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => ({ sync: async () => ({ kind: 'skipped' }) }) },
      './coordinator': { syncGoogleTasks: async () => { calls.push('personal'); return { kind, code: 'synthetic', skipped: kind === 'success' }; } },
        '@/platform/storage/repository': { LOCAL_HOUSEHOLD_ID: 'local', initializeLocalDatabase: async () => {}, loadGoogleSyncState: async () => ({ enabled: true }) },
        '@/platform/sharing/private-calendar-sync': { syncKnownPrivateCalendar: async () => { calls.push('private'); } },
        '@/platform/sharing/workspaces': { syncSharingWorkspace: async () => { calls.push('sharing'); } },
      });
      const expected = kind === 'success' ? 'success' : 'failed';
      assert.equal(await callback({}), expected);
      assert.deepEqual(calls, ['personal', 'private', 'sharing']);
      const row = h.connection.prepare('SELECT * FROM background_sync_runs').get();
      assert.equal(row.outcome, expected); assert.equal(row.personal, expected);
      assert.equal(row.private_calendar, 'success'); assert.equal(row.sharing, 'success');
    } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; h.connection.close(); }
  });
}

for (const kind of ['skipped', 'pending', 'error', 'success']) test(`personal Calendar OS phase ${kind} is independent of disabled Tasks and is never relabeled as a completed Calendar sync`, async () => {
  const h = createDatabase(); const calls = []; let callback; const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    loadNativeModule('src/features/google-sync/background-task.ts', {
      './background-audit': { createBackgroundAudit },
      'expo-background-task': { BackgroundTaskResult: { Success: 'success', Failed: 'failed' } },
      'expo-task-manager': { defineTask: (_name, work) => { callback = work; } },
      'expo-sqlite': { openDatabaseAsync: async name => name === 'background-sync-audit.db' ? { ...h.database, closeAsync: async () => {} } : { closeAsync: async () => {} } },
      '@/platform/storage/repository': { initializeLocalDatabase: async () => {}, loadGoogleSyncState: async () => ({ enabled: false }), LOCAL_HOUSEHOLD_ID: 'local' },
      './coordinator': { syncGoogleTasks: async () => { throw new Error('Tasks are disabled'); } },
      '@/platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => ({ sync: async options => { assert.equal(options.budgetMs, 15000); calls.push('calendar'); return { kind }; } }) },
      '@/platform/sharing/private-calendar-sync': { syncKnownPrivateCalendar: async () => { calls.push('private'); } },
      '@/platform/sharing/workspaces': { syncSharingWorkspace: async () => { calls.push('sharing'); } },
    });
    assert.equal(await callback({}), kind === 'error' ? 'failed' : 'success'); assert.deepEqual(calls, ['calendar', 'private', 'sharing']);
    const row = h.connection.prepare('SELECT * FROM background_sync_runs').get(); assert.equal(row.personal_google_calendar, kind === 'error' ? 'failed' : kind);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; h.connection.close(); }
});

test('turning Tasks off preserves the single OS worker while personal Calendar synchronization remains enabled', async () => {
  let enabled = true; let registered = false; const calls = [];
  const module = loadNativeModule('src/features/google-sync/background-task.ts', {
    './background-audit': { createBackgroundAudit }, './coordinator': {},
    '@/platform/storage/repository': {},
    'expo-task-manager': { defineTask() {}, isAvailableAsync: async () => true, getRegisteredTasksAsync: async () => registered ? [{ taskName: 'housework-planner-google-tasks-sync' }] : [] },
    'expo-background-task': { BackgroundTaskStatus: { Available: 'available' }, getStatusAsync: async () => 'available',
      registerTaskAsync: async () => { calls.push('register'); registered = true; }, unregisterTaskAsync: async () => { calls.push('unregister'); registered = false; } },
    'expo-sqlite': { openDatabaseAsync: async () => ({ closeAsync: async () => { calls.push('close'); } }) },
    '@/platform/sharing/workspaces': { isSharedWorkerNeeded: async () => false },
    '@/platform/storage/personal-google-calendar': { readPersonalGoogleCalendarControl: async () => ({ enabled }) },
  });
  await module.unregisterGoogleSyncBackgroundTask(); assert.equal(registered, true);
  enabled = false; await module.unregisterGoogleSyncBackgroundTask(); assert.equal(registered, false);
  assert.deepEqual(calls, ['register', 'close', 'close', 'unregister']);
});
