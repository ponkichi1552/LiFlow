import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View, useColorScheme } from 'react-native';
import { FormTextInput } from '../../../components/form-text-input';
import { SettingsHeader } from '../../../components/settings-header';
import { SettingsAction } from '../../../components/settings-controls';
import { Chevron } from '../../../components/chevron';
import { typography } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import type { ChoreDefinition } from '../../../domain/chores/types';
import { groupChores } from '../../../domain/chores/chore-groups';
import { choreDisplayCategory } from '../../../domain/chores/chore-presentation';
import { normalizeSearchText, searchTerms } from '../../../domain/search/normalized-search';
export type CalendarChoreChoice = Omit<ChoreDefinition, 'householdId'>;
type ChoiceRow = { kind: 'category'; category: string; count: number } | { kind: 'chore'; chore: CalendarChoreChoice; nested: boolean };

export function CalendarChorePicker({ chores, onSelect, onNew, onClose }: {
  chores: readonly CalendarChoreChoice[]; onSelect(chore: CalendarChoreChoice): void; onNew(): void; onClose(): void;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const terms = useMemo(() => searchTerms(query), [query]);
  const searching = terms.length > 0;
  const index = useMemo(() => chores.filter(chore => !chore.archived).map(chore => ({
    chore, text: normalizeSearchText(`${chore.name} ${chore.category} ${choreDisplayCategory(chore)}`),
  })), [chores]);
  const matches = useMemo(() => index.filter(({ text }) => terms.every(term => text.includes(term))).map(({ chore }) => chore), [index, terms]);
  const rows = useMemo(() => groupChores(matches).flatMap<ChoiceRow>(([name, items]) => {
    const category = name || 'その他';
    return searching ? items.map(chore => ({ kind: 'chore' as const, chore, nested: false })) : [
      { kind: 'category', category, count: items.length },
      ...(opened.has(category) ? items.map(chore => ({ kind: 'chore' as const, chore, nested: true })) : []),
    ];
  }), [matches, opened, searching]);
  return <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={{ paddingHorizontal: 12 }}><SettingsHeader title="家事を選択" onBack={onClose} /></View>
      <FormTextInput accessibilityLabel="追加する既存の家事を検索" placeholder="家事名で検索" value={query} onChangeText={setQuery}
        style={{ ...typography.body, color: colors.ink, margin: 16, paddingHorizontal: 12, minHeight: 46, borderRadius: 10, borderWidth: 1, borderColor: colors.inputBorder }} />
      <FlatList data={rows} keyExtractor={row => row.kind === 'category' ? `category:${row.category}` : `chore:${row.chore.id}`} keyboardShouldPersistTaps="handled" initialNumToRender={12}
        ListEmptyComponent={<Text style={{ ...typography.caption, color: colors.muted, margin: 18 }}>一致する家事はありません。</Text>}
        renderItem={({ item }) => item.kind === 'category' ? <Pressable accessibilityRole="button" accessibilityLabel={`${item.category}の家事を${opened.has(item.category) ? '閉じる' : '開く'}`} accessibilityState={{ expanded: opened.has(item.category) }}
          onPress={() => setOpened(before => { const next = new Set(before); if (next.has(item.category)) next.delete(item.category); else next.add(item.category); return next; })}
          style={{ minHeight: 52, paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ ...typography.body, color: colors.ink, fontWeight: '600', flex: 1 }}>{item.category}</Text><Text style={{ ...typography.caption, color: colors.muted }}>{item.count}件</Text><Chevron direction={opened.has(item.category) ? 'up' : 'down'} color={colors.accent} />
        </Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={`${item.chore.name}を選択`} onPress={() => onSelect(item.chore)}
          style={{ minHeight: 52, paddingLeft: item.nested ? 30 : 18, paddingRight: 18, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ ...typography.body, color: colors.ink, flex: 1 }}>{item.chore.name}</Text><Chevron color={colors.accent} />
        </Pressable>} />
      <View style={{ padding: 16 }}><SettingsAction title="新しい家事を作る" onPress={onNew} /></View>
  </View>;
}
