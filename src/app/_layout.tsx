import { CalendarNotificationBridge } from '@/features/calendar/calendar-notification-bridge';
import { AnalysisReceiptBridge } from '@/features/appliance-care/analysis-receipt-bridge';
import { AnalysisWorkBridge } from '@/features/appliance-care/analysis-work-bridge';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { prepareStartupDisplay } from '@/platform/diagnostics/startup-splash';
import { SQLiteProvider } from 'expo-sqlite';
import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { initializeLocalDatabase } from '@/platform/storage/repository';
import { isTransientPlannerRead, plannerReadRetryDelays } from '@/platform/storage/planner-read-retry';
import { PlannerLoadState } from '@/components/planner-load-state';
import { syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';
import { PlannerDataProvider, usePlannerData } from '@/hooks/use-planner-data';
import { addWidgetUserInteractionListener } from '../platform/widgets/widget-interaction-listener';
import { PlannerSystemBars } from '@/components/planner-system-bars';
import { NotificationWorkspaceBridge } from '@/components/notification-workspace-bridge';
import { WorkspaceProvider, ActiveWorkspaceScope } from '@/hooks/use-workspace';
import { WorkspaceNavigator } from '@/components/workspace-navigator';
import '@/platform/notifications/configure-foreground-notifications';
import '@/platform/sharing/adaptive-personal-runtime';
import '@/platform/sharing/install-native-ed25519';
import { plannerColorsForScheme } from '@/components/planner-theme';
import { WorkspaceDisplayProvider } from '@/features/sharing/v2-ui/workspace-data';
import { LocalCalendarProvider } from '@/features/calendar/use-local-calendar';
import { traceStartup } from '@/platform/diagnostics/startup-timing';
import { prepareSavedStartupDisplay } from '@/platform/sharing/startup-display';
import { SubscriptionBoundary } from '@/features/subscription/subscription-boundary';
import { initializeAppAppearance } from '@/hooks/use-app-appearance';

prepareStartupDisplay(SplashScreen);
prepareSavedStartupDisplay();
initializeAppAppearance();

function PersonalPlannerDatabase({ children }: PropsWithChildren) {
  const [opening, setOpening] = useState({ key: 0, retries: 0, error: null as Error | null, pending: true });
  const key = opening.key;
  const initialize = useCallback(async (database: Parameters<typeof initializeLocalDatabase>[0]) => {
    try {
      await traceStartup('database.initialize', () => initializeLocalDatabase(database));
    } catch (cause) {
      // Expo owns the connection after onInit succeeds. Close a failed initialization before reopening.
      await database.closeAsync().catch(() => undefined);
      throw cause;
    }
    setOpening(current => current.key === key && current.pending && current.error ? { ...current, error: null } : current);
  }, [key]);
  const onError = useCallback((error: Error) => {
    // SQLiteProvider calls onError while rendering; notify its parent after that render.
    queueMicrotask(() => setOpening(current => current.key === key && current.pending ? { ...current, pending: false, error } : current));
  }, [key]);
  const recoverable = isTransientPlannerRead(opening.error);
  const delay = recoverable ? plannerReadRetryDelays[opening.retries] : undefined;
  useEffect(() => {
    if (opening.pending || !recoverable) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reopen = (foreground: boolean) => setOpening(current => current === opening
      ? { ...current, key: current.key + 1, retries: foreground ? 0 : current.retries + 1, pending: true } : current);
    const arm = () => {
      clearTimeout(timer);
      if (delay !== undefined && AppState.currentState !== 'background' && AppState.currentState !== 'inactive') timer = setTimeout(() => reopen(false), delay);
    };
    const subscription = AppState.addEventListener('change', state => {
      clearTimeout(timer);
      if (state === 'active') reopen(true);
    });
    arm();
    return () => { clearTimeout(timer); subscription.remove(); };
  }, [opening, delay, recoverable]);
  return <>
    <SQLiteProvider key={key} databaseName="housework.db" onInit={initialize} onError={onError}>{children}</SQLiteProvider>
    {opening.error ? <PlannerLoadState title="今日の家事" message="家事を読み込んでいます。" startupReady
      error={opening.pending || delay !== undefined ? null : '端末に保存した家事を表示できませんでした。'} /> : null}
  </>;
}

function WidgetInteractionBridge() {
  const { database, refresh } = usePlannerData();

  const processCompletion = useCallback(async (scheduleEntryId: string) => {
    try {
      await refresh({ widgetCompletionIds: [scheduleEntryId] });
      syncGoogleTasksAfterLocalCompletion(database);
    } catch {
      // Widget actions should not interrupt the app if local data cannot be refreshed.
    }
  }, [database, refresh]);

  useEffect(() => {
    const interactionSubscription = addWidgetUserInteractionListener((event) => {
      const prefix = 'complete:';
      if (event.source === 'NextChoreWidget' && event.target.startsWith(prefix)) {
        void processCompletion(event.target.slice(prefix.length));
      }
    });
    return () => {
      interactionSubscription.remove();
    };
  }, [processCompletion]);

  return null;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const colors = plannerColorsForScheme(colorScheme);
  const baseTheme = colorScheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = { ...baseTheme, colors: { ...baseTheme.colors, background: colors.background, card: colors.surface,
    text: colors.ink, border: colors.border, primary: colors.accent, notification: colors.warning } };
  return (
    <SubscriptionBoundary><WorkspaceProvider>
      <PersonalPlannerDatabase>
        <ActiveWorkspaceScope>
          <PlannerDataProvider>
            <LocalCalendarProvider>
              <WorkspaceDisplayProvider>
                <ThemeProvider value={theme}>
                  <>
                    <PlannerSystemBars />
                    <WidgetInteractionBridge />
                    <NotificationWorkspaceBridge />
                    <CalendarNotificationBridge />
                    <AnalysisReceiptBridge />
                    <AnalysisWorkBridge />
                    <WorkspaceNavigator />
                  </>
                </ThemeProvider>
              </WorkspaceDisplayProvider>
            </LocalCalendarProvider>
          </PlannerDataProvider>
        </ActiveWorkspaceScope>
      </PersonalPlannerDatabase>
    </WorkspaceProvider></SubscriptionBoundary>
  );
}
