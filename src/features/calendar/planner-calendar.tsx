import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentRef, ReactNode } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import type { FlatListProps } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { FlatList as GestureFlatList, ScrollView as GestureScrollView, GestureDetector, GestureHandlerRootView, usePanGesture } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCalendarClock } from './use-calendar-clock';
import { AppButton, BackButton, navigationHeaderMetrics, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { WasteTypeLabel } from '../../components/waste-type-icon';
import { addDays, formatJapaneseDate, parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import type { WeeklyWasteSchedule } from '../waste/contracts';
import { wasteCalendarLabels } from '../waste/calendar-labels';
import { calendarEventsInTimeZone, calendarMonth, dateInMonth, indexCalendarOccurrences, minuteLabel, newEventDraft } from './events';
import { projectPrivateCalendarEvents } from './private-event-projection';
import type { CalendarEvent, CalendarOccurrence } from './events';
import { CalendarEditor } from './calendar-editor';
import type { CalendarChoreRegistrationProps, ExistingCalendarChore } from './calendar-editor';
import type { LocalCalendarBinding } from './use-local-calendar';
import { calendarDraftKey, calendarDraftVersion, EMPTY_LOCAL_CALENDAR, saveCalendarEvent, saveCalendarFutureEvent, restoreCalendarOccurrence } from '../../platform/storage/calendar-events';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import { calendarSwipe, timelineEvents, weekStart } from './layout';
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
import { calendarDisplayColor as categoryColor, calendarEventAppearance } from './event-appearance';
import { calendarMonthContentHeight, MONTH_CELL_GAP, MONTH_CELL_PADDING, MONTH_DATE_HEIGHT, MONTH_SUMMARY_HEIGHT } from './month-density';
import { CalendarSearch } from './calendar-search';
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
import { BirthdayCake, BirthdayCalendarDate } from '../../components/birthday-cake';
import { CalendarMonthEvents } from './month-events';
import { CalendarMonthEventTitle } from './month-event-title';
import { calendarEventValue, calendarMovedDraft, calendarSeriesMovedDraft, calendarFutureMovedDraft, calendarMonthDragTarget, calendarOccurrenceDraft, calendarSlotDraft, type CalendarMonthViewport } from './direct-actions';
import { CalendarTimedEvent } from './calendar-timed-event';
import { CalendarRecurrenceScopePicker, type CalendarEditScope } from './calendar-recurrence-scope';
import { CalendarWeek, type WeekRecenter } from './calendar-week';
import { moveCalendarStart } from './event-editing';
import { useMonthDrag } from './use-month-drag';
import { splitCalendarFuture } from '../../domain/calendar/future-series';
import { rebasedCalendarExceptions } from '../../domain/calendar/exception-slots';

export interface CalendarDayInfo { loaded: boolean; partial?: boolean; pending?: number; total?: number; minutes?: number; accessibilityCountLabel?: string }
export interface PlannerCalendarProps {
  timedChores?: readonly TimedCalendarChore[];
  searchChores?: readonly CalendarSearchChore[]; searchChoresIncomplete?: boolean;
  workspaceName?: string;
  today: LocalDate; timeZone: string; selectedDate?: LocalDate; local?: LocalCalendarBinding; busy?: boolean;
  onSelectDate?: (date: LocalDate) => void; onMonth?: (month: LocalDate) => void; monthLoaded?: (month: LocalDate) => boolean;
  dayInfo: (date: LocalDate) => CalendarDayInfo; renderChores: (date: LocalDate, view: CalendarView) => ReactNode; renderWaste?: (date: LocalDate) => ReactNode;
  extendedChoreDates?: ReadonlySet<LocalDate>;
  wasteSchedules?: readonly WeeklyWasteSchedule[]; hiddenWasteKeys?: readonly string[];
  /** Shared rules alone do not prove that date-specific exceptions were read. */
  wasteLoaded?: (date: LocalDate) => boolean;
  notice?: ReactNode; footer?: ReactNode;
  onNavigate?: (tab: 'home' | 'calendar' | 'chores' | 'appliances') => void; existingChores?: readonly ExistingCalendarChore[];
  repeatReturnTo?: 'personal' | 'group';
  renderChoreRegistration?: (props: CalendarChoreRegistrationProps) => ReactNode;
}
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
const hourHeight = 44;
const timeGutter = 44;
const minimumEventHeight = 26;
interface CalendarMoveCapture {
  draft: CalendarEditorDraft; event: CalendarOccurrence; database: NonNullable<LocalCalendarBinding['database']>;
  series: CalendarEvent;
  groupId?: string; timeZone: string; events: LocalCalendarBinding['snapshot']['events']; exceptions: LocalCalendarBinding['snapshot']['exceptions'];
}

/** One mobile calendar for personal and shared chores. Local events never enter a shared outbox. */
export function PlannerCalendar(props: PlannerCalendarProps) {
  const styles = usePlannerBorderStyles(baseStyles);
  const { today, timeZone, local, onMonth, monthLoaded, busy } = props;
  const currentContext = useRef({ local, timeZone }); useLayoutEffect(() => { currentContext.current = { local, timeZone }; }, [local, timeZone]);
  const choreThrough = calendarChoreDisplayThrough(today);
  const showChores = (day: LocalDate) => day <= choreThrough || props.extendedChoreDates?.has(day) === true;
  const source = local?.snapshot ?? EMPTY_LOCAL_CALENDAR; const scheme = useColorScheme(); const { width, fontScale } = useWindowDimensions();
  const display = useCalendarDisplay(); const view = display.view; const setView = display.select;
  const [viewMenu, setViewMenu] = useState(false); const [date, setDate] = useState(props.selectedDate ?? today);
  const [monthPicker, setMonthPicker] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState<{ eventId: string | null; date: LocalDate; minute: number | null } | null>(null);
  const searchFocusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const agendaEventOffsets = useRef(new Map<string, number>());
  const [draftsOpen, setDraftsOpen] = useState(false);
  const preferred = useRef(Number((props.selectedDate ?? today).slice(-2)));
  const [month, setMonth] = useState(calendarMonth(date)); const [year, setYear] = useState(Number(date.slice(0, 4)));
  const [anchor, setAnchor] = useState(weekStart(date)); const [bounds, setBounds] = useState({ from: -260, through: 260 });
  const monthDetail = useCalendarMonthDetail(); const density = monthDetailLayout(monthDetail.value);
  const titleDisplay = useCalendarTitleDisplay();
  const [height, setHeight] = useState(600); const rowHeight = calendarMonthContentHeight(Math.floor(height / density.weeks), density.maxEvents);
  const [expanded, setExpanded] = useState(new Set<LocalDate>()); const [listDays, setListDays] = useState(28);
  const [choreContentHeights, setChoreContentHeights] = useState<Record<string, number>>({});
  const [allDayContentHeights, setAllDayContentHeights] = useState<Record<string, number>>({});
  const activeAllDayMeasurements = useRef<ReadonlySet<string>>(new Set());
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
  const [pendingMove, setPendingMove] = useState<{ capture: CalendarMoveCapture; row: CalendarOccurrence; settled: boolean } | null>(null);
  const [undoMove, setUndoMove] = useState<{ capture: CalendarMoveCapture; saved: CalendarEditorDraft; undoFuture?: () => Promise<void> } | null>(null);
  const [moveScopeOpen, setMoveScopeOpen] = useState(false);
  const moveScopeAnswer = useRef<((scope: CalendarEditScope | null) => void) | null>(null);
  const answerMoveScope = (scope: CalendarEditScope | null) => { const answer = moveScopeAnswer.current; moveScopeAnswer.current = null; setMoveScopeOpen(false); answer?.(scope); };
  useFocusEffect(useCallback(() => () => { setSearchOpen(false); setDraftsOpen(false); moveScopeAnswer.current?.(null); moveScopeAnswer.current = null; setMoveScopeOpen(false); }, [setSearchOpen, setDraftsOpen]));
  useEffect(() => () => { moveScopeAnswer.current?.(null); moveScopeAnswer.current = null; setMoveScopeOpen(false); }, [local?.database, local?.shared?.groupId, timeZone]);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const [editor, setRawEditor] = useState<CalendarEditorDraft | null>(null);
  const setEditor = (draft: CalendarEditorDraft | null) => setRawEditor(draft && local?.prepareDraft ? local.prepareDraft(draft) : draft); const list = useRef<FlatList<CalendarMonthRow>>(null);
  const routeParams = useLocalSearchParams<{ calendarDraft?: string; calendarDraftVersion?: string; calendarDate?: string; calendarMinute?: string; calendarJump?: string }>();
  const returnedDraft = typeof routeParams.calendarDraft === 'string' && typeof routeParams.calendarDraftVersion === 'string'
    ? (source.drafts ?? (source.draft ? [source.draft] : [])).find(row => calendarDraftKey(row) === routeParams.calendarDraft && calendarDraftVersion(row) === routeParams.calendarDraftVersion) : undefined;
  const activeEditor = editor ?? returnedDraft;
  const calendarHelp = useCalendarHelp(!activeEditor && !searchOpen && !draftsOpen && !monthPicker && !viewMenu && !activeDragDay && !moveScopeOpen);
  const closeEditor = () => { setEditor(null); if (routeParams.calendarDraft) router.setParams({ calendarDraft: undefined, calendarDraftVersion: undefined }); };
  const scroll = useRef<FlatList<{ key: string }>>(null); const timelineTop = useRef<number | null>(null); const timelineViewport = useRef(0); const positioned = useRef('');
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
  const currentDate = useRef(date); useLayoutEffect(() => { currentDate.current = date; }, [date]);
  const requestedMonth = useRef<LocalDate | null>(null);
  const clock = useCalendarClock(view === 'day' || view === 'two' || view === 'three' || view === 'week');
  const currentMinute = pinnedClockAt(clock, timeZone).minute;
  useEffect(() => {
    if (props.selectedDate && props.selectedDate !== currentDate.current) { setDate(props.selectedDate); setMonth(calendarMonth(props.selectedDate)); preferred.current = Number(props.selectedDate.slice(-2)); }
  }, [props.selectedDate]);
  useEffect(() => {
    if (!onMonth || month > choreThrough || busy || monthLoaded?.(month) || requestedMonth.current === month) return;
    const timer = setTimeout(() => { requestedMonth.current = month; onMonth(month); }, 180); return () => clearTimeout(timer);
  }, [month, choreThrough, busy, monthLoaded, onMonth]);
  const weeks = useMemo(() => Array.from({ length: bounds.through - bounds.from + 1 }, (_, index) => addDays(anchor, (bounds.from + index) * 7)), [anchor, bounds]);
  const range = view === 'list' ? { from: date, through: addDays(date, Math.min(listDays, 365)) }
    : { from: calendarMonth(month, -1), through: addDays(calendarMonth(month, 2), -1) };
  const requestRange = local?.requestRange;
  useFocusEffect(useCallback(() => { requestRange?.(range.from, range.through, { refresh: true }); }, [requestRange, range.from, range.through]));
  const projection = useMemo(() => {
    try { return { events: calendarEventsInTimeZone(projectPrivateCalendarEvents(source.events.filter(event => !event.holiday), source.exceptions, addDays(range.from, -2), addDays(range.through, 2)), timeZone), error: null }; }
    catch (error) { return { events: [] as CalendarOccurrence[], error: error instanceof Error ? error.message : '予定を表示できません。' }; }
  }, [source.events, source.exceptions, range.from, range.through, timeZone]);
  const displayedEvents = useMemo(() => calendarTitleDisplay.occurrences(projection.events, today, titleDisplay.value), [projection.events, today, titleDisplay.value]);
  const colors = useMemo(() => new Map(source.categories.map(category => [category.id, categoryColor(category.color, scheme === 'dark')])), [source.categories, scheme]);
  const appearances = useMemo(() => new Map(source.categories.map(category => [category.id, calendarEventAppearance(category.color, scheme === 'dark')])), [source.categories, scheme]);
  const fallbackAppearance = useMemo(() => calendarEventAppearance('#718299', scheme === 'dark'), [scheme]);
  const byDate = useMemo<Map<LocalDate, CalendarOccurrence[]>>(() => indexCalendarOccurrences(displayedEvents, range.from, range.through), [displayedEvents, range.from, range.through]);
  const timedChoreIndex = useMemo<Map<LocalDate, CalendarOccurrence[]>>(() => indexCalendarOccurrences(timedCalendarChoreEvents(props.timedChores ?? [], timeZone), range.from, range.through), [props.timedChores, timeZone, range.from, range.through]);
  const editableEventIds = useMemo(() => new Set(source.events.filter(event => !event.readOnly).map(event => event.id)), [source.events]);
  const visibleMove = pendingMove && pendingMove.capture.database === local?.database && pendingMove.capture.groupId === local?.shared?.groupId && pendingMove.capture.timeZone === timeZone
    && !(pendingMove.settled && (source.events !== pendingMove.capture.events || source.exceptions !== pendingMove.capture.exceptions)) ? pendingMove : null;
  const movedDays = useMemo<Map<LocalDate, CalendarOccurrence[]> | null>(() => {
    if (!visibleMove) return null;
    const { capture } = visibleMove;
    if (capture.draft.scope === 'future' && capture.draft.anchorDate) {
      const split = splitCalendarFuture(capture.series, capture.draft.anchorDate, capture.draft.value, capture.exceptions);
      const nextId = `${capture.series.id}.future-preview`;
      const events = [...(split.past ? [{ ...split.past, id: capture.series.id, revision: capture.series.revision }] : []), { ...split.next, id: nextId, revision: 1 }];
      const exceptions = [...split.previous, ...split.following.map(row => ({ ...row, eventId: nextId }))];
      return indexCalendarOccurrences(calendarTitleDisplay.occurrences(calendarEventsInTimeZone(projectPrivateCalendarEvents(events, exceptions, range.from, range.through), timeZone), today, titleDisplay.value), range.from, range.through);
    }
    if (capture.draft.scope !== 'series' || capture.series.recurrence === 'none') return indexCalendarOccurrences(calendarTitleDisplay.occurrences([visibleMove.row], today, titleDisplay.value), range.from, range.through);
    const next = { ...capture.series, ...capture.draft.value };
    const exceptions = rebasedCalendarExceptions(capture.series, next, capture.exceptions);
    return indexCalendarOccurrences(calendarTitleDisplay.occurrences(calendarEventsInTimeZone(projectPrivateCalendarEvents([next], exceptions, range.from, range.through), timeZone), today, titleDisplay.value), range.from, range.through);
  }, [visibleMove, range.from, range.through, timeZone, today, titleDisplay.value]);
  const eventsOn = (day: LocalDate) => {
    const rows = byDate.get(day) ?? [];
    const ordinary = visibleMove ? [...rows.filter(row => row.eventId !== visibleMove.capture.event.eventId || visibleMove.capture.draft.scope === 'one' && row.anchorDate !== visibleMove.capture.event.anchorDate), ...movedDays?.get(day) ?? []] : rows;
    return view === 'day' || view === 'two' || view === 'three' || view === 'week' ? [...ordinary, ...timedChoreIndex.get(day) ?? []].sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id)) : ordinary;
  };
  const waste = useMemo(() => wasteCalendarLabels(props.wasteSchedules ?? [], range.from, range.through, props.hiddenWasteKeys), [props.wasteSchedules, props.hiddenWasteKeys, range.from, range.through]);
  const wasteKnown = (day: LocalDate) => props.wasteLoaded?.(day) !== false;
  const monthRows = useMemo(() => calendarMonthRows(weeks, rowHeight), [weeks, rowHeight]);
  const dateLabel = (day: LocalDate) => {
    const info = showChores(day) ? props.dayInfo(day) : undefined; const labels = wasteKnown(day) ? waste.byDate.get(day) ?? [] : []; const hidden = wasteKnown(day) ? waste.hiddenWeeklyByDate.get(day) ?? [] : []; const events = eventsOn(day);
    const appointments = events.filter(event => !event.holiday); const holiday = japanesePublicHoliday(day);
    return `${formatJapaneseDate(day, { year: true })}${holiday ? `、祝日：${holiday}` : ''}${info ? `、${info.accessibilityCountLabel ?? (info.loaded ? `家事${info.total ?? info.pending ?? 0}件、未完了${info.pending ?? 0}件${info.partial ? '、一部は未取得' : ''}` : busy ? '家事は読み込み中' : '家事は未取得')}` : ''}${!wasteKnown(day) ? '、収集日は未取得' : ''}${labels.length ? `、${labels.join('・')}` : ''}${hidden.length ? `、非表示の収集：${hidden.join('・')}` : ''}${appointments.length ? `、予定${appointments.length}件` : ''}`;
  };
  const positionYear = () => {
    if (!yearTarget.current || !yearScroll.current) return;
    yearScroll.current(yearTarget.current);
    yearTarget.current = null;
  };
  const navigateMonth = (next: LocalDate, day = preferred.current, destination: CalendarView = 'month') => {
    searchPosition.current = null;
    monthDragged.current = false; setBrowsingMonth(false); monthPositioned.current = '';
    const chosen = dateInMonth(next, day); setTarget(chosen); setMonth(calendarMonth(next)); setYear(Number(next.slice(0, 4)));
    setAnchor(weekStart(chosen)); setBounds({ from: -260, through: 260 }); setDate(chosen); positioned.current = ''; timelineTop.current = null; props.onSelectDate?.(chosen); setView(destination);
    if (destination === 'year') { yearTarget.current = next.slice(0, 7); positionYear(); }
  };
  const chooseDate = (next: LocalDate) => { searchPosition.current = null; setDate(next); preferred.current = Number(next.slice(-2)); setMonth(calendarMonth(next)); props.onSelectDate?.(next); };
  const notificationJump = useRef<string | null>(null);
  useEffect(() => {
    if (!routeParams.calendarJump || notificationJump.current === routeParams.calendarJump || !routeParams.calendarDate) return;
    try { parseLocalDate(routeParams.calendarDate as LocalDate); } catch { return; }
    notificationJump.current = routeParams.calendarJump;
    const day = routeParams.calendarDate as LocalDate;
    const minute = routeParams.calendarMinute === '' ? null : Number(routeParams.calendarMinute);
    if (minute !== null && (!Number.isInteger(minute) || minute < 0 || minute >= 1440)) return;
    const delivery = setTimeout(() => {
    navigateMonth(calendarMonth(day), Number(day.slice(-2)), display.detail);
    searchPosition.current = display.detail === 'list' ? null : { date: day, minute };
    clearTimeout(todayTimer.current); todayTimer.current = setTimeout(() => recenter.current(), 0);
    }, 0);
    return () => clearTimeout(delivery);
  // A delivery is consumed once; repainting its destination must not navigate again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeParams.calendarJump, routeParams.calendarDate, routeParams.calendarMinute]);

  const chooseView = (next: CalendarView) => {
    searchPosition.current = null;
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
  const detailSwipeSession = useRef<{ date: LocalDate; view: 'day' | 'two' | 'three'; x: number } | null>(null);
  const detailSwipe = usePanGesture({
    enabled: (view === 'day' || view === 'two' || view === 'three') && !activeDragDay && !activeEditor && !searchOpen && !draftsOpen && !calendarHelp.open && !monthPicker && !viewMenu,
    activeOffsetX: [-16, 16], failOffsetY: [-14, 14], maxPointers: 1, runOnJS: true, cancelsJSResponder: true,
    onActivate: event => {
      detailSwipeSession.current = !dragDay.current && (view === 'day' || view === 'two' || view === 'three') && event.numberOfPointers === 1
        ? { date, view, x: event.x - event.translationX } : null;
    },
    onUpdate: event => { if (event.numberOfPointers !== 1) detailSwipeSession.current = null; },
    onDeactivate: event => {
      const start = detailSwipeSession.current; detailSwipeSession.current = null;
      if (!start || event.canceled || dragDay.current || start.date !== currentDate.current || start.view !== view) return;
      const action = calendarSwipe(start.x, event.translationX, event.translationY, width);
      if (action === 'home' || action === 'chores') { props.onNavigate?.(action); return; }
      if (action !== 'next' && action !== 'previous') return;
      const next = addDays(start.date, (action === 'next' ? 1 : -1));
      const minute = timelineTop.current !== null && timelineViewport.current > 0
        ? Math.max(0, Math.min(1440, (timelineOffset.current + timelineViewport.current / 2 - timelineTop.current) / hourHeight * 60)) : null;
      positioned.current = ''; timelineTop.current = null; chooseDate(next);
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
    if (!local?.database) return;
    event = event?.original ?? event;
    const savedDraft = (source.drafts ?? (source.draft ? [source.draft] : [])).find(draft => event
      ? draft.eventId === event.eventId && (draft.scope === 'series' || draft.anchorDate === event.anchorDate)
      : draft.eventId === null && !draft.value.birthday && draft.audience !== 'group');
    if (savedDraft) { setEditor(savedDraft); return; }
    if (event?.birthday) { setEditor({ eventId: event.eventId, anchorDate: event.anchorDate, revision: event.eventRevision, exceptionRevision: event.exceptionRevision, scope: 'series', value: source.events.find(row => row.id === event.eventId)! }); return; }
    setEditor(event ? { eventId: event.eventId, anchorDate: event.anchorDate, revision: event.eventRevision, exceptionRevision: event.exceptionRevision,
      scope: source.events.find(row => row.id === event.eventId)?.recurrence === 'none' ? 'series' : 'one', value: { ...calendarEventValue(event), recurrence: 'none', untilDate: null } }
      : { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(date.slice(0, 7) === month.slice(0, 7) ? date : dateInMonth(month, preferred.current), timeZone) });
  };
  const openSlot = (day: LocalDate, minute: number) => {
    if (!local?.database || moveLock.current) return;
    chooseDate(day); setEditor(calendarSlotDraft(day, minute, timeZone));
  };
  const canMove = (event: CalendarOccurrence, dateOnly = false) => Boolean(local?.database && !visibleMove && !event.readOnly && (dateOnly || !event.allDay) && !event.birthday && !event.holiday && !event.timeIssue && editableEventIds.has(event.eventId) && local.canEditEvent?.(event.eventId, event.anchorDate) !== false);
  const beginMove = (event: CalendarOccurrence, dateOnly = false): CalendarMoveCapture | null => {
    if (!local?.database || moveLock.current || !canMove(event, dateOnly)) return null;
    const series = source.events.find(row => row.id === event.eventId);
    if (!series) return null;
    const recurring = series.recurrence !== 'none';
    const draft = calendarOccurrenceDraft(event, recurring);
    const current = projection.events.find(row => row.eventId === event.eventId && row.anchorDate === event.anchorDate);
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
      const scope = capture.series.recurrence === 'none' ? 'series' : await new Promise<CalendarEditScope | null>(resolve => { moveScopeAnswer.current = resolve; setMoveScopeOpen(true); });
      if (!scope) return;
      const currentLocal = currentContext.current.local;
      if (!currentLocal?.database || capture.database !== currentLocal.database || capture.groupId !== currentLocal.shared?.groupId || capture.timeZone !== currentContext.current.timeZone) throw new Error('表示先が変わりました。予定を選び直してください。');
      if (currentLocal.canEditEvent?.(capture.event.eventId, capture.event.anchorDate) === false) throw new Error('この予定を変更する権限がありません。');
      const draft = scope === 'future' ? calendarFutureMovedDraft(capture.draft, capture.series, target, timeZone) : scope === 'series' && capture.series.recurrence !== 'none' ? calendarSeriesMovedDraft(capture.draft, capture.series, target, timeZone) : calendarMovedDraft(capture.draft, target, timeZone);
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
  const toggleSummary = (day: LocalDate) => setExpanded(before => {
    const next = new Set(before); if (next.has(day)) next.delete(day); else next.add(day); return next;
  });
  const summaryToggle = (day: LocalDate, cachedInfo?: CalendarDayInfo, weekly = false) => {
    if (!showChores(day)) return null;
    const info = cachedInfo ?? props.dayInfo(day); const open = expanded.has(day);
    if (!info.loaded || (info.total ?? info.pending ?? 0) === 0) return null;
    return <Pressable accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の家事を${open ? '閉じる' : '開く'}`} accessibilityState={{ expanded: open }}
      onPress={() => toggleSummary(day)} style={weekly ? styles.weekSummary : view === 'three' ? [styles.summary, styles.compactDaySummary] : styles.summary}>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.8} style={weekly ? styles.weekSummaryText : styles.summaryTitle}>家事 {info.total ?? info.pending ?? 0}件{info.minutes && !weekly && view !== 'three' ? <Text style={styles.caption}> · 約{info.minutes}分</Text> : null}</Text>
      {weekly ? <SymbolView name={{ ios: open ? 'chevron.up' : 'chevron.down', android: open ? 'keyboard_arrow_up' : 'keyboard_arrow_down' }} size={7} tintColor={palette.accent} /> : <Chevron direction={open ? 'up' : 'down'} />}
    </Pressable>;
  };
  const summaryDetails = (day: LocalDate) => !showChores(day) ? null : <View>{(props.dayInfo(day).pending ?? 0) > 0 && eventsOn(day).some(event => event.allDay && !event.birthday && !event.holiday && event.blocksTime !== false)
    ? <Text style={styles.overlapNotice}>終日予定がある日の家事です</Text> : null}{expanded.has(day) ? <View style={styles.choreList}>{props.renderChores(day, view)}</View> : null}</View>;
  const summary = (day: LocalDate, info?: CalendarDayInfo) => <View>{summaryToggle(day, info)}{summaryDetails(day)}</View>;
  const eventRow = (event: CalendarOccurrence, day: LocalDate) => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${calendarDisplayedTitle(event)}を編集`} accessibilityState={{ selected: searchFocus?.eventId === event.eventId && searchFocus.date === day }} onPress={() => openEvent(event)} onLayout={eventLayout => {
      const y = eventLayout.nativeEvent.layout.y; agendaEventOffsets.current.set(`${event.id}:${day}`, y);
      if (view === 'list' && searchFocus?.eventId === event.eventId && searchFocus.date === day) agenda.current?.scrollToOffset({ offset: y, animated: false });
    }} style={[styles.eventRow, searchFocus?.eventId === event.eventId && searchFocus.date === day && { backgroundColor: palette.accentSoft }]}>
    <Text numberOfLines={1} style={styles.eventTime}>{event.allDay ? '終日' : event.startDate < day ? '継続' : minuteLabel(event.startMinute)}</Text><View style={[styles.eventStripe, { backgroundColor: colors.get(event.categoryId) ?? palette.muted }]} />
    <View style={styles.eventText}><Text style={styles.eventTitle}>{calendarDisplayedTitle(event)}</Text>{event.location ? <Text style={styles.caption}>{event.location}</Text> : null}
      {event.timeIssue ? <Text style={styles.error} accessibilityLabel={`${event.timeZone}の夏時間により${event.timeIssue === 'gap' ? '存在しない' : '重複する'}時刻です。時刻を確認してください。`}>時刻要確認 · {event.timeZone}</Text> : event.original ? <Text style={styles.caption}>元の地域：{event.original.timeZone}</Text> : event.timeZone !== timeZone ? <Text style={styles.caption}>{event.timeZone}</Text> : null}</View><Chevron />
  </Pressable>;
  const dayHeading = (day: LocalDate, agenda = false, weekly = false) => {
    const announcement = dateLabel(day);
    const holiday = japanesePublicHoliday(day);
    const info = showChores(day) ? props.dayInfo(day) : null;
    const incomplete = info && (!info.loaded || info.partial);
    const status = info?.loaded ? '一部未取得' : '未取得';
    const inlineToggle = incomplete && (!info.loaded || (info.total ?? info.pending ?? 0) === 0);
    const open = expanded.has(day);
    // The visual date can remain identical after Undo. Replace only this small
    // native text node so iOS does not retain its old accessibility description.
    if (weekly) return <View style={styles.weekHeading}>
      <Text style={styles.weekWeekday}>{weekdays[parseLocalDate(day).getUTCDay()]}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`${announcement}を選択`} accessibilityState={{ selected: day === date }} disabled={Boolean(activeDragDay)} onPress={() => chooseDate(day)} style={[styles.weekDate, day === date && { backgroundColor: palette.accentSoft }, day === today && { backgroundColor: palette.accent }]}>
        <Text style={[styles.weekNumber, holiday && { color: palette.warning }, day === today && { color: palette.accentInk }]}>{Number(day.slice(-2))}</Text>
      </Pressable>
      {incomplete ? <Pressable accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の家事を${open ? '閉じる' : '開く'}`} accessibilityState={{ expanded: open }} onPress={() => toggleSummary(day)}><Text style={styles.weekMeta}>{status}</Text></Pressable> : null}
      {eventsOn(day).filter(event => event.birthday).map(event => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${calendarDisplayedTitle(event)}を編集`} onPress={() => openEvent(event)}><BirthdayCake width={18} height={16} /></Pressable>)}
      {holiday ? <Text numberOfLines={1} accessibilityLabel={`祝日：${holiday}`} style={[styles.weekMeta, { color: palette.warning }]}>{holiday}</Text> : null}
      {props.renderWaste ? props.renderWaste(day) : wasteKnown(day) ? <>{[...waste.weeklyByColumn[parseLocalDate(day).getUTCDay()].filter(name => !waste.hiddenWeeklyByDate.get(day)?.includes(name)), ...waste.byDate.get(day) ?? []].map(name => <WasteTypeLabel key={name} label={name} size={10} textStyle={styles.weekMeta} />)}</> : null}
    </View>;
    const headingText = <Text key={announcement} accessibilityLabel={announcement} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.85} style={[styles.dayTitle, styles.dayHeadingDate, day === today && { color: palette.accent }, holiday && { color: palette.warning }]}>{formatJapaneseDate(day, { weekday: true }).replace(/[（(]/gu, ' ').replace(/[）)]/gu, '')}</Text>;
    return <View style={[styles.dayHeading, agenda && styles.agendaHeading, view === 'three' && styles.compactDayHeading]}><View style={[styles.dayHeadingMain, agenda && styles.agendaHeadingMain]}>{headingText}
      {incomplete ? inlineToggle ? <Pressable accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の家事を${open ? '閉じる' : '開く'}`} accessibilityValue={{ text: status }} accessibilityState={{ expanded: open }} hitSlop={4} onPress={() => toggleSummary(day)} style={styles.inlineSummary}>
        <Text numberOfLines={1} style={styles.dayStatus}>{status}</Text><SymbolView name={{ ios: open ? 'chevron.up' : 'chevron.down', android: open ? 'keyboard_arrow_up' : 'keyboard_arrow_down' }} size={11} tintColor={palette.accent} />
      </Pressable> : <Text numberOfLines={1} style={styles.dayStatus}>{status}</Text> : null}
    {eventsOn(day).filter(event => event.birthday).map(event => <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${calendarDisplayedTitle(event)}を編集`} onPress={() => openEvent(event)} style={styles.birthday}>
      <BirthdayCake width={20} height={18} /><Text numberOfLines={1} style={[styles.caption, { flexShrink: 1 }]}>{calendarDisplayedTitle(event)}</Text></Pressable>)}</View>
    {holiday ? <Text numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={`祝日：${holiday}`} style={styles.holiday}>{holiday}</Text> : null}
    {props.renderWaste ? props.renderWaste(day) : wasteKnown(day) ? <>{waste.weeklyByColumn[parseLocalDate(day).getUTCDay()]
      .filter(name => !waste.hiddenWeeklyByDate.get(day)?.includes(name)).map(name => <WasteTypeLabel key={name} label={name} size={14} />)}
    {(waste.byDate.get(day) ?? []).map(name => <WasteTypeLabel key={name} label={name} size={14} />)}</> : null}</View>;
  };
  const timelineMinimum = view === 'week' ? 40 : minimumEventHeight;
  const timedDay = (day: LocalDate, days: readonly LocalDate[], columnWidth: number) => <>
              {local?.database ? <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の空き時間に予定を追加`} accessibilityActions={[{ name: 'activate', label: '予定を追加' }]}
                onAccessibilityTap={() => openSlot(day, 9 * 60)}
                onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') openSlot(day, 9 * 60); }}
                onLongPress={event => openSlot(day, event.nativeEvent.locationY / hourHeight * 60)} /> : null}
              {timelineEvents(eventsOn(day), day, timelineMinimum / hourHeight * 60).map(item => { const appearance = appearances.get(item.row.categoryId) ?? fallbackAppearance; return <CalendarTimedEvent helpTarget={registerHelpTarget} key={item.row.id} event={item.row} day={day} days={days} columnWidth={columnWidth} hourHeight={hourHeight}
                selected={searchFocus?.eventId === item.row.eventId && searchFocus.date === day}
                draggable={Boolean(local?.database && !visibleMove && !item.row.allDay && !item.row.birthday && !item.row.holiday && !item.row.readOnly && !item.row.timeIssue && item.row.startDate === day && editableEventIds.has(item.row.eventId) && local.canEditEvent?.(item.row.eventId, item.row.anchorDate) !== false)}
                onOpen={() => openEvent(item.row)} onBegin={() => beginMove(item.row)} onCommit={commitMove} onActive={setDragDay} style={[styles.timedEvent, view === 'week' && styles.weekTimedEvent,
                { top: item.start / 60 * hourHeight, height: Math.max(timelineMinimum, (item.end - item.start) / 60 * hourHeight), left: `${item.lane / item.lanes * 100}%`, width: `${96 / item.lanes}%`,
                  borderLeftColor: appearance.accent, backgroundColor: appearance.backgroundColor, ...(searchFocus?.eventId === item.row.eventId && searchFocus.date === day ? { borderWidth: 2, borderColor: palette.accent } : {}) }]}>
                {view === 'week' ? <><CalendarMonthEventTitle title={calendarDisplayedTitle(item.row)} color={appearance.foregroundColor} backgroundColor={appearance.backgroundColor} lines={(item.end - item.start) / 60 * hourHeight >= 58 ? 2 : 1} centerSingleLine={false} onOverflow={() => {}} /><Text numberOfLines={1} style={[styles.weekTime, { color: appearance.foregroundColor }]}>{minuteLabel(item.start)}</Text></> : <>
                <Text numberOfLines={1} style={[styles.timedTitle, { color: appearance.foregroundColor }]}>{calendarDisplayedTitle(item.row)}{item.row.timeIssue ? '（時刻要確認）' : ''}</Text>{(item.end - item.start) / 60 * hourHeight >= typography.label.lineHeight + typography.caption.lineHeight + 4 ? <Text numberOfLines={1} style={[styles.caption, { color: appearance.foregroundColor }]}>{minuteLabel(item.start)}〜{minuteLabel(item.end)}</Text> : null}</>}

              </CalendarTimedEvent>; })}
              {day === today ? <View pointerEvents="none" style={[styles.now, { top: currentMinute / 60 * hourHeight }]}><View style={styles.nowDot} />{view !== 'week' ? <Text style={styles.nowLabel}>現在 {minuteLabel(currentMinute)}</Text> : null}</View> : null}
  </>;
  const dayList = Array.from({ length: view === 'three' ? 3 : view === 'two' ? 2 : 1 }, (_, i) => addDays(date, i));
  const allDayColumns = view === 'day' || view === 'two' || view === 'three' ? dayList.map(day => {
    const rows = eventsOn(day).filter(event => event.allDay && !event.birthday && !event.holiday);
    // Delayed measurements belong to their exact rows and column width, never a later date's content.
    const measurement = JSON.stringify([view, width, fontScale, timeZone, rows.map(event => [event.id, event.eventRevision, event.exceptionRevision,
      calendarDisplayedTitle(event), event.location, event.timeZone, event.original?.timeZone])]);
    return { day, rows, measurement };
  }) : [];
  useLayoutEffect(() => { activeAllDayMeasurements.current = new Set(allDayColumns.filter(column => column.rows.length).map(column => column.measurement)); });
  const measureAllDay = (measurement: string, contentHeight: number) => {
    if (!activeAllDayMeasurements.current.has(measurement)) return;
    setAllDayContentHeights(before => {
      const active = activeAllDayMeasurements.current;
      if (!active.has(measurement)) return before;
      const retained = Object.entries(before).filter(([key]) => active.has(key));
      if (before[measurement] === contentHeight && retained.length === Object.keys(before).length) return before;
      return { ...Object.fromEntries(retained), [measurement]: contentHeight };
    });
  };
  const hasAllDay = allDayColumns.some(column => column.rows.length > 0);
  const expandedChores = dayList.some(day => showChores(day) && expanded.has(day));
  const fixedSpace = Math.max(0, height - dayHeadingHeight - Math.min(120, height * .25));
  const allDayHeight = hasAllDay ? Math.min(height * .3, fixedSpace * (expandedChores ? .5 : 1),
    Math.max(...allDayColumns.map(column => column.rows.length ? allDayContentHeights[column.measurement] ?? column.rows.length * baseStyles.eventRow.minHeight : 0))) : 0;
  const choreHeight = expandedChores ? Math.max(0, Math.min(height * .65, fixedSpace - allDayHeight,
    Math.max(...dayList.filter(day => expanded.has(day)).map(day => choreContentHeights[day] ?? height * .65)))) : 0;
  const positionTime = () => {
    const key = `${view}:${date}`; if (positioned.current === key || timelineTop.current === null || timelineViewport.current <= 0) return;
    positioned.current = key;
    const first = dayList.flatMap(day => eventsOn(day).filter(event => !event.allDay).map(event => event.startMinute)).sort((a, b) => a - b)[0];
    const selected = searchPosition.current; searchPosition.current = null;
    if (selected?.date === date && selected.minute === null) {
      scroll.current?.scrollToOffset({ offset: 0, animated: false }); return;
    }
    const minute = selected?.date === date && selected.minute !== null ? selected.minute : dayList.includes(today) ? currentMinute : first ?? 9 * 60;
    scroll.current?.scrollToOffset({ offset: Math.max(0, timelineTop.current + minute / 60 * hourHeight - timelineViewport.current / 2), animated: false });
  };
  const goToday = () => {
    searchPosition.current = null;
    preferred.current = Number(today.slice(-2)); monthDragged.current = false; setBrowsingMonth(false); monthPositioned.current = ''; positioned.current = '';
    if (date !== today) timelineTop.current = null;
    setTarget(today); setDate(today); setMonth(calendarMonth(today)); setYear(Number(today.slice(0, 4)));
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
      const match = searchFocus?.date === date ? eventsOn(date).find(event => event.eventId === searchFocus.eventId && (searchFocus.minute === null || event.startMinute === searchFocus.minute)) : undefined;
      agenda.current?.scrollToOffset({ offset: match ? agendaEventOffsets.current.get(`${match.id}:${date}`) ?? 0 : 0, animated: false });
    } }; });
  const renderWeek = ({ item }: { item: CalendarMonthRow }) => <View style={{ height: item.height }}>
    {item.monthStartColumn !== null ? <View style={[styles.monthBoundary, { marginLeft: `${item.monthStartColumn / 7 * 100}%` }]}>
      <Text accessibilityRole="header" style={styles.monthBoundaryTitle}>{Number(item.month.slice(5, 7))}月</Text>
    </View> : null}
    <View style={[styles.week, item.monthStartColumn !== null && styles.monthFirstWeek, { height: item.height - (item.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT) }]}>{item.days.map((day, column) => {
    if (!day) return <View key={`empty:${column}`} pointerEvents="none" style={styles.monthColumn} />;
    const info = showChores(day) ? props.dayInfo(day) : undefined; const dailyEvents = eventsOn(day); const labels = wasteKnown(day) ? waste.byDate.get(day) ?? [] : []; const hidden = wasteKnown(day) ? waste.hiddenWeeklyByDate.get(day) ?? [] : [];
    const total = info?.total ?? info?.pending ?? 0;
    const hasSummary = Boolean(info && (!info.loaded || total > 0 || info.partial));
    const ownBirthday = dailyEvents.some(event => event.eventId === OWN_BIRTHDAY_EVENT_ID && event.birthday);
    const holiday = japanesePublicHoliday(day); const ordinaryEvents = dailyEvents.filter(event => !event.holiday && !(event.eventId === OWN_BIRTHDAY_EVENT_ID && event.birthday));
    const openDay = () => { chooseDate(day); positioned.current = ''; timelineTop.current = null; setView(display.detail); };
    return <View key={day} style={[styles.monthColumn, styles.dayCell, (column === 0 || item.days[column - 1] === null) && styles.firstDayCell, hidden.length > 0 && styles.hiddenDay, activeDragDay === day && { zIndex: 1, overflow: 'visible' }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${dateLabel(day)}${ownBirthday ? '、自分の誕生日' : ''}`}
        accessibilityState={{ selected: day === date }} onPress={openDay} style={StyleSheet.absoluteFill} />
      {hidden.length > 0 ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.hiddenOutline]} /> : null}
      <View pointerEvents="none" style={styles.dayNumberRow}>{ownBirthday ? <BirthdayCalendarDate day={Number(day.slice(-2))} today={day === today} selected={day === date} /> : <Text style={[styles.dayNumber, holiday && { color: palette.warning },
        day === today && styles.todayNumber, day === date && day !== today && styles.selectedNumber]}>{Number(day.slice(-2))}</Text>
      }</View>
      {labels.length || !wasteKnown(day) ? <View pointerEvents="none">
        {labels.slice(0, 1).map(label => <WasteTypeLabel key={label} label={label} size={13} textStyle={styles.gridWasteText} />)}
        {!wasteKnown(day) ? <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.caption, styles.gridWasteText]}>収集未取得</Text> : null}
      </View> : null}
      <CalendarMonthEvents events={ordinaryEvents} day={day} height={item.height - (item.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT)}
        summary={hasSummary} waste={labels.length > 0 || !wasteKnown(day)} detail={monthDetail.value} appearances={appearances} fallbackAppearance={fallbackAppearance} dark={scheme === 'dark'}
        drag={{ helpTarget: registerHelpTarget, canMove: event => canMove(event, true), onBegin: event => beginMove(event, true), onCommit: commitMove,
          activeId: monthDrag.activeId, prepare: monthDrag.prepare, onOpen: openDay }} />
      {hasSummary ? info?.loaded ? <View pointerEvents="none" style={styles.monthCount}><Text numberOfLines={1} adjustsFontSizeToFit style={styles.monthCountText}>{total > 0 ? <>家事 <Text style={styles.monthCountNumber}>{total}</Text>件{info.partial ? '+' : ''}</> : '一部未取得'}</Text></View>
        : <Text pointerEvents="none" numberOfLines={1} style={[styles.caption, styles.monthCountText, { marginTop: 'auto' }]}>{busy ? '読込中' : '未取得'}</Text> : null}
    </View>;
  })}</View></View>;
  const titleLabel = view === 'year' ? `${year}年` : `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
  const yearBody = <CalendarYear initialYear={year} today={today} onMonth={next => navigateMonth(next)} onYear={setYear} onReady={scrollToMonth => { yearScroll.current = scrollToMonth; positionYear(); }} />;
  const drafts = source.drafts ?? (source.draft ? [source.draft] : []);
  const auxiliaryOpen = searchOpen || draftsOpen || calendarHelp.open || moveScopeOpen;
  return <View style={styles.root} {...horizontal.panHandlers}>
    <View style={{ flex: 1, overflow: 'hidden' }}><View style={{ flex: 1 }} accessibilityElementsHidden={auxiliaryOpen} importantForAccessibility={auxiliaryOpen ? 'no-hide-descendants' : 'auto'} pointerEvents={auxiliaryOpen ? 'none' : 'auto'}>
    <View style={styles.header}><View style={styles.headerBack}><BackButton accessibilityLabel={view === 'month' ? '年表示に戻る' : view === 'year' ? 'ホームに戻る' : '月表示に戻る'} onPress={back} /></View>
      <Pressable accessibilityRole="button" accessibilityLabel="表示する年と月を選択" accessibilityValue={{ text: titleLabel }} accessibilityState={{ expanded: monthPicker }} onPress={() => setMonthPicker(true)} style={styles.titleBlock}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.7} style={styles.title}>{titleLabel}</Text></Pressable>
      <View style={styles.headerActions}>
      <View testID="calendar-view-modes" onTouchStart={() => { modesTouched.current = true; }} onTouchEnd={() => { modesTouched.current = false; }} onTouchCancel={() => { modesTouched.current = false; }} {...modeGesture.panHandlers}>
        <Pressable accessibilityRole="button" ref={helpMode} accessibilityLabel="カレンダーの表示を選択" accessibilityValue={{ text: CALENDAR_DETAIL_LABELS[display.detail] }} accessibilityState={{ expanded: viewMenu }} onPress={() => setViewMenu(true)} style={({ pressed }) => [styles.viewChoice, { width: Math.ceil(68 * Math.max(1, fontScale)) }, pressed && { opacity: .65 }]}>
          <Text style={styles.modeText}>{CALENDAR_DETAIL_LABELS[display.detail]}</Text><SymbolView name={{ ios: 'chevron.down', android: 'keyboard_arrow_down' }} size={11} tintColor={palette.accent} />
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" ref={helpAdd} accessibilityLabel="予定を追加" disabled={!local?.database} onPress={() => openEvent()} style={[styles.add, !local?.database && { opacity: .35 }]}><SymbolView name={{ ios: 'plus', android: 'add' }} size={23} tintColor={palette.accent} /></Pressable>
      </View>
    </View>
    {props.notice}
    {view === 'day' || view === 'two' || view === 'three' ? <CalendarDateStrip date={date} today={today} days={view === 'three' ? 3 : view === 'two' ? 2 : 1} onSelect={next => {
      positioned.current = ''; timelineTop.current = null; chooseDate(next);
    }} /> : null}
    {display.error ? <Text accessibilityRole="alert" style={styles.error}>{display.error}</Text> : null}
    {moveError || local?.error || projection.error || source.draftError ? <View style={styles.errorRow}><Text accessibilityRole="alert" style={styles.error}>{moveError ?? local?.error ?? projection.error ?? source.draftError}</Text>{moveError ? <AppButton title="閉じる" variant="quiet" compact onPress={() => setMoveError(null)} /> : local?.error ? <AppButton title="予定を再読込" variant="quiet" compact onPress={() => void local.refresh()} /> : null}</View> : null}
    {source.draft && !activeEditor ? <Pressable accessibilityRole="button" accessibilityLabel="入力中の予定を再開" onPress={() => { if (drafts.length > 1) setDraftsOpen(true); else setEditor(source.draft); }} style={styles.resume}><Text style={styles.caption}>下書きを再開{drafts.length > 1 ? `（${drafts.length}件）` : ''}</Text><Chevron /></Pressable> : null}
    {view === 'month' ? <View style={styles.weekdays}>{weekdays.map((label, i) => <View key={label} style={styles.weekdayCell}><Text style={styles.weekday}>{label}</Text>
      <View style={styles.weeklyLabels} accessibilityLabel={`${label}曜日${waste.weeklyByColumn[i].length ? `、${waste.weeklyByColumn[i].join('・')}` : ''}`}>
        {waste.weeklyByColumn[i].map(name => <WasteTypeLabel key={name} label={name} size={13} textStyle={styles.gridWasteText} />)}</View>
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
        onEndReached={() => setListDays(n => Math.min(365, n + 28))} renderItem={({ item: day }) => {
          const info = showChores(day) ? props.dayInfo(day) : undefined;
          const events = eventsOn(day);
          const empty = !props.renderWaste && wasteKnown(day) && !japanesePublicHoliday(day) && !waste.weeklyByColumn[parseLocalDate(day).getUTCDay()].some(name => !waste.hiddenWeeklyByDate.get(day)?.includes(name)) && !(waste.byDate.get(day)?.length) && !events.length && (info?.total ?? info?.pending ?? 0) === 0 && info?.loaded !== false && !info?.partial && !local?.error && !projection.error;
          return empty ? <View style={[styles.agendaDay, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, minHeight: 44, gap: 8 }]}>
            <Text style={styles.caption}>{formatJapaneseDate(day, { weekday: true })}</Text><Text style={styles.caption}>予定なし</Text></View>
            : <View style={styles.agendaDay}>{dayHeading(day, true)}{summary(day, info)}
              {events.filter(event => !event.birthday && !event.holiday).map(event => eventRow(event, day))}
              {!events.length && (info?.total ?? info?.pending ?? 0) === 0 && (local?.error || projection.error) ? <Text style={styles.empty}>予定を取得できていません</Text> : null}</View>;
        }} />
        : view === 'week' ? <CalendarWeek date={date} currentMinute={weekStart(date) === weekStart(today) ? currentMinute : null}
          defaultMinute={Math.min(...Array.from({ length: 7 }, (_, i) => eventsOn(addDays(weekStart(date), i)).filter(event => !event.allDay).map(event => event.startMinute)).flat(), 9 * 60)}
          dragging={Boolean(activeDragDay)} activeDay={activeDragDay} hourHeight={hourHeight} onSelect={chooseDate} onReady={weekReady} onScroll={refreshHelpTargets}
          renderHeading={day => <>{dayHeading(day, false, true)}{summaryToggle(day, undefined, true)}</>}
          renderSummary={day => <>{eventsOn(day).filter(event => event.allDay && !event.birthday && !event.holiday).map(event => { const appearance = appearances.get(event.categoryId) ?? fallbackAppearance; return <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${calendarDisplayedTitle(event)}、終日予定を編集`} onPress={() => openEvent(event)} style={[styles.weekAllDay, { backgroundColor: appearance.backgroundColor }]}><CalendarMonthEventTitle title={calendarDisplayedTitle(event)} color={appearance.foregroundColor} backgroundColor={appearance.backgroundColor} lines={2} centerSingleLine={false} onOverflow={() => {}} /></Pressable>; })}{summaryDetails(day)}</>}
          renderDay={timedDay} />
        : <><View testID="calendar-fixed-day-heading" onLayout={event => setDayHeadingHeight(event.nativeEvent.layout.height)} style={[styles.dayColumns, styles.fixedDayHeader, (view === 'two' || view === 'three') && styles.alignedDayColumns]}>{dayList.map(day => <View key={day} style={[styles.dayColumn, styles.headingColumn, view === 'three' && styles.compactHeadingColumn]}>{dayHeading(day)}{summaryToggle(day)}</View>)}</View>
          {expandedChores ? <View testID="calendar-fixed-chores" style={[styles.dayColumns, styles.fixedChores,
            { height: choreHeight }, (view === 'two' || view === 'three') && styles.alignedDayColumns]}>
            {dayList.map(day => <GestureScrollView key={day} simultaneousWith={detailSwipe} disallowInterruption={false} enabled={!activeDragDay} nestedScrollEnabled accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の家事一覧`} style={styles.dayColumn} contentContainerStyle={styles.fixedChoreContent}
              onContentSizeChange={(_width, contentHeight) => setChoreContentHeights(before => before[day] === contentHeight ? before : { ...before, [day]: contentHeight })}>
              {expanded.has(day) ? summaryDetails(day) : null}
            </GestureScrollView>)}
          </View> : null}
          {hasAllDay ? <View testID="calendar-fixed-all-day" style={[styles.dayColumns, styles.fixedChores,
            { height: allDayHeight }, (view === 'two' || view === 'three') && styles.alignedDayColumns]}>
            {allDayColumns.map(({ day, rows, measurement }) => rows.length ? <GestureScrollView key={day} simultaneousWith={detailSwipe} disallowInterruption={false}
              enabled={!activeDragDay} scrollEnabled={!activeDragDay} nestedScrollEnabled accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の終日予定`} style={styles.dayColumn}
              onContentSizeChange={(_width, contentHeight) => measureAllDay(measurement, contentHeight)}>
              {rows.map(event => eventRow(event, day))}
            </GestureScrollView> : <View key={day} style={styles.dayColumn} />)}
          </View> : null}
          <GestureFlatList key={`timeline:${view}:${date}`} ref={scroll} simultaneousWith={detailSwipe} disallowInterruption={false} enabled={!activeDragDay} scrollEnabled={!activeDragDay} style={styles.timelineScroll} testID="calendar-timeline" data={[{ key: 'top' }, { key: 'timeline' }]} keyExtractor={item => item.key} initialNumToRender={2}
          onScroll={event => { timelineOffset.current = event.nativeEvent.contentOffset.y; refreshHelpTargets(); }} scrollEventThrottle={16}
          onLayout={event => { timelineViewport.current = event.nativeEvent.layout.height; positionTime(); }} onContentSizeChange={positionTime} contentContainerStyle={styles.timelineBody} renderItem={({ item: section }) => section.key === 'top' ?
          <View testID="calendar-timeline-days" onLayout={event => { timelineTop.current = event.nativeEvent.layout.height + 8; setTimeout(positionTime, 0); }} />
          : <View style={styles.timeline}>
            {Array.from({ length: 25 }, (_, hour) => <View key={hour} pointerEvents="none" style={[styles.hour, { top: hour * hourHeight }]}><Text style={styles.hourLabel}>{String(hour).padStart(2, '0')}:00</Text><View style={styles.hourRule} /></View>)}
            <View style={styles.timelineColumns} onLayout={event => setTimelineWidth(event.nativeEvent.layout.width)}>{dayList.map(day => <View key={day} style={[styles.timelineColumn, activeDragDay === day && { zIndex: 1 }]}>
              {timedDay(day, dayList, timelineWidth / dayList.length)}
            </View>)}</View>
          </View>} /></>}
      <View pointerEvents="box-none" style={styles.todayDock}><View pointerEvents="box-none" style={styles.calendarActions}>
        <View style={styles.calendarActionSurface}><Pressable accessibilityRole="button" accessibilityLabel="今日" onPress={goToday} style={[styles.search, styles.todayAction]}><Text style={styles.todayActionText}>今日</Text></Pressable></View>
        {undoMove && undoMove.capture.database === local?.database && undoMove.capture.groupId === local?.shared?.groupId ? <View style={styles.calendarActionSurface}><Pressable accessibilityRole="button" accessibilityLabel="移動を元に戻す" onPress={() => void undoLastMove()} style={[styles.search, styles.todayAction]}><Text style={[styles.caption, { color: palette.accent }]}>元に戻す</Text></Pressable></View> : null}
        <View style={styles.calendarActionSurface}><View ref={helpSearch} style={styles.searchHelpGroup}>
          <Pressable accessibilityRole="button" accessibilityLabel="予定を検索する" disabled={!local?.database} onPress={() => setSearchOpen(true)} style={({ pressed }) => [styles.searchHelpControl, pressed && styles.searchHelpPressed, !local?.database && { opacity: .35 }]}><SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={20} tintColor={palette.accent} /></Pressable>
          <View style={styles.searchHelpDivider} />
          <Pressable accessibilityRole="button" accessibilityLabel="カレンダーのヘルプを開く" onPress={calendarHelp.show} style={({ pressed }) => [styles.searchHelpControl, pressed && styles.searchHelpPressed]}><SymbolView name={{ ios: 'questionmark', android: 'question_mark' }} size={20} tintColor={palette.accent} /></Pressable>
        </View></View>
      </View></View>
      {view === 'month' ? monthDrag.overlay : null}
    </View>
    </GestureDetector></GestureHandlerRootView>
    </View>
    {moveScopeOpen ? <CalendarRecurrenceScopePicker onSelect={answerMoveScope} onClose={() => answerMoveScope(null)} /> : null}
    {calendarHelp.open ? <CalendarHelp onClose={calendarHelp.close} onShow={calendarHelp.onShow} view={view} measureTargets={measureHelpTargets} /> : null}
    {searchOpen && local ? <CalendarSearch local={local} focusDate={today} chores={props.searchChores} choresIncomplete={props.searchChoresIncomplete} onClose={() => setSearchOpen(false)} resolveSelection={draft => {
      const destination = calendarSearchDestination(draft, source.events, source.exceptions, today, timeZone);
      setSearchFocus({ eventId: draft.eventId, ...destination }); return destination;
    }} onSelect={destination => {
      setSearchOpen(false); if (destination.choreKey) { setSearchFocus({ eventId: null, ...destination }); setExpanded(before => new Set([...before, destination.date])); } clearTimeout(searchFocusTimer.current); searchFocusTimer.current = setTimeout(() => setSearchFocus(null), 2500); preferred.current = Number(destination.date.slice(-2));
      if (date === destination.date && view === display.detail && (view === 'day' || view === 'two' || view === 'three' || view === 'week')) positioned.current = '';
      else navigateMonth(calendarMonth(destination.date), preferred.current, display.detail);
      searchPosition.current = display.detail === 'list' ? null : destination;
      clearTimeout(todayTimer.current); todayTimer.current = setTimeout(() => recenter.current(), 0);
    }} /> : null}
    {draftsOpen && local ? <View style={StyleSheet.absoluteFill}><CalendarDraftList drafts={drafts} local={local} onClose={() => setDraftsOpen(false)} onSelect={draft => { setDraftsOpen(false); setEditor(draft); }} /></View> : null}
    </View>{props.footer}
    {viewMenu ? <CalendarViewMenu value={display.detail} {...(view === 'month' ? { monthDetail: monthDetail.value, onMonthDetail: monthDetail.select } : {})} titleShortening={titleDisplay.value} onTitleShortening={titleDisplay.select} onSelect={chooseView} onClose={() => setViewMenu(false)} /> : null}
    {monthPicker ? <CalendarMonthPicker month={view === 'year' ? `${year}-${month.slice(5, 7)}-01` as LocalDate : month}
      onSelect={next => navigateMonth(next, preferred.current, view)} onClose={() => setMonthPicker(false)} /> : null}
    {activeEditor && local ? <CalendarEditor key={`${activeEditor.eventId ?? 'new'}:${activeEditor.anchorDate ?? ''}:${returnedDraft ? routeParams.calendarDraftVersion : ''}`} initial={activeEditor} local={local} chores={props.existingChores} onDuplicate={draft => setEditor(draft)} renderChoreRegistration={sheet => sheet.audience === 'group' && props.renderChoreRegistration ? props.renderChoreRegistration(sheet) : <PersonalCalendarChoreRegistration {...sheet} local={local} />} repeatReturnTo={props.repeatReturnTo} displayTimeZone={timeZone} onClose={closeEditor} onSaved={day => {
      closeEditor(); if (view === 'month' || view === 'year') navigateMonth(calendarMonth(day), Number(day.slice(-2))); else chooseDate(day);
    }} /> : null}
  </View>;
}

export function CalendarFooter({ onNavigate }: { onNavigate: NonNullable<PlannerCalendarProps['onNavigate']> }) {
  const styles = usePlannerBorderStyles(baseStyles);
  const insets = useSafeAreaInsets();
  const tabs = [['home', 'ホーム', { ios: 'house', android: 'house' }], ['calendar', 'カレンダー', { ios: 'calendar', android: 'calendar_month' }],
    ['chores', '家事', { ios: 'checklist', android: 'checklist' }], ['appliances', '家電', { ios: 'robotic.vacuum', android: 'vacuum' }]] as const;
  return <View style={[styles.footer, { paddingBottom: Math.max(8, insets.bottom) }]}>{tabs.map(([tab, label, icon]) => <Pressable key={tab} accessibilityRole="button" accessibilityLabel={`${label}へ`} accessibilityState={{ selected: tab === 'calendar' }} onPress={() => onNavigate(tab)} style={styles.footerTab}>
    <SymbolView name={icon} size={21} tintColor={tab === 'calendar' ? palette.accent : palette.muted} /><Text style={[styles.footerLabel, tab === 'calendar' && { color: palette.accent }]}>{label}</Text></Pressable>)}</View>;
}
const baseStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, header: { ...navigationHeaderMetrics, gap: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  headerBack: { alignSelf: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  titleBlock: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', alignItems: 'center' }, title: { ...typography.body, fontWeight: '700', color: palette.ink },
  viewChoice: { minHeight: 44, minWidth: 44, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.elevated, borderRadius: 10 }, modeText: { ...typography.caption, color: palette.accent },
  todayDock: { position: 'absolute', left: 10, right: 10, bottom: 10 },
  calendarActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarActionSurface: { padding: 3, backgroundColor: palette.surface, borderRadius: 13 },
  searchHelpGroup: { flexDirection: 'row', borderWidth: 1, borderColor: palette.border, borderRadius: 10, overflow: 'hidden' },
  searchHelpControl: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  searchHelpDivider: { width: 1, alignSelf: 'stretch', marginVertical: 9, backgroundColor: palette.border }, searchHelpPressed: { backgroundColor: palette.accentSoft },
  dockedBody: { paddingBottom: 76 },
  add: { minWidth: 56, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: palette.accentSoft },
  search: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.border, borderRadius: 10 },
  todayAction: { width: undefined, minWidth: 56, paddingHorizontal: 12 }, todayActionText: { ...typography.label, color: palette.accent, fontWeight: '600' },
  viewport: { flex: 1, overflow: 'hidden' }, weekdays: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, weekdayCell: { width: `${100 / 7}%`, alignItems: 'center', paddingTop: 5, paddingBottom: 5, minHeight: 32, gap: 1 },
  weekday: { ...typography.calendarLabel, color: palette.muted }, weeklyLabels: { gap: 1, alignItems: 'center', maxWidth: '100%' },
  week: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, monthColumn: { width: `${100 / 7}%`, minWidth: 0, flexShrink: 0 }, dayCell: { paddingVertical: MONTH_CELL_PADDING, paddingHorizontal: 1, borderRightWidth: 1, borderColor: palette.border, overflow: 'hidden', gap: MONTH_CELL_GAP },
  monthBoundary: { height: MONTH_HEADING_HEIGHT, paddingLeft: 7, justifyContent: 'center', borderColor: palette.border }, monthBoundaryTitle: { ...typography.section, fontWeight: '700', color: palette.ink },
  firstDayCell: { borderLeftWidth: 1 }, monthFirstWeek: { borderTopWidth: 1, borderTopColor: palette.border },
  hiddenDay: { backgroundColor: palette.elevated }, hiddenOutline: { borderWidth: 1.5, borderColor: palette.muted },
  dayNumberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: MONTH_DATE_HEIGHT, flexShrink: 0 }, dayNumber: { ...typography.calendarDate, color: palette.ink, fontWeight: '500', minWidth: 28, height: 28, textAlign: 'center', paddingTop: 2, borderRadius: 14 },
  todayNumber: { color: palette.accentInk, backgroundColor: palette.accent, fontWeight: '800' }, selectedNumber: { color: palette.accent, backgroundColor: palette.accentSoft },
  gridWasteText: { fontSize: 12, lineHeight: 16 },
  monthCount: { marginTop: 'auto', minHeight: MONTH_SUMMARY_HEIGHT, flexShrink: 0, backgroundColor: palette.elevated, borderRadius: 4, alignItems: 'center' }, monthCountText: { fontSize: 12, lineHeight: MONTH_SUMMARY_HEIGHT, color: palette.muted }, monthCountNumber: { fontSize: 13, fontWeight: '700', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning, flex: 1 }, errorRow: { paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', gap: 8, alignItems: 'center' },
  resume: { paddingHorizontal: 12, minHeight: 38, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  summary: { flexDirection: 'row', gap: 5, alignItems: 'center', minHeight: 36, paddingHorizontal: 8 }, summaryTitle: { ...typography.label, color: palette.ink, fontWeight: '500', flex: 1 }, choreList: { gap: 0, paddingHorizontal: 2, paddingBottom: 4 },
  overlapNotice: { ...typography.small, color: palette.gold, paddingHorizontal: 10, paddingBottom: 4 },
  dayHeading: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingTop: 7, paddingBottom: 3 }, dayTitle: { ...typography.label, color: palette.ink, fontWeight: '600', textAlign: 'center' },
  agendaHeading: { justifyContent: 'flex-start', paddingHorizontal: 12 },
  dayHeadingMain: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, agendaHeadingMain: { justifyContent: 'flex-start' },
  weekAllDay: { marginHorizontal: 1, marginBottom: 3, padding: 1, borderRadius: 5, minHeight: 30, justifyContent: 'center' },
  weekHeading: { alignItems: 'center', paddingVertical: 4, gap: 2 }, weekWeekday: { fontSize: 11, lineHeight: 14, color: palette.muted }, weekNumber: { ...typography.calendarDate, color: palette.ink }, weekMeta: { fontSize: 10, lineHeight: 14, color: palette.muted },
  weekDate: { minHeight: 30, minWidth: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  weekSummary: { minHeight: 32, paddingHorizontal: 2, flexDirection: 'row', gap: 1, justifyContent: 'center', alignItems: 'center' }, weekSummaryText: { fontSize: 10.5, lineHeight: 16, color: palette.ink, flexShrink: 1 },
  weekTimedEvent: { borderLeftWidth: 0, paddingHorizontal: 1, paddingVertical: 1, borderRadius: 3 }, weekTime: { fontSize: 10.5, lineHeight: 18 },
  dayHeadingDate: { minWidth: 0, flexShrink: 1 }, dayStatus: { ...typography.small, color: palette.muted, flexShrink: 0 },
  inlineSummary: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 36, flexShrink: 0 },
  birthday: { flexDirection: 'row', gap: 3, alignItems: 'center', flexShrink: 1, minWidth: 0, maxWidth: '65%' }, dayColumns: { flexDirection: 'row' }, dayColumn: { flex: 1, minWidth: 0, borderRightWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  eventRow: { minHeight: 48, paddingVertical: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  eventTime: { ...typography.caption, color: palette.muted, minWidth: 39, flexShrink: 0 }, eventStripe: { width: 3, alignSelf: 'stretch', borderRadius: 2 }, eventText: { flex: 1, gap: 1 }, eventTitle: { ...typography.body, color: palette.ink, fontWeight: '600' },
  agendaDay: { paddingBottom: 10, borderBottomWidth: 1, borderColor: palette.border }, empty: { ...typography.caption, color: palette.muted, paddingHorizontal: 12, paddingVertical: 8 },
  alignedDayColumns: { marginLeft: timeGutter, borderLeftWidth: 1, borderLeftColor: palette.border },
  fixedDayHeader: { backgroundColor: palette.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  headingColumn: { justifyContent: 'space-between' }, compactHeadingColumn: { justifyContent: 'flex-start' },
  compactDayHeading: { paddingTop: 4, paddingBottom: 0, gap: 0 }, compactDaySummary: { minHeight: 32 },
  fixedChores: { flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, backgroundColor: palette.background }, fixedChoreContent: { paddingBottom: 4 },
  timelineScroll: { flex: 1, minHeight: 0 },
  holiday: { ...typography.caption, color: palette.warning, maxWidth: '100%' },
  timelineBody: { paddingBottom: 76 }, timeline: { height: 24 * hourHeight + 15, marginTop: 8 }, hour: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center' }, hourLabel: { fontSize: 12, lineHeight: 18, color: palette.muted, width: timeGutter, textAlign: 'center', transform: [{ translateY: -9 }] }, hourRule: { flex: 1, height: 1, backgroundColor: palette.border },
  timelineColumns: { marginLeft: timeGutter, flexDirection: 'row', height: '100%', borderLeftWidth: 1, borderColor: palette.border }, timelineColumn: { flex: 1, minWidth: 0, borderRightWidth: 1, borderColor: palette.border },
  timedEvent: { position: 'absolute', borderLeftWidth: 3, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' }, timedTitle: { ...typography.label, color: palette.ink, fontWeight: '600' },
  now: { position: 'absolute', left: 0, right: 0, borderTopWidth: 1.5, borderColor: palette.accent, height: 1 }, nowDot: { position: 'absolute', left: -4, top: -4, width: 7, height: 7, borderRadius: 4, backgroundColor: palette.accent }, nowLabel: { position: 'absolute', right: 3, bottom: 3, paddingHorizontal: 3, fontSize: 11, lineHeight: 15, color: palette.accent, backgroundColor: palette.background },
  footer: { minHeight: 62, flexDirection: 'row', borderTopWidth: 1, borderColor: palette.border, backgroundColor: palette.surface }, footerTab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 56 }, footerLabel: { ...typography.tab, color: palette.muted },
});
