import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const platform of ['ios', 'android']) {
  for (const first of ['database', 'workspace']) {
    test(`${platform} authorized cold startup overlaps the two local reads and waits for both when ${first} finishes first`, async t => {
      const reads = { database: deferred(), workspace: deferred() };
      const started = [], mounted = [];
      let phase = 'checking', initialization, databaseReady = false;
      const database = {};
      const workspaceContext = { _currentValue: null };
      workspaceContext.Provider = { harnessContext: workspaceContext };
      const child = name => ({ children }) => { mounted.push(name); return children; };
      const empty = () => null;
      const screen = screenHarness('src/app/_layout.tsx', {
        platform, effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
        mocks: {
          'expo-router': { ThemeProvider: ({ children }) => children, DarkTheme: { colors: {} }, DefaultTheme: { colors: {} } },
          'expo-sqlite': { SQLiteProvider: ({ onInit, children }) => {
            initialization ??= onInit(database).then(() => { databaseReady = true; });
            return databaseReady ? children : null;
          } },
          '@/contexts/workspace-context': { WorkspaceContext: workspaceContext },
          '@/platform/subscription/runtime': { subscriptionRequired: true, subscriptionSnapshot: () => ({ phase }),
            subscribeSubscription: () => () => {}, startSubscriptions: async () => {}, refreshSubscription: async () => {} },
          './subscription-screen': { SubscriptionScreen: () => 'subscription-screen' },
          '../../platform/subscription/stop-expired-features': { stopExpiredSubscriptionFeatures: async () => {} },
          '@/platform/storage/repository': { initializeLocalDatabase: async handle => {
            assert.equal(handle, database); started.push('database'); await reads.database.promise;
          } },
          '@/platform/sharing/startup-display': { prepareSavedStartupDisplay() {}, readSavedStartupDisplay: async () => {
            started.push('workspace'); await reads.workspace.promise;
          } },
          '@/platform/sharing/workspaces': { readSharingSelection: async () => null, hasSharingSessionEnabled: async () => false,
            subscribeSharingChanges: () => () => {} },
          '@/platform/sharing/auth': {}, '@/platform/sharing/private-calendar-sync': {},
          '@/components/planner-ui': { palette: {} },
          '@/platform/diagnostics/startup-splash': { prepareStartupDisplay() {}, finishStartupDisplay() {} },
          '@/hooks/use-app-appearance': { initializeAppAppearance() {} },
          '@/hooks/use-planner-data': { PlannerDataProvider: child('planner'), usePlannerData: () => ({ database, refresh: async () => {} }) },
          '@/features/calendar/use-local-calendar': { LocalCalendarProvider: child('calendar') },
          '@/features/sharing/v2-ui/workspace-data': { WorkspaceDisplayProvider: child('display') },
          '../platform/widgets/widget-interaction-listener': { addWidgetUserInteractionListener: () => ({ remove() {} }) },
          '@/components/planner-system-bars': { PlannerSystemBars: empty },
          '@/features/calendar/calendar-notification-bridge': { CalendarNotificationBridge: empty },
          '@/components/notification-workspace-bridge': { NotificationWorkspaceBridge: empty },
          '@/features/appliance-care/analysis-receipt-bridge': { AnalysisReceiptBridge: empty },
          '@/components/workspace-navigator': { WorkspaceNavigator: () => 'authorized-navigation' },
          '@/platform/notifications/configure-foreground-notifications': {},
          '@/platform/sharing/adaptive-personal-runtime': {}, '@/platform/sharing/install-native-ed25519': {},
        },
      });
      t.after(() => { screen.unmount(); reads.database.resolve(); reads.workspace.resolve(); });
      assert.deepEqual(started, []);
      phase = 'locked'; await screen.flush();
      assert.equal(screen.text(), 'subscription-screen'); assert.deepEqual(started, []);
      phase = 'active'; await screen.flush();
      assert.deepEqual([...started].sort(), ['database', 'workspace'], 'each local read must start while the other is outstanding');
      assert.deepEqual(mounted, []); assert.doesNotMatch(screen.text(), /authorized-navigation/);
      reads[first].resolve(); await screen.flush();
      assert.deepEqual(mounted, []); assert.doesNotMatch(screen.text(), /authorized-navigation/);
      reads[first === 'database' ? 'workspace' : 'database'].resolve(); await screen.flush();
      assert.deepEqual(new Set(mounted), new Set(['planner', 'calendar', 'display']));
      assert.match(screen.text(), /authorized-navigation/);
      phase = 'locked'; await screen.flush();
      assert.equal(screen.text(), 'subscription-screen'); assert.equal(started.length, 2);
    });
  }
}

test('restoring the named sharing Auth starts Firestore only when the first database consumer needs it', t => {
  const keys = ['API_KEY', 'PROJECT_ID', 'AUTH_DOMAIN', 'APP_ID'].map(key => `EXPO_PUBLIC_FIREBASE_${key}`);
  for (const key of keys) {
    const before = process.env[key]; process.env[key] = 'synthetic';
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const app = { name: 'liflow-sharing' }, auth = {}, vault = {}, persistence = {}, firestore = {};
  const calls = [];
  const { getSharingServices } = loadNativeModule('src/platform/sharing/firebase-services.ts', {
    'firebase/app': { getApps: () => [app] },
    'firebase/auth': {
      getReactNativePersistence: value => { assert.equal(value, vault); return persistence; },
      initializeAuth: (namedApp, options) => { assert.equal(namedApp, app); assert.equal(options.persistence, persistence); calls.push('auth'); return auth; },
    },
    'firebase/firestore': { initializeFirestore: (namedApp, options) => {
      assert.equal(namedApp, app); assert.deepEqual(options, { experimentalAutoDetectLongPolling: true });
      calls.push('firestore'); return firestore;
    } },
    './secure-store.ts': { sharingSecureVault: vault },
  });
  assert.equal(getSharingServices().auth, auth);
  assert.deepEqual(calls, ['auth']);
  assert.equal(getSharingServices().firestore, firestore);
  assert.equal(getSharingServices().firestore, firestore);
  assert.equal(getSharingServices().auth, auth);
  assert.deepEqual(calls, ['auth', 'firestore']);
});
