import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentRef, ReactNode } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import type { FlatListProps, ViewStyle } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { FlatList as GestureFlatList, ScrollView as GestureScrollView, GestureDetector, GestureHandlerRootView, usePanGesture } from 'react-native-gesture-handler';
import Animated, { ReduceMotion, useAnimatedRef, useAnimatedStyle, useReducedMotion, useScrollOffset, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCalendarClock } from './use-calendar-clock';
import { AppButton, BackButton, navigationHeaderMetrics, palette, typography } from '../../components/planner-ui';
import { plannerPressColorsForScheme } from '../../components/planner-theme';
import { Chevron } from '../../components/chevron';
import { CalendarCollectionLabels } from '../../components/waste-type-icon';
import { addDays, formatJapaneseDate, parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import type { WeeklyWasteSchedule } from '../waste/contracts';
import { wasteCalendarLabels } from '../waste/calendar-labels';
import { CATEGORY_PRESETS, UNCATEGORIZED_CALENDAR_CATEGORY, calendarMonth, dateInMonth, indexCalendarOccurrences, isCalendarAnchor, minuteLabel, newAppointmentValue } from './events';
import { projectPrivateCalendarDisplayEvents } from './private-event-projection';
import { createCalendarMonthCache } from './month-cache';
import { createCalendarMonthEventIndex } from './month-event-index';
import { visibleEventProjectionCandidates } from './visible-event-candidates';
import type { CalendarEvent, CalendarOccurrence } from './events';
import { CalendarEditor } from './calendar-editor';
import type { CalendarChoreRegistrationProps, ExistingCalendarChore } from './calendar-editor';
import type { LocalCalendarBinding } from './use-local-calendar';
import { calendarDraftKey, calendarDraftVersion, newCalendarDraftId, EMPTY_LOCAL_CALENDAR, saveCalendarEvent, saveCalendarFutureEvent, restoreCalendarOccurrence } from '../../platform/storage/calendar-events';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import { calendarSwipe, compactAllDayLanes, compactTimelineLayout, timelineDayMinutes, timelineGroups, weekStart, type TimelineEntry, type TimelineLabel } from './layout';
import { createCalendarGesture } from './gesture-control';
import { calendarMonthRows, calendarRowForDate, MONTH_HEADING_HEIGHT } from './month-rows';
import type { CalendarMonthRow } from './month-rows';
import type { CalendarView } from './display-store';
import { useCalendarDisplay } from '../../hooks/use-calendar-display';
import { CalendarViewMenu, CALENDAR_DETAIL_LABELS } from './view-menu';
import { CalendarMonthPicker } from './month-picker';
import { CalendarDateStrip } from './calendar-date-strip';
import { calendarChoreDisplayThrough } from './chore-display-range';
import { japanesePublicHoliday } from './holiday-label';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { calendarDisplayColor as categoryColor, calendarEventAppearance, uncategorizedOverlapAppearances } from './event-appearance';
import { calendarMonthContentHeight, MONTH_CELL_GAP, MONTH_CELL_PADDING, MONTH_DATE_HEIGHT, MONTH_SUMMARY_HEIGHT } from './month-density';
import { CalendarSearch, CalendarSearchContent } from './calendar-search';
import { CalendarHelp } from './calendar-help';
import { useCalendarHelp } from './use-calendar-help';
import { useCalendarMonthDetail } from './use-month-detail';
import { useCalendarTitleDisplay } from './use-title-display';
import { calendarDisplayedTitle, calendarTitleDisplay } from './title-display';
import { monthDetailLayout } from './month-detail-store';
import { measureCalendarHelpTargets, type CalendarHelpHost, type CalendarHelpTargets } from './help-targets';
import { CalendarDraftList } from './calendar-draft-list';
import { calendarSearchDestination, type CalendarSearchDestination, type CalendarSearchChore } from './search';
import { CalendarYear, type YearScroller } from './calendar-year';
import { PersonalCalendarChoreRegistration } from './personal-chore-registration';
import { timedCalendarChoreEvents, type TimedCalendarChore } from './timed-chores';
import { OWN_BIRTHDAY_EVENT_ID } from '../../domain/calendar/own-birthday';
import { BirthdayCalendarDate } from '../../components/birthday-cake';
import { CalendarMonthEvents } from './month-events';
import { CalendarMoveScopeRequiredError, calendarEventValue, calendarMovedDraft, calendarSeriesMovedDraft, calendarFutureMovedDraft, calendarMonthDragTarget, calendarOccurrenceDraft, calendarSlotDraft, type CalendarDragColumn, type CalendarMonthViewport } from './direct-actions';
import { CalendarTimedEvent } from './calendar-timed-event';
import { CalendarRecurrenceScopePicker, type CalendarEditScope } from './calendar-recurrence-scope';
import { CalendarWeek, type WeekRecenter } from './calendar-week';
import { CalendarChoreScroll } from './calendar-chore-scroll';
import { CompactAllDay } from './compact-all-day';
import { CalendarDayPanels, CalendarTimelineShift, compactAllDayBand, layoutCalendarDayPanels } from './calendar-day-panels';
import { calendarDragColumn, calendarTimelineInset, calendarTimelineOffset } from './timeline-origin';
import { CalendarOverlapSheet } from './calendar-overlap-sheet';
import { calendarWeekDays } from './week-layout';
import { moveCalendarStart } from './event-editing';
import { useMonthDrag } from './use-month-drag';
import { splitCalendarFuture } from '../../domain/calendar/future-series';
import { rebasedCalendarExceptions } from '../../domain/calendar/exception-slots';
import type { createCalendarReviewPreferences } from '../development/ui-review/calendar-preferences';

export interface CalendarDayInfo { loaded: boolean; partial?: boolean; pending?: number; total?: number; minutes?: number; accessibilityCountLabel?: string }
export interface PlannerCalendarProps {
  timedChores?: readonly TimedCalendarChore[];
  searchChores?: readonly CalendarSearchChore[]; searchChoresIncomplete?: boolean;
  loadSearchChores?: () => readonly CalendarSearchChore[];
  workspaceName?: string;
  today: LocalDate; timeZone: string; selectedDate?: LocalDate; local?: LocalCalendarBinding; busy?: boolean;
  onSelectDate?: (date: LocalDate) => void; onMonth?: (month: LocalDate) => void; monthLoaded?: (month: LocalDate) => boolean;
  dayInfo: (date: LocalDate) => CalendarDayInfo; renderChores: (date: LocalDate, view: CalendarView) => ReactNode; renderWaste?: (date: LocalDate, view: CalendarView) => ReactNode;
  extendedChoreDates?: ReadonlySet<LocalDate>;
  wasteSchedules?: readonly WeeklyWasteSchedule[]; hiddenWasteKeys?: readonly string[];
  /** Shared rules alone do not prove that date-specific exceptions were read. */
  wasteLoaded?: (date: LocalDate) => boolean;
  notice?: ReactNode; footer?: ReactNode;
  onNavigate?: (tab: 'home' | 'calendar' | 'chores' | 'appliances') => void; existingChores?: readonly ExistingCalendarChore[];
  repeatReturnTo?: 'personal' | 'group';
  renderChoreRegistration?: (props: CalendarChoreRegistrationProps) => ReactNode;
  preview?: { preferences: ReturnType<typeof createCalendarReviewPreferences>; initialExpandedDay?: LocalDate; currentMinute: number; onInspectEvent?(event: CalendarOccurrence): void; onExit?(): void };
}
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
const hourHeight = 44;
const timeGutter = 44;
const timelineTopPadding = 8;
const timelineHours = Array.from({ length: 25 }, (_, hour) => hour);
const minimumEventHeight = 26;
const agendaViewability = { itemVisiblePercentThreshold: 10 };
interface CalendarMoveCapture {
  draft: CalendarEditorDraft; event: CalendarOccurrence; database: NonNullable<LocalCalendarBinding['database']>;
  series: CalendarEvent;
  groupId?: string; timeZone: string; events: LocalCalendarBinding['snapshot']['events']; exceptions: LocalCalendarBinding['snapshot']['exceptions'];
}

/** One mobile calendar for personal and shared chores. Local events never enter a shared outbox. */
export function PlannerCalendar(props: PlannerCalendarProps) {
  const styles = usePlannerBorderStyles(baseStyles);
  const { today, timeZone, local, onMonth, monthLoaded, busy, preview } = props;
  const preferences = preview?.preferences;
  const canSearch = Boolean(local && (local.database || preview));
  const currentContext = useRef({ local, timeZone }); useLayoutEffect(() => { currentContext.current = { local, timeZone }; }, [local, timeZone]);
  const choreThrough = calendarChoreDisplayThrough(today);
  const showChores = (day: LocalDate) => day <= choreThrough || props.extendedChoreDates?.has(day) === true;
  const source = local?.snapshot ?? EMPTY_LOCAL_CALENDAR; const scheme = useColorScheme(); const { width, fontScale } = useWindowDimensions();
  const pressColors = plannerPressColorsForScheme(scheme);
  const display = useCalendarDisplay(preferences?.display); const view = display.view; const setView = display.select;
  const [viewMenu, setViewMenu] = useState(false); const [date, setDate] = useState(props.selectedDate ?? today);
  const [detailRangeStart, setDetailRangeStart] = useState(date);
  const detailDays = view === 'three' ? 3 : view === 'two' ? 2 : 1;
  const visibleStart = detailDays > 1 ? detailRangeStart : date;
  const visibleEnd = detailDays > 1 ? addDays(visibleStart, detailDays - 1) : visibleStart;
  const [agendaTop, setAgendaTop] = useState<{ anchor: LocalDate; day: LocalDate } | null>(null);
  const agendaDate = agendaTop?.anchor === date ? agendaTop.day : date;
  const agendaAnchor = useRef(date);
  useLayoutEffect(() => { agendaAnchor.current = date; }, [date]);
  const visibleAgendaChanged = useCallback<NonNullable<FlatListProps<LocalDate>['onViewableItemsChanged']>>(({ viewableItems }) => {
    const anchor = agendaAnchor.current;
    const first = viewableItems.find(row => row.isViewable && typeof row.index === 'number' && addDays(anchor, row.index) === row.item);
    if (first) setAgendaTop(before => before?.anchor === anchor && before.day === first.item ? before : { anchor, day: first.item });
  }, []);
  const [monthPicker, setMonthPicker] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [overlap, setOverlap] = useState<{ day: LocalDate; eventIds: readonly string[]; start: number } | null>(null);
  const [searchFocus, setSearchFocus] = useState<{ eventId: string | null; anchorDate?: LocalDate; date: LocalDate; minute: number | null } | null>(null);
  const { loadSearchChores, searchChores: preparedSearchChores } = props;
  const searchChores = useMemo(() => searchOpen ? loadSearchChores?.() ?? preparedSearchChores : undefined,
    [searchOpen, loadSearchChores, preparedSearchChores]);
  const searchFocusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const agendaEventOffsets = useRef(new Map<string, number>());
  const [draftsOpen, setDraftsOpen] = useState(false);
  const preferred = useRef(Number((props.selectedDate ?? today).slice(-2)));
  const [month, setMonth] = useState(calendarMonth(date)); const [year, setYear] = useState(Number(date.slice(0, 4)));
  const [anchor, setAnchor] = useState(weekStart(date)); const [bounds, setBounds] = useState({ from: -260, through: 260 });
  const monthDetail = useCalendarMonthDetail(preferences?.monthDetail); const density = monthDetailLayout(monthDetail.value);
  const titleDisplay = useCalendarTitleDisplay(preferences?.titleDisplay);
  const [height, setHeight] = useState(600); const rowHeight = calendarMonthContentHeight(Math.floor(height / density.weeks), density.maxEvents);
  const [expanded, setExpanded] = useState(() => new Set<LocalDate>(preview?.initialExpandedDay ? [preview.initialExpandedDay] : []));
  const [listDays, setListDays] = useState(28);
  const [choreContentHeights, setChoreContentHeights] = useState<Record<string, number>>({});
  const [dayHeadingHeight, setDayHeadingHeight] = useState(0);
  const [timelineWidth, setTimelineWidth] = useState(width - timeGutter);
  const monthViewport = useRef<CalendarMonthViewport | null>(null); const monthScrollOffset = useRef(0); const viewportHost = useRef<ComponentRef<typeof View>>(null);
  const helpAdd = useRef<ComponentRef<typeof View>>(null), helpMode = useRef<ComponentRef<typeof View>>(null), helpSearch = useRef<ComponentRef<typeof View>>(null);
  const helpEventHosts = useRef(new Map<string, CalendarHelpHost>()), helpTargetListeners = useRef(new Set<() => void>());
  const refreshHelpTargets = useCallback(() => { for (const listener of helpTargetListeners.current) listener(); }, []);
  const registerHelpTarget = useCallback((key: string, host: CalendarHelpHost | null) => { if (host) helpEventHosts.current.set(key, host); else helpEventHosts.current.delete(key); refreshHelpTargets(); }, [refreshHelpTargets]);
  const measureHelpTargets = useCallback((done: (targets: CalendarHelpTargets) => void) => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined; let cancel = () => {};
    const measure = () => { if (stopped) return; timer = undefined; cancel(); cancel = measureCalendarHelpTargets({ add: helpAdd.current, mode: helpMode.current, search: helpSearch.current, calendar: viewportHost.current }, helpEventHosts.current, done); };
    const changed = () => { if (timer === undefined && !stopped) timer = setTimeout(measure, 16); };
    helpTargetListeners.current.add(changed); measure();
    return () => { stopped = true; clearTimeout(timer); cancel(); helpTargetListeners.current.delete(changed); };
  }, []);
  const dragDay = useRef<LocalDate | null>(null); const [activeDragDay, setActiveDragDay] = useState<LocalDate | null>(null);
  const setDragDay = useCallback((day: LocalDate | null) => { dragDay.current = day; setActiveDragDay(day); }, []);
  const moveLock = useRef(false); const [moveError, setMoveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!saveNotice) return;
    const timer = setTimeout(() => setSaveNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [saveNotice]);
  const [pendingMove, setPendingMove] = useState<{ capture: CalendarMoveCapture; row: CalendarOccurrence; settled: boolean } | null>(null);
  const [undoMove, setUndoMove] = useState<{ capture: CalendarMoveCapture; saved: CalendarEditorDraft; undoFuture?: () => Promise<void> } | null>(null);
  const [moveScopeEvent, setMoveScopeEvent] = useState<{ futureDisabled: boolean; seriesDisabled: boolean; notice?: string } | null>(null);
  const moveScopeOpen = moveScopeEvent !== null;
  const moveScopeAnswer = useRef<((scope: CalendarEditScope | null) => void) | null>(null);
  const answerMoveScope = (scope: CalendarEditScope | null) => { const answer = moveScopeAnswer.current; moveScopeAnswer.current = null; setMoveScopeEvent(null); answer?.(scope); };
  useFocusEffect(useCallback(() => () => { setSearchOpen(false); setDraftsOpen(false); setSaveNotice(null); moveScopeAnswer.current?.(null); moveScopeAnswer.current = null; setMoveScopeEvent(null); }, [setSearchOpen, setDraftsOpen, setSaveNotice]));
  useEffect(() => () => { moveScopeAnswer.current?.(null); moveScopeAnswer.current = null; setMoveScopeEvent(null); }, [local?.database, local?.shared?.groupId, timeZone]);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const [editor, setRawEditor] = useState<CalendarEditorDraft | null>(null);
  const [checkingChore, setCheckingChore] = useState(false);
  useFocusEffect(useCallback(() => { setCheckingChore(false); }, [setCheckingChore]));
  const setEditor = (draft: CalendarEditorDraft | null) => setRawEditor(draft && local?.prepareDraft ? local.prepareDraft(draft) : draft); const list = useRef<FlatList<CalendarMonthRow>>(null);
  const openNewEditor = (draft: CalendarEditorDraft) => setEditor({ ...draft, draftId: newCalendarDraftId() });
  const routeParams = useLocalSearchParams<{ calendarDraft?: string; calendarDraftVersion?: string; calendarDate?: string; calendarMinute?: string; calendarJump?: string }>();
  const returnedDraft = typeof routeParams.calendarDraft === 'string' && typeof routeParams.calendarDraftVersion === 'string'
    ? (source.drafts ?? (source.draft ? [source.draft] : [])).find(row => calendarDraftKey(row) === routeParams.calendarDraft && calendarDraftVersion(row) === routeParams.calendarDraftVersion) : undefined;
  const activeEditor = editor ?? returnedDraft;
  const calendarHelp = useCalendarHelp(!activeEditor && !searchOpen && !draftsOpen && !monthPicker && !viewMenu && !activeDragDay && !moveScopeOpen, preferences?.help);
  const closeEditor = () => { setEditor(null); if (routeParams.calendarDraft) router.setParams({ calendarDraft: undefined, calendarDraftVersion: undefined }); };
  const scroll = useAnimatedRef<FlatList<{ key: string }>>(); const timelineTop = useRef<number | null>(null); const timelineViewport = useRef(0); const positioned = useRef('');
  const detailScrollY = useScrollOffset(view === 'day' || view === 'two' || view === 'three' ? scroll : null);
  const timelineOffset = useRef(0);
  const agenda = useRef<FlatList<LocalDate>>(null);
  const searchPosition = useRef<CalendarSearchDestination | null>(null);
  const monthPositioned = useRef(''); const [target, setTarget] = useState(date);
  const monthDragged = useRef(false);
  const [browsingMonth, setBrowsingMonth] = useState(false);
  const modesTouched = useRef(false); const modeGesture = useMemo(() => createCalendarGesture(), []);
  const recenter = useRef(() => {}); const todayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const yearScroll = useRef<YearScroller | null>(null);
  const weekScroll = useRef<WeekRecenter | null>(null);
  const weekReady = useCallback((recenter: WeekRecenter | null) => { weekScroll.current = recenter; }, []);
  const yearTarget = useRef<string | null>(null);
  useEffect(() => () => { clearTimeout(todayTimer.current); clearTimeout(searchFocusTimer.current); }, []);
  const selection = useRef({ date, visibleStart, visibleEnd });
  useLayoutEffect(() => { selection.current = { date, visibleStart, visibleEnd }; }, [date, visibleStart, visibleEnd]);
  const requestedMonth = useRef<LocalDate | null>(null);
  const clock = useCalendarClock(!preview && (view === 'day' || view === 'two' || view === 'three' || view === 'week'));
  const currentMinute = preview?.currentMinute ?? pinnedClockAt(clock, timeZone).minute;
  useEffect(() => {
    const next = props.selectedDate;
    const current = selection.current;
    if (!next || next === current.date) return;
    if (next < current.visibleStart || next > current.visibleEnd) {
      positioned.current = ''; timelineTop.current = null; setDetailRangeStart(next);
    }
    setDate(next); setMonth(calendarMonth(next)); preferred.current = Number(next.slice(-2));
  }, [props.selectedDate]);
  useEffect(() => {
    if (!onMonth || month > choreThrough || busy || monthLoaded?.(month) || requestedMonth.current === month) return;
    const timer = setTimeout(() => { requestedMonth.current = month; onMonth(month); }, 180); return () => clearTimeout(timer);
  }, [month, choreThrough, busy, monthLoaded, onMonth]);
  const weeks = useMemo(() => Array.from({ length: bounds.through - bounds.from + 1 }, (_, index) => addDays(anchor, (bounds.from + index) * 7)), [anchor, bounds]);
  const range = view === 'list' ? { from: date, through: addDays(date, Math.min(listDays, 365)) }
    : { from: calendarMonth(month, -1), through: addDays(calendarMonth(month, 2), -1) };
  const requestRange = local?.requestRange; const loadRange = local?.loadRange;
  useFocusEffect(useCallback(() => { requestRange?.(range.from, range.through, { refresh: true }); void loadRange?.(range.from, range.through); }, [requestRange, loadRange, range.from, range.through]));
  const eventSources = useMemo(() => source.events.filter(event => !event.holiday), [source.events]);
  const monthEventIndex = useMemo(() => createCalendarMonthEventIndex((from, through) => {
    const candidates = visibleEventProjectionCandidates(eventSources, source.exceptions, from, through);
    return calendarTitleDisplay.occurrences(projectPrivateCalendarDisplayEvents(candidates.events, candidates.exceptions, from, through, timeZone), today, titleDisplay.value);
  }),
  [eventSources, source.exceptions, timeZone, today, titleDisplay.value]);
  const colors = useMemo(() => new Map(source.categories.map(category => [category.id, categoryColor(category.color, scheme === 'dark')])), [source.categories, scheme]);
  const appearances = useMemo(() => new Map(source.categories.map(category => [category.id, calendarEventAppearance(category.color, scheme === 'dark')])), [source.categories, scheme]);
  const fallbackAppearance = useMemo(() => calendarEventAppearance(UNCATEGORIZED_CALENDAR_CATEGORY.color, scheme === 'dark'), [scheme]);
  const availableOverlapAppearances = useMemo(() => {
    const used = new Set([...appearances.values(), fallbackAppearance].map(appearance => appearance.accent.toLowerCase()));
    return CATEGORY_PRESETS.map(color => calendarEventAppearance(color, scheme === 'dark')).filter(appearance => !used.has(appearance.accent.toLowerCase()));
  }, [appearances, fallbackAppearance, scheme]);
  const timedChoreIndex = useMemo<Map<LocalDate, CalendarOccurrence[]>>(() => indexCalendarOccurrences(timedCalendarChoreEvents(props.timedChores ?? [], timeZone), range.from, range.through), [props.timedChores, timeZone, range.from, range.through]);
  const editableEventIds = useMemo(() => new Set(source.events.filter(event => !event.readOnly).map(event => event.id)), [source.events]);
  const visibleMove = pendingMove && pendingMove.capture.database === local?.database && pendingMove.capture.groupId === local?.shared?.groupId && pendingMove.capture.timeZone === timeZone
    && !(pendingMove.settled && (source.events !== pendingMove.capture.events || source.exceptions !== pendingMove.capture.exceptions)) ? pendingMove : null;
  const movedMonthIndex = useMemo(() => {
    if (!visibleMove) return null;
    const { capture } = visibleMove;
    return createCalendarMonthEventIndex((from, through) => {
      if (capture.draft.scope === 'future' && capture.draft.anchorDate) {
        const split = splitCalendarFuture(capture.series, capture.draft.anchorDate, capture.draft.value, capture.exceptions);
        const nextId = `${capture.series.id}.future-preview`;
        const events = [...(split.past ? [{ ...split.past, id: capture.series.id, revision: capture.series.revision }] : []), { ...split.next, id: nextId, revision: 1 }];
        const exceptions = [...split.previous, ...split.following.map(row => ({ ...row, eventId: nextId }))];
        return calendarTitleDisplay.occurrences(projectPrivateCalendarDisplayEvents(events, exceptions, from, through, timeZone), today, titleDisplay.value);
      }
      if (capture.draft.scope !== 'series' || capture.series.recurrence === 'none') return calendarTitleDisplay.occurrences([visibleMove.row], today, titleDisplay.value);
      const next = { ...capture.series, ...capture.draft.value };
      const exceptions = rebasedCalendarExceptions(capture.series, next, capture.exceptions);
      return calendarTitleDisplay.occurrences(projectPrivateCalendarDisplayEvents([next], exceptions, from, through, timeZone), today, titleDisplay.value);
    });
  }, [visibleMove, timeZone, today, titleDisplay.value]);
  const eventsOn = useCallback((day: LocalDate) => {
    const rows = monthEventIndex.forDate(day);
    const ordinary = visibleMove ? [...rows.filter(row => row.eventId !== visibleMove.capture.event.eventId || visibleMove.capture.draft.scope === 'one' && row.anchorDate !== visibleMove.capture.event.anchorDate), ...movedMonthIndex?.forDate(day) ?? []] : rows;
    return view === 'day' || view === 'two' || view === 'three' || view === 'week' ? [...ordinary, ...timedChoreIndex.get(day) ?? []].sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id)) : ordinary;
  }, [monthEventIndex, visibleMove, movedMonthIndex, view, timedChoreIndex]);
  const eventErrorOn = (day: LocalDate) => monthEventIndex.errorForDate(day) ?? movedMonthIndex?.errorForDate(day) ?? null;
  const waste = useMemo(() => wasteCalendarLabels(props.wasteSchedules ?? [], range.from, range.through, props.hiddenWasteKeys), [props.wasteSchedules, props.hiddenWasteKeys, range.from, range.through]);
  const wasteKnown = (day: LocalDate) => props.wasteLoaded?.(day) !== false;
  const wasteMonthCache = useMemo(() => createCalendarMonthCache((from, through) =>
    wasteCalendarLabels(props.wasteSchedules ?? [], from, through, props.hiddenWasteKeys)), [props.wasteSchedules, props.hiddenWasteKeys]);
  const wasteForDate = (day: LocalDate) => {
    if (!wasteKnown(day)) return null;
    if (day >= range.from && day <= range.through) return waste;
    return wasteMonthCache.forDate(day);
  };
  const monthRows = useMemo(() => calendarMonthRows(weeks, rowHeight), [weeks, rowHeight]);
  const dateLabel = (day: LocalDate, dateWaste: ReturnType<typeof wasteForDate>, events: readonly CalendarOccurrence[], eventError: string | null) => {
    const info = showChores(day) ? props.dayInfo(day) : undefined; const labels = dateWaste?.byDate.get(day) ?? []; const hidden = dateWaste?.hiddenWeeklyByDate.get(day) ?? [];
    const appointments = events.filter(event => !event.holiday); const holiday = japanesePublicHoliday(day);
    return `${formatJapaneseDate(day, { year: true })}${holiday ? `、祝日：${holiday}` : ''}${info ? `、${info.accessibilityCountLabel ?? `家事${info.loaded ? `${info.total ?? info.pending ?? 0}件、未完了${info.pending ?? 0}件${info.partial ? '、一部は未取得' : ''}` : busy ? '家事は読み込み中' : '家事は未取得'}`}` : ''}${labels.length ? `、${labels.join('・')}` : ''}${hidden.length ? `、非表示の収集：${hidden.join('・')}` : ''}${eventError ? `、予定を表示できません。${eventError}` : appointments.length ? `、予定${appointments.length}件` : ''}`;
  };
  const headerWaste = wasteForDate(month)?.weeklyByColumn ?? Array.from({ length: 7 }, () => [] as string[]);
  const positionYear = useCallback(() => {
    if (!yearTarget.current || !yearScroll.current) return;
    yearScroll.current(yearTarget.current);
    yearTarget.current = null;
  }, []);
  const yearReady = useCallback((scrollToMonth: YearScroller | null) => {
    yearScroll.current = scrollToMonth;
    positionYear();
  }, [positionYear]);
  const navigateMonth = (next: LocalDate, day = preferred.current, destination: CalendarView = 'month', applyView = setView) => {
    searchPosition.current = null;
    monthDragged.current = false; setBrowsingMonth(false); monthPositioned.current = '';
    const chosen = dateInMonth(next, day); setTarget(chosen); setMonth(calendarMonth(next)); setYear(Number(next.slice(0, 4)));
    setAnchor(weekStart(chosen)); setBounds({ from: -260, through: 260 }); setDate(chosen); setDetailRangeStart(chosen);
    positioned.current = ''; timelineTop.current = null; props.onSelectDate?.(chosen); applyView(destination);
    if (destination === 'year') { yearTarget.current = next.slice(0, 7); positionYear(); }
  };
  const chooseDate = (next: LocalDate, rangeStart = next) => {
    searchPosition.current = null; setDate(next); setDetailRangeStart(rangeStart);
    preferred.current = Number(next.slice(-2)); setMonth(calendarMonth(next)); props.onSelectDate?.(next);
  };
  const focusDetailDate = (next: LocalDate) => {
    if (next === date) return;
    const inRange = next >= visibleStart && next <= visibleEnd;
    if (!inRange) { positioned.current = ''; timelineTop.current = null; }
    chooseDate(next, inRange ? visibleStart : next);
  };
  const notificationJump = useRef<string | null>(null);
  useEffect(() => {
    const { calendarJump: jump, calendarDate, calendarMinute } = routeParams;
    if (typeof jump !== 'string' || !jump || notificationJump.current === jump || typeof calendarDate !== 'string' || typeof calendarMinute !== 'string') return;
    const day = calendarDate as LocalDate;
    try { parseLocalDate(day); } catch { return; }
    const minute = calendarMinute === '' ? null : Number(calendarMinute);
    if (minute !== null && (!Number.isInteger(minute) || minute < 0 || minute >= 1440)) return;
    const delivery = setTimeout(() => {
      const detail = display.detail;
      const openDetail = () => display.openDetail(detail);
      if (date === day && view === detail) {
        // The same timeline may stay mounted and never publish another layout.
        positioned.current = '';
        openDetail();
      } else navigateMonth(calendarMonth(day), Number(day.slice(-2)), detail, openDetail);
      searchPosition.current = detail === 'list' ? null : { date: day, minute };
      clearTimeout(todayTimer.current); todayTimer.current = setTimeout(() => recenter.current(), 0);
      notificationJump.current = jump;
    }, 0);
    return () => clearTimeout(delivery);
  // A delivery is consumed once; repainting its destination must not navigate again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeParams.calendarJump, routeParams.calendarDate, routeParams.calendarMinute]);

  const chooseView = (next: CalendarView) => {
    if (next === view) return;
    searchPosition.current = null;
    setDetailRangeStart(date);
    if (view === 'month' && date.slice(0, 7) !== month.slice(0, 7)) chooseDate(dateInMonth(month, preferred.current));
    if (view === 'year') chooseDate(dateInMonth(`${year}-${month.slice(5, 7)}-01` as LocalDate, preferred.current));
    positioned.current = ''; timelineTop.current = null; setView(next);
  };
  const back = () => { if (view === 'year') props.onNavigate?.('home'); else if (view === 'month') { setYear(Number(month.slice(0, 4))); setView('year'); }
    else { monthDragged.current = false; setBrowsingMonth(false); monthPositioned.current = ''; setTarget(date); setAnchor(weekStart(date)); setBounds({ from: -260, through: 260 }); setView('month'); } };
  const horizontal = useMemo(() => createCalendarGesture(), []);
  useLayoutEffect(() => { horizontal.update({ canStart: gesture => {
    // The detail viewport uses a native horizontal recognizer so vertical native
    // lists cannot take this swipe first or deliver a second navigation.
    if (view === 'day' || view === 'two' || view === 'three' || view === 'week') return false;
    if (dragDay.current || modesTouched.current || searchOpen || draftsOpen || calendarHelp.open) return false;
    // Claim a horizontal drag before the native vertical list takes ownership;
    // committing navigation still requires the longer release threshold.
    const action = calendarSwipe(gesture.x0, gesture.dx, gesture.dy, width, 14);
    return Boolean(action && (view !== 'year' || action === 'home' || action === 'chores'));
  }, release: gesture => {
    const action = calendarSwipe(gesture.x0, gesture.dx, gesture.dy, width);
    if (action === 'home' || action === 'chores') props.onNavigate?.(action);
    else if (action === 'next' || action === 'previous') {
      const direction = action === 'next' ? 1 : -1;
      if (view === 'month') navigateMonth(calendarMonth(month, direction));
      else if (view !== 'year') { positioned.current = ''; timelineTop.current = null; chooseDate(addDays(date, direction)); }
    }
  } }); });
  const detailSwipeSession = useRef<{ date: LocalDate; rangeStart: LocalDate; view: 'day' | 'two' | 'three'; x: number } | null>(null);
  const pendingSlide = useRef<{ date: LocalDate; view: 'day' | 'two' | 'three'; direction: number } | null>(null);
  const reduceMotion = useReducedMotion();
  const slideX = useSharedValue(0);
  const detailSlide = useAnimatedStyle(() => ({ transform: [{ translateX: slideX.get() }] }));
  useLayoutEffect(() => {
    const slide = pendingSlide.current;
    pendingSlide.current = null;
    if (!slide || slide.date !== date || slide.view !== view || reduceMotion) {
      slideX.set(0);
      return;
    }
    slideX.set(slide.direction * 36);
    slideX.set(withTiming(0, { duration: 170, reduceMotion: ReduceMotion.System }));
  }, [date, view, reduceMotion, slideX]);
  const detailSwipe = usePanGesture({
    enabled: (view === 'day' || view === 'two' || view === 'three') && !activeDragDay && !activeEditor && !searchOpen && !draftsOpen && !calendarHelp.open && !monthPicker && !viewMenu && !overlap,
    activeOffsetX: [-16, 16], failOffsetY: [-14, 14], maxPointers: 1, runOnJS: true, cancelsJSResponder: true,
    onActivate: event => {
      detailSwipeSession.current = !dragDay.current && (view === 'day' || view === 'two' || view === 'three') && event.numberOfPointers === 1
        ? { date, rangeStart: visibleStart, view, x: event.x - event.translationX } : null;
    },
    onUpdate: event => { if (event.numberOfPointers !== 1) detailSwipeSession.current = null; },
    onDeactivate: event => {
      const start = detailSwipeSession.current; detailSwipeSession.current = null;
      if (!start || event.canceled || dragDay.current || start.date !== selection.current.date || start.rangeStart !== visibleStart || start.view !== view) return;
      const action = calendarSwipe(start.x, event.translationX, event.translationY, width);
      if (action === 'home' || action === 'chores') { props.onNavigate?.(action); return; }
      if (action !== 'next' && action !== 'previous') return;
      const direction = action === 'next' ? 1 : -1;
      const next = addDays(start.date, direction);
      const pane = detailPanels?.columns.find(column => column.day === start.date);
      const panelHeight = pane?.height ?? 0;
      const minute = timelineTop.current !== null && timelineViewport.current > 0
        ? Math.max(0, Math.min(1440, (timelineOffset.current + (timelineViewport.current + panelHeight) / 2
          - timelineTop.current - calendarTimelineInset(panelHeight, timelineOffset.current, hourHeight)) / hourHeight * 60)) : null;
      pendingSlide.current = { date: next, view: start.view, direction };
      positioned.current = ''; timelineTop.current = null; chooseDate(next, addDays(start.rangeStart, direction));
      if (minute !== null) searchPosition.current = { date: next, minute };
    },
    onFinalize: () => { detailSwipeSession.current = null; },
  });
  useLayoutEffect(() => { modeGesture.update({ canStart: gesture => Math.abs(gesture.dx) > 18 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
    release: gesture => {
      modesTouched.current = false; if (Math.abs(gesture.dx) < 40) return;
      const modes = ['day', 'two', 'three', 'week', 'list'] as const; const current = modes.indexOf(display.detail);
      chooseView(modes[current < 0 ? 0 : Math.max(0, Math.min(modes.length - 1, current + (gesture.dx < 0 ? 1 : -1)))]);
    } }); });
  const openEvent = (event?: CalendarOccurrence) => {
    if (moveLock.current) return;
    const eventId = event?.id; const chore = eventId && props.timedChores?.find(row => `chore-time:${row.id}` === eventId);
    if (chore) { chore.onOpen(); return; }
    if (event && preview?.onInspectEvent) { preview.onInspectEvent(event); return; }
    if (!local?.database) return;
    event = event?.original ?? event;
    const selected = event;
    const savedDraft = selected && (source.drafts ?? (source.draft ? [source.draft] : []))
      .find(draft => draft.eventId === selected.eventId && (draft.scope === 'series' || draft.anchorDate === selected.anchorDate));
    if (savedDraft) { setEditor(savedDraft); return; }
    if (event?.birthday) { setEditor({ eventId: event.eventId, anchorDate: event.anchorDate, revision: event.eventRevision, exceptionRevision: event.exceptionRevision, scope: 'series', value: source.events.find(row => row.id === event.eventId)! }); return; }
    const addDate = view === 'list' ? agendaDate : view === 'year' ? dateInMonth(`${year}-${month.slice(5, 7)}-01` as LocalDate, preferred.current)
      : date.slice(0, 7) === month.slice(0, 7) ? date : dateInMonth(month, preferred.current);
    if (event) setEditor(calendarOccurrenceDraft(event, source.events.find(row => row.id === event.eventId)?.recurrence !== 'none'));
    else openNewEditor({ eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newAppointmentValue(addDate, timeZone) });
  };
  const openSlot = (day: LocalDate, minute: number) => {
    if (!local?.database || moveLock.current) return;
    focusDetailDate(day); openNewEditor(calendarSlotDraft(day, minute, timeZone));
  };
  const canMove = (event: CalendarOccurrence, dateOnly = false) => Boolean(local?.database && !visibleMove && !event.readOnly && (dateOnly || !event.allDay) && !event.birthday && !event.holiday && !event.timeIssue && editableEventIds.has(event.eventId) && local.canEditEvent?.(event.eventId, event.anchorDate) !== false);
  const beginMove = (event: CalendarOccurrence, dateOnly = false): CalendarMoveCapture | null => {
    if (!local?.database || moveLock.current || !canMove(event, dateOnly)) return null;
    const series = source.events.find(row => row.id === event.eventId);
    if (!series) return null;
    const recurring = series.recurrence !== 'none';
    const draft = calendarOccurrenceDraft(event, recurring);
    const current = eventsOn(event.startDate).find(row => row.eventId === event.eventId && row.anchorDate === event.anchorDate);
    if (!current || JSON.stringify(calendarOccurrenceDraft(current, recurring)) !== JSON.stringify(draft)) {
      setMoveError('予定が更新されました。選び直してから移動してください。'); return null;
    }
    return { draft: local.prepareDraft?.(draft) ?? draft, event, series, database: local.database, groupId: local.shared?.groupId, timeZone,
      events: source.events, exceptions: source.exceptions };
  };
  const commitMove = async (capture: CalendarMoveCapture, target: { day: LocalDate; minute: number }) => {
    if (moveLock.current) return;
    moveLock.current = true; setMoveError(null);
    let committed = false;
    try {
      const one = calendarMovedDraft(capture.draft, target, timeZone);
      let draft = one;
      if (capture.series.recurrence !== 'none') {
        let notice: string | undefined;
        const available = (resolve: () => CalendarEditorDraft) => {
          try { return resolve(); }
          catch (cause) {
            if (!(cause instanceof CalendarMoveScopeRequiredError)) throw cause;
            notice = capture.event.exceptionRevision > 0 ? cause.message : 'この日付に移動できる範囲を選んでください。';
            return undefined;
          }
        };
        const choices = { one,
          future: isCalendarAnchor(capture.series, capture.event.anchorDate) ? available(() => calendarFutureMovedDraft(capture.draft, capture.series, target, timeZone)) : undefined,
          series: available(() => calendarSeriesMovedDraft(capture.draft, capture.series, target, timeZone)),
        };
        const scope = await new Promise<CalendarEditScope | null>(resolve => {
          moveScopeAnswer.current = resolve; setMoveScopeEvent({ futureDisabled: !choices.future, seriesDisabled: !choices.series, notice });
        });
        const selected = scope && choices[scope];
        if (!selected) return;
        draft = selected;
      }
      const currentLocal = currentContext.current.local;
      if (!currentLocal?.database || capture.database !== currentLocal.database || capture.groupId !== currentLocal.shared?.groupId || capture.timeZone !== currentContext.current.timeZone) throw new Error('表示先が変わりました。予定を選び直してください。');
      if (currentLocal.canEditEvent?.(capture.event.eventId, capture.event.anchorDate) === false) throw new Error('この予定を変更する権限がありません。');
      const row = { ...capture.event, ...moveCalendarStart(calendarEventValue(capture.event), { startDate: target.day, startMinute: target.minute }) };
      setPendingMove({ capture: { ...capture, draft }, row, settled: false });
      let result: void | import('../../platform/storage/calendar-events').CalendarFutureSave = undefined;
      if (currentLocal.saveEvent) result = await currentLocal.saveEvent(draft, false);
      else {
        if (draft.audience === 'group') throw new Error('共有予定の保存先を確認してください。');
        if (draft.scope === 'future') result = await saveCalendarFutureEvent(currentLocal.database, draft);
        else await saveCalendarEvent(currentLocal.database, { id: draft.eventId!, expectedRevision: draft.revision, value: draft.value, scope: draft.scope,
          anchorDate: draft.anchorDate ?? undefined, expectedExceptionRevision: draft.exceptionRevision });
      }
      committed = true;
      setPendingMove(previous => previous?.capture.event === capture.event ? { ...previous, settled: true } : previous);
      await currentLocal.refresh();
      clearTimeout(undoTimer.current); setUndoMove(draft.scope !== 'future' || result?.undoFuture ? { capture, saved: draft, undoFuture: result?.undoFuture } : null); undoTimer.current = setTimeout(() => setUndoMove(null), 8000);
    } catch (cause) {
      if (!committed) setPendingMove(previous => previous?.capture.event === capture.event ? null : previous);
      setMoveError(committed ? '移動は保存済みです。表示を更新できませんでした。' : cause instanceof Error ? cause.message : '予定を移動できませんでした。もう一度お試しください。');
    } finally { moveLock.current = false; }
  };
  const undoLastMove = async () => {
    const undo = undoMove; if (!undo || moveLock.current) return;
    moveLock.current = true; setMoveError(null);
    try {
      const { capture, saved } = undo;
      if (!local?.database || capture.database !== local.database || capture.groupId !== local.shared?.groupId || capture.timeZone !== timeZone) throw new Error('表示先が変わりました。');
      if (local.canEditEvent?.(saved.eventId!, saved.anchorDate) === false) throw new Error('この予定を変更する権限がありません。');
      if (undo.undoFuture) { await undo.undoFuture(); clearTimeout(undoTimer.current); setUndoMove(null); setPendingMove(null); await local.refresh(); return; }
      if (saved.scope === 'future') throw new Error('移動した予定を読み直してください。');
      const series = source.events.find(row => row.id === saved.eventId); const exception = source.exceptions.find(row => row.eventId === saved.eventId && row.anchorDate === saved.anchorDate);
      const current = saved.scope === 'one' ? exception?.override : series;
      const same = (a: CalendarEvent | import('./events').EventDraft | undefined | null, b: import('./events').EventDraft) => Boolean(a && JSON.stringify(calendarEventValue(a)) === JSON.stringify(calendarEventValue(b)));
      if (!series || !same(current, saved.value) || saved.scope === 'one' && !same(series, capture.series)) throw new Error('予定が更新されています。上書きせずに停止しました。');
      const value = saved.scope === 'one' ? capture.draft.value : calendarEventValue(capture.series);
      const base: CalendarEditorDraft = { eventId: saved.eventId, scope: saved.scope, anchorDate: saved.anchorDate, revision: series.revision, exceptionRevision: exception?.revision ?? 0, value };
      const draft = local.prepareDraft?.(base) ?? base;
      if (draft.scope === 'future') throw new Error('変更範囲を確認してください。');
      if (capture.draft.audience === 'group' && draft.audience !== 'group') throw new Error('共有予定の保存先を確認してください。');
      const removeNewException = saved.scope === 'one' && !capture.exceptions.some(row => row.eventId === saved.eventId && row.anchorDate === saved.anchorDate);
      if (removeNewException) {
        if (local.restoreOccurrence) await local.restoreOccurrence(draft);
        else if (draft.audience !== 'group') await restoreCalendarOccurrence(local.database, draft);
        else throw new Error('共有予定を読み直してください。');
      } else if (local.saveEvent) await local.saveEvent(draft, false);
      else await saveCalendarEvent(local.database, { id: draft.eventId!, expectedRevision: draft.revision, scope: draft.scope, anchorDate: draft.anchorDate ?? undefined, expectedExceptionRevision: draft.exceptionRevision, value: draft.value });
      clearTimeout(undoTimer.current); setUndoMove(null); setPendingMove(null); await local.refresh();
    } catch (cause) { setMoveError(cause instanceof Error ? cause.message : '移動を元に戻せませんでした。'); }
    finally { moveLock.current = false; }
  };
  const monthDrag = useMonthDrag<CalendarMoveCapture>({ enabled: view === 'month',
    viewport: () => monthViewport.current, offset: () => monthScrollOffset.current,
    limit: () => Math.max(0, (monthRows.at(-1)?.offset ?? 0) + (monthRows.at(-1)?.height ?? 0) + 76 - (monthViewport.current?.height ?? height)),
    resolve: (start, point) => calendarMonthDragTarget(start.event, start.day, monthRows, monthViewport.current, monthScrollOffset.current, point.x, point.y),
    scroll: offset => { monthScrollOffset.current = offset; list.current?.scrollToOffset({ offset, animated: false }); },
    begin: day => { monthDragged.current = true; setBrowsingMonth(true); setDragDay(day); }, end: () => setDragDay(null), commit: commitMove,
  });
  const dayList = useMemo(() => Array.from({ length: detailDays }, (_, i) => addDays(visibleStart, i)), [visibleStart, detailDays]);
  const weekDays = useMemo(() => view === 'week' ? calendarWeekDays(date) : [], [view, date]);
  const compactDays = view === 'week' ? weekDays : view === 'three' ? dayList : null;
  const isSummaryExpanded = (day: LocalDate) => expanded.has(day);
  const isVisibleChoreDay = (day: LocalDate) => {
    if (!isSummaryExpanded(day) || !showChores(day)) return false;
    const info = props.dayInfo(day);
    return !info.loaded || info.partial || (info.total ?? info.pending ?? 0) > 0;
  };
  const toggleSummary = (day: LocalDate) => setExpanded(before => {
    const next = new Set(before);
    if (!next.delete(day)) next.add(day);
    return next;
  });
  const choreSummaryHeight = Math.ceil((view === 'week' || view === 'three' ? 32 : 38) * Math.max(1, fontScale));
  const choreSummary = (day: LocalDate, cachedInfo?: CalendarDayInfo) => {
    if (!showChores(day)) return null;
    const info = cachedInfo ?? props.dayInfo(day);
    const count = info.total ?? info.pending ?? 0;
    const status = !info.loaded || (info.partial && count === 0) ? info.loaded ? '一部未取得' : '未取得' : null;
    return status || count > 0 ? { info, count, status } : null;
  };
  const summaryToggle = (day: LocalDate, cachedInfo?: CalendarDayInfo) => {
    const summary = choreSummary(day, cachedInfo);
    if (!summary) return null;
    const { info, count, status } = summary;
    const open = isSummaryExpanded(day);
    const weekly = view === 'week';
    return <Pressable accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の家事を${open ? '閉じる' : '開く'}`} accessibilityState={{ expanded: open }}
      accessibilityValue={{ text: status ?? `${count}件` }} onPress={() => toggleSummary(day)} style={({ pressed }) => [
        weekly ? styles.weekSummary : styles.summary, { minHeight: choreSummaryHeight },
        open && styles.compactSummarySelected,
        pressed && { backgroundColor: open ? pressColors.tinted : palette.accentSoft },
      ]}>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.8} style={weekly ? styles.weekSummaryText : styles.summaryTitle}>{status ?? `家事 ${count}件`}{!status && info.minutes && (view === 'day' || view === 'list') ? <Text style={styles.caption}> · 約{info.minutes}分</Text> : null}</Text>
      {weekly ? <SymbolView name={{ ios: open ? 'chevron.up' : 'chevron.down', android: open ? 'keyboard_arrow_up' : 'keyboard_arrow_down' }} size={7} tintColor={palette.accent} /> : <Chevron direction={open ? 'up' : 'down'} />}
    </Pressable>;
  };
  const summaryDetails = (day: LocalDate) => !showChores(day) ? null : <View>{(props.dayInfo(day).pending ?? 0) > 0 && eventsOn(day).some(event => event.allDay && !event.birthday && !event.holiday && event.blocksTime !== false)
    ? <Text style={styles.overlapNotice}>終日予定がある日の家事です</Text> : null}{isVisibleChoreDay(day) ? <View style={styles.choreList}>{props.renderChores(day, view)}</View> : null}</View>;
  const summary = (day: LocalDate, info?: CalendarDayInfo) => <View>{summaryToggle(day, info)}{summaryDetails(day)}</View>;
  const eventRow = (event: CalendarOccurrence, day: LocalDate) => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${calendarDisplayedTitle(event)}を編集`}
    accessibilityValue={{ text: `${formatJapaneseDate(day)}、${event.allDay ? '終日' : event.startDate < day ? '前日から継続' : minuteLabel(event.startMinute)}${event.location ? `、${event.location}` : ''}` }}
    accessibilityState={{ selected: searchFocus?.eventId === event.eventId && searchFocus.anchorDate === event.anchorDate && searchFocus.date === day }} onPress={() => openEvent(event)} onLayout={eventLayout => {
      const y = eventLayout.nativeEvent.layout.y; agendaEventOffsets.current.set(`${event.id}:${day}`, y);
      if (view === 'list' && searchFocus?.eventId === event.eventId && searchFocus.anchorDate === event.anchorDate && searchFocus.date === day) agenda.current?.scrollToOffset({ offset: y, animated: false });
    }} style={({ pressed }) => [styles.eventRow, (pressed || focusedEvent(event, day)) && { backgroundColor: palette.accentSoft }]}>
    <Text numberOfLines={1} style={styles.eventTime}>{event.allDay ? '終日' : event.startDate < day ? '継続' : minuteLabel(event.startMinute)}</Text><View style={[styles.eventStripe, { backgroundColor: colors.get(event.categoryId) ?? palette.muted }]} />
    <View style={styles.eventText}>
      <Text style={styles.eventTitle}>{calendarDisplayedTitle(event)}</Text>
      {event.location ? <Text style={styles.caption}>{event.location}</Text> : null}
      {event.timeIssue ? <Text style={styles.error} accessibilityLabel={`${event.timeZone}の夏時間により${event.timeIssue === 'gap' ? '存在しない' : '重複する'}時刻です。時刻を確認してください。`}>時刻要確認 · {event.timeZone}</Text> : event.original ? <Text style={styles.caption}>元の地域：{event.original.timeZone}</Text> : event.timeZone !== timeZone ? <Text style={styles.caption}>{event.timeZone}</Text> : null}</View><Chevron />
  </Pressable>;
  const dayHeading = (day: LocalDate, agenda = false, weekly = false, dateWaste = wasteForDate(day), events = eventsOn(day), eventError = eventErrorOn(day)) => {
    const announcement = dateLabel(day, dateWaste, events, eventError);
    const eventNotice = eventError ? <Text accessibilityRole="alert" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の予定を表示できません。${eventError}`} style={[weekly ? styles.weekMeta : styles.caption, { color: palette.warning }]}>{weekly ? '予定表示不可' : eventError}</Text> : null;
    const holiday = japanesePublicHoliday(day);
    const info = showChores(day) ? props.dayInfo(day) : null;
    const partial = info?.loaded && info.partial && (info.total ?? info.pending ?? 0) > 0;
    const ownBirthday = events.find(event => event.birthday && event.eventId === OWN_BIRTHDAY_EVENT_ID);
    const birthdays = events.filter(event => event.birthday && event !== ownBirthday);
    const birthdayDate = ownBirthday ? <BirthdayCalendarDate day={Number(day.slice(-2))} today={day === today} selected={day === date} /> : null;
    const collections = props.renderWaste ? props.renderWaste(day, view) : dateWaste ? <CalendarCollectionLabels narrow={weekly} compact={view !== 'day' && view !== 'list'} labels={[
      ...(dateWaste.weeklyByColumn[parseLocalDate(day).getUTCDay()] ?? []).filter(name => !dateWaste.hiddenWeeklyByDate.get(day)?.includes(name)),
      ...(dateWaste.byDate.get(day) ?? []),
    ]} /> : null;
    // The visual date can remain identical after Undo. Replace only this small
    // native text node so iOS does not retain its old accessibility description.
    if (weekly) return <View style={styles.weekHeading}>
      <Text style={styles.weekWeekday}>{weekdays[parseLocalDate(day).getUTCDay()]}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`${announcement}を選択${ownBirthday ? '、自分の誕生日' : ''}`} accessibilityState={{ selected: day === date }} disabled={Boolean(activeDragDay)} onPress={() => chooseDate(day)} style={[styles.weekDate, day === date && { backgroundColor: palette.accentSoft }, !ownBirthday && day === today && { backgroundColor: palette.accent }]}>
        {birthdayDate ?? <Text style={[styles.weekNumber, day === today ? { color: palette.accentInk } : day === date ? { color: palette.accent } : holiday && { color: palette.warning }]}>{Number(day.slice(-2))}</Text>}
      </Pressable>
      <GestureScrollView enabled={!activeDragDay} nestedScrollEnabled style={styles.weekMetadata} contentContainerStyle={styles.weekMetadataContent}>
      {eventNotice}
      {holiday ? <Text numberOfLines={1} accessibilityLabel={`祝日：${holiday}`} style={[styles.weekMeta, { color: palette.warning }]}>{holiday}</Text> : null}
      {collections}
      {birthdays.map(event => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${calendarDisplayedTitle(event)}を編集`} onPress={() => openEvent(event)}>
        <Text numberOfLines={1} style={styles.birthdayName}>{calendarDisplayedTitle(event)}</Text>
      </Pressable>)}
      </GestureScrollView>
    </View>;
    const compact = view === 'three';
    const headingColor = !agenda && day === date ? palette.accent : holiday ? palette.warning : day === today ? palette.accent : undefined;
    const headingText = <Text key={announcement} testID={agenda ? undefined : `calendar-time-heading-${day}`} accessibilityLabel={announcement} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.85} style={[styles.dayTitle, styles.dayHeadingDate, headingColor && { color: headingColor }]}>{formatJapaneseDate(day, { weekday: true }).replace(/[（(]/gu, ' ').replace(/[）)]/gu, '')}</Text>;
    const choreStatus = partial ? <Text numberOfLines={1} style={styles.dayStatus}>一部未取得</Text> : null;
    return <View style={[styles.dayHeading, agenda && styles.agendaHeading, compact && styles.compactDayHeading]}><View style={[styles.dayHeadingMain, agenda && styles.agendaHeadingMain]}>
      {agenda && ownBirthday ? <View accessible accessibilityRole="header" accessibilityLabel={`${announcement}、自分の誕生日`} style={styles.birthdayHeading}>
        <Text style={styles.dayTitle}>{Number(day.slice(5, 7))}月</Text>{birthdayDate}<Text style={styles.dayTitle}>日 {weekdays[parseLocalDate(day).getUTCDay()]}</Text>
      </View> : headingText}
      {compact ? null : choreStatus}
    </View>
    {compact ? choreStatus : null}
    {eventNotice}
    {holiday ? <Text numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={`祝日：${holiday}`} style={styles.holiday}>{holiday}</Text> : null}
    {collections}
    {birthdays.map(event => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${calendarDisplayedTitle(event)}を編集`} onPress={() => openEvent(event)} style={styles.birthdayHeading}>
      <Text numberOfLines={1} style={[styles.caption, styles.birthdayName]}>{calendarDisplayedTitle(event)}</Text>
    </Pressable>)}</View>;
  };
  const appearanceFor = (event: CalendarOccurrence) => appearances.get(event.categoryId) ?? fallbackAppearance;
  const focusedEvent = (event: CalendarOccurrence, day: LocalDate) => searchFocus?.eventId === event.eventId && searchFocus.anchorDate === event.anchorDate && searchFocus.date === day;
  const compactTimeline = view === 'three' || view === 'week';
  const y = (minute: number) => minute / 60 * hourHeight;
  const minutesAt = (height: number) => height / hourHeight * 60;
  const scale = Math.max(1, fontScale);
  const compactTitle = view === 'week' ? styles.weekTimedTitle : styles.threeTimedTitle;
  const titleHeight = compactTitle.lineHeight * scale;
  const stackedLabelHeight = Math.ceil(titleHeight) + 4;
  const stackedLabelMinutes = minutesAt(stackedLabelHeight);
  const minimumTimelineMinutes = minutesAt(compactTimeline ? Math.max(24, stackedLabelHeight)
    : Math.max(minimumEventHeight, Math.ceil(styles.timedTitle.lineHeight * scale) + 4));
  const timedDates = compactDays ?? (view === 'day' || view === 'two' ? dayList : null);
  const timeline = useMemo(() => {
    const columns = new Map<LocalDate, {
      groups: TimelineEntry[][];
      overrides: ReturnType<typeof uncategorizedOverlapAppearances>;
    }>();
    let end = timelineDayMinutes, first = Infinity;
    for (const day of timedDates ?? []) {
      const groups = timelineGroups(eventsOn(day), day, minimumTimelineMinutes, true);
      columns.set(day, { groups, overrides: uncategorizedOverlapAppearances(groups, availableOverlapAppearances) });
      for (const group of groups) for (const item of group) {
        end = Math.max(end, item.end);
        first = Math.min(first, item.start);
      }
    }
    return { columns, end, first: Number.isFinite(first) ? first : 9 * 60 };
  }, [timedDates, eventsOn, minimumTimelineMinutes, availableOverlapAppearances]);
  const timedDay = (day: LocalDate, days: readonly LocalDate[], columnWidth: number, dragColumns?: () => readonly CalendarDragColumn[]) => {
    const column = timeline.columns.get(day);
    const groups = column?.groups ?? [];
    const timedAppearance = (event: CalendarOccurrence) => column?.overrides.get(event.id) ?? appearanceFor(event);
    const withClock = (lines: 1 | 2) => minutesAt(Math.ceil(titleHeight * lines + styles.compactTime.lineHeight * scale) + 4);
    const label = (item: TimelineEntry, available: number): TimelineLabel => {
      const duration = item.end - item.start;
      if (duration < 60 || available + 1e-6 < withClock(1)) return { minutes: stackedLabelMinutes, lines: 1, clock: false };
      const lines = view === 'three' && (item.lanes === 1 || duration >= 90) && available + 1e-6 >= withClock(2) ? 2 : 1;
      return { minutes: withClock(lines), lines, clock: true };
    };
    const railBottom = (item: TimelineEntry) => compactTimeline
      ? Math.min(item.bottom, Math.max(item.end, item.start + stackedLabelMinutes)) : item.end;
    const inColumns = ({ top, bottom, lane, lanes }: { top: number; bottom: number; lane: number; lanes: number }, reserve = 0): ViewStyle => {
      const width = Math.max(0, columnWidth - reserve);
      return { top: y(top), height: y(bottom - top),
        left: reserve ? reserve + lane / lanes * width : `${lane / lanes * 100}%`,
        width: reserve ? .96 / lanes * width : `${96 / lanes}%` };
    };
    const sharesEventEdge = day === today && groups.some(group => group.some(item => item.start === currentMinute || item.end === currentMinute));
    const now = day === today ? <View testID="calendar-now-rule" pointerEvents="none"
      style={[styles.now, { top: y(currentMinute) }, sharesEventEdge && styles.nowMarkerOnly]}><View style={styles.nowDot} /></View> : null;
    const eventSurface = (item: TimelineEntry, placement: ViewStyle, stacked: boolean, selected: boolean) => {
      const appearance = timedAppearance(item.row);
      const titleTop = typeof placement.top === 'number' ? placement.top : y(item.start);
      const titleAboveStart = titleTop < y(item.start) - 1e-6;
      const durationHeight = y(item.end - item.start);
      const extendsShortOverlap = !compactTimeline && !stacked && !titleAboveStart && item.lanes > 1
        && typeof placement.height === 'number' && placement.height > durationHeight + 1;
      return {
        style: [styles.timedEvent, compactTimeline && styles.compactTimedEvent, stacked && styles.stackedTimedEvent,
          (titleAboveStart || extendsShortOverlap) && { borderLeftWidth: 0, paddingLeft: compactTimeline ? 7 : 9 }, placement,
          { borderLeftColor: appearance.accent, backgroundColor: titleAboveStart ? palette.background : appearance.backgroundColor },
          selected && styles.selectedTimeline],
        background: titleAboveStart && !stacked ? <View pointerEvents="none" testID={`calendar-duration-${item.row.id}`}
          style={[styles.timedEventDuration, {
            top: y(item.start) - titleTop, height: durationHeight,
            borderLeftColor: appearance.accent, backgroundColor: appearance.backgroundColor,
          }]} /> : extendsShortOverlap ? <View pointerEvents="none" testID={`calendar-duration-${item.row.id}`}
            style={[styles.durationRail, { top: 0, left: 0, width: 3, height: durationHeight, backgroundColor: appearance.accent }]} /> : null,
      };
    };
    const card = (item: TimelineEntry, placement: ViewStyle, content: ReactNode, stacked = false) => {
      const event = item.row;
      const selected = focusedEvent(event, day);
      const accessibleTime = `${event.startDate < day ? `${formatJapaneseDate(event.startDate)} ` : ''}${minuteLabel(event.startMinute)}〜${event.endDate > day ? `${formatJapaneseDate(event.endDate)} ` : ''}${minuteLabel(event.endMinute)}${event.timeIssue ? '、時刻要確認' : ''}`;
      const surface = eventSurface(item, placement, stacked, selected);
      return <CalendarTimedEvent helpTarget={registerHelpTarget} key={event.id} event={event} day={day} days={days} columnWidth={columnWidth} hourHeight={hourHeight}
        selected={selected} draggable={event.startDate === day && canMove(event)} accessibleTime={accessibleTime}
        onOpen={() => openEvent(event)} onBegin={() => beginMove(event)} onCommit={commitMove} onActive={setDragDay} dragColumns={dragColumns}
        style={surface.style} background={surface.background}>
        {content}
      </CalendarTimedEvent>;
    };
    const fullCard = (item: TimelineEntry, position: ViewStyle) => {
      const appearance = timedAppearance(item.row);
      const height = y(item.end - item.start);
      const endDay = item.row.endDate;
      const through = endDay === day ? '' : endDay === addDays(day, 1) ? '翌' : `${formatJapaneseDate(endDay)} `;
      return card(item, position, <>
        <Text numberOfLines={1} style={[styles.timedTitle, { color: appearance.foregroundColor }]}>{calendarDisplayedTitle(item.row)}{item.row.timeIssue ? '（時刻要確認）' : ''}</Text>
        {item.end - item.start >= 45 && height >= (typography.label.lineHeight + styles.compactTime.lineHeight) * scale + 4
          ? <Text numberOfLines={1} style={[styles.compactTime, { color: appearance.foregroundColor }]}>{minuteLabel(item.start)}〜{through}{minuteLabel(item.row.endMinute)}</Text> : null}
      </>);
    };
    const compactCard = (entries: readonly TimelineEntry[], position: ViewStyle, size: TimelineLabel, stacked = false) => {
      const [item] = entries;
      const event = item.row;
      const appearance = timedAppearance(event);
      const count = entries.length;
      const title = calendarDisplayedTitle(event);
      const clock = event.startDate === day ? minuteLabel(item.start) : event.endDate > day ? '継続' : `〜${minuteLabel(event.endMinute)}`;
      const content = <View style={styles.timedContent}>
        <View style={styles.compactTitleRow}>
          <Text numberOfLines={size.lines} style={[compactTitle, styles.compactTitle, { color: appearance.foregroundColor }]}>{title}{event.timeIssue && !size.clock ? ' !' : ''}</Text>
          {count > 1 ? <Text numberOfLines={1} style={[styles.compactTime, styles.overlapCount, { color: appearance.foregroundColor }]}>+{count - 1}</Text> : null}
        </View>
        {size.clock ? <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.85} style={[styles.compactTime, { color: event.timeIssue ? palette.warning : appearance.foregroundColor }]}>{clock}{event.timeIssue ? ' !' : ''}</Text> : null}
      </View>;
      if (count === 1) return card(item, position, content, stacked);
      const surface = eventSurface(item, position, stacked, entries.some(entry => focusedEvent(entry.row, day)));
      return <Pressable key={`overlap:${event.id}`} accessibilityRole="button"
        accessibilityLabel={`${formatJapaneseDate(day)} ${minuteLabel(item.start)}、重なった予定${count}件を開く`}
        accessibilityHint={title}
        onPress={() => setOverlap({ day, start: item.start, eventIds: entries.map(entry => entry.row.id) })}
        style={surface.style}>
        {surface.background}
        {content}
      </Pressable>;
    };
    return <>
      {local?.database ? <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の空き時間に予定を追加`} accessibilityActions={[{ name: 'activate', label: '予定を追加' }]}
        onAccessibilityTap={() => openSlot(day, 9 * 60)}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') openSlot(day, 9 * 60); }}
        onLongPress={event => {
          const minute = minutesAt(event.nativeEvent.locationY);
          if (minute < timelineDayMinutes) openSlot(day, minute);
        }} /> : null}
      {now}
      {groups.flatMap((group, index) => {
        if (!compactTimeline && group.length === 1) return [fullCard(group[0], inColumns(group[0]))];
        const blocks = compactTimelineLayout(group, groups[index + 1]?.[0].top ?? timeline.end, {
          minimumLabel: stackedLabelMinutes, gap: minutesAt(2), railBottom, label, mergeCrowdedHeads: compactTimeline,
        });
        const railBudget = compactTimeline ? view === 'week' ? 12 : 16 : Math.min(32, columnWidth * .18);
        const railStep = Math.min(compactTimeline ? 5 : 8, railBudget / group[0].lanes);
        const railWidth = Math.max(StyleSheet.hairlineWidth, Math.min(3, railStep - 2));
        const railLeft = (item: TimelineEntry) => 1 + item.lane * railStep;
        const rails = blocks.flatMap(block => block.kind === 'stacked' ? block.cards.flatMap(card => card.entries) : []);
        const rightOfRails = (top: number, bottom: number, start = 0) => rails.reduce((edge, item) =>
          item.start < bottom && railBottom(item) > top ? Math.max(edge, railLeft(item) + railWidth) : edge, start);
        const columnReserve = (cards: readonly { top: number; bottom: number }[]) => {
          const bottom = cards.reduce((end, item) => Math.max(end, item.bottom), cards[0].top);
          const edge = rightOfRails(cards[0].top, bottom);
          return edge ? edge + 2 : 0;
        };
        const combined = new Map<(typeof blocks)[number], TimelineEntry[]>();
        if (columnWidth > 0) for (const block of blocks) {
          if (block.kind !== 'columns' || block.cards[0].lanes < 2) continue;
          const width = .96 * (columnWidth - columnReserve(block.cards)) / block.cards[0].lanes;
          const minimumWidth = compactTimeline ? 11 + compactTitle.fontSize * scale * 2.25 : 12 + styles.timedTitle.fontSize * scale * 3;
          if (width >= minimumWidth) continue;
          // Leave readable names at their normal size. The existing overlap list
          // exposes every occurrence, and the rails still start at their own times.
          combined.set(block, block.cards.flatMap(card => card.entries)
            .sort((a, b) => a.start - b.start || a.row.id.localeCompare(b.row.id)));
        }
        for (const entries of combined.values()) rails.push(...entries);
        const stackedCard = ({ entries, top, size }: { entries: readonly TimelineEntry[]; top: number; size: TimelineLabel }) => {
          const cardLeft = railLeft(entries[0]) + railWidth;
          const paddingLeft = rightOfRails(top, top + size.minutes, cardLeft) - cardLeft + 4;
          return compactCard(entries, { top: y(top), height: y(size.minutes), left: cardLeft,
            width: Math.max(0, columnWidth - cardLeft - 2), paddingLeft }, size, true);
        };
        return [
          ...blocks.flatMap(block => {
            if (block.kind === 'columns') {
              const entries = combined.get(block);
              if (entries) {
                const [item] = entries;
                return stackedCard({ entries, top: item.top, size: label(item, railBottom(item) - item.top) });
              }
              const reserve = columnReserve(block.cards);
              return block.cards.map(item => {
                const position = inColumns(item, reserve);
                return !compactTimeline && item.entries.length === 1
                  ? fullCard(item.entries[0], position) : compactCard(item.entries, position, label(item.entries[0], item.bottom - item.top));
              });
            }
            return block.cards.map(stackedCard);
          }),
          ...rails.map(item => {
            const position = { top: y(item.start), height: y(railBottom(item) - item.start), left: railLeft(item) };
            const identity = `calendar-duration-${item.row.id}`;
            const stroke = { width: railWidth, backgroundColor: timedAppearance(item.row).accent };
            return compactTimeline ? <View key={identity} pointerEvents="none" testID={identity}
              style={[styles.durationRail, position, stroke]} />
              : <Pressable key={identity} testID={identity} accessible={false} importantForAccessibility="no"
                style={[styles.durationRail, position, { width: railWidth }]} onPress={() => openEvent(item.row)}>
                <View pointerEvents="none" style={[styles.durationRail, { top: 0, bottom: 0, left: 0 }, stroke]} />
              </Pressable>;
          }),
        ];
      })}
    </>;
  };
  const allDayLanes = useMemo(() => timedDates ? compactAllDayLanes(timedDates, eventsOn) : [], [timedDates, eventsOn]);
  const allDayRowHeight = Math.ceil(typography.caption.lineHeight * Math.max(1, fontScale) + 12);
  const isAllDaySelected = (event: CalendarOccurrence) => searchFocus ? focusedEvent(event, searchFocus.date) : false;
  const layoutPanels = (days: readonly LocalDate[], bodyHeight: number) => {
    const band = compactAllDayBand(allDayLanes, bodyHeight, allDayRowHeight, (heightLimit, scrollable) => <CompactAllDay
      days={days} lanes={allDayLanes} rowHeight={allDayRowHeight} heightLimit={heightLimit} scrollable={scrollable}
      dragging={Boolean(activeDragDay)} simultaneousWith={view === 'week' ? undefined : detailSwipe}
      appearanceFor={appearanceFor} isSelected={isAllDaySelected} onOpen={openEvent} />);
    return layoutCalendarDayPanels(days, bodyHeight, band, day => isVisibleChoreDay(day)
      ? choreContentHeights[`${view}:${day}`] ?? Infinity : 0, day => choreSummary(day) ? choreSummaryHeight : 0);
  };
  const renderChorePanel = (day: LocalDate, height: number) => {
    const key = `${view}:${day}`;
    return <CalendarChoreScroll day={day} height={height} contentHeight={choreContentHeights[key]} enabled={!activeDragDay}
      simultaneousWith={view === 'week' ? undefined : detailSwipe}
      onHeight={measured => setChoreContentHeights(before => before[key] === measured ? before : { ...before, [key]: measured })}>
      {props.renderChores(day, view)}
    </CalendarChoreScroll>;
  };
  const detailPanels = view === 'day' || view === 'two' || view === 'three' ? layoutPanels(dayList, Math.max(0, height - dayHeadingHeight)) : null;
  const detailDragColumns = () => (detailPanels?.columns ?? []).map(({ height }) =>
    calendarDragColumn(height, timelineOffset.current, timelineTop.current ?? timelineTopPadding, hourHeight));
  const positionTime = () => {
    const key = `${view}:${visibleStart}`; if (positioned.current === key || timelineTop.current === null || timelineViewport.current <= 0) return;
    positioned.current = key;
    const selected = searchPosition.current; searchPosition.current = null;
    if (selected?.date === date && selected.minute === null) {
      scroll.current?.scrollToOffset({ offset: 0, animated: false }); return;
    }
    const minute = selected?.date === date && selected.minute !== null ? selected.minute : dayList.includes(today) ? currentMinute : timeline.first;
    const pane = detailPanels?.columns.find(column => column.day === (selected?.date ?? (dayList.includes(today) ? today : date)));
    const offset = calendarTimelineOffset(minute, timelineViewport.current, pane?.height ?? 0, timelineTop.current, hourHeight);
    scroll.current?.scrollToOffset({ offset, animated: false });
  };
  const goToday = () => {
    searchPosition.current = null;
    preferred.current = Number(today.slice(-2)); monthDragged.current = false; setBrowsingMonth(false); monthPositioned.current = ''; positioned.current = '';
    if (visibleStart !== today) timelineTop.current = null;
    setTarget(today); setDate(today); setDetailRangeStart(today); setMonth(calendarMonth(today)); setYear(Number(today.slice(0, 4)));
    setAnchor(weekStart(today)); setBounds({ from: -260, through: 260 }); props.onSelectDate?.(today);
    if (view === 'year') yearTarget.current = today.slice(0, 7);
    clearTimeout(todayTimer.current); todayTimer.current = setTimeout(() => recenter.current(), 0);
  };
  // Offsets can still describe the previous row height while native layout is
  // changing (notices/rotation). Actual visible identities remain authoritative.
  const weekViewability = useMemo(() => ({ itemVisiblePercentThreshold: 50, minimumViewTime: 60 }), []);
  const visibleWeeksChanged = useCallback<NonNullable<FlatListProps<CalendarMonthRow>['onViewableItemsChanged']>>(({ viewableItems }) => {
    // Editor dismissal, keyboard resizing and initial positioning can deliver
    // stale native rows. Explicit navigation owns its month until a user drags.
    if (!monthDragged.current) return;
    const visible = viewableItems.filter(item => item.isViewable && item.index !== null).sort((a, b) => a.index! - b.index!);
    if (!visible.length) return;
    const next = visible[Math.floor((visible.length - 1) / 2)].item.month;
    setMonth(next); setYear(Number(next.slice(0, 4)));
  }, []);
  const positionMonth = () => {
    // Native maintainVisibleContentPosition owns layout changes after browsing.
    // A notice/resize must not pull the user back to the original target date.
    if (monthDragged.current) return;
    const row = monthRows[calendarRowForDate(monthRows, target)];
    if (!row) return;
    const key = `${anchor}:${row.offset}:${row.height}:${height}`; if (monthPositioned.current === key) return;
    monthPositioned.current = key;
    const first = calendarRowForDate(monthRows, `${target.slice(0, 7)}-01` as LocalDate);
    const visibleRows = Math.max(1, Math.floor(height / rowHeight));
    const start = Math.max(first, calendarRowForDate(monthRows, target) - visibleRows + 1);
    monthScrollOffset.current = Math.max(0, monthRows[start]?.offset ?? row.offset);
    list.current?.scrollToOffset({ offset: monthScrollOffset.current, animated: false });
  };
  useLayoutEffect(() => { recenter.current = () => { if (view === 'month') positionMonth(); else if (view === 'year') positionYear(); else if (view === 'day' || view === 'two' || view === 'three') positionTime(); else if (view === 'week') { const selected = searchPosition.current; searchPosition.current = null; weekScroll.current?.(selected?.minute); } else if (view === 'list') {
      const match = searchFocus?.date === date ? eventsOn(date).find(event => event.eventId === searchFocus.eventId && event.anchorDate === searchFocus.anchorDate && (searchFocus.minute === null || event.startMinute === searchFocus.minute)) : undefined;
      agenda.current?.scrollToOffset({ offset: match ? agendaEventOffsets.current.get(`${match.id}:${date}`) ?? 0 : 0, animated: false });
    } }; });
  const renderWeek = ({ item }: { item: CalendarMonthRow }) => <View style={{ height: item.height }}>
    {item.monthStartColumn !== null ? <View style={styles.monthBoundary}>
      <Text accessibilityRole="header" style={styles.monthBoundaryTitle}>{Number(item.month.slice(5, 7))}月</Text>
    </View> : null}
    <View style={[styles.week, item.monthStartColumn !== null && styles.monthFirstWeek, { height: item.height - (item.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT) }]}>{item.days.map((day, column) => {
    if (!day) return <View key={`empty:${column}`} pointerEvents="none" style={styles.monthColumn} />;
    const info = showChores(day) ? props.dayInfo(day) : undefined; const dailyEvents = eventsOn(day); const eventError = eventErrorOn(day); const dateWaste = wasteForDate(day); const labels = dateWaste?.byDate.get(day) ?? []; const hidden = dateWaste?.hiddenWeeklyByDate.get(day) ?? [];
    const total = info?.total ?? info?.pending ?? 0;
    const hasSummary = Boolean(info && (!info.loaded || total > 0 || info.partial));
    const ownBirthday = dailyEvents.some(event => event.eventId === OWN_BIRTHDAY_EVENT_ID && event.birthday);
    const holiday = japanesePublicHoliday(day); const ordinaryEvents = dailyEvents.filter(event => !event.holiday && !(event.eventId === OWN_BIRTHDAY_EVENT_ID && event.birthday));
    const openDay = () => { chooseDate(day); positioned.current = ''; timelineTop.current = null; setView(display.detail); };
    return <View key={day} style={[styles.monthColumn, styles.dayCell, (column === 0 || item.days[column - 1] === null) && styles.firstDayCell, hidden.length > 0 && styles.hiddenDay, activeDragDay === day && { zIndex: 1, overflow: 'visible' }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${dateLabel(day, dateWaste, dailyEvents, eventError)}${ownBirthday ? '、自分の誕生日' : ''}`}
        accessibilityState={{ selected: day === date }} onPress={openDay} style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={styles.dayNumberRow}>{ownBirthday
        ? <BirthdayCalendarDate day={Number(day.slice(-2))} today={day === today} selected={day === date} />
        : <View style={[styles.dayNumberBadge, day === today ? styles.todayBadge : day === date && styles.selectedBadge]}>
          <Text style={[styles.dayNumber, holiday && { color: palette.warning },
            day === today ? styles.todayNumber : day === date && styles.selectedNumber]}>{Number(day.slice(-2))}</Text>
        </View>}</View>
      <CalendarMonthEvents events={ordinaryEvents} day={day} height={item.height - (item.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT)}
        summary={hasSummary} wasteLabel={labels[0]} eventError={Boolean(eventError)} width={width} fontScale={fontScale} framed={hidden.length > 0}
        detail={monthDetail.value} appearances={appearances} fallbackAppearance={fallbackAppearance} dark={scheme === 'dark'}
        drag={{ helpTarget: registerHelpTarget, canMove: event => canMove(event, true), onBegin: event => beginMove(event, true), onCommit: commitMove,
          activeId: monthDrag.activeId, prepare: monthDrag.prepare, onOpen: openDay }} />
      {hasSummary ? info?.loaded ? <View pointerEvents="none" style={styles.monthCount}><Text numberOfLines={1} adjustsFontSizeToFit style={styles.monthCountText}>{total > 0 ? <>家事 <Text style={styles.monthCountNumber}>{total}</Text>件{info.partial ? '+' : ''}</> : '一部未取得'}</Text></View>
        : <Text pointerEvents="none" numberOfLines={1} style={[styles.caption, styles.monthCountText, { marginTop: 'auto' }]}>{busy ? '読込中' : '未取得'}</Text> : null}
      {hidden.length > 0 ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.hiddenOutline]} /> : null}
    </View>;
  })}</View></View>;
  const headerMonth = view === 'list' ? calendarMonth(agendaDate) : month;
  const titleLabel = view === 'year' ? `${year}年` : `${Number(headerMonth.slice(0, 4))}年${Number(headerMonth.slice(5, 7))}月`;
  const overview = view === 'month' || view === 'year';
  const modeLabel = view === 'month' ? '月' : view === 'year' ? '年' : CALENDAR_DETAIL_LABELS[view];
  const Search = preview ? CalendarSearchContent : CalendarSearch;
  const yearBody = <CalendarYear initialYear={year} today={today} editorOpen={Boolean(activeEditor)} onMonth={next => navigateMonth(next)} onYear={setYear} onReady={yearReady} />;
  const drafts = source.drafts ?? (source.draft ? [source.draft] : []);
  const auxiliaryOpen = searchOpen || draftsOpen || calendarHelp.open || moveScopeOpen || Boolean(overlap);
  const calendarActions = <View pointerEvents="box-none" style={styles.todayDock}>
      <Pressable accessibilityRole="button" accessibilityLabel="今日" onPress={goToday} style={({ pressed }) => [styles.todayAction, pressed && styles.accentPressed]}><Text style={styles.todayActionText}>今日</Text></Pressable>
      {undoMove && undoMove.capture.database === local?.database && undoMove.capture.groupId === local?.shared?.groupId ? <Pressable accessibilityRole="button" accessibilityLabel="移動を元に戻す" onPress={() => void undoLastMove()} style={({ pressed }) => [styles.todayAction, pressed && styles.accentPressed]}><Text style={[styles.caption, { color: palette.accent }]}>元に戻す</Text></Pressable> : null}
      <View ref={helpSearch} style={styles.searchHelpGroup}>
        <Pressable accessibilityRole="button" accessibilityLabel="予定を検索する" disabled={!canSearch} onPress={() => setSearchOpen(true)} style={({ pressed }) => [styles.searchHelpControl, canSearch ? pressed && styles.accentPressed : styles.actionDisabled]}><SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={20} tintColor={palette.accent} /></Pressable>
        <View style={styles.searchHelpDivider} />
        <Pressable accessibilityRole="button" accessibilityLabel="カレンダーのヘルプを開く" onPress={calendarHelp.show} style={({ pressed }) => [styles.searchHelpControl, pressed && styles.accentPressed]}><SymbolView name={{ ios: 'questionmark', android: 'question_mark' }} size={20} tintColor={palette.accent} /></Pressable>
      </View>
  </View>;
  return <View style={styles.root} {...horizontal.panHandlers}>
    <View style={{ flex: 1, overflow: 'hidden' }}><View style={{ flex: 1 }} accessibilityElementsHidden={auxiliaryOpen} importantForAccessibility={auxiliaryOpen ? 'no-hide-descendants' : 'auto'} pointerEvents={auxiliaryOpen ? 'none' : 'auto'}>
    <View style={styles.header}><View style={styles.headerBack}><BackButton accessibilityLabel={preview?.onExit ? 'UI確認用データ一覧へ戻る' : view === 'month' ? '年表示に戻る' : view === 'year' ? 'ホームに戻る' : '月表示に戻る'} onPress={preview?.onExit ?? back} /></View>
      <Pressable accessibilityRole="button" accessibilityLabel="表示する年と月を選択" accessibilityValue={{ text: titleLabel }} accessibilityState={{ expanded: monthPicker }} onPress={() => setMonthPicker(true)}
        style={({ pressed }) => [styles.titleBlock, pressed && styles.accentPressed]}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.7} style={styles.title}>{titleLabel}</Text></Pressable>
      <View style={styles.headerActions}>
      <View testID="calendar-view-modes" onTouchStart={() => { modesTouched.current = true; }} onTouchEnd={() => { modesTouched.current = false; }} onTouchCancel={() => { modesTouched.current = false; }} {...modeGesture.panHandlers}>
        <Pressable accessibilityRole="button" ref={helpMode} accessibilityLabel="カレンダーの表示を選択" accessibilityValue={{ text: overview ? `${modeLabel}表示` : modeLabel }} accessibilityState={{ expanded: viewMenu }} onPress={() => setViewMenu(true)} style={({ pressed }) => [styles.viewChoice, { width: Math.ceil(68 * Math.max(1, fontScale)) }, pressed && styles.accentPressed]}>
          <Text style={styles.modeText}>{modeLabel}</Text><SymbolView name={{ ios: 'chevron.down', android: 'keyboard_arrow_down' }} size={11} tintColor={palette.accent} />
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" ref={helpAdd} accessibilityLabel="予定を追加" disabled={!local?.database} onPress={() => openEvent()}
        style={({ pressed }) => [styles.add, local?.database ? pressed && { backgroundColor: pressColors.tinted } : styles.actionDisabled]}><SymbolView name={{ ios: 'plus', android: 'add' }} size={23} tintColor={palette.accent} /></Pressable>
      </View>
    </View>
    {props.notice}
    {view === 'day' || view === 'two' || view === 'three'
      ? <CalendarDateStrip date={date} rangeStart={visibleStart} today={today} days={detailDays} onSelect={focusDetailDate}
        isOwnBirthday={day => monthEventIndex.forDate(day).some(event => event.birthday && event.eventId === OWN_BIRTHDAY_EVENT_ID)} /> : null}
    {display.error ? <Text accessibilityRole="alert" style={styles.error}>{display.error}</Text> : null}
    {moveError || local?.error || source.draftError ? <View style={styles.errorRow}><Text accessibilityRole="alert" style={styles.error}>{moveError ?? local?.error ?? source.draftError}</Text>{moveError ? <AppButton title="閉じる" variant="quiet" compact onPress={() => setMoveError(null)} /> : local?.error ? <AppButton title="予定を再読込" variant="quiet" compact onPress={() => void local.refresh()} /> : null}</View> : null}
    {view === 'list' && local?.loading && !local.error ? <Text accessibilityRole="progressbar" accessibilityLiveRegion="polite" style={styles.loadingAgenda}>予定を読み込み中…</Text> : null}
    {saveNotice ? <View style={styles.errorRow}><Text accessibilityLiveRegion="polite" style={styles.caption}>{saveNotice}</Text></View> : null}
    {source.draft && !activeEditor ? <Pressable accessibilityRole="button" accessibilityLabel="入力中の予定を再開" onPress={() => { if (drafts.length > 1) setDraftsOpen(true); else setEditor(source.draft); }} style={styles.resume}><Text style={styles.caption}>下書きを再開{drafts.length > 1 ? `（${drafts.length}件）` : ''}</Text><Chevron /></Pressable> : null}
    {view === 'month' ? <View style={styles.weekdays}>{weekdays.map((label, i) => <View key={label} style={styles.weekdayCell}><Text style={styles.weekday}>{label}</Text>
      <View style={styles.weeklyLabels} accessibilityLabel={`${label}曜日${headerWaste[i].length ? `、${headerWaste[i].join('・')}` : ''}`}>
        <CalendarCollectionLabels labels={headerWaste[i]} narrow size={13} textStyle={styles.gridWasteText} /></View>
    </View>)}</View> : null}
    <GestureHandlerRootView style={styles.viewport}><GestureDetector gesture={view === 'day' || view === 'two' || view === 'three' ? detailSwipe : monthDrag.gesture}>
    <View ref={viewportHost} testID="calendar-viewport" style={styles.viewport} onLayout={event => {
      const next = Math.round(event.nativeEvent.layout.height); if (next > 100) setHeight(next); refreshHelpTargets();
      const target = viewportHost.current ?? event.currentTarget;
      if (target && typeof target !== 'number') target.measureInWindow((x, y, width, height) => { monthViewport.current = { x, y, width, height }; });
    }}>
      {view === 'year' ? yearBody : view === 'month' ? <FlatList key={anchor} ref={list} testID="calendar-weeks" data={monthRows} renderItem={renderWeek} keyExtractor={row => row.id}
        scrollEnabled={!activeDragDay}
        onScroll={event => { monthScrollOffset.current = event.nativeEvent.contentOffset.y; monthDrag.observedScroll(); refreshHelpTargets(); }} scrollEventThrottle={16}
        initialScrollIndex={Math.max(0, calendarRowForDate(monthRows, target) - 2)} initialNumToRender={9} maxToRenderPerBatch={8} windowSize={7}
        getItemLayout={(_data, index) => ({ length: monthRows[index].height, offset: monthRows[index].offset, index })}
        onLayout={positionMonth} onContentSizeChange={positionMonth}
        onScrollBeginDrag={() => { monthDragged.current = true; setBrowsingMonth(true); }}
        maintainVisibleContentPosition={browsingMonth ? { minIndexForVisible: 0 } : undefined} viewabilityConfig={weekViewability} onViewableItemsChanged={visibleWeeksChanged}
        onStartReached={() => setBounds(before => ({ ...before, from: Math.max(-20_000, before.from - 52) }))} onStartReachedThreshold={.5}
        onEndReached={() => setBounds(before => ({ ...before, through: Math.min(20_000, before.through + 52) }))} onEndReachedThreshold={.5}
        accessibilityLabel="月カレンダー" accessibilityActions={[{ name: 'increment', label: '次の月' }, { name: 'decrement', label: '前の月' }]}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'increment' || event.nativeEvent.actionName === 'decrement') navigateMonth(calendarMonth(month, event.nativeEvent.actionName === 'increment' ? 1 : -1)); }}
        onScrollToIndexFailed={() => { if (!monthDragged.current) list.current?.scrollToOffset({ offset: monthRows[Math.max(0, calendarRowForDate(monthRows, target) - 2)]?.offset ?? 0, animated: false }); }}
        contentContainerStyle={styles.dockedBody}
      /> : view === 'list' ? <FlatList ref={agenda} key={`agenda:${date}`} testID="calendar-agenda" contentContainerStyle={styles.dockedBody} data={Array.from({ length: Math.min(listDays, 365) }, (_, i) => addDays(date, i))} keyExtractor={day => day} initialNumToRender={7}
        viewabilityConfig={agendaViewability} onViewableItemsChanged={visibleAgendaChanged}
        onEndReached={() => setListDays(n => Math.min(365, n + 28))} renderItem={({ item: day }) => {
          const info = showChores(day) ? props.dayInfo(day) : undefined;
          const events = eventsOn(day); const projectionError = eventErrorOn(day);
          const dateWaste = wasteForDate(day);
          const empty = !local?.loading && Boolean(dateWaste) && !japanesePublicHoliday(day) && !(dateWaste?.weeklyByColumn[parseLocalDate(day).getUTCDay()] ?? []).some(name => !dateWaste?.hiddenWeeklyByDate.get(day)?.includes(name)) && !(dateWaste?.byDate.get(day)?.length) && !events.length && (info?.total ?? info?.pending ?? 0) === 0 && info?.loaded !== false && !info?.partial && !local?.error && !projectionError;
          return empty ? (
            <View style={[styles.agendaDay, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, minHeight: 44, gap: 8 }]}>
              <Text style={styles.caption}>{formatJapaneseDate(day, { weekday: true })}</Text><Text style={styles.caption}>予定なし</Text>
            </View>
          ) : (
            <View style={styles.agendaDay}>{dayHeading(day, true, false, dateWaste, events, projectionError)}{summary(day, info)}
              {events.filter(event => !event.birthday && !event.holiday).map(event => eventRow(event, day))}
              {!events.length && (info?.total ?? info?.pending ?? 0) === 0 && local?.error && !projectionError ? <Text style={styles.empty}>予定を取得できていません</Text> : null}</View>
          );
        }} />
        : view === 'week' ? <CalendarWeek date={date} height={height} currentMinute={weekStart(date) === weekStart(today) ? currentMinute : null}
          defaultMinute={timeline.first} endMinute={timeline.end}
          dragging={Boolean(activeDragDay)} activeDay={activeDragDay} hourHeight={hourHeight} onSelect={chooseDate} onReady={weekReady} onScroll={refreshHelpTargets}
          renderHeading={day => dayHeading(day, false, true)}
          layoutPanels={layoutPanels} renderChores={renderChorePanel} renderSummary={summaryToggle} renderDay={timedDay} />
        : <View style={styles.detailClip}><Animated.View style={[styles.viewport, detailSlide]}><View testID="calendar-fixed-day-heading" onLayout={event => setDayHeadingHeight(event.nativeEvent.layout.height)} style={[styles.dayColumns, styles.fixedDayHeader, (view === 'two' || view === 'three') && styles.alignedDayColumns]}>{dayList.map(day => <View key={day} style={[styles.dayColumn, styles.headingColumn]}>{dayHeading(day)}</View>)}</View>
          <View style={styles.timelineScroll}>
          {detailPanels ? <CalendarDayPanels layout={detailPanels} gutter={timeGutter + 1} dragging={Boolean(activeDragDay)} renderChores={renderChorePanel} renderSummary={summaryToggle} /> : null}
          <GestureFlatList key={`timeline:${view}:${visibleStart}`} ref={scroll} simultaneousWith={detailSwipe} disallowInterruption={false} enabled={!activeDragDay} scrollEnabled={!activeDragDay} style={styles.timelineScroll} testID="calendar-timeline" data={[{ key: 'top' }, { key: 'timeline' }]} keyExtractor={item => item.key} initialNumToRender={2}
          onScroll={event => { timelineOffset.current = event.nativeEvent.contentOffset.y; refreshHelpTargets(); }} scrollEventThrottle={16}
          onLayout={event => { timelineViewport.current = event.nativeEvent.layout.height; positionTime(); }} onContentSizeChange={positionTime} contentContainerStyle={styles.timelineBody} renderItem={({ item: section }) => section.key === 'top' ?
          <View testID="calendar-timeline-days" onLayout={event => {
            timelineTop.current = event.nativeEvent.layout.height + timelineTopPadding; setTimeout(positionTime, 0);
          }} />
          : <View style={[styles.timeline, { height: y(timeline.end) + 15 }]}>
            <CalendarTimelineShift panelHeight={detailPanels?.firstVisibleClock ?? 0} hourHeight={hourHeight} scrollOffset={detailScrollY} style={styles.clockGutter} decorative>
              {timelineHours.map(hour => <View key={hour} testID={`calendar-hour-${hour}`} style={[styles.hour, { top: hour * hourHeight }]}><Text style={styles.hourLabel}>{String(hour).padStart(2, '0')}:00</Text></View>)}
            </CalendarTimelineShift>
            <View style={styles.timelineColumns} onLayout={event => setTimelineWidth(event.nativeEvent.layout.width)}>{(detailPanels?.columns ?? []).map(({ day, height }) =>
              <View key={day} style={[styles.timelineColumn, activeDragDay === day && { zIndex: 1 }]}>
                <CalendarTimelineShift testID={`calendar-detail-time:${day}`} panelHeight={height} hourHeight={hourHeight} scrollOffset={detailScrollY} style={styles.timelineScroll}>
                  {timelineHours.map(hour => <View key={hour} testID={hour === 24 ? `calendar-midnight-rule:${day}` : undefined}
                    pointerEvents="none" style={[styles.hourRule, { top: hour * hourHeight }]} />)}
                  {timedDay(day, dayList, timelineWidth / dayList.length, detailDragColumns)}
                  {!compactTimeline && day === today ? <Text testID="calendar-now-clock" pointerEvents="none" numberOfLines={1} maxFontSizeMultiplier={1.3}
                    accessibilityLabel={`現在 ${minuteLabel(currentMinute)}`} style={[styles.nowLabel, { top: y(currentMinute) - 8 }]}>{minuteLabel(currentMinute)}</Text> : null}
                </CalendarTimelineShift>
              </View>)}</View>
          </View>} />
          </View></Animated.View></View>}
      {calendarActions}
      {view === 'month' ? monthDrag.overlay : null}
    </View>
    </GestureDetector></GestureHandlerRootView>
    </View>
    {moveScopeEvent ? <CalendarRecurrenceScopePicker {...moveScopeEvent} onSelect={answerMoveScope} onClose={() => answerMoveScope(null)} /> : null}
    {calendarHelp.open ? <CalendarHelp onClose={calendarHelp.close} onShow={calendarHelp.onShow} view={view} measureTargets={measureHelpTargets} /> : null}
    {overlap ? <CalendarOverlapSheet day={overlap.day} events={eventsOn(overlap.day).filter(event => overlap.eventIds.includes(event.id))}
      onClose={() => setOverlap(null)} onOpen={event => { setOverlap(null); openEvent(event); }}
      onShowDay={view === 'day' ? undefined : () => {
        setOverlap(null); chooseView('day'); chooseDate(overlap.day);
        searchPosition.current = { date: overlap.day, minute: overlap.start };
      }} /> : null}
    {searchOpen && local ? <Search local={local} focusDate={today} displayTimeZone={timeZone} shortenTitles={titleDisplay.value} chores={searchChores} choresIncomplete={props.searchChoresIncomplete} onClose={() => setSearchOpen(false)} resolveSelection={(draft, events, exceptions) => {
      const destination = calendarSearchDestination(draft, events, exceptions, today, timeZone);
      setSearchFocus({ eventId: draft.eventId, ...destination }); return destination;
    }} onSelect={destination => {
      setSearchOpen(false);
      if (destination.choreKey) {
        setSearchFocus({ ...destination, eventId: destination.timedChoreId ?? null, anchorDate: destination.date });
        if (!destination.timedChoreId || display.detail === 'list') setExpanded(before => new Set([...before].filter(day => day !== destination.date).concat(destination.date)));
      }
      clearTimeout(searchFocusTimer.current); searchFocusTimer.current = setTimeout(() => setSearchFocus(null), 2500); preferred.current = Number(destination.date.slice(-2));
      if (date === destination.date && view === display.detail && (view === 'day' || view === 'two' || view === 'three' || view === 'week')) positioned.current = '';
      else navigateMonth(calendarMonth(destination.date), preferred.current, display.detail);
      searchPosition.current = display.detail === 'list' ? null : destination;
      clearTimeout(todayTimer.current); todayTimer.current = setTimeout(() => recenter.current(), 0);
    }} /> : null}
    {draftsOpen && local ? <View style={StyleSheet.absoluteFill}><CalendarDraftList drafts={drafts} local={local} onClose={() => setDraftsOpen(false)} onSelect={draft => { setDraftsOpen(false); setEditor(draft); }} /></View> : null}
    </View>{props.footer}
    {viewMenu ? <CalendarViewMenu value={display.detail} overview={overview} {...(view === 'month' ? { monthDetail: monthDetail.value, onMonthDetail: monthDetail.select } : {})} titleShortening={titleDisplay.value} onTitleShortening={titleDisplay.select} onSelect={chooseView} onClose={() => setViewMenu(false)} /> : null}
    {monthPicker ? <CalendarMonthPicker month={view === 'year' ? `${year}-${month.slice(5, 7)}-01` as LocalDate : headerMonth}
      onSelect={next => navigateMonth(next, preferred.current, view)} onClose={() => setMonthPicker(false)} /> : null}
    {activeEditor && local ? <CalendarEditor key={`${calendarDraftKey(activeEditor)}:${activeEditor.anchorDate ?? ''}:${returnedDraft ? routeParams.calendarDraftVersion : ''}`} initial={activeEditor} local={local} chores={props.existingChores} onDuplicate={openNewEditor} renderChoreRegistration={sheet => sheet.audience === 'group' && props.renderChoreRegistration ? props.renderChoreRegistration(sheet) : <PersonalCalendarChoreRegistration {...sheet} local={local} />} repeatReturnTo={props.repeatReturnTo} displayTimeZone={timeZone} onClose={closeEditor}
      hiddenForChore={checkingChore} onPreviewChore={open => { setCheckingChore(true); open(); }} onSaved={(day, notice, keepDateRange) => {
      setSaveNotice(notice ?? null);
      closeEditor();
      if (view === 'month' || view === 'year') navigateMonth(calendarMonth(day), Number(day.slice(-2)));
      else if (!keepDateRange || view === 'list') focusDetailDate(day);
    }} /> : null}
  </View>;
}

export function CalendarFooter({ onNavigate }: { onNavigate: NonNullable<PlannerCalendarProps['onNavigate']> }) {
  const styles = usePlannerBorderStyles(baseStyles);
  const insets = useSafeAreaInsets();
  const tabs = [['home', 'ホーム', { ios: 'house', android: 'house' }], ['calendar', 'カレンダー', { ios: 'calendar', android: 'calendar_month' }],
    ['chores', '家事', { ios: 'checklist', android: 'checklist' }], ['appliances', '家電', { ios: 'robotic.vacuum', android: 'vacuum' }]] as const;
  return <View style={[styles.footer, { paddingBottom: Math.max(8, insets.bottom) }]}>{tabs.map(([tab, label, icon]) => <Pressable key={tab} accessibilityRole="button" accessibilityLabel={`${label}へ`} accessibilityState={{ selected: tab === 'calendar' }} onPress={() => onNavigate(tab)} style={({ pressed }) => [styles.footerTab, pressed && styles.accentPressed]}>
    <SymbolView name={icon} size={21} tintColor={tab === 'calendar' ? palette.accent : palette.muted} /><Text style={[styles.footerLabel, tab === 'calendar' && { color: palette.accent }]}>{label}</Text></Pressable>)}</View>;
}
const baseStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, header: { ...navigationHeaderMetrics, gap: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  headerBack: { alignSelf: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  titleBlock: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10 }, title: { ...typography.body, fontWeight: '700', color: palette.ink },
  viewChoice: { minHeight: 44, minWidth: 44, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.elevated, borderRadius: 10 }, modeText: { ...typography.caption, color: palette.accent },
  todayDock: { position: 'absolute', left: 13, right: 13, bottom: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  searchHelpGroup: { flexDirection: 'row', borderWidth: 1, borderColor: palette.border, borderRadius: 10, overflow: 'hidden', backgroundColor: palette.surface },
  searchHelpControl: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  searchHelpDivider: { width: 1, alignSelf: 'stretch', marginVertical: 9, backgroundColor: palette.border },
  accentPressed: { backgroundColor: palette.accentSoft }, actionDisabled: { opacity: .35 },
  dockedBody: { paddingBottom: 76 },
  add: { minWidth: 56, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: palette.accentSoft },
  todayAction: { minWidth: 56, minHeight: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.border, borderRadius: 10, backgroundColor: palette.surface },
  todayActionText: { ...typography.label, color: palette.accent, fontWeight: '600' },
  viewport: { flex: 1, overflow: 'hidden' }, weekdays: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, weekdayCell: { width: `${100 / 7}%`, alignItems: 'center', paddingTop: 5, paddingBottom: 5, minHeight: 32, gap: 1 },
  weekday: { ...typography.calendarLabel, color: palette.muted }, weeklyLabels: { alignSelf: 'stretch' },
  week: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, monthColumn: { width: `${100 / 7}%`, minWidth: 0, flexShrink: 0 }, dayCell: { paddingVertical: MONTH_CELL_PADDING, paddingHorizontal: 1, borderRightWidth: 1, borderColor: palette.border, overflow: 'hidden', gap: MONTH_CELL_GAP },
  monthBoundary: { height: MONTH_HEADING_HEIGHT, paddingLeft: 7, justifyContent: 'center', borderColor: palette.border }, monthBoundaryTitle: { ...typography.section, fontWeight: '700', color: palette.ink },
  firstDayCell: { borderLeftWidth: 1 }, monthFirstWeek: { borderTopWidth: 1, borderTopColor: palette.border },
  hiddenDay: { backgroundColor: palette.elevated }, hiddenOutline: { borderWidth: 1.5, borderColor: palette.muted },
  dayNumberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: MONTH_DATE_HEIGHT, flexShrink: 0 },
  dayNumberBadge: { minWidth: MONTH_DATE_HEIGHT, minHeight: MONTH_DATE_HEIGHT, borderRadius: MONTH_DATE_HEIGHT / 2, alignItems: 'center', justifyContent: 'center' },
  dayNumber: { ...typography.calendarDate, color: palette.ink, fontWeight: '500', includeFontPadding: false, textAlign: 'center' },
  todayBadge: { backgroundColor: palette.accent }, selectedBadge: { backgroundColor: palette.accentSoft },
  todayNumber: { color: palette.accentInk, fontWeight: '800' }, selectedNumber: { color: palette.accent },
  gridWasteText: { fontSize: 12, lineHeight: 16 },
  monthCount: { marginTop: 'auto', minHeight: MONTH_SUMMARY_HEIGHT, flexShrink: 0, backgroundColor: palette.elevated, borderRadius: 4, alignItems: 'center' }, monthCountText: { fontSize: 12, lineHeight: MONTH_SUMMARY_HEIGHT, color: palette.muted }, monthCountNumber: { fontSize: 13, fontWeight: '700', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning, flex: 1 }, errorRow: { paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', gap: 8, alignItems: 'center' },
  resume: { paddingHorizontal: 12, minHeight: 38, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  summary: { flexDirection: 'row', gap: 5, alignItems: 'center', minHeight: 36, paddingHorizontal: 8 }, summaryTitle: { ...typography.label, color: palette.ink, fontWeight: '500', flex: 1 }, choreList: { gap: 0, paddingHorizontal: 2, paddingBottom: 4 },
  overlapNotice: { ...typography.small, color: palette.gold, paddingHorizontal: 10, paddingBottom: 4 },
  dayHeading: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingTop: 7, paddingBottom: 3 }, dayTitle: { ...typography.label, color: palette.ink, fontWeight: '600', textAlign: 'center' },
  agendaHeading: { justifyContent: 'flex-start', paddingHorizontal: 12 },
  dayHeadingMain: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, agendaHeadingMain: { justifyContent: 'flex-start' },
  weekHeading: { alignItems: 'center', paddingVertical: 4, gap: 2 }, weekWeekday: { fontSize: 11, lineHeight: 14, color: palette.muted }, weekNumber: { ...typography.calendarDate, color: palette.ink }, weekMeta: { fontSize: 10, lineHeight: 14, color: palette.muted },
  weekMetadata: { alignSelf: 'stretch', flexGrow: 0, maxHeight: 46 }, weekMetadataContent: { alignItems: 'center', gap: 2 },
  weekDate: { minHeight: 30, minWidth: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  weekSummary: { minHeight: 32, paddingHorizontal: 2, flexDirection: 'row', gap: 1, justifyContent: 'center', alignItems: 'center' }, weekSummaryText: { fontSize: 10.5, lineHeight: 16, color: palette.ink, flexShrink: 1 },
  compactTimedEvent: { paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 },
  stackedTimedEvent: { borderLeftWidth: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
  timedEventDuration: { position: 'absolute', left: 0, right: 0, borderLeftWidth: 3, borderBottomLeftRadius: 5, borderBottomRightRadius: 5 },
  timedContent: { flex: 1 },
  compactTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 2 }, compactTitle: { flex: 1, minWidth: 0 },
  weekTimedTitle: { fontSize: 11, lineHeight: 14, fontWeight: '600', includeFontPadding: false }, threeTimedTitle: { fontSize: 13, lineHeight: 16, fontWeight: '600', includeFontPadding: false },
  compactTime: { fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'], includeFontPadding: false },
  durationRail: { position: 'absolute', borderRadius: 1 },
  overlapCount: { fontWeight: '700' },
  selectedTimeline: { borderWidth: 1, borderColor: palette.accent },
  dayHeadingDate: { minWidth: 0, flexShrink: 1 }, dayStatus: { ...typography.small, color: palette.muted, flexShrink: 0 },
  birthdayHeading: { flexDirection: 'row', gap: 2, alignItems: 'center', flexShrink: 1, minWidth: 0 },
  birthdayName: { ...typography.small, color: palette.accent, flexShrink: 1 },
  dayColumns: { flexDirection: 'row' }, dayColumn: { flex: 1, minWidth: 0, borderRightWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  eventRow: { minHeight: 48, paddingVertical: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  eventTime: { ...typography.caption, color: palette.muted, minWidth: 39, flexShrink: 0 }, eventStripe: { width: 3, alignSelf: 'stretch', borderRadius: 2 }, eventText: { flex: 1, gap: 1 }, eventTitle: { ...typography.body, color: palette.ink, fontWeight: '600' },
  agendaDay: { paddingBottom: 10, borderBottomWidth: 1, borderColor: palette.border }, empty: { ...typography.caption, color: palette.muted, paddingHorizontal: 12, paddingVertical: 8 },
  loadingAgenda: { ...typography.caption, color: palette.muted, paddingHorizontal: 12, paddingVertical: 5 },
  alignedDayColumns: { marginLeft: timeGutter, borderLeftWidth: 1, borderLeftColor: palette.border },
  fixedDayHeader: { backgroundColor: palette.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  headingColumn: { justifyContent: 'space-between' },
  compactDayHeading: { paddingTop: 4, paddingBottom: 0, gap: 0 },
  compactSummarySelected: { backgroundColor: palette.accentSoft, alignSelf: 'stretch' },
  detailClip: { flex: 1, minHeight: 0, overflow: 'hidden' },
  timelineScroll: { flex: 1, minHeight: 0 },
  holiday: { ...typography.caption, color: palette.warning, maxWidth: '100%' },
  timelineBody: { paddingBottom: 76 }, timeline: { marginTop: timelineTopPadding },
  clockGutter: { position: 'absolute', top: 0, bottom: 0, left: 0, width: timeGutter },
  hour: { position: 'absolute', left: 0, right: 0 },
  hourLabel: { fontSize: 12, lineHeight: 18, color: palette.muted, width: timeGutter, textAlign: 'center', transform: [{ translateY: -9 }] },
  hourRule: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: palette.border },
  timelineColumns: { marginLeft: timeGutter, flexDirection: 'row', height: '100%', borderLeftWidth: 1, borderColor: palette.border }, timelineColumn: { flex: 1, minWidth: 0, borderRightWidth: 1, borderColor: palette.border },
  timedEvent: { position: 'absolute', borderLeftWidth: 3, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' }, timedTitle: { ...typography.label, color: palette.ink, fontWeight: '600' },
  now: { position: 'absolute', left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.accent, height: 1 },
  nowMarkerOnly: { right: undefined, width: 0, borderTopWidth: 0 },
  nowDot: { position: 'absolute', left: -4, top: -4, width: 7, height: 7, borderRadius: 4, backgroundColor: palette.accent }, nowLabel: { position: 'absolute', right: '100%', width: timeGutter - 4, textAlign: 'center', fontSize: 11, lineHeight: 16, color: palette.accent, backgroundColor: palette.background },
  footer: { minHeight: 62, flexDirection: 'row', borderTopWidth: 1, borderColor: palette.border, backgroundColor: palette.surface }, footerTab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 56 }, footerLabel: { ...typography.tab, color: palette.muted },
});
