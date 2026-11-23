import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { SearchField } from '../../components/search-field';
import { SettingsHeader } from '../../components/settings-header';
import { Chevron } from '../../components/chevron';
import { Page, ScreenHeading, palette, typography } from '../../components/planner-ui';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { normalizeSearchText, searchTerms } from '../../domain/search/normalized-search';

export interface TriviaLibraryItem { id: string; chore: { name: string }; trivia: { title: string; body: string } }

export function TriviaArticleContent({ item, header, error }: { item?: TriviaLibraryItem; header: ReactNode; error?: string | null }) {
  return <Page header={header}>
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error}</Text> : null}
    {item ? <><ScreenHeading title={item.trivia.title} description={item.chore.name} />
      <Text style={{ ...typography.body, color: palette.ink }}>{item.trivia.body}</Text></>
      : <Text style={{ ...typography.body, color: palette.muted }}>この豆知識は見つかりませんでした。</Text>}
  </Page>;
}

export function useTriviaLibraryState(initialQuery = '') {
  const [query, setQuery] = useState(initialQuery);
  const reset = useCallback(() => setQuery(''), []);
  return { query, setQuery, reset };
}

export function TriviaLibrary({ items, onOpen, onBack, notice, state: supplied, backAccessibilityLabel = '家事一覧に戻る' }: {
  items: readonly TriviaLibraryItem[]; onOpen(id: string): void; onBack(): void; notice?: ReactNode;
  state?: ReturnType<typeof useTriviaLibraryState>; backAccessibilityLabel?: string;
}) {
  const local = useTriviaLibraryState(), state = supplied ?? local;
  const styles = usePlannerBorderStyles(baseStyles); const list = useRef<FlatList<TriviaLibraryItem>>(null);
  const index = useMemo(() => items.map(item => ({ item, text: normalizeSearchText(`${item.trivia.title}\n${item.chore.name}\n${item.trivia.body}`) })), [items]);
  const terms = useMemo(() => searchTerms(state.query), [state.query]);
  const rows = useMemo(() => index.filter(row => terms.every(term => row.text.includes(term))).map(row => row.item), [index, terms]);
  return <View style={styles.root}>
    <SettingsHeader title="豆知識" onBack={onBack} backAccessibilityLabel={backAccessibilityLabel} />
    <View style={styles.searchArea}>{notice}<View style={styles.searchRow}>
      <SearchField accessibilityLabel="豆知識を検索" value={state.query} onChangeText={value => {
        state.setQuery(value); list.current?.scrollToOffset({ offset: 0, animated: false });
      }} placeholder="豆知識・家事名で検索" style={styles.search} />
      {rows.length ? <Text accessibilityLiveRegion="polite" style={styles.count}>{rows.length}件</Text> : null}
    </View></View>
    <FlatList ref={list} testID="trivia-library" data={rows} keyExtractor={item => item.id} initialNumToRender={10}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      contentContainerStyle={styles.content}
      ListEmptyComponent={<Text style={styles.empty}>{terms.length ? '一致する豆知識はありません。' : '豆知識はまだありません。'}</Text>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.trivia.title}、${item.chore.name}`} onPress={() => onOpen(item.id)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <View style={styles.copy}><Text style={styles.title}>{item.trivia.title}</Text><Text style={styles.caption}>{item.chore.name}</Text></View><Chevron />
      </Pressable>} />
  </View>;
}

const baseStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, searchArea: { paddingHorizontal: 18, paddingVertical: 12, gap: 8 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  search: { flex: 1, minWidth: 0 },
  count: { ...typography.caption, color: palette.muted }, content: { paddingHorizontal: 18, paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  copy: { flex: 1, minWidth: 0, gap: 4 }, title: { ...typography.control, fontWeight: '500', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, pressed: { backgroundColor: palette.accentSoft },
  empty: { ...typography.body, color: palette.muted, paddingVertical: 16 },
});
