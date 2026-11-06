import { SafeAreaView } from '@/components/screen-safe-area';
import { ChoreLibrary, useChoreLibraryState } from '@/features/chores/chore-library';
import { ChorePlanToggle } from '@/features/chores/chore-plan-toggle';
import { setChoresEnabled } from '@/platform/storage/repository';
import { WorkspaceTab } from '@/components/workspace-tab';
import { Chevron } from '../../components/chevron';
import { FormTextInput as TextInput } from '../../components/form-text-input';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { GuideChapterActions } from '@/features/chores/guide-chapter-actions';
import { ChoreBook } from '@/components/chore-book';
import { ChoreGuide } from '@/features/chores/chore-guide';
import { groupChores } from '@/domain/chores/chore-groups';
import { BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';

export default function ChoreGuideScreen() {
  return <WorkspaceTab view="chores"><PersonalChoreGuideScreen /></WorkspaceTab>;
}

function PersonalChoreGuideScreen() {
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
  const [searchText, setSearchText] = useState('');
  const [isTriviaCollectionOpen, setIsTriviaCollectionOpen] = useState(false);
  const [selectedTriviaId, setSelectedTriviaId] = useState<string | null>(null);
  useEffect(() => navigation.addListener('tabPress', () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined, ...(personalSource ? { source: undefined } : {}) });
    setIsTriviaCollectionOpen(false);
    setSelectedTriviaId(null);
    setSearchText('');
  }), [navigation, personalSource]);
  const returnFromDetail = () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined, ...(personalSource ? { source: undefined } : {}) });
    if (returnTo === 'home') router.navigate('/');
    else if (returnTo === 'calendar') router.navigate('/(tabs)/explore');
  };
  const selectChoreFromList = (choreId: string) => router.setParams({ choreId, returnTo: undefined });
  const returnFromTrivia = () => {
    if (selectedTriviaId) setSelectedTriviaId(null);
    else {
      setIsTriviaCollectionOpen(false);
      setSearchText('');
    }
  };
  const selectedChoreId = requestedId;
  const chores = useMemo(() => groupChores(snapshot?.chores ?? []).flatMap(([, rows]) => rows), [snapshot]);
  const triviaItems = useMemo(() => chores.flatMap((chore) =>
    (chore.trivia ?? []).map((trivia, index) => ({ id: `${chore.id}:${trivia.id || index}`, chore, trivia })),
  ), [chores]);
  const query = normalizeChoreSearchText(searchText.trim());

  if (loading || !snapshot) {
    return <PlannerLoadState title="家事の説明" message="家事を読み込んでいます。" error={error} retry={refresh} />;
  }

  const selectedTrivia = selectedTriviaId ? triviaItems.find((item) => item.id === selectedTriviaId) : undefined;
  const matchingTriviaItems = query
    ? triviaItems.filter((item) => normalizeChoreSearchText(item.trivia.title).includes(query))
    : triviaItems;
  if (selectedTriviaId) {
    return (
      <Page header={<BackButton accessibilityLabel="豆知識一覧に戻る" onPress={returnFromTrivia} />}>

        {selectedTrivia ? (
          <>
            <ScreenHeading title={selectedTrivia.trivia.title} description={selectedTrivia.chore.name} />
            <Card style={styles.triviaCard}>
              <Text style={styles.triviaHeading}>豆知識</Text>
              <Text style={styles.triviaBody}>{selectedTrivia.trivia.body}</Text>
            </Card>
          </>
        ) : <Card><Text style={styles.body}>この豆知識は見つかりませんでした。</Text></Card>}
      </Page>
    );
  }

  if (isTriviaCollectionOpen && !selectedChoreId) {
    return (
      <Page header={<BackButton accessibilityLabel="家事一覧に戻る" onPress={returnFromTrivia} />}>

        <ScreenHeading title="豆知識" description="家事の見出しを選ぶと、知っていると便利な情報を確認できます。" />
        <TextInput
          accessibilityLabel="豆知識の見出しを検索"
          autoCapitalize="none"
          clearButtonMode="while-editing"
          onChangeText={setSearchText}
          placeholder="豆知識の見出しで検索"
          placeholderTextColor={palette.muted}
          returnKeyType="search"
          style={styles.searchInput}
          value={searchText}
        />
        <SectionHeading title="見出しを選択" trailing={<Text style={styles.resultCount}>{matchingTriviaItems.length}件</Text>} />
        {matchingTriviaItems.length > 0 ? (
          <View style={styles.choreList}>
            {matchingTriviaItems.map((item) => (
              <TriviaListRow key={item.id} item={item} onPress={() => setSelectedTriviaId(item.id)} />
            ))}
          </View>
        ) : <Card><Text style={styles.body}>一致する豆知識はありません。</Text></Card>}
      </Page>
    );
  }

  if (!selectedChoreId) return <SafeAreaView style={{ flex: 1 }} edges={['top']}><ChoreLibrary chores={chores} onOpen={selectChoreFromList} state={libraryState}
    header={<><ScreenHeading title="家事一覧" />{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</>}
    triviaCount={triviaItems.length} onTrivia={() => { setSearchText(''); setIsTriviaCollectionOpen(true); }} /></SafeAreaView>;

  return <ChoreBook chores={chores} selectedId={selectedChoreId} title="家事の説明" onBack={returnFromDetail} hasTabBar
    header={error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : undefined}
    renderChore={chore => <View style={{ gap: 12 }}>
      <ChoreGuide chore={chore} mode={snapshot.settings.frequencyMode} cadenceLabel={snapshot.personalCadences?.[chore.id]?.label} procedureAction={<ChorePlanToggle name={chore.name} enabled={chore.enabled} requiresCycleSelection={chore.requiresCycleSelection}
        onConfigure={() => router.push({ pathname: '/chores/[id]', params: { id: chore.id, source: 'personal' } })}
        retryRead={async () => { await refresh(); return !readError(); }} save={async enabled => { await setChoresEnabled(database, [chore.id], enabled); await refresh(); return { refreshed: !readError() }; }} />} />
      <GuideChapterActions choreId={chore.id} snapshot={snapshot} database={database} refresh={refresh} personalSource={personalSource} />
    </View>} />;

}

function normalizeChoreSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0x60));
}

function TriviaListRow({ item, onPress }: {
  item: { id: string; chore: ChoreDefinition; trivia: NonNullable<ChoreDefinition['trivia']>[number] };
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.trivia.title}、${item.chore.name}`}
      onPress={onPress}
      style={({ pressed }) => [styles.choreListRow, pressed && styles.choreListRowPressed]}>
      <View style={styles.choreListCopy}>
        <Text style={styles.choreListName}>{item.trivia.title}</Text>
        <Text style={styles.choreListCategory}>{item.chore.name}</Text>
      </View>
      <Chevron />
    </Pressable>
  );
}


const styles = StyleSheet.create({
  choreList: { gap: 10 },
  searchInput: { ...typography.body, minHeight: 54, borderWidth: 1, borderColor: palette.border, borderRadius: 16, backgroundColor: palette.surface, color: palette.ink, paddingHorizontal: 16 },
  resultCount: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  choreListRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.border, borderRadius: 16, backgroundColor: palette.surface, paddingHorizontal: 16, paddingVertical: 12 },
  choreListRowPressed: { backgroundColor: palette.accentSoft },
  choreListCopy: { flex: 1, gap: 4 },
  choreListName: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  choreListCategory: { ...typography.caption, color: palette.muted },
  choreListChevron: { color: palette.accent, fontSize: 31, lineHeight: 36, fontWeight: '500', paddingLeft: 12 },
  otherChores: { gap: 8, paddingTop: 5 },
  recordActions: { gap: 4 },
  chorePicker: { gap: 8, paddingRight: 20 },
  choreOption: { minHeight: 44, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 14, paddingVertical: 8 },
  choreOptionSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  choreOptionText: { ...typography.label, color: palette.muted, fontWeight: '600' },
  choreOptionTextSelected: { color: palette.accent, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  procedureSection: { gap: 10 },
  procedureTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  stepNumber: { ...typography.body, minWidth: 32, color: palette.accent, fontWeight: '800' },
  stepText: { ...typography.body, flex: 1, color: palette.ink },
  toolList: { gap: 7 },
  toolText: { ...typography.body, color: palette.ink },
  cautionCard: { backgroundColor: palette.goldSoft, borderColor: palette.border },
  cautionHeading: { ...typography.subheading, color: palette.gold, fontWeight: '700' },
  cautionText: { ...typography.body, color: palette.gold },
  triviaCard: { backgroundColor: palette.accentSoft, borderColor: palette.border, gap: 10 },
  triviaHeading: { ...typography.subheading, color: palette.accent, fontWeight: '800' },
  triviaItem: { gap: 5 },
  triviaTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  triviaBody: { ...typography.body, color: palette.ink },
  body: { ...typography.body, color: palette.muted },
  error: { ...typography.label, color: palette.warning },
});
