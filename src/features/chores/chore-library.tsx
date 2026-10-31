import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FormTextInput } from '../../components/form-text-input';
import { BackButton, Card, SectionHeading, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { groupChores } from '../../domain/chores/chore-groups';
import type { ChoreDefinition } from '../../domain/chores/types';

export const normalizeChoreName = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja')
  .replace(/[\u30a1-\u30f6]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60));
type Row = { kind: 'category'; id: string; name: string; count: number } | { kind: 'chore'; id: string; chore: ChoreDefinition }
  | { kind: 'heading'; id: string; name: string } | { kind: 'trivia'; id: string; count: number };

/** Personal and joined catalogs use the same search, category navigation and compact rows. */
export function ChoreLibrary({ chores, onOpen, header, footer, accessory, onTrivia, triviaCount = 0, disabled = false }: {
  chores: readonly ChoreDefinition[]; onOpen(id: string): void; header?: ReactNode; footer?: ReactNode;
  accessory?: (chore: ChoreDefinition) => ReactNode; onTrivia?: () => void; triviaCount?: number; disabled?: boolean;
}) {
  const [query, setQuery] = useState(''); const [category, setCategory] = useState<string | null>(null);
  const groups = useMemo(() => groupChores(chores.filter(chore => !chore.archived)), [chores]);
  const search = normalizeChoreName(query.trim());
  const rows = useMemo<Row[]>(() => {
    if (!search && !category) return [...groups.map(([name, chores]) => ({ kind: 'category' as const, id: name, name, count: chores.length })),
      ...(onTrivia ? [{ kind: 'trivia' as const, id: 'trivia', count: triviaCount }] : [])];
    const visible = groups.filter(([name]) => !category || name === category).flatMap(([, values]) => values);
    const ranked = visible.map((chore, index) => ({ chore, index, match: normalizeChoreName(chore.name).indexOf(search) }));
    const matching = ranked.filter(row => row.match >= 0).sort((a, b) => a.match - b.match || a.index - b.index);
    const others = ranked.filter(row => row.match < 0);
    return [...matching.map(({ chore }) => ({ kind: 'chore' as const, id: chore.id, chore })),
      ...(others.length ? [{ kind: 'heading' as const, id: 'other-heading', name: 'ほかの家事' }, ...others.map(({ chore }) => ({ kind: 'chore' as const, id: chore.id, chore }))] : [])];
  }, [category, groups, onTrivia, search, triviaCount]);
  return <View style={styles.safe}><FlatList data={rows} keyExtractor={row => `${row.kind}:${row.id}`} initialNumToRender={10}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
    contentContainerStyle={styles.content} ListHeaderComponent={<View style={styles.header}>{header}
      {category ? <BackButton accessibilityLabel="分類一覧に戻る" onPress={() => setCategory(null)} /> : null}
      <FormTextInput accessibilityLabel="家事名を検索" value={query} onChangeText={setQuery} placeholder="家事名で検索" autoCapitalize="none" clearButtonMode="while-editing" returnKeyType="search" style={styles.search} />
      <SectionHeading title={search ? '検索結果' : category ?? '分類を選ぶ'} />
      {search && !rows.some(row => row.kind === 'chore' && normalizeChoreName(row.chore.name).includes(search)) ? <Text style={styles.caption}>見出しに一致する家事はありません。</Text> : null}
    </View>} ListEmptyComponent={<Card><Text style={typography.body}>家事がまだ登録されていません。</Text></Card>}
    renderItem={({ item }) => item.kind === 'heading' ? <SectionHeading title={item.name} /> : item.kind === 'chore'
      ? <Pressable accessibilityRole="button" accessibilityLabel={`${item.chore.name}の説明を開く`} disabled={disabled} onPress={() => onOpen(item.id)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        {accessory ? <View aria-hidden>{accessory(item.chore)}</View> : null}<Text style={styles.name}>{item.chore.name}</Text><Chevron />
      </Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={item.kind === 'trivia' ? `豆知識、${item.count}件の豆知識` : `${item.name}、${item.count}件`}
        onPress={() => item.kind === 'trivia' ? onTrivia?.() : setCategory(item.name)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text style={styles.name}>{item.kind === 'trivia' ? '豆知識' : item.name}</Text><Text style={styles.caption}>{item.count}件</Text><Chevron />
      </Pressable>} />{footer ? <View style={styles.footer}>{footer}</View> : null}</View>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background }, content: { padding: 18, paddingBottom: 24 }, header: { gap: 14, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  pressed: { backgroundColor: palette.accentSoft }, name: { ...typography.control, fontWeight: '600', color: palette.ink, flex: 1 },
  caption: { ...typography.caption, color: palette.muted }, search: { ...typography.body, color: palette.ink, borderColor: palette.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 48 },
  footer: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
});
