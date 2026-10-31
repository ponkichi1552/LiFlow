import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useContext, useEffect, useState } from 'react';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { openSharedWorkspace, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import type { SharedWorkspace } from '@/platform/sharing/workspace-types';
import { PlannerLoadState } from '@/components/planner-load-state';
import { createV2SettingsSession } from './group-chore-settings-source';
import { V2GroupScreen } from '../sharing/v2-ui/group-screen';
import type { V2GroupScreenProps } from '../sharing/v2-ui/group-screen';

export function GroupChoreSettingsScreen() {
  const context = useContext(WorkspaceContext);
  const params = useLocalSearchParams<{ id: string; groupId: string }>();
  if (!context?.userId || typeof params.groupId !== 'string' || typeof params.id !== 'string'
    || !(context.group?.userId === context.userId && context.group.groupId === params.groupId && ['active', 'creating'].includes(context.group.status))) {
    return <PlannerLoadState title="グループの家事設定" message="所属グループを確認してください。" error="このグループは現在編集できません。" retry={async () => router.back()} />;
  }
  return <SelectedGroupChoreSettings key={`${context.userId}:${params.groupId}`} userId={context.userId} groupId={params.groupId} choreId={params.id} />;
}
export function SelectedGroupChoreSettings({ userId, groupId, choreId, initialView = 'details' }: { userId: string; groupId: string; choreId: string; initialView?: 'details' | 'history' }) {
  const [workspace, setWorkspace] = useState<SharedWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void openSharedWorkspace({ userId, groupId }).then(async value => {
      await value.record(); if (current) { setWorkspace(value); setError(null); }
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : 'グループを読み込めませんでした。'); });
    return () => { current = false; };
  }, [userId, groupId, retry]);
  if (!workspace) return <PlannerLoadState title="グループの家事設定" message="設定を読み込んでいます。" error={error} retry={async () => setRetry(value => value + 1)} />;
  if (workspace.protocol === 2) return <V2GroupChoreSettings workspace={workspace} choreId={choreId} initialView={initialView} />;
  return <PlannerLoadState title="グループの家事設定" message="履歴と設定を保持しています。" error="共有グループでv2への移行を完了してください。" retry={async () => router.replace('/sharing')} />;
}
/** A detached editor always targets the named group, including when another workspace is open. */
function V2GroupChoreSettings({ workspace, choreId, initialView }: { workspace: Extract<SharedWorkspace, { protocol: 2 }>; choreId: string; initialView: 'details' | 'history' }) {
  const [view, setView] = useState<V2GroupScreenProps['view']>(initialView);
  const loadSession = useCallback(async () => { await workspace.record(); return createV2SettingsSession(workspace); }, [workspace]);
  const subscribe = useCallback((refresh: () => void) => subscribeSharingChanges(scope => {
    if (scope?.userId === workspace.userId && scope.groupId === workspace.groupId) refresh();
  }), [workspace]);
  const openConfiguration = useCallback(() => setView('configuration'), []);
  const onBack = () => view === initialView ? router.back() : setView('details');
  return <V2GroupScreen purpose="workspace" view={view} choreId={choreId} loadSession={loadSession} subscribe={subscribe}
    onBack={onBack} onConfiguration={openConfiguration} onHistory={() => setView('history')} onDetails={() => setView('details')}
    onGroupPolicy={() => setView('groupPolicy')} onDateRights={() => setView('dateRights')} />;
}
