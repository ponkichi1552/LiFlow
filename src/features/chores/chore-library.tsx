import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FormTextInput } from '../../components/form-text-input';
import { Card, SectionHeading, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { groupChores } from '../../domain/chores/chore-groups';
import type { ChoreDefinition } from '../../domain/chores/types';

export const normalizeChoreName = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja')
  .replace(/[\u30a1-\u30f6]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60));
type Row = { kind: 'category'; id: string; name: string; count: number; expanded: boolean } | { kind: 'chore'; id: string; chore: ChoreDefinition }
  | { kind: 'heading'; id: string; name: string } | { kind: 'trivia'; id: string; count: number };

export function useChoreLibraryState() {
  const [query, setQuery] = useState(''); const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return { query, setQuery, expanded, setExpanded };
}
/** Categories expand in place; the parent can retain search and expansion while reading a guide. */
export function ChoreLibrary({ chores, onOpen, header, footer, onTrivia, triviaCount = 0, disabled = false, state }: {
  chores: readonly ChoreDefinition[]; onOpen(id: string): void; header?: ReactNode; footer?: ReactNode;
  onTrivia?: () => void; triviaCount?: number; disabled?: boolean; state?: ReturnType<typeof useChoreLibraryState>;
}) {
  const local = useChoreLibraryState(); const { query, setQuery, expanded, setExpanded } = state ?? local;
  const groups = useMemo(() => groupChores(chores.filter(chore => !chore.archived)), [chores]);
  const search = normalizeChoreName(query.trim());
  const rows = useMemo<Row[]>(() => {
    if (!search) return [...groups.flatMap(([name, chores]): Row[] => [{ kind: 'category', id: name, name, count: chores.length, expanded: expanded.has(name) },
      ...(expanded.has(name) ? chores.map(chore => ({ kind: 'chore' as const, id: chore.id, chore })) : [])]),
      ...(onTrivia ? [{ kind: 'trivia' as const, id: 'trivia', count: triviaCount }] : [])];
    const visible = groups.flatMap(([, values]) => values);
    const ranked = visible.map((chore, index) => ({ chore, index, match: normalizeChoreName(chore.name).indexOf(search) }));
    const matching = ranked.filter(row => row.match >= 0).sort((a, b) => a.match - b.match || a.index - b.index);
    const others = ranked.filter(row => row.match < 0);
    return [...matching.map(({ chore }) => ({ kind: 'chore' as const, id: chore.id, chore })),
      ...(others.length ? [{ kind: 'heading' as const, id: 'other-heading', name: 'ほかの家事' }, ...others.map(({ chore }) => ({ kind: 'chore' as const, id: chore.id, chore }))] : [])];
  }, [expanded, groups, onTrivia, search, triviaCount]);
  return <View style={styles.safe}><FlatList data={rows} keyExtractor={row => `${row.kind}:${row.id}`} initialNumToRender={10}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
    contentContainerStyle={styles.content} ListHeaderComponent={<View style={styles.header}>{header}
      <FormTextInput accessibilityLabel="家事名を検索" value={query} onChangeText={setQuery} placeholder="家事名で検索" autoCapitalize="none" clearButtonMode="while-editing" returnKeyType="search" style={styles.search} />
      {search ? <SectionHeading title="検索結果" /> : null}
      {search && !rows.some(row => row.kind === 'chore' && normalizeChoreName(row.chore.name).includes(search)) ? <Text style={styles.caption}>見出しに一致する家事はありません。</Text> : null}
    </View>} ListEmptyComponent={<Card><Text style={typography.body}>家事がまだ登録されていません。</Text></Card>}
    renderItem={({ item }) => item.kind === 'heading' ? <SectionHeading title={item.name} /> : item.kind === 'chore'
      ? <Pressable accessibilityRole="button" accessibilityLabel={`${item.chore.name}の説明を開く`} disabled={disabled} onPress={() => onOpen(item.id)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text style={styles.name}>{item.chore.name}</Text><Chevron />
      </Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={item.kind === 'trivia' ? `豆知識、${item.count}件の豆知識` : `${item.name}、${item.count}件`}
        accessibilityState={item.kind === 'category' ? { expanded: item.expanded } : undefined}
        onPress={() => item.kind === 'trivia' ? onTrivia?.() : setExpanded(before => { const next = new Set(before); if (next.has(item.name)) next.delete(item.name); else next.add(item.name); return next; })} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text style={styles.name}>{item.kind === 'trivia' ? '豆知識' : item.name}</Text><Text style={styles.caption}>{item.count}件</Text><Chevron direction={item.kind === 'category' ? item.expanded ? 'up' : 'down' : 'right'} />
      </Pressable>} />{footer ? <View style={styles.footer}>{footer}</View> : null}</View>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background }, content: { padding: 18, paddingBottom: 24 }, header: { gap: 14, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  pressed: { backgroundColor: palette.accentSoft }, name: { ...typography.control, fontWeight: '600', color: palette.ink, flex: 1 },
  caption: { ...typography.caption, color: palette.muted }, search: { ...typography.body, color: palette.ink, borderColor: palette.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 48 },
  footer: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
});
