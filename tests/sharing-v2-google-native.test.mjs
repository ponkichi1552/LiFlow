import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { now } from './helpers/sharing-v2-repository-fixture.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as storeModule from '../src/platform/storage/sharing-v2-google-tasks.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
import { memoryTaskClaims } from './helpers/shared-task-claims.mjs';
import { sharedTaskCreateJournal } from '../src/features/google-sync/shared-task-create-journal.ts';
import { resolveSharedGoogleTaskList, sharedTaskListIdentity, verifySharedTaskListForLocalChanges } from '../src/features/google-sync/shared-task-list.ts';
import { sharedTaskClaimKey, sharedTaskIdHash } from '../src/features/google-sync/shared-task-claim.ts';
import * as createIntent from '../src/features/google-sync/task-create-intent.ts';
const runtimeModule = await import('../src/features/sharing/v2/google-tasks-runtime.ts');

test('Native v2 Tasks remains unconfigured without OAuth, then uses the same owner-only input and existing Google gateway', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now().getTime() });
  const h = await googleFixture(); const calls = []; const appState = { currentState: null }; let runtimeOptions;
  const remote = memoryTaskClaims(h.namespace); let cloudInitializations = 0;
  try {
    const module = loadNativeModule('src/platform/sharing/v2-google-tasks.ts', {
      'expo-crypto': { randomUUID: () => 'native-google-completion' }, '../storage/sharing-v2-google-tasks': storeModule,
      'react-native': { AppState: appState },
      '../../features/sharing/v2/google-tasks-runtime': { createV2GoogleTaskRuntime: options => {
        runtimeOptions = options; return runtimeModule.createV2GoogleTaskRuntime(options);
      } },
      '../../features/google-sync/task-create-intent.ts': createIntent,
      '../../features/google-sync/shared-task-create-journal': { sharedTaskCreateJournal },
      '../../features/google-sync/shared-task-list': { resolveSharedGoogleTaskList, verifySharedTaskListForLocalChanges },
      './firebase-services': { getSharingServices: () => { cloudInitializations++; return { firestore: {}, auth: { currentUser: { uid: 'owner' } } }; } },
      './google-task-claims': { createSharedGoogleTaskClaims: options => {
        assert.equal(options.userId, 'owner'); assert.equal(options.namespace, h.namespace); assert.equal(options.currentUserId(), 'owner'); return remote.cloud;
      } },
      '../google-tasks/google-tasks-api': { createGoogleTasksApi: () => h.api },
      '../google-tasks/google-sign-in-gateway': { getCurrentGoogleSubject: async () => 'synthetic-google-subject',
        getGoogleTasksAccessToken: async subject => { assert.equal(subject, 'synthetic-google-subject'); calls.push('token'); return 'synthetic-token'; },
        authorizeGoogleTasks: async () => { calls.push('authorize'); }, restorePrivateGoogleCalendarAccount: async () => { calls.push('restore'); return { subject: 'synthetic-google-subject', label: '検査用' }; } },
      './v2-local-planning': { readV2LocalPlanning: async (input, now) => { assert.equal(input.userId, 'owner'); calls.push('private-input'); return { revision: 'input-v1',
        personalize: plan => buildV2PersonalPlan(plan, { viewerUserId: input.userId, now: now.getTime(), settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } } }) }; } },
    });
    const runtime = module.createNativeV2GoogleTasks(h.scope);
    for (const [state, budget] of [[null, 15_000], ['active', 100_000], ['background', 15_000], ['inactive', 15_000]]) {
      appState.currentState = state; assert.equal(runtimeOptions.defaultBudgetMs(), budget);
    }
    appState.currentState = 'active';
    await runtime.synchronize(); assert.deepEqual(calls, []); assert.equal(h.tasks.size, 0); assert.equal(cloudInitializations, 0);
    await runtime.connect(await runtime.reviewConnection()); assert.deepEqual(calls, ['restore', 'authorize']);
    assert.equal((await runtime.synchronize({ force: true })).kind, 'success'); assert.deepEqual(calls, ['restore', 'authorize', 'private-input', 'token']);
    assert.ok(h.tasks.size > 0); assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
    assert.equal(cloudInitializations, 1); assert.ok([...remote.rows.values()].every(row => row.phase === 'linked'));
    const listKey = sharedTaskClaimKey(h.namespace, sharedTaskListIdentity(h.namespace, 'synthetic-google-subject'));
    assert.equal(remote.rows.get(listKey.occurrenceHash)?.taskHash, sharedTaskIdHash('v2-private-list'));
    for (const task of h.tasks.values()) assert.equal(JSON.stringify([...remote.rows]).includes(task.id), false);
    appState.currentState = 'background';
    assert.equal(runtimeOptions.defaultDeltaOnly(), true);
    const item = (await runtime.store.port.readLocalStatusSnapshot('2026-10-27', h.namespace)).entries.find(row => row.target);
    assert.ok(item); await h.actions.complete(item.target);
    h.api.listTaskLists = h.api.listTasks = async () => { throw new Error('No inventory reads during a native background status push'); };
    const pushed = await runtime.synchronize({ localChange: true });
    assert.equal(pushed.kind, 'success'); assert.equal(pushed.localStatusesOnly, true); assert.equal(pushed.updated, 1);
    const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(h.tasks.get(link.googleTaskId).status, 'completed'); assert.equal(link.pendingStatus, undefined);
    const tokensBeforeStop = calls.filter(call => call === 'token').length;
    h.stop(); await assert.rejects(runtime.synchronize({ force: true }), /account changed/u); assert.equal(calls.filter(call => call === 'token').length, tokensBeforeStop);
  } finally { h.close(); }
});

test('Native v2 Tasks QA service rejects release calls before identity, database or Google initialization', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    const source = readFileSync(new URL('../src/platform/sharing/v2-google-tasks-preview.ts', import.meta.url), 'utf8');
    const mocks = Object.fromEntries([...source.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => [match[1], {}]));
    const module = loadNativeModule('src/platform/sharing/v2-google-tasks-preview.ts', mocks);
    await assert.rejects(module.createV2GoogleTasksPreview(), /開発ビルド専用/u);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});
