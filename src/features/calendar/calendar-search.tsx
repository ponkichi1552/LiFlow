import { useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, Text, View, useColorScheme } from 'react-native';
import { FormTextInput } from '../../components/form-text-input';
import { Chevron } from '../../components/chevron';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { formatJapaneseDate, localDateFromDate } from '../../domain/scheduling/local-date';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import type { LocalCalendarBinding } from './use-local-calendar';
import { minuteLabel, recurrenceLabel } from './events';
import { calendarSearchIndex, searchCalendarWithChores } from './search';
import type { CalendarSearchChore, CalendarSearchDestination } from './search';
import { calendarEventAppearance } from './event-appearance';
import { SettingsAction } from '../../components/settings-controls';
import type { LocalDate } from '../../domain/shared/types';
import { useCalendarTitleDisplay } from './use-title-display';
import { calendarTitleDisplay } from './title-display';

export function CalendarSearch({ local, chores = [], choresIncomplete, focusDate = localDateFromDate(new Date()), onClose, onSelect, resolveSelection }: { local: LocalCalendarBinding; chores?: readonly CalendarSearchChore[]; choresIncomplete?: boolean; focusDate?: LocalDate; onClose(): void; onSelect(destination: CalendarSearchDestination): void; resolveSelection(draft: CalendarEditorDraft): CalendarSearchDestination }) {
  const scheme = useColorScheme(); const colors = plannerColorsForScheme(scheme); const [query, setQuery] = useState(''); const [selectionError, setSelectionError] = useState<string | null>(null);
  const titleDisplay = useCalendarTitleDisplay();
  const [visibleCount, setVisibleCount] = useState(60);
  const [visible, setVisible] = useState(true); const closing = useRef(false); const finished = useRef(false); const pending = useRef<CalendarSearchDestination | null>(null);
  const finish = () => { if (finished.current) return; finished.current = true; if (pending.current) onSelect(pending.current); else onClose(); };
  const close = () => { if (closing.current) return; closing.current = true; setVisible(false); if (Platform.OS !== 'ios') finish(); };
  const index = useMemo(() => calendarSearchIndex(local.snapshot.events, local.snapshot.exceptions, focusDate), [local.snapshot.events, local.snapshot.exceptions, focusDate]);
  const result = useMemo(() => searchCalendarWithChores(index, chores, query, Infinity, focusDate), [index, chores, query, focusDate]);
  const rows = useMemo(() => result.matches.slice(0, visibleCount), [result, visibleCount]);
  const more = rows.length < result.matches.length;
  const showMore = () => setVisibleCount(count => Math.min(count + 60, result.matches.length));
  const categories = useMemo(() => new Map(local.snapshot.categories.map(category => [category.id, category.color])), [local.snapshot.categories]);
  return <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'overFullScreen'} transparent={Platform.OS === 'android'} allowSwipeDismissal onRequestClose={close} onDismiss={finish}>
    <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={{ flex: Platform.OS === 'android' ? 0 : 1, ...(Platform.OS === 'android' ? { height: '92%' as const, borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: 'hidden' as const } : {}), backgroundColor: colors.surface, gap: 10 }}>
    <View style={{ width: 34, height: 4, borderRadius: 2, backgroundColor: colors.inputBorder, alignSelf: 'center', marginTop: 8 }} />
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 52, borderBottomWidth: 1, borderColor: colors.border }}>
      <Pressable accessibilityRole="button" accessibilityLabel="予定の検索を閉じる" onPress={close} style={{ width: 64, minHeight: 44, justifyContent: 'center' }}><Text style={{ ...typography.body, color: colors.accent }}>閉じる</Text></Pressable>
      <Text style={{ ...typography.body, flex: 1, textAlign: 'center', fontWeight: '700', color: colors.ink }}>予定を検索</Text><View style={{ width: 64 }} />
    </View>
    <FormTextInput accessibilityLabel="予定を検索" placeholder="予定名・家事名・場所・メモで検索" value={query} onChangeText={value => { setQuery(value); setVisibleCount(60); setSelectionError(null); }} autoFocus autoCorrect={false} returnKeyType="search"
      style={{ ...typography.body, marginHorizontal: 12, paddingHorizontal: 12, minHeight: 46, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 10, color: colors.ink, backgroundColor: colors.surface }} />
    {choresIncomplete ? <Text style={{ ...typography.caption, color: colors.muted, paddingHorizontal: 14 }}>家事は取得済みの期間から検索します</Text> : null}
    {local.error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning, paddingHorizontal: 14 }}>{local.error}</Text> : null}
    {selectionError ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning, paddingHorizontal: 14 }}>{selectionError}</Text> : null}
    <FlatList key={query.trim()} testID="calendar-search-results" data={rows} keyExtractor={item => item.key} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" initialNumToRender={10}
      onEndReached={more ? showMore : undefined} onEndReachedThreshold={0.25}
      ListEmptyComponent={query.trim() ? <Text style={{ ...typography.caption, color: colors.muted, padding: 16 }}>{local.loading && !local.snapshot.events.length ? '予定を読み込んでいます' : '一致する予定はありません'}</Text> : undefined}
      ListFooterComponent={more ? <View style={{ padding: 12 }}><SettingsAction title="続きを表示" onPress={showMore} /></View> : undefined}
      renderItem={({ item }) => {
        if (!('draft' in item)) return <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}の検索結果を開く`} onPress={() => { if (closing.current) return; pending.current = { date: item.date, minute: item.minute ?? null, choreKey: item.key }; close(); }}
          style={{ padding: 14, minHeight: 64, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, gap: 4 }}><Text style={{ ...typography.body, color: colors.ink }} numberOfLines={2}>{item.title}</Text>
            <Text style={{ ...typography.caption, color: colors.muted }}>{formatJapaneseDate(item.date, { year: true, weekday: false })} · {item.source === 'personal' ? '個人の家事' : '共有の家事'}</Text>
          </View><Chevron color={colors.accent} /></Pressable>;
        const value = item.draft.value; const appearance = calendarEventAppearance(categories.get(value.categoryId) ?? colors.muted, scheme === 'dark');
        const title = calendarTitleDisplay.label(value.title, focusDate, titleDisplay.value);
        return <Pressable accessibilityRole="button" accessibilityLabel={`${title}の検索結果を開く`} onPress={() => { if (closing.current) return; try { pending.current = resolveSelection(item.draft); close(); } catch (cause) { setSelectionError(cause instanceof Error ? cause.message : '予定を表示できませんでした。'); } }}
          style={{ padding: 14, minHeight: 64, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, gap: 4 }}><Text style={{ ...typography.body, color: appearance.foregroundColor }} numberOfLines={2}>{title}</Text>
            <Text style={{ ...typography.caption, color: colors.muted }} numberOfLines={1}>{value.recurrence !== 'none' && item.draft.scope === 'series' ? recurrenceLabel(value) : formatJapaneseDate(value.startDate, { year: true, weekday: false })}{value.allDay ? ' · 終日' : ` ${minuteLabel(value.startMinute)}`}</Text>
            {value.location ? <Text style={{ ...typography.caption, color: colors.muted }} numberOfLines={1}>{value.location}</Text> : null}
          </View><Chevron color={colors.accent} />
        </Pressable>;
      }} />
  </View></KeyboardAvoidingView></Modal>;
}
