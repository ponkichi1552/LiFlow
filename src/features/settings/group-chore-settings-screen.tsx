import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useContext, useEffect, useState } from 'react';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { openSharedWorkspace, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import type { SharedWorkspace } from '@/platform/sharing/workspace-types';
import { PlannerLoadState } from '@/components/planner-load-state';
import { createV2SettingsSession } from './group-chore-settings-source';
import { V2GroupScreen } from '../sharing/v2-ui/group-screen';
import { readOptionsForView, type V2GroupScreenProps } from '../sharing/v2-ui/group-screen';
import { useOptionalWorkspaceDisplay } from '../sharing/v2-ui/workspace-data';
import type { ChoreAudienceSelection } from '../chores/audience-selection';

export function GroupChoreSettingsScreen() {
  const context = useContext(WorkspaceContext);
  const params = useLocalSearchParams<{ id: string; groupId: string; matchName?: string; matchCategory?: string }>();
  if (!context?.userId || typeof params.groupId !== 'string' || typeof params.id !== 'string'
    || !(context.group?.userId === context.userId && context.group.groupId === params.groupId && ['active', 'creating'].includes(context.group.status))) {
    return <PlannerLoadState title="グループの家事設定" message="所属グループを確認してください。" error="このグループは現在編集できません。" retry={async () => router.back()} />;
  }
  const selection = typeof params.matchName === 'string' && typeof params.matchCategory === 'string'
    ? { name: params.matchName, category: params.matchCategory } : undefined;
  const opened = context.active?.userId === context.userId && context.active.groupId === params.groupId ? context.active : undefined;
  return <SelectedGroupChoreSettings key={`${context.userId}:${params.groupId}`} userId={context.userId} groupId={params.groupId} choreId={params.id} selection={selection} initialWorkspace={opened} />;
}
export function SelectedGroupChoreSettings({ userId, groupId, choreId, selection, initialView = 'details', initialWorkspace }: { userId: string; groupId: string; choreId: string; selection?: ChoreAudienceSelection; initialView?: 'details' | 'history'; initialWorkspace?: SharedWorkspace }) {
  const display = useOptionalWorkspaceDisplay();
  const [workspace, setWorkspace] = useState<SharedWorkspace | null>(display?.workspace?.userId === userId && display.workspace.groupId === groupId ? display.workspace
    : initialWorkspace?.userId === userId && initialWorkspace.groupId === groupId ? initialWorkspace : null);
  const [error, setError] = useState<string | null>(null); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void openSharedWorkspace({ userId, groupId }).then(async value => {
      await value.record(); if (current) { setWorkspace(value); setError(null); }
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : 'グループを読み込めませんでした。'); });
    return () => { current = false; };
  }, [userId, groupId, retry]);
  if (!workspace) return <PlannerLoadState title="グループの家事設定" message="設定を読み込んでいます。" error={error} retry={async () => setRetry(value => value + 1)} />;
  if (workspace.protocol === 2) return <V2GroupChoreSettings workspace={workspace} choreId={choreId} selection={selection} initialView={initialView} />;
  return <PlannerLoadState title="グループの家事設定" message="履歴と設定を保持しています。" error="共有グループでv2への移行を完了してください。" retry={async () => router.replace('/sharing')} />;
}
/** A detached editor always targets the named group, including when another workspace is open. */
function V2GroupChoreSettings({ workspace, choreId, selection, initialView }: { workspace: Extract<SharedWorkspace, { protocol: 2 }>; choreId: string; selection?: ChoreAudienceSelection; initialView: 'details' | 'history' }) {
  const binding = useOptionalWorkspaceDisplay(); const display = binding?.workspace === workspace ? binding : null;
  const [view, setView] = useState<V2GroupScreenProps['view']>(initialView);
  const loadSession = useCallback(async () => { await workspace.record(); return display ? display.loadSession() : createV2SettingsSession(workspace); }, [workspace, display]);
  const subscribe = useCallback((refresh: () => void) => display ? display.subscribe(refresh) : subscribeSharingChanges(scope => {
    if (scope?.userId === workspace.userId && scope.groupId === workspace.groupId) refresh();
  }), [workspace, display]);
  const openConfiguration = useCallback(() => setView('configuration'), []);
  const onBack = () => view === initialView ? router.back() : setView('details');
  return <V2GroupScreen purpose="workspace" view={view} choreId={choreId} settingsSelection={selection} loadSession={loadSession} subscribe={subscribe} lifecycleManaged={Boolean(display)} initialDisplay={display?.peek(readOptionsForView(view, undefined, choreId))}
    onBack={onBack} onConfiguration={openConfiguration} onHistory={() => setView('history')} onDetails={() => setView('details')}
    onGroupPolicy={() => setView('groupPolicy')} onDateRights={() => setView('dateRights')} />;
}
