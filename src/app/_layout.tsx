import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { useCallback, useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { initializeLocalDatabase } from '@/platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';
import { PlannerDataProvider, usePlannerData } from '@/hooks/use-planner-data';
import { addWidgetUserInteractionListener } from '../platform/widgets/widget-interaction-listener';
import { PlannerSystemBars } from '@/components/planner-system-bars';
import { NotificationWorkspaceBridge } from '@/components/notification-workspace-bridge';
import { WorkspaceProvider, ActiveWorkspaceScope, useWorkspace } from '@/hooks/use-workspace';
import { WorkspaceNavigator } from '@/components/workspace-navigator';
import '@/platform/notifications/configure-foreground-notifications';
import { plannerColorsForScheme } from '@/components/planner-theme';

function WidgetInteractionBridge() {
  const { database, refresh } = usePlannerData();
  const { switchTo, active } = useWorkspace();

  const processCompletion = useCallback(async (scheduleEntryId: string) => {
    try {
      await refresh({ widgetCompletionIds: [scheduleEntryId] });
      if (active) await switchTo(null);
      syncGoogleTasksAfterLocalCompletion(database);
    } catch {
      // Widget actions should not interrupt the app if local data cannot be refreshed.
    }
  }, [database, refresh, switchTo, active]);

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
    <SQLiteProvider databaseName="housework.db" onInit={initializeLocalDatabase}>
      <PlannerDataProvider>
        <WorkspaceProvider>
        <ThemeProvider value={theme}>
          <>
            <PlannerSystemBars />
            <WidgetInteractionBridge />
            <NotificationWorkspaceBridge />
            <ActiveWorkspaceScope>
            <WorkspaceNavigator />
            </ActiveWorkspaceScope>
          </>
        </ThemeProvider>
        </WorkspaceProvider>
      </PlannerDataProvider>
    </SQLiteProvider>
  );
}
