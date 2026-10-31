import { router, useLocalSearchParams } from 'expo-router';
import { useContext } from 'react';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { PlannerLoadState } from '@/components/planner-load-state';
import { SelectedGroupChoreSettings } from './group-chore-settings-screen';

export function GroupHistoryScreen() {
  const context = useContext(WorkspaceContext); const params = useLocalSearchParams<{ groupId: string; choreId?: string }>();
  if (!context?.userId || typeof params.groupId !== 'string' || !(context.group?.userId === context.userId && context.group.groupId === params.groupId && ['active', 'creating'].includes(context.group.status))) return <PlannerLoadState title="実施履歴" message="履歴を読み込んでいます。"
      error="このグループの参加状態を確認してください。" retry={async () => router.back()} />;
  return <GroupHistory key={`${context.userId}:${params.groupId}`} userId={context.userId} groupId={params.groupId}
    choreId={typeof params.choreId === 'string' ? params.choreId : undefined} />;
}
function GroupHistory({ userId, groupId, choreId }: { userId: string; groupId: string; choreId?: string }) {
  return <SelectedGroupChoreSettings userId={userId} groupId={groupId} choreId={choreId ?? ''} initialView="history" />;
}
