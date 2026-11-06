import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { AdaptiveOwnerInputsChangedError } from '../src/platform/storage/adaptive-owner-inputs.ts';

for (const [platform, cancelled, name] of [
  [
    "ios",
    false,
    "ios Calendar automatic sync waits for the local read and never starts after its provider departs=false"
  ],
  [
    "android",
    false,
    "android Calendar automatic sync waits for the local read and never starts after its provider departs=false"
  ],
  [
    "ios",
    true,
    "ios Calendar automatic sync waits for the local read and never starts after its provider departs=true"
  ],
  [
    "android",
    true,
    "android Calendar automatic sync waits for the local read and never starts after its provider departs=true"
  ]
]) test(name, async t => {
  const effects = [], timers = [], calls = []; let resolve; const local = new Promise(done => { resolve = done; });
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const module = loadNativeModule('src/features/calendar/use-personal-google-sync.tsx', {
    react: { useRef: value => ({ current: value }), useEffect: work => effects.push(work), useCallback: work => work },
    'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
    '../planner/initial-display-gate': { waitForInitialFrame: async () => { calls.push('frame'); } },
    '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => { calls.push('runtime'); return { sync: async () => { calls.push('sync'); return { kind: 'success' }; } }; } },
  }, { setTimeout: work => { timers.push(work); return timers.length; }, clearTimeout() {} });
  module.usePersonalGoogleSync({}, () => local); const cleanup = effects[0](); timers.shift()();
  await new Promise(setImmediate); assert.deepEqual(calls, []);
  if (cancelled) cleanup(); resolve(); await new Promise(setImmediate);
  assert.deepEqual(calls, cancelled ? ['frame'] : ['frame', 'runtime', 'sync']);
  if (!cancelled) cleanup();
});

for (const [platform, name] of [
  [
    "ios",
    "ios Tasks automatic startup waits for its own forced local refresh and backgrounding cancels the pending launch"
  ],
  [
    "android",
    "android Tasks automatic startup waits for its own forced local refresh and backgrounding cancels the pending launch"
  ]
]) test(name, async () => {
  for (const phase of ['foreground', 'background-during-read', 'background-before-frame', 'unmount-before-frame']) {
    const background = phase === 'background-during-read'; const beforeFrame = phase.endsWith('before-frame');
    const effects = [], calls = []; let finish, changed, paint;
    const firstFrame = new Promise(resolve => { paint = resolve; }); let frames = 0;
    const state = { snapshot: null };
    const local = new Promise(resolve => { finish = resolve; });
    const controller = { getSnapshot: () => state, refresh: () => { calls.push('local'); return local; }, subscribe: () => () => {}, invalidate() {} };
    const { PlannerDataProvider } = loadNativeModule('src/hooks/use-planner-data.ts', {
      'expo-sqlite': { useSQLiteContext: () => ({}) },
      react: { createContext: () => ({}), useMemo: work => work(), useEffect: work => effects.push(work), createElement: () => null },
      'react-native': { AppState: { currentState: 'active', addEventListener: (_event, listener) => { changed = listener; return { remove() {} }; } } },
      '@/domain/scheduling/local-date': { millisecondsUntilNextLocalDay: () => 1000000 },
      '@/platform/storage/repository': { LOCAL_HOUSEHOLD_ID: 'local-household', loadGoogleSyncState: async () => { calls.push('state'); return { enabled: true }; } },
      '@/features/appliance-care/library-changes': { subscribeApplianceLibraryChanges: () => () => {} },
      '@/platform/widgets/refresh-planner-from-widget': {}, '@/features/widgets/publish-today-widget-snapshot': {},
      '@/features/notifications/daily-housework-digest': {}, '@/platform/notifications/expo-local-notification-gateway': {},
      '@/features/google-sync/planner-change-events': { subscribeToGooglePlannerChanges: () => () => {} },
      '@/features/google-sync/background-task': { registerGoogleSyncBackgroundTask: async () => { calls.push('worker'); } },
      '@/features/google-sync/coordinator': { syncGoogleTasks: async () => { calls.push('sync'); } },
      '@/platform/storage/adaptive-owner-inputs': { AdaptiveOwnerInputsChangedError },
      '@/features/planner/refresh-controller': { createPlannerRefreshController: dependencies => {
        assert.equal(dependencies.retryLoadOnError(new AdaptiveOwnerInputsChangedError()), true);
        assert.equal(dependencies.retryLoadOnError(new Error('access denied')), false);
        return controller;
      } },
      '@/platform/storage/shared-repository-adapter': { sharedRepositoryAdapter: () => undefined },
      '@/features/google-sync/workspace-policy': {}, '@/features/sharing/group-clock': {}, '@/platform/sharing/workspaces': {}, '@/contexts/planner-issues-context': {},
      '@/features/planner/initial-display-gate': { waitForInitialFrame: async () => { calls.push('frame'); if (++frames === 1 && beforeFrame) await firstFrame; } },
    });
    PlannerDataProvider({ children: null }); const cleanup = effects[0](); await new Promise(setImmediate);
    if (beforeFrame) {
      assert.deepEqual(calls, ['frame']);
      if (phase === 'unmount-before-frame') cleanup(); else changed('background');
      paint(); await new Promise(setImmediate); assert.deepEqual(calls, ['frame']);
      if (phase !== 'unmount-before-frame') cleanup(); continue;
    }
    assert.deepEqual(calls, ['frame', 'local']);
    if (background) changed('background'); finish(); await new Promise(setImmediate);
    assert.deepEqual(calls, background ? ['frame', 'local', 'frame'] : ['frame', 'local', 'frame', 'state', 'worker', 'sync']); cleanup();
  }
});
