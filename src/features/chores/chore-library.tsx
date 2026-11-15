import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FormTextInput } from '../../components/form-text-input';
import { Card, SectionHeading, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { groupChores } from '../../domain/chores/chore-groups';
import type { ChoreDefinition } from '../../domain/chores/types';
import { finishStartupDisplay } from '../../platform/diagnostics/startup-splash';
import { hasChoreGuide } from './guide-content';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { normalizeSearchText, searchTerms } from '../../domain/search/normalized-search';

export const normalizeChoreName = normalizeSearchText;
type Row = { kind: 'category'; id: string; name: string; count: number; expanded: boolean } | { kind: 'chore'; id: string; chore: ChoreDefinition }
  | { kind: 'trivia'; id: string; count: number };

export function useChoreLibraryState() {
  const [query, setQuery] = useState(''); const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return { query, setQuery, expanded, setExpanded };
}
/** Categories expand in place; the parent can retain search and expansion while reading a guide. */
export function ChoreLibrary({ chores, onOpen, header, footer, onTrivia, triviaCount = 0, disabled = false, state }: {
  chores: readonly ChoreDefinition[]; onOpen(id: string): void; header?: ReactNode; footer?: ReactNode;
  onTrivia?: () => void; triviaCount?: number; disabled?: boolean; state?: ReturnType<typeof useChoreLibraryState>;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const local = useChoreLibraryState(); const { query, setQuery, expanded, setExpanded } = state ?? local;
  const groups = useMemo(() => groupChores(chores.filter(chore => !chore.archived && hasChoreGuide(chore))), [chores]);
  const index = useMemo(() => groups.flatMap(([, values]) => values).map((chore, index) => ({ chore, index, text: normalizeChoreName(chore.name) })), [groups]);
  const search = normalizeChoreName(query.trim());
  const rows = useMemo<Row[]>(() => {
    if (!search) return [...groups.flatMap(([name, chores]): Row[] => [{ kind: 'category', id: name, name, count: chores.length, expanded: expanded.has(name) },
      ...(expanded.has(name) ? chores.map(chore => ({ kind: 'chore' as const, id: chore.id, chore })) : [])]),
      ...(onTrivia ? [{ kind: 'trivia' as const, id: 'trivia', count: triviaCount }] : [])];
    const terms = searchTerms(search);
    const matching = index.filter(row => terms.every(term => row.text.includes(term)))
      .sort((a, b) => a.text.indexOf(terms[0]) - b.text.indexOf(terms[0]) || a.index - b.index);
    return matching.map(({ chore }) => ({ kind: 'chore' as const, id: chore.id, chore }));
  }, [expanded, groups, index, onTrivia, search, triviaCount]);
  return <View style={styles.safe} onLayout={finishStartupDisplay}>
    <View style={styles.header}>{header}
      <FormTextInput accessibilityLabel="家事名を検索" value={query} onChangeText={setQuery} placeholder="家事名で検索" autoCapitalize="none" clearButtonMode="while-editing" returnKeyType="search" style={styles.search} />
      {search ? <SectionHeading title="検索結果" trailing={<Text style={styles.caption}>{rows.length}件</Text>} /> : null}
    </View>
    <FlatList key={search ? `search:${search}` : 'categories'} data={rows} keyExtractor={row => `${row.kind}:${row.id}`} initialNumToRender={10}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
    contentContainerStyle={styles.content} ListEmptyComponent={search ? <Text style={styles.empty}>一致する家事はありません。</Text> : <Card><Text style={typography.body}>家事がまだ登録されていません。</Text></Card>}
    renderItem={({ item }) => item.kind === 'chore'
      ? <Pressable accessibilityRole="button" accessibilityLabel={`${item.chore.name}の説明を開く`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onOpen(item.id)} style={({ pressed }) => [styles.row, !search && styles.choreRow, disabled && styles.disabled, pressed && styles.pressed]}>
        <Text style={[styles.name, styles.choreName]}>{item.chore.name}</Text><Chevron />
      </Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={item.kind === 'trivia' ? `豆知識、${item.count}件の豆知識` : `${item.name}、${item.count}件`}
        accessibilityState={item.kind === 'category' ? { expanded: item.expanded } : undefined}
        onPress={() => item.kind === 'trivia' ? onTrivia?.() : setExpanded(before => { const next = new Set(before); if (next.has(item.name)) next.delete(item.name); else next.add(item.name); return next; })} style={({ pressed }) => [styles.row, item.kind === 'category' && item.expanded && styles.openCategory, pressed && styles.pressed]}>
        <Text style={styles.name}>{item.kind === 'trivia' ? '豆知識' : item.name}</Text><Text style={styles.caption}>{item.count}件</Text><Chevron direction={item.kind === 'category' ? item.expanded ? 'up' : 'down' : 'right'} />
      </Pressable>} />{footer ? <View style={styles.footer}>{footer}</View> : null}</View>;
}
const baseStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background }, content: { paddingHorizontal: 18, paddingBottom: 24 }, header: { gap: 12, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  choreRow: { paddingLeft: 16 }, choreName: { fontWeight: '400' }, openCategory: { backgroundColor: palette.elevated }, disabled: { opacity: .45 },
  pressed: { backgroundColor: palette.accentSoft }, name: { ...typography.control, fontWeight: '600', color: palette.ink, flex: 1 },
  caption: { ...typography.caption, color: palette.muted }, search: { ...typography.body, color: palette.ink, borderColor: palette.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 48 },
  empty: { ...typography.body, color: palette.muted, paddingVertical: 12 },
  footer: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
});
