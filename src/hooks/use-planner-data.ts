import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { createContext, createElement, useContext, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import { millisecondsUntilNextLocalDay } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { applyWeatherToPlannerSnapshot, loadGoogleSyncState, loadPlannerSnapshot, LOCAL_HOUSEHOLD_ID, refreshCachedApplianceLibrary } from '@/platform/storage/repository';
import { subscribeApplianceLibraryChanges } from '@/features/appliance-care/library-changes';
import { refreshPlannerFromWidget } from '@/platform/widgets/refresh-planner-from-widget';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { syncDailyHouseworkDigest } from '@/features/notifications/daily-housework-digest';
import { expoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import { subscribeToGooglePlannerChanges } from '@/features/google-sync/planner-change-events';
import { registerGoogleSyncBackgroundTask } from '@/features/google-sync/background-task';
import { syncGoogleTasks } from '@/features/google-sync/coordinator';
import { createPlannerRefreshController } from '@/features/planner/refresh-controller';
import { sharedRepositoryAdapter } from '@/platform/storage/shared-repository-adapter';
import { sharedGoogleNamespace, sharedPlannerChangeScope } from '@/features/google-sync/workspace-policy';
import { millisecondsUntilNextSharedDay } from '@/features/sharing/group-clock';
import { subscribeSharingChanges } from '@/platform/sharing/workspaces';
import { PlannerIssuesContext } from '@/contexts/planner-issues-context';

type PlannerController = ReturnType<typeof createPlannerRefreshController<PlannerSnapshot>>;
type PlannerBinding = { database: SQLiteDatabase; controller: PlannerController };
const PlannerContext = createContext<PlannerBinding | null>(null);
const PersonalPlannerContext = createContext<PlannerBinding | null>(null);

function SharedPlannerIssuesProvider({ children, controller, groupId }: {
  children?: ReactNode; controller: PlannerController; groupId: string;
}) {
  const getCount = useMemo(() => () => {
    const sharing = controller.getSnapshot().snapshot?.sharing;
    return sharing?.groupId === groupId ? sharing.issues.length : 0;
  }, [controller, groupId]);
  const issueCount = useSyncExternalStore(controller.subscribe, getCount, getCount);
  const value = useMemo(() => ({ groupId, issueCount }), [groupId, issueCount]);
  return createElement(PlannerIssuesContext.Provider, { value }, children);
}

/** The only foreground owner of planner reads, lifecycle subscriptions and snapshot side effects. */
export function PlannerDataProvider({ children, databaseOverride }: { children: ReactNode; databaseOverride?: SQLiteDatabase }) {
  const personalDatabase = useSQLiteContext();
  const database = databaseOverride ?? personalDatabase;
  const shared = sharedRepositoryAdapter(database);
  const controller = useMemo(() => createPlannerRefreshController<PlannerSnapshot>({
    discardSnapshotOnError: (error) => Boolean(shared && error && typeof error === 'object' && 'code' in error
      && ['sharing/scheduler-version-mismatch', 'sharing/access-denied'].includes(String(error.code))),
    load: (ids, force) => shared ? loadPlannerSnapshot(database).then((snapshot) => ({ snapshot, canPublishWidget: false }))
      : refreshPlannerFromWidget(database, ids, { publish: false, preferCached: !force }),
    weather: (snapshot, canCommit) => snapshot.settings.weatherLocation
      ? applyWeatherToPlannerSnapshot(database, snapshot, canCommit) : Promise.resolve(null),
    publish: (snapshot, canPublishWidget) => {
      if (!shared && canPublishWidget) publishTodayWidgetSnapshot(snapshot);
      return syncDailyHouseworkDigest(expoLocalNotificationGateway, shared ? { ...snapshot,
        notificationScope: sharedGoogleNamespace(shared.userId, shared.groupId), notificationTitle: `${snapshot.household.name}の家事` } : snapshot).then(() => undefined);
    },
  }), [database, shared]);

  useEffect(() => {
    let live = true;
    let appState = AppState.currentState;
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;
    const syncGoogleIfDue = async () => {
      const state = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
      if (!state?.enabled) return;
      await registerGoogleSyncBackgroundTask().catch(() => false);
      await syncGoogleTasks(database);
    };
    const scheduleMidnight = () => {
      clearTimeout(midnightTimer);
      if (!live || appState === 'background' || appState === 'inactive') return;
      midnightTimer = setTimeout(() => {
        void controller.refresh({ force: true });
        scheduleMidnight();
      }, (shared && controller.getSnapshot().snapshot?.timeZone
        ? millisecondsUntilNextSharedDay(new Date(), controller.getSnapshot().snapshot!.timeZone!) : millisecondsUntilNextLocalDay(new Date())) + 100);
    };
    const resume = () => {
      // Native/background work can use another SQLite connection, so bypass the JS cache on resume.
      void controller.refresh({ force: true }).then(scheduleMidnight);
      void syncGoogleIfDue().catch(() => undefined);
      scheduleMidnight();
    };
    if (appState !== 'background' && appState !== 'inactive') resume();
    const refresh = () => {
      if (appState === 'background' || appState === 'inactive') return false;
      void controller.refresh();
      return true;
    };
    const unsubscribe = subscribeToGooglePlannerChanges(refresh, shared ? sharedPlannerChangeScope(shared.userId, shared.groupId) : 'personal');
    const unsubscribeAppliances = shared ? () => {} : subscribeApplianceLibraryChanges(() => {
      void refreshCachedApplianceLibrary(database).then(() => { if (live) refresh(); }).catch(() => { if (live) void controller.refresh({ force: true }); });
    });
    const unsubscribeSharing = shared ? subscribeSharingChanges((scope) => {
      if (scope?.userId === shared.userId && scope.groupId === shared.groupId) refresh();
    }) : () => {};
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && appState !== 'active') resume();
      else if (next !== 'active') {
        clearTimeout(midnightTimer);
        controller.invalidate();
      }
      appState = next;
    });
    let previousZone = controller.getSnapshot().snapshot?.timeZone;
    const unsubscribeClock = controller.subscribe(() => {
      const zone = controller.getSnapshot().snapshot?.timeZone;
      if (zone !== previousZone) { previousZone = zone; scheduleMidnight(); }
    });
    return () => {
      live = false;
      unsubscribeClock();
      unsubscribe();
      unsubscribeAppliances();
      unsubscribeSharing();
      subscription.remove();
      clearTimeout(midnightTimer);
      controller.invalidate();
      // Access revocation or a failed initial read can clear the snapshot before
      // unmount. Cancellation needs only the scope, never a readable old group.
      if (shared) void syncDailyHouseworkDigest(expoLocalNotificationGateway, {
        notificationScope: sharedGoogleNamespace(shared.userId, shared.groupId),
        scheduleEntries: [], chores: [], completions: [],
        settings: { notificationHour: 9, notificationMinute: 0, notificationsEnabled: false, setupCompleted: false },
      }).catch(() => undefined);
    };
  }, [controller, database, shared]);

  const value = useMemo(() => ({ database, controller }), [database, controller]);
  const scoped = createElement(PlannerContext.Provider, { value }, shared
    ? createElement(SharedPlannerIssuesProvider, { controller, groupId: shared.groupId }, children) : children);
  // Reuse the root provider's reads and lifecycle work. A shared provider cannot replace this binding.
  return shared ? scoped : createElement(PersonalPlannerContext.Provider, { value }, scoped);
}

export function usePlannerData(options?: { personal?: boolean }) {
  const scoped = useContext(PlannerContext);
  const personal = useContext(PersonalPlannerContext);
  const context = options?.personal ? personal : scoped;
  if (!context) throw new Error('usePlannerData must be used within PlannerDataProvider');
  const readError = useCallback(() => context.controller.getSnapshot().error, [context.controller]);
  const readSnapshot = useCallback(() => context.controller.getSnapshot().snapshot, [context.controller]);
  const state = useSyncExternalStore(context.controller.subscribe, context.controller.getSnapshot, context.controller.getSnapshot);
  return { ...state, database: context.database, refresh: context.controller.refresh, readError, readSnapshot };
}
