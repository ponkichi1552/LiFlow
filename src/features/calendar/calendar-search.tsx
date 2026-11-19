import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, Text, View, useColorScheme } from 'react-native';
import { FormTextInput } from '../../components/form-text-input';
import { Chevron } from '../../components/chevron';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { formatJapaneseDate, localDateFromDate } from '../../domain/scheduling/local-date';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock';
import { v2WallTimeCandidates } from '../sharing/v2/local-time';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import type { LocalCalendarBinding } from './use-local-calendar';
import type { CalendarEvent, CalendarException } from '../../domain/calendar/events';
import { minuteLabel, recurrenceLabel } from './events';
import { calendarSearchIndex, searchCalendarIndex, searchCalendarWithChores } from './search';
import type { CalendarSearchChore, CalendarSearchDestination } from './search';
import { calendarEventAppearance } from './event-appearance';
import { SettingsAction } from '../../components/settings-controls';
import type { LocalDate } from '../../domain/shared/types';
import { useCalendarTitleDisplay } from './use-title-display';
import { calendarTitleDisplay } from './title-display';
import { searchTerms } from '../../domain/search/normalized-search';

type HistorySearchState = { events: CalendarEvent[]; exceptions: CalendarException[]; loading: boolean; error?: boolean };
const EMPTY_HISTORY: Pick<HistorySearchState, 'events' | 'exceptions'> = { events: [], exceptions: [] };

function indexSearchData(input: { historyEvents: CalendarEvent[]; historyExceptions: CalendarException[];
  localEvents: readonly CalendarEvent[]; localExceptions: readonly CalendarException[]; focusDate: LocalDate }) {
  const events = [...new Map([...input.historyEvents, ...input.localEvents].map(event => [event.id, event])).values()];
  const exceptions = [...new Map([...input.historyExceptions, ...input.localExceptions]
    .map(exception => [`${exception.eventId}:${exception.anchorDate}`, exception])).values()];
  return { input, events, exceptions, index: calendarSearchIndex(events, exceptions, input.focusDate) };
}

interface CalendarSearchProps {
  local: LocalCalendarBinding;
  chores?: readonly CalendarSearchChore[];
  choresIncomplete?: boolean;
  focusDate?: LocalDate;
  displayTimeZone?: string;
  onClose(): void;
  onSelect(destination: CalendarSearchDestination): void;
  resolveSelection(draft: CalendarEditorDraft, events: readonly CalendarEvent[], exceptions: readonly CalendarException[]): CalendarSearchDestination;
}

export function CalendarSearch(props: CalendarSearchProps) {
  const { value } = useCalendarTitleDisplay();
  return <CalendarSearchContent {...props} shortenTitles={value} />;
}

export function CalendarSearchContent({ local, chores = [], choresIncomplete, focusDate = localDateFromDate(new Date()), displayTimeZone,
  onClose, onSelect, resolveSelection, shortenTitles, initialQuery = '' }: CalendarSearchProps & { shortenTitles: boolean; initialQuery?: string }) {
  const scheme = useColorScheme(); const colors = plannerColorsForScheme(scheme); const [query, setQuery] = useState(initialQuery); const [selectionError, setSelectionError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(60);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [historyState, setHistoryState] = useState<HistorySearchState & { key: string }>({ key: '', events: [], exceptions: [], loading: false });
  const [visible, setVisible] = useState(true); const closing = useRef(false); const finished = useRef(false); const pending = useRef<CalendarSearchDestination | null>(null);
  const finish = () => { if (finished.current) return; finished.current = true; if (pending.current) onSelect(pending.current); else onClose(); };
  const close = () => { if (closing.current) return; closing.current = true; setVisible(false); if (Platform.OS !== 'ios') finish(); };
  const hasSearchTerms = searchTerms(query).length > 0;
  const readHistoryPage = local.readHistoryPage;
  const historyGeneration = local.historyGeneration ?? 0;
  const historyKey = JSON.stringify([historyGeneration, focusDate, query, historyAttempt]);
  const searchHistory = local.historyLimited === true && hasSearchTerms && Boolean(readHistoryPage);
  const history: HistorySearchState = searchHistory && historyState.key === historyKey ? historyState
    : { ...EMPTY_HISTORY, loading: searchHistory };
  useEffect(() => {
    if (!searchHistory || !readHistoryPage) return;
    let live = true; let afterId: string | undefined;
    const events = new Map<string, CalendarEvent>(); const exceptions = new Map<string, CalendarException>();
    const run = async () => {
      try {
        do {
          const page = await readHistoryPage(afterId, historyGeneration);
          if (!live) return;
          const matching = searchCalendarIndex(calendarSearchIndex(page.events, page.exceptions, focusDate), query, Infinity).matches;
          const matchingSeries = new Set(matching.filter(row => row.draft.scope === 'series').map(row => row.draft.eventId).filter((id): id is string => Boolean(id)));
          const matchingOverrides = new Set(matching.filter(row => row.draft.scope === 'one' && row.draft.eventId && row.draft.anchorDate)
            .map(row => `${row.draft.eventId}:${row.draft.anchorDate}`));
          if (matchingSeries.size || matchingOverrides.size) {
            const included = new Set([...matchingSeries, ...[...matchingOverrides].map(key => key.slice(0, key.lastIndexOf(':')))]);
            for (const event of page.events) if (included.has(event.id)) events.set(event.id, event);
            for (const exception of page.exceptions) if (matchingSeries.has(exception.eventId) || matchingOverrides.has(`${exception.eventId}:${exception.anchorDate}`))
              exceptions.set(`${exception.eventId}:${exception.anchorDate}`, exception);
            setHistoryState({ key: historyKey, events: [...events.values()], exceptions: [...exceptions.values()], loading: Boolean(page.nextAfterId) });
          }
          afterId = page.nextAfterId;
        } while (live && afterId);
        if (live) setHistoryState({ key: historyKey, events: [...events.values()], exceptions: [...exceptions.values()], loading: false });
      } catch { if (live) setHistoryState({ key: historyKey, events: [...events.values()], exceptions: [...exceptions.values()], loading: false, error: true }); }
    };
    const timer = setTimeout(() => { void run(); }, 160);
    return () => { live = false; clearTimeout(timer); };
  }, [searchHistory, readHistoryPage, historyGeneration, historyKey, focusDate, query]);
  const input = useMemo(() => ({ historyEvents: history.events, historyExceptions: history.exceptions,
    localEvents: local.snapshot.events, localExceptions: local.snapshot.exceptions, focusDate }),
  [history.events, history.exceptions, local.snapshot.events, local.snapshot.exceptions, focusDate]);
  const [indexed, setIndexed] = useState<ReturnType<typeof indexSearchData> | null>(null);
  // An empty search never builds an index. Keep the last index only while its input stays current.
  const searchData = indexed?.input === input ? indexed : hasSearchTerms ? indexSearchData(input) : null;
  if (indexed !== searchData) setIndexed(searchData);
  const result = useMemo(() => searchCalendarWithChores(searchData?.index ?? [], chores, query, Infinity, focusDate),
    [searchData, chores, query, focusDate]);
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
    <FormTextInput accessibilityLabel="予定を検索" placeholder="予定名・家事名・場所・メモで検索" value={query} onChangeText={value => { setQuery(value); setVisibleCount(60); setSelectionError(null); }} autoFocus={!initialQuery} autoCorrect={false} returnKeyType="search"
      style={{ ...typography.body, marginHorizontal: 12, paddingHorizontal: 12, minHeight: 46, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 10, color: colors.ink, backgroundColor: colors.surface }} />
    {history.loading ? <Text accessibilityLiveRegion="polite" style={{ ...typography.caption, color: colors.muted, paddingHorizontal: 14 }}>過去の予定を検索中</Text> : null}
    {history.error ? <View style={{ paddingHorizontal: 14 }}>
      <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning }}>保存履歴を検索できませんでした</Text>
      <SettingsAction title="検索を再試行" onPress={() => setHistoryAttempt(attempt => attempt + 1)} />
    </View> : null}
    {choresIncomplete ? <Text style={{ ...typography.caption, color: colors.muted, paddingHorizontal: 14 }}>家事は取得済みの期間から検索します</Text> : null}
    {local.error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning, paddingHorizontal: 14 }}>{local.error}</Text> : null}
    {selectionError ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning, paddingHorizontal: 14 }}>{selectionError}</Text> : null}
    <FlatList key={query.trim()} testID="calendar-search-results" data={rows} keyExtractor={item => item.key} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" initialNumToRender={10}
      onEndReached={more ? showMore : undefined} onEndReachedThreshold={0.25}
      ListEmptyComponent={hasSearchTerms && !history.loading && !history.error && !local.error ? <Text accessibilityLiveRegion="polite" style={{ ...typography.caption, color: colors.muted, padding: 16 }}>{local.loading ? '予定を読み込んでいます' : '一致する予定はありません'}</Text> : undefined}
      ListFooterComponent={more ? <View style={{ padding: 12 }}><SettingsAction title="続きを表示" onPress={showMore} /></View> : undefined}
      renderItem={({ item }) => {
        if (!('draft' in item)) {
          const detail = `${formatJapaneseDate(item.date, { year: true })}${item.minute == null ? '' : ` ${minuteLabel(item.minute)}`} · ${item.source === 'personal' ? '個人の家事' : '共有の家事'}`;
          return <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}の検索結果を開く`} accessibilityValue={{ text: detail }} onPress={() => { if (closing.current) return; pending.current = { date: item.date, minute: item.minute ?? null, choreKey: item.key }; close(); }}
          style={{ padding: 14, minHeight: 64, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, gap: 4 }}><Text style={{ ...typography.body, color: colors.ink }} numberOfLines={2}>{item.title}</Text>
            <Text style={{ ...typography.caption, color: colors.muted }}>{detail}</Text>
          </View><Chevron color={colors.accent} /></Pressable>;
        }
        const value = item.draft.value; const appearance = calendarEventAppearance(categories.get(value.categoryId) ?? colors.muted, scheme === 'dark');
        const title = calendarTitleDisplay.label(value.title, focusDate, shortenTitles);
        const repeat = value.recurrence !== 'none' && item.draft.scope === 'series';
        const dateTime = searchResultDateTime(item.draft, displayTimeZone);
        const dateLabel = repeat ? recurrenceLabel(value) : formatJapaneseDate(dateTime.date, { year: true });
        const timeLabel = value.allDay ? ' · 終日' : dateTime.minute === null ? ` · 時刻要確認（${value.timeZone}）` : ` ${minuteLabel(dateTime.minute)}${repeat && displayTimeZone && value.timeZone !== displayTimeZone ? `（${value.timeZone}）` : ''}`;
        return <Pressable accessibilityRole="button" accessibilityLabel={`${title}の検索結果を開く`} accessibilityValue={{ text: `${dateLabel}${timeLabel}${value.location ? ` · ${value.location}` : ''}` }} onPress={() => {
          if (closing.current || !searchData) return;
          try {
            pending.current = resolveSelection(item.draft, searchData.events, searchData.exceptions);
            close();
          } catch (cause) { setSelectionError(cause instanceof Error ? cause.message : '予定を表示できませんでした。'); }
        }}
          style={{ padding: 14, minHeight: 64, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View aria-hidden style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: appearance.foregroundColor }} />
          <View style={{ flex: 1, gap: 4 }}><Text style={{ ...typography.body, color: colors.ink }} numberOfLines={2}>{title}</Text>
            <Text style={{ ...typography.caption, color: colors.muted }}>{dateLabel}{timeLabel}</Text>
            {value.location ? <Text style={{ ...typography.caption, color: colors.muted }} numberOfLines={1}>{value.location}</Text> : null}
          </View><Chevron color={colors.accent} />
        </Pressable>;
      }} />
  </View></KeyboardAvoidingView></Modal>;
}

function searchResultDateTime(draft: CalendarEditorDraft, timeZone?: string): { date: LocalDate; minute: number | null } {
  const value = draft.value;
  if (value.allDay || (draft.scope === 'series' && value.recurrence !== 'none') || !timeZone || timeZone === value.timeZone) {
    return { date: value.startDate, minute: value.startMinute };
  }
  const candidates = v2WallTimeCandidates({ date: value.startDate, timeZone: value.timeZone, hour: Math.floor(value.startMinute / 60), minute: value.startMinute % 60 });
  if (candidates.length !== 1) return { date: value.startDate, minute: null };
  return pinnedClockAt(candidates[0], timeZone);
}
