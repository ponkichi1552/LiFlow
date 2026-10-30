import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, BackButton, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { CalendarTaskCountIndicator } from '../../components/calendar-task-count-indicator';
import { WasteTypeLabel } from '../../components/waste-type-icon';
import { DEFAULT_CALENDAR_COUNT_COLORS } from '../../domain/calendar/count-colors';
import { addDays, formatJapaneseDate, monthDates, parseLocalDate } from '../../domain/scheduling/local-date';
import type { CalendarCountColors, CalendarCountDisplayMode, LocalDate } from '../../domain/shared/types';
import type { WeeklyWasteSchedule } from '../waste/contracts';
import { wasteCalendarLabels } from '../waste/calendar-labels';
import { calendarEventsInTimeZone, calendarMonth, categoryColor, dateInMonth, minuteLabel, newEventDraft, occurrencesOnDate, projectCalendarEvents } from './events';
import type { CalendarOccurrence } from './events';
import { CalendarEditor } from './calendar-editor';
import type { ExistingCalendarChore } from './calendar-editor';
import type { LocalCalendarBinding } from './use-local-calendar';
import { calendarDraftKey, calendarDraftVersion, EMPTY_LOCAL_CALENDAR } from '../../platform/storage/calendar-events';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import { calendarSwipe, timelineEvents, weekIndex, weekStart } from './layout';
import { createCalendarGesture } from './gesture-control';

type CalendarView = 'year' | 'month' | 'day' | 'two' | 'list';
export interface CalendarDayInfo { loaded: boolean; partial?: boolean; pending?: number; total?: number; minutes?: number; accessibilityCountLabel?: string }
export interface PlannerCalendarProps {
  workspaceName?: string;
  today: LocalDate; timeZone: string; selectedDate?: LocalDate; local?: LocalCalendarBinding; busy?: boolean;
  onSelectDate?: (date: LocalDate) => void; onMonth?: (month: LocalDate) => void; monthLoaded?: (month: LocalDate) => boolean;
  dayInfo: (date: LocalDate) => CalendarDayInfo; renderChores: (date: LocalDate) => ReactNode; renderWaste?: (date: LocalDate) => ReactNode;
  wasteSchedules?: readonly WeeklyWasteSchedule[]; hiddenWasteKeys?: readonly string[];
  countColors?: CalendarCountColors; countMode?: CalendarCountDisplayMode; notice?: ReactNode; footer?: ReactNode;
  onNavigate?: (tab: 'home' | 'calendar' | 'chores' | 'appliances') => void; existingChores?: readonly ExistingCalendarChore[];
  repeatReturnTo?: 'personal' | 'group';
}
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
const hourHeight = 58;

/** One mobile calendar for personal and shared chores. Local events never enter a shared outbox. */
export function PlannerCalendar(props: PlannerCalendarProps) {
  const { today, timeZone, local, onMonth, monthLoaded, busy, countColors = DEFAULT_CALENDAR_COUNT_COLORS, countMode = 'bar' } = props;
  const source = local?.snapshot ?? EMPTY_LOCAL_CALENDAR; const scheme = useColorScheme(); const { width } = useWindowDimensions();
  const [view, setView] = useState<CalendarView>('month'); const [date, setDate] = useState(props.selectedDate ?? today);
  const preferred = useRef(Number((props.selectedDate ?? today).slice(-2)));
  const [month, setMonth] = useState(calendarMonth(date)); const [year, setYear] = useState(Number(date.slice(0, 4)));
  const [anchor, setAnchor] = useState(weekStart(date)); const [bounds, setBounds] = useState({ from: -260, through: 260 });
  const [height, setHeight] = useState(600); const rowHeight = Math.max(86, Math.floor(height / 6));
  const [expanded, setExpanded] = useState(new Set<LocalDate>()); const [listDays, setListDays] = useState(28);
  const [editor, setEditor] = useState<CalendarEditorDraft | null>(null); const list = useRef<FlatList<LocalDate>>(null);
  const routeParams = useLocalSearchParams<{ calendarDraft?: string; calendarDraftVersion?: string }>();
  const returnedDraft = typeof routeParams.calendarDraft === 'string' && typeof routeParams.calendarDraftVersion === 'string'
    ? (source.drafts ?? (source.draft ? [source.draft] : [])).find(row => calendarDraftKey(row) === routeParams.calendarDraft && calendarDraftVersion(row) === routeParams.calendarDraftVersion) : undefined;
  const activeEditor = editor ?? returnedDraft;
  const closeEditor = () => { setEditor(null); if (routeParams.calendarDraft) router.setParams({ calendarDraft: undefined, calendarDraftVersion: undefined }); };
  const scroll = useRef<FlatList<{ key: string }>>(null); const timelineTop = useRef<number | null>(null); const positioned = useRef('');
  const monthPositioned = useRef(''); const [target, setTarget] = useState(date);
  const currentDate = useRef(date); useLayoutEffect(() => { currentDate.current = date; }, [date]);
  const requestedMonth = useRef<LocalDate | null>(null);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { if (view !== 'day' && view !== 'two') return; const timer = setInterval(() => setClock(new Date()), 60_000); return () => clearInterval(timer); }, [view]);
  const todayTime = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(clock).split(':').map(Number);
  const currentMinute = todayTime[0] * 60 + todayTime[1];
  useEffect(() => {
    if (props.selectedDate && props.selectedDate !== currentDate.current) { setDate(props.selectedDate); setMonth(calendarMonth(props.selectedDate)); preferred.current = Number(props.selectedDate.slice(-2)); }
  }, [props.selectedDate]);
  useEffect(() => {
    if (!onMonth || busy || monthLoaded?.(month) || requestedMonth.current === month) return;
    const timer = setTimeout(() => { requestedMonth.current = month; onMonth(month); }, 180); return () => clearTimeout(timer);
  }, [month, busy, monthLoaded, onMonth]);
  const weeks = useMemo(() => Array.from({ length: bounds.through - bounds.from + 1 }, (_, index) => addDays(anchor, (bounds.from + index) * 7)), [anchor, bounds]);
  const range = view === 'list' ? { from: date, through: addDays(date, Math.min(listDays, 365)) }
    : { from: calendarMonth(month, -1), through: addDays(calendarMonth(month, 2), -1) };
  const projection = useMemo(() => {
    try { return { events: calendarEventsInTimeZone(projectCalendarEvents(source.events, source.exceptions, addDays(range.from, -2), addDays(range.through, 2)), timeZone), error: null }; }
    catch (error) { return { events: [] as CalendarOccurrence[], error: error instanceof Error ? error.message : '予定を表示できません。' }; }
  }, [source.events, source.exceptions, range.from, range.through, timeZone]);
  const colors = new Map(source.categories.map(category => [category.id, categoryColor(category.color, scheme === 'dark')]));
  const eventsOn = (day: LocalDate) => occurrencesOnDate(projection.events, day);
  const waste = wasteCalendarLabels(props.wasteSchedules ?? [], range.from, range.through, props.hiddenWasteKeys);
  const dateLabel = (day: LocalDate) => {
    const info = props.dayInfo(day); const labels = waste.byDate.get(day) ?? []; const hidden = waste.hiddenWeeklyByDate.get(day) ?? []; const events = eventsOn(day);
    return `${formatJapaneseDate(day, { year: true })}、${info.accessibilityCountLabel ?? (info.loaded ? `推奨日の未完了の家事${info.pending ?? 0}件${info.partial ? '、個人家事は未取得' : ''}` : '家事は未取得')}${labels.length ? `、${labels.join('・')}` : ''}${hidden.length ? `、非表示の収集：${hidden.join('・')}` : ''}${events.length ? `、予定${events.length}件` : ''}`;
  };
  const navigateMonth = (next: LocalDate, day = preferred.current) => {
    const chosen = dateInMonth(next, day); setTarget(chosen); setMonth(calendarMonth(next)); setYear(Number(next.slice(0, 4)));
    setAnchor(weekStart(chosen)); setBounds({ from: -260, through: 260 }); setDate(chosen); props.onSelectDate?.(chosen); setView('month');
  };
  const chooseDate = (next: LocalDate) => { setDate(next); preferred.current = Number(next.slice(-2)); setMonth(calendarMonth(next)); props.onSelectDate?.(next); };
  const chooseView = (next: CalendarView) => {
    if (view === 'month' && date.slice(0, 7) !== month.slice(0, 7)) chooseDate(dateInMonth(month, preferred.current));
    if (view === 'year') chooseDate(dateInMonth(`${year}-${month.slice(5, 7)}-01` as LocalDate, preferred.current));
    positioned.current = ''; timelineTop.current = null; setView(next);
  };
  const back = () => { if (view === 'year') props.onNavigate?.('home'); else if (view === 'month') { setYear(Number(month.slice(0, 4))); setView('year'); }
    else { setTarget(date); setAnchor(weekStart(date)); setBounds({ from: -260, through: 260 }); setView('month'); } };
  const horizontal = useMemo(() => createCalendarGesture(), []);
  useLayoutEffect(() => { horizontal.update({ canStart: gesture => {
    const action = calendarSwipe(gesture.x0, gesture.dx, gesture.dy, width);
    return action === 'home' || action === 'chores' || (view === 'day' || view === 'two' || view === 'list') && Boolean(action);
  }, release: gesture => {
    const action = calendarSwipe(gesture.x0, gesture.dx, gesture.dy, width);
    if (action === 'home' || action === 'chores') props.onNavigate?.(action);
    else if (action === 'next' || action === 'previous') { positioned.current = ''; timelineTop.current = null; chooseDate(addDays(date, (action === 'next' ? 1 : -1) * (view === 'two' ? 2 : 1))); }
  } }); });
  const openEvent = (event?: CalendarOccurrence) => {
    if (!local?.database) return;
    event = event?.original ?? event;
    const savedDraft = (source.drafts ?? (source.draft ? [source.draft] : [])).find(draft => event
      ? draft.eventId === event.eventId && (draft.scope === 'series' || draft.anchorDate === event.anchorDate)
      : draft.eventId === null && !draft.value.birthday);
    if (savedDraft) { setEditor(savedDraft); return; }
    if (event?.birthday) { setEditor({ eventId: event.eventId, anchorDate: event.anchorDate, revision: event.eventRevision, exceptionRevision: event.exceptionRevision, scope: 'series', value: source.events.find(row => row.id === event.eventId)! }); return; }
    setEditor(event ? { eventId: event.eventId, anchorDate: event.anchorDate, revision: event.eventRevision, exceptionRevision: event.exceptionRevision,
      scope: source.events.find(row => row.id === event.eventId)?.recurrence === 'none' ? 'series' : 'one', value: { ...event, recurrence: 'none', untilDate: null } }
      : { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(date.slice(0, 7) === month.slice(0, 7) ? date : dateInMonth(month, preferred.current), timeZone) });
  };
  const summary = (day: LocalDate) => {
    const info = props.dayInfo(day); const open = expanded.has(day);
    return <View><Pressable accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の家事を${open ? '閉じる' : '開く'}`} accessibilityState={{ expanded: open }}
      onPress={() => setExpanded(before => { const next = new Set(before); if (next.has(day)) next.delete(day); else next.add(day); return next; })} style={styles.summary}>
      <Text style={styles.summaryTitle}>{info.loaded ? info.partial ? '家事（一部未取得）' : `家事 ${info.total ?? info.pending ?? 0}件` : '家事は未取得'}</Text>
      {info.loaded && info.minutes ? <Text style={styles.caption}>約{info.minutes}分</Text> : null}<Chevron direction={open ? 'up' : 'down'} />
    </Pressable>{(info.pending ?? 0) > 0 && eventsOn(day).some(event => event.allDay && !event.birthday) ? <Text style={styles.overlapNotice}>終日予定がある日の家事です</Text> : null}{open ? <View style={styles.choreList}>{props.renderChores(day)}</View> : null}</View>;
  };
  const eventRow = (event: CalendarOccurrence, day: LocalDate) => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${event.title}を編集`} onPress={() => openEvent(event)} style={styles.eventRow}>
    <Text style={styles.eventTime}>{event.allDay ? '終日' : event.startDate < day ? '継続' : minuteLabel(event.startMinute)}</Text><View style={[styles.eventStripe, { backgroundColor: colors.get(event.categoryId) ?? palette.muted }]} />
    <View style={styles.eventText}><Text style={styles.eventTitle}>{event.title}</Text>{event.location ? <Text style={styles.caption}>{event.location}</Text> : null}
      {event.timeIssue ? <Text style={styles.error}>時刻の確認が必要</Text> : event.original ? <Text style={styles.caption}>元の地域：{event.original.timeZone}</Text> : event.timeZone !== timeZone ? <Text style={styles.caption}>{event.timeZone}</Text> : null}</View><Chevron />
  </Pressable>;
  const dayHeading = (day: LocalDate) => <View style={styles.dayHeading}><Text accessibilityLabel={dateLabel(day)} style={styles.dayTitle}>{formatJapaneseDate(day, { weekday: true })}</Text>
    {eventsOn(day).filter(event => event.birthday).map(event => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${event.title}を編集`} onPress={() => openEvent(event)} style={styles.birthday}>
      <SymbolView name={{ ios: 'birthday.cake', android: 'cake' }} size={16} tintColor={colors.get(event.categoryId) ?? palette.muted} /><Text numberOfLines={1} style={styles.caption}>{event.title}</Text></Pressable>)}
    {waste.weeklyByColumn[parseLocalDate(day).getUTCDay()].map(name => <WasteTypeLabel key={name} label={name} size={14} />)}
    {(waste.byDate.get(day) ?? []).map(name => <WasteTypeLabel key={name} label={name} size={14} />)}</View>;
  const dayList = view === 'two' ? [date, addDays(date, 1)] : [date];
  const positionTime = () => {
    const key = `${view}:${date}`; if (positioned.current === key || timelineTop.current === null) return;
    positioned.current = key;
    const first = dayList.flatMap(day => eventsOn(day).filter(event => !event.allDay).map(event => event.startMinute)).sort((a, b) => a - b)[0];
    const minute = dayList.includes(today) ? currentMinute : first ?? 9 * 60;
    scroll.current?.scrollToOffset({ offset: Math.max(0, timelineTop.current + minute / 60 * hourHeight - height / 2), animated: false });
  };
  const scrollWeeks = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.max(0, Math.min(weeks.length - 1, Math.floor((event.nativeEvent.contentOffset.y + height / 2) / rowHeight)));
    const next = calendarMonth(addDays(weeks[index], 3));
    if (next !== month) { setMonth(next); setYear(Number(next.slice(0, 4))); }
  };
  const positionMonth = () => {
    const key = `${anchor}:${rowHeight}:${height}`; if (monthPositioned.current === key) return;
    monthPositioned.current = key;
    list.current?.scrollToOffset({ offset: Math.max(0, (weekIndex(anchor, target) - bounds.from + .5) * rowHeight - height / 2), animated: false });
  };
  const renderWeek = ({ item }: { item: LocalDate }) => <View style={[styles.week, { height: rowHeight }]}>{Array.from({ length: 7 }, (_, i) => addDays(item, i)).map(day => {
    const info = props.dayInfo(day); const dailyEvents = eventsOn(day); const labels = waste.byDate.get(day) ?? []; const hidden = waste.hiddenWeeklyByDate.get(day) ?? [];
    const slots = Math.max(1, Math.min(3, Math.floor((rowHeight - 36 - ((info.pending ?? 0) > 0 ? 25 : 0) - (labels.length ? 17 : 0)) / 18))); const shown = dailyEvents.slice(0, slots);
    return <Pressable key={day} accessibilityRole="button" accessibilityLabel={dateLabel(day)}
      accessibilityState={{ selected: day === date }} onPress={() => { chooseDate(day); positioned.current = ''; timelineTop.current = null; setView('day'); }}
      style={[styles.dayCell, hidden.length > 0 && styles.hiddenDay]}>
      {hidden.length > 0 ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.hiddenOutline]} /> : null}
      <View style={styles.dayNumberRow}><Text style={[styles.dayNumber, day.slice(0, 7) !== month.slice(0, 7) && styles.outside,
        day === today && styles.todayNumber, day === date && day !== today && styles.selectedNumber]}>{Number(day.slice(-2))}</Text>
        {Number(day.slice(-2)) === 1 ? <Text style={styles.tinyMonth}>{Number(day.slice(5, 7))}月</Text> : null}</View>
      {labels.slice(0, 1).map(label => <WasteTypeLabel key={label} label={label} size={13} textStyle={styles.gridWasteText} />)}
      {shown.map(event => <View key={event.id} style={[styles.monthEvent, { borderLeftColor: colors.get(event.categoryId) ?? palette.muted, backgroundColor: (colors.get(event.categoryId) ?? '#718299') + '1C' }]}>
        <Text numberOfLines={1} style={[styles.monthEventText, { flex: 1 }]}>{event.title}</Text>{event.id === shown.at(-1)?.id && dailyEvents.length > slots ? <Text style={styles.more}>+{dailyEvents.length - slots}</Text> : null}</View>)}
      {info.loaded && (info.pending ?? 0) > 0 ? <View style={styles.monthCount}><Text numberOfLines={1} style={styles.monthCountText}>家事 <Text style={styles.monthCountNumber}>{info.pending}</Text>件{info.partial ? '+' : ''}</Text><CalendarTaskCountIndicator count={info.pending!} colors={countColors} mode={countMode} /></View> : null}
    </Pressable>;
  })}</View>;
  const yearBody = <ScrollView contentContainerStyle={styles.yearBody}><View style={styles.yearControls}><AppButton title="‹" accessibilityLabel="前の年" compact variant="quiet" disabled={year <= 1900} onPress={() => setYear(v => v - 1)} />
    <AppButton title="今日" compact variant="quiet" onPress={() => { preferred.current = Number(today.slice(-2)); navigateMonth(calendarMonth(today), Number(today.slice(-2))); }} />
    <AppButton title="›" accessibilityLabel="次の年" compact variant="quiet" disabled={year >= 2199} onPress={() => setYear(v => v + 1)} /></View>
    <View style={styles.yearGrid}>{Array.from({ length: 12 }, (_, m) => {
      const dates = monthDates(year, m); const start = parseLocalDate(dates[0]).getUTCDay();
      return <Pressable key={m} accessibilityRole="button" accessibilityLabel={`${year}年${m + 1}月を表示`} onPress={() => navigateMonth(dates[0])} style={styles.miniMonth}>
        <Text style={styles.miniTitle}>{m + 1}月</Text><View style={styles.miniDays}>{weekdays.map(day => <Text key={day} style={styles.miniWeekday}>{day}</Text>)}{Array.from({ length: start }, (_, i) => <View key={`empty${i}`} style={styles.miniDateSlot} />)}
          {dates.map(day => <Text key={day} style={[styles.miniDateSlot, styles.miniDate, day === today && { color: palette.accent, fontWeight: '800' }]}>{Number(day.slice(-2))}</Text>)}</View>
      </Pressable>;
    })}</View>
  </ScrollView>;
  return <View style={styles.root} {...horizontal.panHandlers}>
    <View style={styles.header}><View style={styles.headerBack}><BackButton accessibilityLabel={view === 'month' ? '年表示に戻る' : view === 'year' ? 'ホームに戻る' : '月表示に戻る'} onPress={back} /></View>
      <View style={styles.titleBlock}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.85} style={styles.title}>{view === 'year' ? `${year}年` : `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`}</Text>{props.workspaceName ? <Text numberOfLines={1} style={styles.workspaceName}>{props.workspaceName}</Text> : null}</View>
      <View style={styles.modes}>{([['day', '1日'], ['two', '2日'], ['list', 'リスト']] as const).map(([mode, label], index) => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={`${label}表示`} accessibilityState={{ selected: view === mode }} onPress={() => chooseView(mode)} style={({ pressed }) => [styles.mode, index > 0 && styles.modeDivider, view === mode && styles.modeActive, pressed && { opacity: .65 }]}><Text style={[styles.modeText, view === mode && styles.modeTextActive]}>{label}</Text></Pressable>)}</View>
      <Pressable accessibilityRole="button" accessibilityLabel="予定を追加" disabled={!local?.database} onPress={() => openEvent()} style={[styles.add, !local?.database && { opacity: .35 }]}><SymbolView name={{ ios: 'plus', android: 'add' }} size={23} tintColor={palette.accent} /></Pressable>
    </View>
    {props.notice}
    {local?.error || projection.error || source.draftError ? <View style={styles.errorRow}><Text accessibilityRole="alert" style={styles.error}>{local?.error ?? projection.error ?? source.draftError}</Text>{local?.error ? <AppButton title="予定を再読込" variant="quiet" compact onPress={() => void local.refresh()} /> : null}</View> : null}
    {source.draft && !activeEditor ? <Pressable accessibilityRole="button" accessibilityLabel="入力中の予定を再開" onPress={() => setEditor(source.draft)} style={styles.resume}><Text style={styles.caption}>入力中の予定を再開</Text><Chevron /></Pressable> : null}
    {view === 'month' ? <View style={styles.weekdays}>{weekdays.map((label, i) => <View key={label} style={styles.weekdayCell}><Text style={styles.weekday}>{label}</Text>
      <View style={styles.weeklyLabels} accessibilityLabel={`${label}曜日${waste.weeklyByColumn[i].length ? `、${waste.weeklyByColumn[i].join('・')}` : ''}`}>
        {waste.weeklyByColumn[i].map(name => <WasteTypeLabel key={name} label={name} size={13} textStyle={styles.gridWasteText} />)}</View>
    </View>)}</View> : null}
    <View style={styles.viewport} onLayout={event => { const next = Math.round(event.nativeEvent.layout.height); if (next > 100) setHeight(next); }}>
      {view === 'year' ? yearBody : view === 'month' ? <FlatList key={anchor} ref={list} testID="calendar-weeks" data={weeks} renderItem={renderWeek} keyExtractor={week => week}
        initialScrollIndex={Math.max(0, weekIndex(anchor, target) - bounds.from - 2)} initialNumToRender={9} maxToRenderPerBatch={8} windowSize={7}
        getItemLayout={(_data, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
        onLayout={positionMonth} onContentSizeChange={positionMonth}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }} scrollEventThrottle={32} onScroll={scrollWeeks}
        onStartReached={() => setBounds(before => ({ ...before, from: Math.max(-20_000, before.from - 52) }))} onStartReachedThreshold={.5}
        onEndReached={() => setBounds(before => ({ ...before, through: Math.min(20_000, before.through + 52) }))} onEndReachedThreshold={.5}
        accessibilityLabel="月カレンダー" accessibilityActions={[{ name: 'increment', label: '次の月' }, { name: 'decrement', label: '前の月' }]}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'increment' || event.nativeEvent.actionName === 'decrement') navigateMonth(calendarMonth(month, event.nativeEvent.actionName === 'increment' ? 1 : -1)); }}
        onScrollToIndexFailed={() => list.current?.scrollToOffset({ offset: Math.max(0, weekIndex(anchor, target) - bounds.from - 2) * rowHeight, animated: false })}
      /> : view === 'list' ? <FlatList testID="calendar-agenda" data={Array.from({ length: Math.min(listDays, 365) }, (_, i) => addDays(date, i))} keyExtractor={day => day} initialNumToRender={7}
        onEndReached={() => setListDays(n => Math.min(365, n + 28))} renderItem={({ item: day }) => <View style={styles.agendaDay}>{dayHeading(day)}{props.renderWaste?.(day)}{summary(day)}
          {eventsOn(day).filter(event => !event.birthday).map(event => eventRow(event, day))}{eventsOn(day).length === 0 ? <Text style={styles.empty}>{local?.error || projection.error ? '予定を取得できていません' : '予定はありません'}</Text> : null}</View>} />
        : <FlatList ref={scroll} testID="calendar-timeline" data={[{ key: 'top' }, { key: 'timeline' }]} keyExtractor={item => item.key} initialNumToRender={2}
          onContentSizeChange={positionTime} contentContainerStyle={styles.timelineBody} renderItem={({ item: section }) => section.key === 'top' ?
          <View style={styles.dayColumns} onLayout={event => { timelineTop.current = event.nativeEvent.layout.height + 8; setTimeout(positionTime, 0); }}>{dayList.map(day => <View key={day} style={styles.dayColumn}>{dayHeading(day)}{props.renderWaste?.(day)}{summary(day)}
            {eventsOn(day).filter(event => event.allDay && !event.birthday).map(event => eventRow(event, day))}</View>)}</View>
          : <View style={styles.timeline}>
            {Array.from({ length: 25 }, (_, hour) => <View key={hour} pointerEvents="none" style={[styles.hour, { top: hour * hourHeight }]}><Text style={styles.hourLabel}>{String(hour).padStart(2, '0')}:00</Text><View style={styles.hourRule} /></View>)}
            <View style={styles.timelineColumns}>{dayList.map(day => <View key={day} style={styles.timelineColumn}>
              {timelineEvents(eventsOn(day), day).map(item => <Pressable key={item.row.id} accessibilityRole="button" accessibilityLabel={`${item.row.title}を編集`} onPress={() => openEvent(item.row)} style={[styles.timedEvent,
                { top: item.start / 60 * hourHeight, height: Math.max(26, (item.end - item.start) / 60 * hourHeight), left: `${item.lane / item.lanes * 100}%`, width: `${96 / item.lanes}%`,
                  borderLeftColor: colors.get(item.row.categoryId) ?? palette.muted, backgroundColor: (colors.get(item.row.categoryId) ?? '#718299') + '30' }]}>
                <Text numberOfLines={1} style={styles.timedTitle}>{item.row.title}{item.row.timeIssue ? '（時刻要確認）' : ''}</Text>{item.end - item.start >= 35 ? <Text numberOfLines={1} style={styles.caption}>{minuteLabel(item.start)}〜{minuteLabel(item.end)}</Text> : null}
              </Pressable>)}
              {day === today ? <View pointerEvents="none" style={[styles.now, { top: currentMinute / 60 * hourHeight }]}><View style={styles.nowDot} /><Text style={styles.nowLabel}>現在 {minuteLabel(currentMinute)}</Text></View> : null}
            </View>)}</View>
          </View>} />}
    </View>
    {props.footer}
    {activeEditor && local ? <CalendarEditor key={`${activeEditor.eventId ?? 'new'}:${activeEditor.anchorDate ?? ''}:${returnedDraft ? routeParams.calendarDraftVersion : ''}`} initial={activeEditor} local={local} chores={props.existingChores} repeatReturnTo={props.repeatReturnTo} onClose={() => { closeEditor(); void local.refresh(); }} onSaved={day => {
      closeEditor(); if (view === 'month' || view === 'year') navigateMonth(calendarMonth(day), Number(day.slice(-2))); else chooseDate(day); void local.refresh();
    }} /> : null}
  </View>;
}

export function CalendarFooter({ onNavigate }: { onNavigate: NonNullable<PlannerCalendarProps['onNavigate']> }) {
  const insets = useSafeAreaInsets();
  const tabs = [['home', 'ホーム', { ios: 'house', android: 'house' }], ['calendar', 'カレンダー', { ios: 'calendar', android: 'calendar_month' }],
    ['chores', '家事', { ios: 'checklist', android: 'checklist' }], ['appliances', '家電', { ios: 'robotic.vacuum', android: 'vacuum' }]] as const;
  return <View style={[styles.footer, { paddingBottom: Math.max(8, insets.bottom) }]}>{tabs.map(([tab, label, icon]) => <Pressable key={tab} accessibilityRole="button" accessibilityLabel={`${label}へ`} accessibilityState={{ selected: tab === 'calendar' }} onPress={() => onNavigate(tab)} style={styles.footerTab}>
    <SymbolView name={icon} size={21} tintColor={tab === 'calendar' ? palette.accent : palette.muted} /><Text style={[styles.footerLabel, tab === 'calendar' && { color: palette.accent }]}>{label}</Text></Pressable>)}</View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, header: { minHeight: 56, paddingHorizontal: 8, gap: 3, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  headerBack: { alignSelf: 'center' },
  titleBlock: { flex: 1 }, title: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: palette.ink }, workspaceName: { fontSize: 12, lineHeight: 16, color: palette.muted }, modes: { flexDirection: 'row', backgroundColor: palette.elevated, borderRadius: 10, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' },
  mode: { minHeight: 42, minWidth: 34, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }, modeDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, modeActive: { backgroundColor: palette.accentSoft, borderBottomWidth: 2, borderBottomColor: palette.accent }, modeText: { ...typography.caption, color: palette.accent }, modeTextActive: { fontWeight: '700' },
  add: { minWidth: 40, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: palette.accentSoft },
  viewport: { flex: 1, overflow: 'hidden' }, weekdays: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, weekdayCell: { width: `${100 / 7}%`, alignItems: 'center', paddingTop: 5, paddingBottom: 5, minHeight: 32, gap: 1 },
  weekday: { ...typography.calendarLabel, color: palette.muted }, weeklyLabels: { gap: 1, alignItems: 'center', maxWidth: '100%' },
  week: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, dayCell: { flex: 1, minWidth: 0, padding: 3, borderRightWidth: 1, borderColor: palette.border, overflow: 'hidden', gap: 2 },
  hiddenDay: { backgroundColor: palette.elevated }, hiddenOutline: { borderWidth: 1.5, borderColor: palette.muted },
  dayNumberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 28 }, dayNumber: { ...typography.calendarDate, color: palette.ink, fontWeight: '500', minWidth: 28, height: 28, textAlign: 'center', paddingTop: 2, borderRadius: 14 },
  todayNumber: { color: palette.accentInk, backgroundColor: palette.accent, fontWeight: '800' }, selectedNumber: { color: palette.accent, backgroundColor: palette.accentSoft }, outside: { color: palette.muted }, tinyMonth: { fontSize: 10, color: palette.muted },
  monthEvent: { borderLeftWidth: 2, borderRadius: 3, paddingHorizontal: 2, flexDirection: 'row', alignItems: 'center' }, monthEventText: { fontSize: 13, lineHeight: 18, color: palette.ink }, gridWasteText: { fontSize: 12, lineHeight: 16 }, more: { fontSize: 10, color: palette.muted },
  monthCount: { marginTop: 'auto', backgroundColor: palette.elevated, borderRadius: 4, paddingTop: 1, alignItems: 'center' }, monthCountText: { fontSize: 12, lineHeight: 16, color: palette.muted }, monthCountNumber: { fontSize: 13, fontWeight: '700', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning, flex: 1 }, errorRow: { paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', gap: 8, alignItems: 'center' },
  resume: { paddingHorizontal: 12, minHeight: 38, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  summary: { flexDirection: 'row', gap: 8, alignItems: 'center', minHeight: 38, paddingHorizontal: 10 }, summaryTitle: { ...typography.label, color: palette.ink, fontWeight: '600', flex: 1 }, choreList: { gap: 0, paddingHorizontal: 6, paddingBottom: 8 },
  overlapNotice: { ...typography.small, color: palette.gold, paddingHorizontal: 10, paddingBottom: 4 },
  dayHeading: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', paddingHorizontal: 10, paddingTop: 9, paddingBottom: 3 }, dayTitle: { ...typography.label, color: palette.ink, fontWeight: '700' },
  birthday: { flexDirection: 'row', gap: 3, alignItems: 'center', maxWidth: '65%' }, dayColumns: { flexDirection: 'row' }, dayColumn: { flex: 1, minWidth: 0, borderRightWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  eventRow: { minHeight: 48, paddingVertical: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  eventTime: { ...typography.caption, color: palette.muted, width: 39 }, eventStripe: { width: 3, alignSelf: 'stretch', borderRadius: 2 }, eventText: { flex: 1, gap: 1 }, eventTitle: { ...typography.body, color: palette.ink, fontWeight: '600' },
  agendaDay: { paddingBottom: 10, borderBottomWidth: 1, borderColor: palette.border }, empty: { ...typography.caption, color: palette.muted, paddingHorizontal: 12, paddingVertical: 8 },
  timelineBody: { paddingBottom: 24 }, timeline: { height: 24 * hourHeight + 15, marginTop: 8 }, hour: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center' }, hourLabel: { fontSize: 12, lineHeight: 18, color: palette.muted, width: 44, textAlign: 'center', transform: [{ translateY: -9 }] }, hourRule: { flex: 1, height: 1, backgroundColor: palette.border },
  timelineColumns: { marginLeft: 44, flexDirection: 'row', height: '100%', borderLeftWidth: 1, borderColor: palette.border }, timelineColumn: { flex: 1, minWidth: 0, borderRightWidth: 1, borderColor: palette.border },
  timedEvent: { position: 'absolute', borderLeftWidth: 3, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' }, timedTitle: { ...typography.label, color: palette.ink, fontWeight: '600' },
  now: { position: 'absolute', left: 0, right: 0, borderTopWidth: 1.5, borderColor: palette.accent, height: 1 }, nowDot: { position: 'absolute', left: -4, top: -4, width: 7, height: 7, borderRadius: 4, backgroundColor: palette.accent }, nowLabel: { position: 'absolute', right: 3, bottom: 3, paddingHorizontal: 3, fontSize: 11, lineHeight: 15, color: palette.accent, backgroundColor: palette.background },
  yearBody: { padding: 12, gap: 12 }, yearControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, yearGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: '3%' }, miniMonth: { width: '31.3%', marginBottom: 18, gap: 4, minHeight: 124 }, miniTitle: { ...typography.label, color: palette.ink, fontWeight: '700' },
  miniDays: { flexDirection: 'row', flexWrap: 'wrap' }, miniWeekday: { fontSize: 9, color: palette.muted, textAlign: 'center', width: `${100 / 7}%` }, miniDateSlot: { width: `${100 / 7}%`, minHeight: 14 }, miniDate: { fontSize: 9, color: palette.ink, textAlign: 'center' },
  footer: { minHeight: 62, flexDirection: 'row', borderTopWidth: 1, borderColor: palette.border, backgroundColor: palette.surface }, footerTab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 56 }, footerLabel: { ...typography.tab, color: palette.muted },
});
