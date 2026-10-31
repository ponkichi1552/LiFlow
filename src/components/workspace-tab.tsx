import { useContext, useEffect, type ReactNode } from 'react';
import { WorkspaceContext } from '../contexts/workspace-context';
import { V2WorkspaceRoute } from '@/features/sharing/v2-ui/workspace-route';
import { Tabs, useLocalSearchParams, useNavigation } from 'expo-router';
import { resetCalendarOverview } from '../hooks/use-calendar-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { plannerTabBarLayout } from './planner-tab-bar';
import { palette } from './planner-ui';
type TabState = { type?: string; index?: number; routes: readonly { name: string }[] };
type TabNavigation = {
  getState?(): TabState;
  addListener(event: 'state', callback: (event: { data: { state: TabState } }) => void): () => void;
  setParams(params: { choreId?: string; source?: string; returnTo?: string }): void;
};

/** The tab identity stays the same when joining or leaving a group. */
export function WorkspaceTab({ view, children }: {
  view: 'home' | 'calendar' | 'chores' | 'appliances'; children: ReactNode;
}) {
  const workspace = useContext(WorkspaceContext);
  const navigation = useNavigation<TabNavigation>();
  useEffect(() => {
    const name = ({ home: 'index', calendar: 'explore', chores: 'guide', appliances: 'manual' } as const)[view];
    const initial = navigation.getState?.();
    let wasActive = initial?.index !== undefined && initial.routes[initial.index]?.name === name;
    return navigation.addListener('state', event => {
      const state = event.data.state;
      // Opening a settings page above the tabs is not a tab change.
      if (state.type !== 'tab' || state.index === undefined) return;
      const active = state.routes[state.index]?.name;
      if (wasActive && active !== name) {
        if (view === 'calendar') resetCalendarOverview();
        if (view === 'chores') navigation.setParams({ choreId: undefined, source: undefined, returnTo: undefined });
      }
      wasActive = active === name;
    });
  }, [navigation, view]);
  const params = useLocalSearchParams<{ choreId?: string }>();
  const insets = useSafeAreaInsets();
  return workspace?.active?.protocol === 2 || workspace?.startupDisplay ? <><Tabs.Screen options={{ tabBarStyle: { ...plannerTabBarLayout(insets.bottom), backgroundColor: palette.surface, borderTopColor: palette.border, borderTopWidth: 1 } }} />
    <V2WorkspaceRoute view={view === 'chores' && typeof params.choreId === 'string' ? 'guide' : view} /></> : children;
}
