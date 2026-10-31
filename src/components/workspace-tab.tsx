import { useContext, type ReactNode } from 'react';
import { WorkspaceContext } from '../contexts/workspace-context';
import { V2WorkspaceRoute } from '@/features/sharing/v2-ui/workspace-route';
import { Tabs, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { plannerTabBarLayout } from './planner-tab-bar';
import { palette } from './planner-ui';

/** The tab identity stays the same when joining or leaving a group. */
export function WorkspaceTab({ view, children }: {
  view: 'home' | 'calendar' | 'chores' | 'appliances'; children: ReactNode;
}) {
  const workspace = useContext(WorkspaceContext);
  const params = useLocalSearchParams<{ choreId?: string }>();
  const insets = useSafeAreaInsets();
  return workspace?.active?.protocol === 2 || workspace?.startupDisplay ? <><Tabs.Screen options={{ tabBarStyle: { ...plannerTabBarLayout(insets.bottom), backgroundColor: palette.surface, borderTopColor: palette.border, borderTopWidth: 1 } }} />
    <V2WorkspaceRoute view={view === 'chores' && typeof params.choreId === 'string' ? 'guide' : view} /></> : children;
}
