import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { createBackgroundAudit } from '../src/features/google-sync/background-audit.ts';
import { loadNativeModule } from './helpers/native-module.mjs';

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
    assert.deepEqual(columns, ['id', 'started_at', 'finished_at', 'release', 'outcome', 'personal', 'private_calendar', 'sharing']);
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
