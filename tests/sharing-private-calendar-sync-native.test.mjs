import { createBackgroundAudit } from '../src/features/google-sync/background-audit.ts';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { updateSharingWorkspace } from '../src/platform/storage/sharing-registry.ts';

function fixture() {
  const state = { enabled: false, uid: 'owner', authReads: 0, opens: [], syncs: [], phase: 'unconfigured', registrations: 0, stops: 0, onReady: null };
  const module = loadNativeModule('src/platform/sharing/private-calendar-sync.ts', {
    './workspaces': { hasSharingSessionEnabled: async () => state.enabled, sharingSessionUser: async () => { state.authReads++; return state.uid ? { uid: state.uid } : null; } },
    './private-calendar-runtime': { openPrivateCalendarRuntime: uid => { assert.equal(uid, state.uid, 'owner changed'); state.opens.push(uid); return {
      synchronizeAutomatically: async options => { state.syncs.push(options); }, readSettings: async () => ({ device: { phase: state.phase } }),
      observeRemote: onReady => { state.onReady = onReady; return () => { state.stops++; }; },
    }; } },
    '../../features/sharing/private-calendar/sync-deadline': { PRIVATE_CALENDAR_AUTOMATIC_BUDGET_MS: 25000 },
    '../../features/google-sync/background-task': { registerGoogleSyncBackgroundTask: async () => { state.registrations++; } },
  });
  return { module, state };
}
test('private Calendar Native automatic entry remains lazy and never initializes sharing for personal users or requests an account', async () => {
  const f = fixture(); assert.equal(f.state.authReads, 0); assert.equal(f.state.opens.length, 0);
  await f.module.syncKnownPrivateCalendar(); assert.equal(await f.module.isPrivateCalendarWorkerNeeded(), false); assert.equal(f.state.authReads, 0);
  f.state.enabled = true; f.state.uid = null; await f.module.syncKnownPrivateCalendar(); assert.equal(await f.module.isPrivateCalendarWorkerNeeded(), false); assert.equal(f.state.opens.length, 0);
  f.state.uid = 'owner'; await f.module.syncKnownPrivateCalendar(15000); assert.deepEqual(f.state.syncs, [{ budgetMs: 15000 }]); assert.deepEqual(f.state.opens, ['owner']);
});
test('private Calendar Native worker retention is based on explicit approved or prepared trust and foreground registration reuses the existing task', async () => {
  const f = fixture(); f.state.enabled = true;
  for (const phase of ['unconfigured', 'pairing', 'revoked', 'approved', 'firstPending']) { f.state.phase = phase; assert.equal(await f.module.isPrivateCalendarWorkerNeeded(), ['approved', 'firstPending'].includes(phase)); }
  const stop = f.module.startPrivateCalendarForeground('owner'); assert.equal(f.state.registrations, 0); await f.state.onReady(); assert.equal(f.state.registrations, 1); stop(); assert.equal(f.state.stops, 1);
});
test('private Calendar keeps the shared OS worker needed after every group has left without creating or altering a group', async t => {
  for (const needed of [true, false]) {
    const h = await workspaceHarness({ privateCalendarNeeded: needed }); t.after(h.close); h.vault.set('sharing-enabled', 'true');
    await updateSharingWorkspace(h.index.database, h.record.userId, h.record.groupId, before => ({ ...before, status: 'left' }));
    assert.equal(await h.api.isSharedWorkerNeeded(), needed); assert.equal(h.calls.includes('create-cloud'), false);
  }
});
for (const broken of ['personal', 'private', 'sharing']) {
  test(`single OS worker isolates ${broken} failure and still runs all three independent domains with one definition`, async () => {
    const calls = []; let callback; let definitions = 0; let registered = false; let registrations = 0;
    const module = loadNativeModule('src/features/google-sync/background-task.ts', {
      './background-audit': { createBackgroundAudit },
    'expo-background-task': { BackgroundTaskResult: { Success: 'success', Failed: 'failed' }, BackgroundTaskStatus: { Available: 'available' }, getStatusAsync: async () => 'available',
        registerTaskAsync: async (name, options) => { assert.equal(name, 'housework-planner-google-tasks-sync'); assert.equal(options.minimumInterval, 60); registrations++; registered = true; } },
      'expo-task-manager': { defineTask: (_name, work) => { definitions++; callback = work; }, isAvailableAsync: async () => true,
        getRegisteredTasksAsync: async () => registered ? [{ taskName: 'housework-planner-google-tasks-sync' }] : [] },
      'expo-sqlite': { openDatabaseAsync: async () => ({ closeAsync: async () => { calls.push('close'); } }) },
      '@/platform/storage/repository': { initializeLocalDatabase: async () => {}, loadGoogleSyncState: async () => ({ enabled: true }), LOCAL_HOUSEHOLD_ID: 'local' },
      '@/platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => ({ sync: async () => ({ kind: 'skipped' }) }) },
      './coordinator': { syncGoogleTasks: async () => { calls.push('personal'); if (broken === 'personal') throw new Error('synthetic personal failure'); return { kind: 'success' }; } },
      '@/platform/sharing/private-calendar-sync': { syncKnownPrivateCalendar: async budget => { assert.equal(budget, 15000); calls.push('private'); if (broken === 'private') throw new Error('synthetic private failure'); } },
      '@/platform/sharing/workspaces': { syncSharingWorkspace: async budget => { assert.equal(budget, 30000); calls.push('sharing'); if (broken === 'sharing') throw new Error('synthetic sharing failure'); } },
    });
    assert.equal(definitions, 1); assert.deepEqual(calls, []); await module.registerGoogleSyncBackgroundTask(); await module.registerGoogleSyncBackgroundTask(); assert.equal(registrations, 1);
    assert.equal(await callback({}), 'failed'); assert.deepEqual(calls, ['personal', 'close', 'private', 'sharing', 'close']); assert.equal(definitions, 1);
  });
}
