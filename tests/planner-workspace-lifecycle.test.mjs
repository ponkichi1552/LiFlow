import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { AdaptiveOwnerInputsChangedError } from '../src/platform/storage/adaptive-owner-inputs.ts';

const loadedSnapshot = { household: { name: '家族' }, settings: { notificationsEnabled: true } };
for (const [platform, snapshot, name] of [
  ['ios', null, 'ios leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: no snapshot'],
  ['ios', loadedSnapshot, 'ios leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: loaded'],
  ['android', null, 'android leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: no snapshot'],
  ['android', loadedSnapshot, 'android leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: loaded'],
]) {
    test(name, async () => {
      const effects = [], cancelled = []; const gateway = {}; let invalidated = 0;
      const shared = { userId: 'member', groupId: 'group-test' };
      const scope = 'a'.repeat(64);
      let currentSnapshot = snapshot;
      const controller = { getSnapshot: () => ({ snapshot: currentSnapshot }), subscribe: () => () => {}, invalidate() { invalidated++; } };
      const { PlannerDataProvider } = loadNativeModule('src/hooks/use-planner-data.ts', {
        'expo-sqlite': { useSQLiteContext: () => ({}) },
        react: { createContext: () => ({}), useMemo: (callback) => callback(),
          useEffect: (callback) => effects.push(callback), createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
          useSyncExternalStore: (subscribe, getSnapshot, getServerSnapshot) => {
            assert.equal(subscribe, controller.subscribe); assert.equal(getSnapshot(), getServerSnapshot()); return getSnapshot();
          } },
        'react-native': { Platform: { OS: platform }, AppState: { currentState: 'background', addEventListener: () => ({ remove() {} }) } },
        '@/domain/scheduling/local-date': {}, '@/platform/storage/repository': {}, '@/platform/widgets/refresh-planner-from-widget': {},
        '@/features/widgets/publish-today-widget-snapshot': {},
        '@/features/notifications/daily-housework-digest': { syncDailyHouseworkDigest: async (usedGateway, state) => {
          assert.equal(usedGateway, gateway); cancelled.push(state);
        } },
        '@/platform/notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
        '@/features/google-sync/planner-change-events': { subscribeToGooglePlannerChanges: () => () => {} },
        '@/features/appliance-care/library-changes': { subscribeApplianceLibraryChanges: () => () => {} },
        '@/features/google-sync/background-task': {}, '@/features/google-sync/coordinator': {},
        '@/features/planner/refresh-controller': { createPlannerRefreshController: () => controller },
        '@/platform/storage/adaptive-owner-inputs': { AdaptiveOwnerInputsChangedError },
        '@/platform/storage/shared-repository-adapter': { sharedRepositoryAdapter: () => shared },
        '@/features/google-sync/workspace-policy': { sharedGoogleNamespace: (userId, groupId) => {
          assert.equal(userId, shared.userId); assert.equal(groupId, shared.groupId); return scope;
        }, sharedPlannerChangeScope: () => scope },
        '@/features/sharing/group-clock': {}, '@/platform/sharing/workspaces': { subscribeSharingChanges: () => () => {} },
        '@/contexts/planner-issues-context': { PlannerIssuesContext: { Provider: 'PlannerIssuesProvider' } },
      });
      const provider = PlannerDataProvider({ children: null, databaseOverride: {} });
      const issues = provider.props.children[0];
      assert.equal(issues.type(issues.props).props.value.issueCount, 0);
      currentSnapshot = { sharing: { groupId: shared.groupId, issues: [{}] } };
      assert.deepEqual(issues.type(issues.props).props.value, { groupId: shared.groupId, issueCount: 1 });
      currentSnapshot = { sharing: { groupId: 'another-group', issues: [{}, {}] } };
      assert.equal(issues.type(issues.props).props.value.issueCount, 0, 'a previous group snapshot cannot leak its warning');
      const dispose = effects[0]();
      dispose();
      await Promise.resolve();
      assert.equal(invalidated, 1);
      assert.equal(cancelled.length, 1, 'startup failure, access revocation and group switches must all cancel old reminders');
      assert.equal(cancelled[0].notificationScope, scope);
      assert.equal(cancelled[0].settings.notificationsEnabled, false);
    });
}
