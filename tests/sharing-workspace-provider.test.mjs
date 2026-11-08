import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) test(`${platform} solo idle fallback preserves remote signals private polling unfinished retries and resume synchronization`, async t => {
  const effects = [], ticks = []; let stateListener, remote, remoteFailure; let shared = 0, privateSyncs = 0, received = 0;
  let time = 10_000_000, coordinatorKind = 'success', incomplete = false;
  t.mock.method(Date, 'now', () => time);
  t.mock.method(globalThis, 'setInterval', callback => { ticks.push(callback); return ticks.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const record = { userId: 'owner', groupId: 'house', status: 'active', lastSuccessfulSyncAt: time, lastErrorCode: null };
  const checkpoint = { pendingCount: 0 };
  const member = { userId: 'owner', devices: [{ identity: { deviceId: 'device' } }] };
  const workspace = { ...record, protocol: 2, identity: { deviceId: 'device' }, drain: async () => {},
    record: async () => record, checkpoint: async () => checkpoint, roster: () => ({ body: { groupId: 'house', members: [member] } }),
    googleTasks: async () => ({ readControl: async () => ({ state: null }) }), googleCalendar: async () => ({ readControl: async () => ({ enabled: false }) }),
    watch: (changed, failed) => { remote = changed; remoteFailure = failed; return () => {}; },
    sync: async () => { received++; return { complete: !incomplete, pending: 0, waitingForApproval: false }; } };
  const appState = { currentState: 'active', addEventListener: (_event, listener) => { stateListener = listener; return { remove() {} }; } };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
    '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
    '@/features/planner/initial-display-gate': { createInitialDisplayGate: () => ({ wait: () => ({ promise: Promise.resolve(true), cancel() {} }), complete() {} }), waitForInitialFrame: async () => {} },
    '@/platform/sharing/startup-display': { readSavedStartupDisplay: async () => undefined, canShowPersonalStartup: async () => false, startupDisplayCache: { read: async () => undefined } },
    '@/platform/sharing/auth': { observeSharingUser: () => () => {} }, 'react-native': { AppState: appState },
    '@/platform/sharing/account-device-runtime': { startAccountDeviceForeground: () => () => {}, subscribeAccountDeviceRestoreStatus: () => () => {}, accountDeviceRestoreStatus: () => null },
    '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => () => {}, syncKnownPrivateCalendar: async () => { privateSyncs++; } },
    '@/platform/sharing/workspaces': { saveSharingSelection: async () => {}, readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
      sharingSessionUser: async () => ({ uid: 'owner' }), currentSharingWorkspace: async () => record, openSharedWorkspace: async () => workspace,
      subscribeSharingChanges: () => () => {}, syncSharingWorkspace: async () => { shared++; if (coordinatorKind === 'success') record.lastSuccessfulSyncAt = time; return { kind: coordinatorKind }; } },
  } });
  const disposeBoot = effects[0](); let disposeForeground;
  try {
    for (let i = 0; i < 8; i++) await screen.flush();
    const boot = screen.nodes().find(node => node.props.value?.ready)?.props.value;
    assert.equal(boot?.active, workspace, boot?.error ?? 'workspace restoration must finish before foreground polling');
    disposeForeground = effects.at(-1)();
    for (let i = 0; i < 8 && shared === 0; i++) await screen.flush();
    assert.equal(shared, 1); assert.equal(privateSyncs, 1); assert.equal(ticks.length, 1);
    time += 600_000; ticks[0](); await screen.flush(); assert.equal(shared, 1); assert.equal(privateSyncs, 2);
    remote(); await screen.flush(); assert.equal(received, 1, 'remote changes bypass idle fallback');
    incomplete = true; remoteFailure(); await screen.flush();
    ticks[0](); await screen.flush(); assert.equal(shared, 2, 'unfinished remote synchronization must retry before an hour');
    incomplete = false; checkpoint.pendingCount = 1; ticks[0](); await screen.flush(); assert.equal(shared, 3);
    checkpoint.pendingCount = 0; member.devices.push({ identity: { deviceId: 'second-device' } });
    coordinatorKind = 'pending'; ticks[0](); await screen.flush(); assert.equal(shared, 4);
    member.devices.pop(); ticks[0](); await screen.flush(); assert.equal(shared, 5, 'incomplete coordinator work cannot be suppressed');
    coordinatorKind = 'success'; ticks[0](); await screen.flush(); assert.equal(shared, 6);
    time += 3_600_000; ticks[0](); await screen.flush(); assert.equal(shared, 7, 'one-hour fallback eventually rechecks membership');
    appState.currentState = 'background'; stateListener('background'); const before = [shared, privateSyncs, received];
    ticks[0](); remote(); await screen.flush(); assert.deepEqual([shared, privateSyncs, received], before);
    appState.currentState = 'active'; stateListener('active'); await screen.flush();
    assert.equal(shared, before[0] + 1, 'resume always synchronizes even shortly after a successful check');
  } finally { disposeForeground?.(); disposeBoot?.(); screen.unmount(); }
});

for (const platform of ['ios', 'android']) test(`${platform} cold startup restores the local display before mounting planner calendar and prefetch work`, async () => {
  let ready = false; const started = [];
  const provider = name => ({ children }) => { started.push(name); return children; };
  const screen = screenHarness('src/app/_layout.tsx', { platform, mocks: {
    'expo-router': { ThemeProvider: ({ children }) => children, DarkTheme: { colors: {} }, DefaultTheme: { colors: {} } },
    'expo-sqlite': { SQLiteProvider: ({ children }) => children },
    '@/platform/diagnostics/startup-splash': { prepareStartupDisplay() {} },
    '@/hooks/use-app-appearance': { initializeAppAppearance() {} },
    '@/platform/storage/repository': { initializeLocalDatabase: async () => {} },
    '@/features/google-sync/coordinator': { syncGoogleTasksAfterLocalCompletion() {} },
    '@/hooks/use-planner-data': { PlannerDataProvider: provider('planner'), usePlannerData: () => ({ database: {}, refresh: async () => {} }) },
    '../platform/widgets/widget-interaction-listener': {}, '@/components/planner-system-bars': { PlannerSystemBars: () => null },
    '@/components/notification-workspace-bridge': { NotificationWorkspaceBridge: () => null },
    '@/hooks/use-workspace': { WorkspaceProvider: ({ children }) => children, ActiveWorkspaceScope: ({ children }) => ready ? children : null },
    '@/components/workspace-navigator': { WorkspaceNavigator: () => 'ready-navigation' },
    '@/platform/sharing/adaptive-personal-runtime': {},
    '@/features/subscription/subscription-boundary': { SubscriptionBoundary: ({ children }) => children },
    '@/platform/notifications/configure-foreground-notifications': {}, '@/components/planner-theme': { plannerColorsForScheme: () => ({}) },
    '@/features/sharing/v2-ui/workspace-data': { WorkspaceDisplayProvider: provider('prefetch') },
    '@/features/calendar/use-local-calendar': { LocalCalendarProvider: provider('calendar') },
  } });
  try {
    assert.deepEqual(started, [], 'background providers must not compete with initial protected-display restoration');
    ready = true; await screen.flush();
    for (const kind of ['planner', 'calendar', 'prefetch']) assert.ok(started.includes(kind));
  } finally { screen.unmount(); }
});

for (const platform of ['ios', 'android']) test(`${platform} a device with no saved shared workspaces shows personal data before unrelated account restoration without starting workers`, async () => {
  for (const empty of [true, false]) {
    const effects = []; let finish; let workers = 0;
    const authentication = new Promise(resolve => { finish = resolve; });
    const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      '@/platform/sharing/startup-display': { readSavedStartupDisplay: async () => undefined, canShowPersonalStartup: async () => empty },
      '@/platform/sharing/auth': {}, '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => { workers++; return () => {}; } },
      '@/platform/sharing/workspaces': { readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => authentication, currentSharingWorkspace: async () => null,
        saveSharingSelection: async () => {}, subscribeSharingChanges: () => () => {} },
    } });
    const dispose = effects[0]();
    try {
      await new Promise(resolve => setTimeout(resolve, 5)); await screen.flush();
      let value = screen.nodes().find(node => node.props.value)?.props.value;
      assert.equal(value.ready, empty); assert.equal(value.active, null); assert.equal(value.userId, null); assert.equal(value.startupDisplay, null);
      effects.at(-1)()?.(); assert.equal(workers, 0);
      finish(null); await new Promise(resolve => setTimeout(resolve, 2)); await screen.flush();
      value = screen.nodes().find(node => node.props.value)?.props.value; assert.equal(value.ready, true); assert.equal(value.active, null);
    } finally { dispose?.(); screen.unmount(); }
  }
});

for (const platform of ['ios', 'android']) test(`${platform} local presentation does not wait for Firebase and cannot start network workers or authorize an old account`, async () => {
  const effects = []; let finishAuthentication; let workers = 0;
  const record = { userId: 'previous-owner', groupId: 'house', status: 'active' };
  const model = { viewerUserId: 'previous-owner', plan: { groupId: 'house' } };
  const authentication = new Promise(resolve => { finishAuthentication = resolve; });
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
    '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
    '@/platform/sharing/startup-display': { readSavedStartupDisplay: async () => ({ record, model }), startupDisplayCache: { read: async () => undefined } },
    '@/platform/sharing/auth': {}, '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => { workers++; return () => {}; } },
    '@/platform/sharing/workspaces': { readSharingSelection: async () => ({ userId: record.userId, groupId: record.groupId }), hasSharingSessionEnabled: async () => true,
      sharingSessionUser: async () => authentication, currentSharingWorkspace: async () => null,
      saveSharingSelection: async () => {}, subscribeSharingChanges: () => () => {} },
  } });
  const dispose = effects[0]();
  try {
    await screen.flush(); const value = screen.nodes().find(node => node.props.value)?.props.value;
    assert.equal(value.ready, true); assert.equal(value.active, null); assert.deepEqual(value.startupDisplay.model, model);
    const stop = effects.at(-1)(); assert.equal(workers, 0); stop?.();
    finishAuthentication({ uid: 'new-owner' }); await new Promise(resolve => setTimeout(resolve, 2)); await screen.flush();
    const current = screen.nodes().find(node => node.props.value)?.props.value;
    assert.equal(current.userId, 'new-owner'); assert.equal(current.active, null); assert.equal(current.startupDisplay, null);
  } finally { dispose?.(); screen.unmount(); }
});

for (const platform of ['ios', 'android']) test(`${platform} the saved home appears before expensive workspace restoration and an account change discards the pending old session`, async () => {
  const effects = []; let uid = 'owner'; let finish; let opened = 0;
  const record = { userId: 'owner', groupId: 'house', status: 'active' };
  const model = { viewerUserId: 'owner', plan: { groupId: 'house' } };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
    '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
    '@/platform/sharing/startup-display': { readSavedStartupDisplay: async () => undefined, startupDisplayCache: { read: async () => model } },
    '@/platform/sharing/private-calendar-sync': {}, '@/platform/sharing/auth': {},
    '@/platform/sharing/workspaces': { readSharingSelection: async () => ({ userId: 'owner', groupId: 'house' }), hasSharingSessionEnabled: async () => true,
      sharingSessionUser: async () => ({ uid }), currentSharingWorkspace: async () => uid === 'owner' ? record : null,
      openSharedWorkspace: async () => { opened++; return new Promise(resolve => { finish = resolve; }); }, saveSharingSelection: async () => {}, subscribeSharingChanges: () => () => {} },
  } });
  const dispose = effects[0]();
  try {
    for (let i = 0; i < 20 && !finish; i++) { await new Promise(resolve => setTimeout(resolve, 1)); await screen.flush(); }
    let value = screen.nodes().find(node => node.props.value)?.props.value;
    assert.equal(value.ready, true); assert.equal(value.active, null); assert.deepEqual(value.startupDisplay.model, model); assert.equal(opened, 1);
    uid = 'different-account'; await value.refreshSharing(); await screen.flush();
    finish({ ...record, protocol: 2, drain: async () => {} }); await screen.flush();
    value = screen.nodes().find(node => node.props.value)?.props.value;
    assert.equal(value.userId, 'different-account'); assert.equal(value.active, null); assert.equal(value.startupDisplay, null);
  } finally { dispose?.(); screen.unmount(); }
});

test('active workspace scope never injects a legacy provider and preserves the personal database context', () => {
  for (const platform of ['ios', 'android']) for (const active of [null, { protocol: 1, userId: 'owner', groupId: 'legacy', database: { legacy: true } },
    { protocol: 2, userId: 'owner', groupId: 'v2', database: { v2: true } }]) {
    const mounted = [];
    const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'ActiveWorkspaceScope', props: { children: 'workspace-child' }, mocks: {
      '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { ready: true, active } } },
      './use-planner-data': { PlannerDataProvider: ({ databaseOverride, children }) => { mounted.push(databaseOverride); return children; } },
      '@/platform/sharing/private-calendar-sync': {},
      '@/platform/sharing/auth': {}, '@/platform/storage/repository': {},
    } });
    assert.deepEqual(mounted, []);
    assert.ok(screen.text().includes('workspace-child'));
  }
});

for (const platform of ['ios', 'android']) test(`${platform} the same restored account keeps its saved tab hierarchy visible while membership is still loading`, async () => {
  const effects = []; let finishAuthentication; let finishMembership; let finishCache;
  const record = { userId: 'owner', groupId: 'house', status: 'active' }; const model = { viewerUserId: 'owner', plan: { groupId: 'house' } };
  const authentication = new Promise(resolve => { finishAuthentication = resolve; });
  const membership = new Promise(resolve => { finishMembership = resolve; });
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effectDependencies: true,
    effect: callback => effects.push(callback), mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      '@/platform/sharing/startup-display': { readSavedStartupDisplay: async () => ({ record, model }), startupDisplayCache: { read: () => new Promise(resolve => { finishCache = resolve; }) } },
      '@/platform/sharing/auth': {}, '@/platform/sharing/private-calendar-sync': {},
      '@/platform/sharing/workspaces': { readSharingSelection: async () => ({ userId: 'owner', groupId: 'house' }), hasSharingSessionEnabled: async () => true,
        sharingSessionUser: () => authentication, currentSharingWorkspace: () => membership,
        openSharedWorkspace: async () => ({ protocol: 2, userId: 'owner', groupId: 'house', drain: async () => {} }),
        saveSharingSelection: async () => {}, subscribeSharingChanges: () => () => {} },
    } });
  const cleanup = effects[0]();
  try {
    await screen.flush(); const current = () => screen.nodes().find(node => node.props.value)?.props.value;
    assert.deepEqual(current().startupDisplay.model, model);
    finishAuthentication({ uid: 'owner' }); await screen.flush();
    assert.deepEqual(current().startupDisplay.model, model, 'authentication must not tear down the same account route hierarchy');
    finishMembership(record);
    for (const deadline = Date.now() + 1000; !finishCache && Date.now() < deadline;) { await new Promise(resolve => setTimeout(resolve, 2)); await screen.flush(); }
    assert.ok(finishCache); assert.deepEqual(current().startupDisplay?.model, model);
    finishCache(model);
    for (let i = 0; i < 12; i++) { await new Promise(resolve => setTimeout(resolve, 1)); await screen.flush(); }
    assert.equal(current().active?.groupId, 'house');
  } finally { cleanup?.(); screen.unmount(); }
});

for (const platform of ['ios', 'android']) for (const registryBroken of [false, true]) {
  test(`${platform} foreground uses one timer for shared and private Calendar work and stops both after backgrounding even with registry failure=${registryBroken}`, async t => {
    const effects = []; const ticks = []; let stateListener; let privateStarts = 0; let privateStops = 0; let privateSyncs = 0; let sharedSyncs = 0;
    t.mock.method(globalThis, 'setInterval', (work, interval) => { assert.equal(interval, 600000); ticks.push(work); return ticks.length; });
    t.mock.method(globalThis, 'clearInterval', () => {});
    const appState = { currentState: 'active', addEventListener: (_event, listener) => { stateListener = listener; return { remove() {} }; } };
    const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) }, '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} }, 'react-native': { AppState: appState },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: userId => { assert.equal(userId, 'owner'); privateStarts++; return () => { privateStops++; }; }, syncKnownPrivateCalendar: async () => { privateSyncs++; } },
      '@/platform/sharing/workspaces': { saveSharingSelection: async () => {}, readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true, sharingSessionUser: async () => ({ uid: 'owner' }),
        currentSharingWorkspace: async () => { if (registryBroken) throw new Error('synthetic registry failure'); return null; },
        subscribeSharingChanges: () => () => {}, syncSharingWorkspace: async () => { sharedSyncs++; } },
    } });
    const disposeBoot = effects[0](); let disposeForeground;
    try {
      await screen.flush(); disposeForeground = effects.at(-1)(); await screen.flush();
      assert.equal(privateStarts, 1); assert.equal(privateSyncs, 1); assert.equal(sharedSyncs, 1); assert.equal(ticks.length, 1);
      ticks[0](); await screen.flush(); assert.equal(privateSyncs, 2); assert.equal(sharedSyncs, 2);
      appState.currentState = 'background'; stateListener('background'); ticks[0](); await screen.flush();
      assert.equal(privateStops, 1); assert.equal(privateSyncs, 2); assert.equal(sharedSyncs, 2);
      appState.currentState = 'active'; stateListener('active'); await screen.flush();
      assert.equal(privateStarts, 2); assert.equal(privateSyncs, 3); assert.equal(sharedSyncs, 3); assert.equal(ticks.length, 2);
    } finally { disposeForeground?.(); disposeBoot?.(); }
    assert.equal(privateStops, 2);
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} workspace bootstrap rechecks the account after registry I/O before exposing groups or starting private work`, async () => {
    let currentUser = 'old-owner'; const effects = [];
    const group = { userId: 'new-owner', groupId: 'new-account-group', status: 'active' };
    const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) }, '@/platform/storage/repository': {},
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} }, '@/platform/sharing/private-calendar-sync': {},
      '@/platform/sharing/workspaces': { saveSharingSelection: async () => {}, readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: currentUser }), currentSharingWorkspace: async () => { currentUser = 'new-owner'; return group; }, openSharedWorkspace: async () => ({ ...group, protocol: 2, drain: async () => {} }), subscribeSharingChanges: () => () => {} },
    } });
    const dispose = effects[0](); try { await screen.flush(); const value = screen.nodes().find(node => node.props.value?.ready === true)?.props.value;
      assert.ok(value); assert.equal(value.userId, 'new-owner'); assert.deepEqual(value.group, group);
    } finally { dispose?.(); }
  });
}

for (const [platform, name] of [
  ['ios', 'ios foreground sharing listener errors recheck membership instead of leaving revoked groups actionable until the next interval'],
  ['android', 'android foreground sharing listener errors recheck membership instead of leaving revoked groups actionable until the next interval'],
]) test(name, async () => {
  const effects = []; const watches = []; const synchronizations = []; let unsubscribed = 0;
  const group = { userId: 'owner', groupId: 'group-test', status: 'active', displayName: '家族' };
  const workspace = { ...group, protocol: 1, database: {}, readOverview: async () => ({}), drain: async () => {}, adapter: { readSnapshot: async () => ({}) },
    watch: (changed, failed) => { watches.push({ changed, failed }); return () => { unsubscribed++; }; },
    async sync() { synchronizations.push('membership-check'); throw new Error('synthetic unavailable or permission-denied'); } };
  const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: (callback) => effects.push(callback),
    mocks: {
      '@/components/planner-ui': {},
      '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) },
      '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => () => {}, syncKnownPrivateCalendar: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} },
      'react-native': { AppState: appState },
      '@/platform/sharing/workspaces': {
        readSharingSelection: async () => ({ userId: group.userId, groupId: group.groupId }), hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: 'owner' }), currentSharingWorkspace: async () => group,
        openSharedWorkspace: async () => workspace, subscribeSharingChanges: () => () => {}, syncSharingWorkspace: async () => {},
      },
    } });
  const disposeBoot = effects[0](); let disposeForeground;
  try {
    await screen.flush();
    disposeForeground = effects.at(-1)();
    await screen.flush();
    assert.equal(watches.length, 1);
    watches[0].failed({ code: 'permission-denied' });
    await screen.flush();
    assert.deepEqual(synchronizations, ['membership-check']);
    watches[0].failed({ code: 'unavailable' });
    watches[0].changed();
    await screen.flush();
    assert.equal(synchronizations.length, 3, 'both successful updates and terminated listeners use the same existing coordinator');
  } finally { disposeForeground?.(); disposeBoot?.(); }
  assert.equal(unsubscribed, 1);
});

for (const [platform, name] of [['ios', 'ios backgrounding during the current group listener setup never starts periodic recovery'], ['android', 'android backgrounding during the current group listener setup never starts periodic recovery']]) test(name, async () => {
  const effects = [], opened = []; let appStateListener, recoveries = 0, foreground = false;
  const group = { userId: 'owner', groupId: 'broken', status: 'active' };
  const appState = { currentState: 'active', addEventListener: (_event, listener) => { appStateListener = listener; return { remove() {} }; } };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: (callback) => effects.push(callback),
    mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) },
      '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => () => {}, syncKnownPrivateCalendar: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} }, 'react-native': { AppState: appState },
      '@/platform/sharing/workspaces': {
        saveSharingSelection: async () => {}, readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: 'owner' }), currentSharingWorkspace: async () => group,
        openSharedWorkspace: async (group) => {
          if (!foreground) return { ...group, protocol: 2, drain: async () => {} };
          opened.push(group.groupId);
          if (group.groupId === 'broken') { appState.currentState = 'background'; appStateListener('background'); throw new Error('DB open interrupted'); }
          return { watch: () => () => {} };
        },
        subscribeSharingChanges: () => () => {}, syncSharingWorkspace: async () => { recoveries++; },
      },
    } });
  const disposeBoot = effects[0](); let disposeForeground;
  try {
    await screen.flush();
    const value = screen.nodes().find(node => node.props.value?.active)?.props.value;
    assert.ok(value); value.completeInitialDisplay(value.active);
    await new Promise(resolve => setTimeout(resolve, 1));
    foreground = true; disposeForeground = effects.at(-1)(); await screen.flush();
    assert.deepEqual(opened, ['broken']);
    assert.equal(recoveries, 0, 'a failed final group must not start recovery after the app has backgrounded');
  } finally { disposeForeground?.(); disposeBoot?.(); }
});

for (const [platform, name] of [
  ['ios', 'ios historical groups are not watched while the current group retains periodic recovery'],
  ['android', 'android historical groups are not watched while the current group retains periodic recovery'],
]) test(name, async () => {
  const effects = [], watches = []; let unsubscribed = 0, recoveries = 0;
  const groups = ['broken', 'healthy'].map((groupId) => ({ userId: 'owner', groupId, status: 'active' }));
  const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: (callback) => effects.push(callback),
    mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) },
      '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => () => {}, syncKnownPrivateCalendar: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} },
      'react-native': { AppState: appState },
      '@/platform/sharing/workspaces': {
        saveSharingSelection: async () => {}, readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: 'owner' }), currentSharingWorkspace: async () => groups.find(group => group.groupId === 'healthy') ?? null,
        openSharedWorkspace: async (group) => {
          if (group.groupId === 'broken') throw new Error('protected database cannot open');
          return { watch: () => { watches.push(group.groupId); return () => { unsubscribed++; }; } };
        },
        subscribeSharingChanges: () => () => {}, syncSharingWorkspace: async () => { recoveries++; },
      },
    } });
  const disposeBoot = effects[0](); let disposeForeground;
  try {
    await screen.flush(); disposeForeground = effects.at(-1)(); await screen.flush();
    assert.deepEqual(watches, ['healthy']);
    assert.equal(recoveries, 1, 'a failed group must not prevent the recovery coordinator from being started');
  } finally { disposeForeground?.(); disposeBoot?.(); }
  assert.equal(unsubscribed, 1);
});

for (const platform of ['ios', 'android']) test(`${platform} status-only sync notifications do not reload account membership while real permission changes still revoke the workspace`, async () => {
  const effects = []; let notify; let membershipReads = 0; let authReads = 0; let drained = 0;
  let record = { userId: 'owner', groupId: 'house', status: 'active' };
  const workspace = { ...record, protocol: 2, drain: async () => { drained++; } };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
    '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
    '@/platform/sharing/startup-display': { readSavedStartupDisplay: async () => undefined, startupDisplayCache: { read: async () => undefined } },
    '@/platform/sharing/auth': {}, '@/platform/sharing/private-calendar-sync': {},
    '@/platform/sharing/workspaces': { readSharingSelection: async () => ({ userId: 'owner', groupId: 'house' }), hasSharingSessionEnabled: async () => true,
      sharingSessionUser: async () => { authReads++; return { uid: 'owner' }; }, currentSharingWorkspace: async () => { membershipReads++; return record; },
      openSharedWorkspace: async () => workspace, saveSharingSelection: async () => {}, subscribeSharingChanges: listener => { notify = listener; return () => {}; } },
  } });
  const dispose = effects[0]();
  try {
    for (let n = 0; n < 5; n++) await screen.flush();
    assert.equal(screen.nodes().find(node => node.props.value)?.props.value.active, workspace);
    const before = { authReads, membershipReads };
    for (let n = 0; n < 50; n++) notify({ userId: 'owner', groupId: 'house', statusOnly: true });
    for (let n = 0; n < 5; n++) await screen.flush();
    assert.deepEqual({ authReads, membershipReads }, before, 'a completed sync does not restart membership or notification work');
    record = { ...record, status: 'removed' }; notify({ userId: 'owner', groupId: 'house' });
    for (let n = 0; n < 5; n++) await screen.flush();
    assert.ok(membershipReads > before.membershipReads); assert.equal(drained, 1);
    assert.equal(screen.nodes().find(node => node.props.value)?.props.value.active, null);
  } finally { dispose?.(); screen.unmount(); }
});
