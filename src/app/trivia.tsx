import { useLocalSearchParams } from 'expo-router';
import { useContext } from 'react';
import { SettingsHeader } from '@/components/settings-header';
import { PlannerLoadState } from '@/components/planner-load-state';
import { TriviaArticleContent } from '@/features/chores/trivia-library';
import { usePlannerData } from '@/hooks/use-planner-data';
import { WorkspaceContext } from '@/contexts/workspace-context';

/** Keep the source list mounted; native Back restores its exact search/scroll state. */
export default function TriviaArticleScreen() {
  const params = useLocalSearchParams<{ id?: string; source?: string; householdId?: string; groupId?: string; userId?: string }>();
  const workspace = useContext(WorkspaceContext);
  const { snapshot, loading, error, refresh } = usePlannerData({ personal: params.source === 'personal' });
  const header = <SettingsHeader title="豆知識" backAccessibilityLabel="豆知識一覧に戻る" />;
  if (loading || !snapshot) return <PlannerLoadState header={header} message="豆知識を読み込んでいます。" error={error} retry={refresh} />;
  const sharing = snapshot.sharing;
  const sameScope = params.householdId === snapshot.household.id && (params.groupId ?? '') === (sharing?.groupId ?? '')
    && (!sharing || !!workspace && params.userId === workspace.userId && workspace.active?.groupId === sharing.groupId);
  const item = sameScope ? snapshot.chores.flatMap(chore => (chore.trivia ?? []).map((trivia, index) => ({ id: `${chore.id}:${trivia.id || index}`, chore, trivia })))
    .find(row => row.id === params.id) : undefined;
  return <TriviaArticleContent item={item} header={header} error={error} />;
}
