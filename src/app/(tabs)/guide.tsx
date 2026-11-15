import { SafeAreaView } from '@/components/screen-safe-area';
import { ChoreLibrary, useChoreLibraryState } from '@/features/chores/chore-library';
import { ChorePlanToggle } from '@/features/chores/chore-plan-toggle';
import { setChoresEnabled } from '@/platform/storage/repository';
import { WorkspaceTab } from '@/components/workspace-tab';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useContext, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ChoreBook } from '@/components/chore-book';
import { ChoreGuide } from '@/features/chores/chore-guide';
import { groupChores } from '@/domain/chores/chore-groups';
import { AppButton, ScreenHeading, palette, typography } from '@/components/planner-ui';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { TriviaLibrary, useTriviaLibraryState } from '@/features/chores/trivia-library';
import { WorkspaceContext } from '@/contexts/workspace-context';

export default function ChoreGuideScreen() {
  return <WorkspaceTab view="chores"><PersonalChoreGuideScreen /></WorkspaceTab>;
}

function PersonalChoreGuideScreen() {
  const workspace = useContext(WorkspaceContext);
  const libraryState = useChoreLibraryState();
  const params = useLocalSearchParams<{ choreId?: string; returnTo?: 'home' | 'calendar'; source?: string }>();
  const personalSource = params.source === 'personal';
  const requestedId = Array.isArray(params.choreId) ? params.choreId[0] : params.choreId;
  const requestedReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = requestedReturnTo === 'home' || requestedReturnTo === 'calendar' ? requestedReturnTo : undefined;
  const navigation = useNavigation('/(tabs)') as {
    addListener(event: 'tabPress', callback: () => void): () => void;
    setParams(params: { choreId?: string | undefined; returnTo?: 'home' | 'calendar' | undefined; source?: string | undefined }): void;
  };
  const { snapshot, loading, error, refresh, database, readError } = usePlannerData({ personal: personalSource });
  const triviaState = useTriviaLibraryState();
  const { reset: resetTrivia } = triviaState;
  const [isTriviaCollectionOpen, setIsTriviaCollectionOpen] = useState(false);
  useEffect(() => navigation.addListener('tabPress', () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined, ...(personalSource ? { source: undefined } : {}) });
    setIsTriviaCollectionOpen(false);
    resetTrivia();
  }), [navigation, personalSource, resetTrivia]);
  const returnFromDetail = () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined, ...(personalSource ? { source: undefined } : {}) });
    if (returnTo === 'home') router.navigate('/');
    else if (returnTo === 'calendar') router.navigate('/(tabs)/explore');
  };
  const selectChoreFromList = (choreId: string) => router.setParams({ choreId, returnTo: undefined });
  const returnFromTrivia = () => {
    setIsTriviaCollectionOpen(false); resetTrivia();
  };
  const selectedChoreId = requestedId;
  const chores = useMemo(() => groupChores(snapshot?.chores ?? []).flatMap(([, rows]) => rows), [snapshot]);
  const triviaItems = useMemo(() => chores.flatMap((chore) =>
    (chore.trivia ?? []).map((trivia, index) => ({ id: `${chore.id}:${trivia.id || index}`, chore, trivia })),
  ), [chores]);

  if (loading || !snapshot) {
    return <PlannerLoadState title="家事の説明" message="家事を読み込んでいます。" error={error} retry={refresh} />;
  }

  if (isTriviaCollectionOpen && !selectedChoreId) return <SafeAreaView style={styles.safeArea} edges={['top']}>
    <TriviaLibrary items={triviaItems} onOpen={id => router.push({ pathname: '/trivia', params: { id, householdId: snapshot.household.id,
      source: personalSource ? 'personal' : 'current', groupId: snapshot.sharing?.groupId ?? '', userId: snapshot.sharing ? workspace?.userId ?? '' : '' } })} onBack={returnFromTrivia} state={triviaState}
      notice={error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : undefined} />
  </SafeAreaView>;

  if (!selectedChoreId) return <SafeAreaView style={styles.safeArea} edges={['top']}><ChoreLibrary chores={chores} onOpen={selectChoreFromList} state={libraryState}
    footer={<AppButton title="家事を追加" accessibilityLabel="新しい個人家事を追加" onPress={() => router.push('/settings/add-chore')} />}
    header={<><ScreenHeading title="家事一覧" />{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</>}
    triviaCount={triviaItems.length} onTrivia={() => { resetTrivia(); setIsTriviaCollectionOpen(true); }} /></SafeAreaView>;

  return <ChoreBook chores={chores} selectedId={selectedChoreId} title="家事の説明" onBack={returnFromDetail} hasTabBar
    header={error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : undefined}
    renderChore={chore => <View style={{ gap: 12 }}>
      <ChoreGuide chore={chore} mode={snapshot.settings.frequencyMode} cadenceLabel={snapshot.personalCadences?.[chore.id]?.label} procedureAction={<ChorePlanToggle name={chore.name} enabled={chore.enabled} requiresCycleSelection={chore.requiresCycleSelection}
        onConfigure={() => router.push({ pathname: '/chores/[id]', params: { id: chore.id, source: 'personal' } })}
        retryRead={async () => { await refresh(); return !readError(); }} save={async enabled => { await setChoresEnabled(database, [chore.id], enabled); await refresh(); return { refreshed: !readError() }; }} />} />
    </View>} />;

}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  error: { ...typography.label, color: palette.warning },
});
