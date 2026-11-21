import { V2ChoreSettingsBook } from './chore-settings-book';
import { ChoreLibraryPane, useChoreLibraryState } from '../../chores/chore-library';
import { buildHomeRows } from './home-rows';
import type { HomeWeekScope } from '../../planner/home-presentation';
import { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/components/screen-safe-area';
import { AppButton, BackButton, Card, NavigationHeader, palette, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { V2RoundCard } from './round-card';
import { V2DateForm } from './date-form';
import { V2CompletionForm } from './completion-form';
import { V2DateRequests } from './date-requests';
import { V2AssignmentForm } from './assignment-form';
import { V2AssignmentRequests } from './assignment-requests';
import { V2Calendar } from './calendar';
import { v2CalendarMonth } from './calendar-projection';
import { v2CalendarDisplayRange } from './calendar-range';
import type { WorkspaceDisplayValue } from './workspace-display-store';
import type { LocalDate } from '../../../domain/shared/types';
import { daysBetween } from '../../../domain/scheduling/local-date';
import { calendarRegistrationDate } from '../../calendar/registration-date';
import { SettingsHeader } from '../../../components/settings-header';
import { V2HistoryContent } from './history-content';
import { V2FormScrollView } from './form-controls';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2GroupUiSession } from './screen-session';
import { millisecondsUntilNextSharedDay } from '../group-clock';
import { privateOverlayForViewer } from './private-overlay';
import { V2PrivateTaskCard, V2PrivateTaskNotice } from './private-task-card';
import { V2ChoreList } from './chore-list';
import { V2AddChore } from './add-chore';
import { V2ChoreProcedures } from './chore-procedures';
import { V2GroupPolicyEditor } from './group-policy-editor';
import { V2DateRightsEditor } from './date-rights-editor';
import type { V2MutationOutcome } from './mutation-outcome';
import { V2WasteScreen } from './waste-screen';
import { V2WasteOccurrence } from './waste-occurrence';
import { V2ApplianceScreen } from './appliance-screen';
import { V2ApplianceLibrary } from './appliance-library';
import { V2ChoreBook, type PersonalGuideSource } from './chore-book';
import type { CompletionFeedback } from './completion-feedback';
import { HomeMotionList } from '../../../components/home-row-motion';
import { HomeHeader, homeHeaderContainerStyle, HomeLinks, HomeProgress, HomeWeekSwitcher, HomeUpcomingDate, HomeExpiredHeading, LoadSortButton, CompletionToast } from '../../../components/home-ui';
import { finishStartupDisplay } from '../../../platform/diagnostics/startup-splash';
import { useHomeDisplay } from '../../../hooks/use-home-display';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import type { PlannerCalendarProps } from '../../calendar/planner-calendar';
import { calendarChoreDisplayThrough } from '../../calendar/chore-display-range';
import type { ChoreAudienceSelection } from '../../chores/audience-selection';
import { personalCompletionKey } from '../../planner/completion-command';
import type { CompletionIntentState } from '../../planner/completion-intents';
import { V2ChoreAdvancedSettings } from './chore-advanced-settings';
import type { CompletionIntentRuntime } from '../../../platform/storage/completion-intents';

const noCompletionChanges = () => () => {};
const emptyCompletionState: CompletionIntentState = { values: new Map(), pending: new Set(), failed: new Set(), restored: false, error: null };
const noCompletionState = () => emptyCompletionState;

export interface V2GroupScreenProps {
  sharedCompletion?: CompletionIntentRuntime;
  personalCompletion?: CompletionIntentRuntime;
  invalidateCompletionDisplay?: () => void;
  settingsSelection?: ChoreAudienceSelection;
  initialDisplay?: WorkspaceDisplayValue;
  lifecycleManaged?: boolean;
  localCalendar?: LocalCalendarBinding; onCalendarNavigate?: PlannerCalendarProps['onNavigate'];
  purpose: 'development' | 'workspace'; workspaceName?: string; workspaceError?: string; onManage?: () => void;
  subscribe?: (changed: () => void) => () => void;
  loadSession: () => Promise<V2GroupUiSession>; view: 'home' | 'configuration' | 'history' | 'round' | 'date' | 'requests' | 'assignment' | 'assignmentRequests' | 'calendar' | 'chores' | 'details' | 'advancedSettings' | 'addChore' | 'groupPolicy' | 'dateRights' | 'waste' | 'appliances' | 'appliance' | 'applianceReview' | 'guide'; choreId?: string; applianceId?: string;
  occurrenceId?: string; subjectId?: string; anchorDate?: string; targetDate?: string; calendarAdd?: boolean; onRound?: (occurrenceId: string, subjectId: string, anchorDate?: string) => void; onDate?: (occurrenceId: string, subjectId: string, targetDate?: LocalDate, anchorDate?: LocalDate) => void;
  onBack: () => void; onConfiguration: (choreId: string) => void; onHistory: () => void; onRequests?: () => void;
  onAssignment?: (occurrenceId: string, subjectId?: string, anchorDate?: LocalDate) => void; onAssignmentRequests?: () => void;
  onCalendar?: () => void; personalGuide?: PersonalGuideSource; guideSource?: 'shared' | 'personal'; onGuide?: (choreId: string, source: 'shared' | 'personal') => void;
  onManageChores?: () => void; onDetails?: (choreId: string) => void; onAddChore?: (date?: LocalDate) => void; onChoreCreated?: (choreId: string) => void;
  onGroupPolicy?: () => void; onNotifications?: () => void; onGoogleTasks?: () => void; onPersonalCopy?: () => void;
  onDateRights?: (choreId: string) => void;
  onWaste?: () => void;
  onAppliances?: () => void; onAppliance?: (id: string) => void; onApplianceReview?: (id?: string) => void;
  onPersonalAppliance?: (id: string) => void; onPersonalApplianceReview?: (id?: string) => void;
}

export function readOptionsForView(view: V2GroupScreenProps['view'], anchorDate?: string, choreId?: string, applianceId?: string): Parameters<V2GroupUiSession['readModel']>[0] {
  if (view === 'appliances' || view === 'appliance' || view === 'applianceReview') return { management: true, appliances: true, applianceId };
  if (view === 'waste') return { management: true, waste: true };
  if (view === 'groupPolicy') return { management: true, groupPolicy: true };
  if (view === 'dateRights') return { management: true, permissionsChoreId: choreId };
  if (view === 'details' || view === 'configuration' || view === 'advancedSettings') return { management: true, choreSettings: true };
  if (view === 'guide' || view === 'chores') return undefined;
  if (view === 'addChore') return anchorDate ? { focusDate: anchorDate } : { management: true };
  if (anchorDate) return { focusDate: anchorDate, ...(['calendar', 'home'].includes(view) ? { waste: true } : {}), ...(view === 'calendar' ? { wasteCalendarPolicy: true } : {}) };
  return view === 'calendar' ? { calendarMonth: 'current', waste: true, wasteCalendarPolicy: true } : view === 'home' ? { waste: true } : undefined;
}

export function V2GroupScreen({ purpose, workspaceName, workspaceError, onManage, subscribe, loadSession, view, choreId, settingsSelection, applianceId, onBack, onConfiguration, onHistory, onRequests, occurrenceId, subjectId, onRound, onDate, onAssignment, onAssignmentRequests, onCalendar, anchorDate, targetDate, calendarAdd, onManageChores, onDetails, onAddChore, onChoreCreated, onGroupPolicy, onNotifications, onGoogleTasks, onPersonalCopy, onDateRights, onWaste, onAppliances, onAppliance, onApplianceReview, localCalendar, onCalendarNavigate, onGuide, personalGuide, guideSource, onPersonalAppliance, onPersonalApplianceReview, initialDisplay, lifecycleManaged = false, sharedCompletion, personalCompletion, invalidateCompletionDisplay }: V2GroupScreenProps) {
  const libraryState = useChoreLibraryState();
  const [session, setSession] = useState<V2GroupUiSession | null>(initialDisplay?.session ?? null); const [screenModel, setModel] = useState<Awaited<ReturnType<V2GroupUiSession['readModel']>> | null>(initialDisplay?.model ?? null);
  const composition = useMemo(() => {
    if (!screenModel) return null;
    const { personal, privateOverlay: privateValue, ...model } = screenModel; return { personal, privateValue, model };
  }, [screenModel]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [weekScope, setWeekScope] = useState<HomeWeekScope>('current');
  const [expiredExpanded, setExpiredExpanded] = useState(false);
  const [proceduresOpen, setProceduresOpen] = useState(true);
  const [legacyCompletionValues, setCompletionValues] = useState(new Map<string, boolean>());
  const sharedIntents = useSyncExternalStore(sharedCompletion?.queue.subscribe ?? noCompletionChanges, sharedCompletion?.queue.getSnapshot ?? noCompletionState, noCompletionState);
  const personalIntents = useSyncExternalStore(personalCompletion?.queue.subscribe ?? noCompletionChanges, personalCompletion?.queue.getSnapshot ?? noCompletionState, noCompletionState);
  const hasPersonalIntents = personalIntents.values.size > 0;
  const personalAliases = useMemo(() => {
    const aliases = new Map<string, Set<string>>(); const overlay = composition?.privateValue;
    if (hasPersonalIntents && overlay?.status === 'ready') for (const rows of [overlay.home, ...overlay.byDate.values()]) for (const row of rows) {
      try { const key = personalCompletionKey(row.revision); const names = aliases.get(key) ?? new Set<string>(); names.add(row.key); aliases.set(key, names); } catch { /* Invalid cached rows remain non-authoritative. */ }
    }
    return aliases;
  }, [composition?.privateValue, hasPersonalIntents]);
  const completionValues = useMemo(() => {
    if (!sharedIntents.values.size && !personalIntents.values.size) return legacyCompletionValues;
    const values = new Map(legacyCompletionValues);
    for (const [key, completed] of sharedIntents.values) values.set(key, completed);
    for (const [key, completed] of personalIntents.values) for (const alias of personalAliases.get(key) ?? []) values.set(alias, completed);
    return values;
  }, [legacyCompletionValues, sharedIntents.values, personalIntents.values, personalAliases]);
  const feedbackEpoch = useRef(0);
  const display = useHomeDisplay();
  // The checked glyph follows the accepted intent immediately. Rebuilding the
  // dated list and moving the row can take place in the following render.
  const orderedCompletions = useDeferredValue(view === 'home' ? completionValues : null);
  const home = useMemo(() => view === 'home' && composition?.personal && orderedCompletions
    ? buildHomeRows(composition.model, composition.personal, privateOverlayForViewer(composition.privateValue, composition.model.viewerUserId),
      weekScope, display.order, orderedCompletions, expiredExpanded)
    : null, [view, composition, orderedCompletions, weekScope, display.order, expiredExpanded]);
  const insets = useSafeAreaInsets();
  const [lastUndo, setLastUndo] = useState<{ undo: () => Promise<unknown>; queuedKey?: string } | null>(null);
  const undoFailed = lastUndo?.queuedKey && (sharedIntents.failed.has(lastUndo.queuedKey) || personalIntents.failed.has(lastUndo.queuedKey));
  useEffect(() => { if (!lastUndo || busy && !lastUndo.queuedKey) return; const timer = setTimeout(() => setLastUndo(null), 6500); return () => clearTimeout(timer); }, [lastUndo, busy]);
  const alive = useRef(false); const generation = useRef(0); const running = useRef(false);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mutationRead = useRef(false); const refreshQueued = useRef(false);
  const readOptions = useRef(readOptionsForView(view, anchorDate, choreId, applianceId));
  const readBinding = useRef({ anchorDate, view, choreId, applianceId });
  const sessionLoader = useRef(loadSession);
  const refreshPending = useRef<{ options: typeof readOptions.current; revision: number; work: Promise<boolean> } | undefined>(undefined);
  useLayoutEffect(() => { sessionLoader.current = loadSession; }, [loadSession]);
  const [calendarMonth, setCalendarMonth] = useState<LocalDate | null>(null); const [calendarDay, setCalendarDay] = useState<LocalDate | null>(null);
  const refresh = useCallback(() => {
    clearTimeout(notificationTimer.current); notificationTimer.current = undefined;
    const options = readOptions.current;
    const pending = refreshPending.current;
    // Publishing a prepared display notifies this screen during its own read.
    // Join that read so the saved gesture can acknowledge it, rather than
    // superseding itself and retaining a stale optimistic value indefinitely.
    if (pending && pending.options === options && pending.revision === generation.current) return pending.work;
    const revision = ++generation.current;
    const work = (async () => { try {
      const preview = await sessionLoader.current(); const value = await preview.readModel(options);
      if (alive.current && generation.current === revision) {
        setSession(preview); setModel(value); setError(null);
        setCompletionValues(values => values.size ? new Map() : values);
        return true;
      } return false;
    } catch (cause) { if (alive.current && generation.current === revision) setError(cause instanceof Error ? cause.message : '共有データを読み込めませんでした。'); return false; } })();
    const reading = { options, revision, work }; refreshPending.current = reading;
    void work.finally(() => { if (refreshPending.current === reading) refreshPending.current = undefined; });
    return work;
  }, []);
  useEffect(() => {
    const read = async () => { invalidateCompletionDisplay?.(); if (!await refresh()) throw new Error('表示を更新できませんでした。'); };
    const stops = [sharedCompletion, personalCompletion].flatMap(runtime => runtime ? [runtime.watchDisplay(read, () => alive.current)] : []);
    return () => { stops.forEach(stop => stop()); };
  }, [sharedCompletion, personalCompletion, invalidateCompletionDisplay, refresh]);
  useFocusEffect(useCallback(() => {
    alive.current = true;
    if (readBinding.current.anchorDate !== anchorDate || readBinding.current.view !== view || readBinding.current.choreId !== choreId || readBinding.current.applianceId !== applianceId) {
      readOptions.current = readOptionsForView(view, anchorDate, choreId, applianceId);
      readBinding.current = { anchorDate, view, choreId, applianceId };
    }
    void refresh(); sharedCompletion?.queue.retryRead(); personalCompletion?.queue.retryRead();
    return () => { alive.current = false; setLastUndo(null); feedbackEpoch.current++; setCompletionValues(new Map()); generation.current++; clearTimeout(notificationTimer.current); refreshQueued.current = false; };
  }, [refresh, anchorDate, view, choreId, applianceId, sharedCompletion, personalCompletion]));
  // Restoring a live provider may replace its subscription while this route is
  // still focused. Rebind observation without cancelling the pending user action.
  useEffect(() => {
    const unsubscribe = subscribe?.(() => {
      clearTimeout(notificationTimer.current);
      if (!alive.current) return;
      if (running.current) { if (mutationRead.current) refreshQueued.current = true; return; }
      if (lifecycleManaged) { void refresh(); return; }
      notificationTimer.current = setTimeout(() => { notificationTimer.current = undefined; if (alive.current) void refresh(); }, 80);
    });
    const foreground = lifecycleManaged ? undefined : AppState.addEventListener('change', state => {
      if (state !== 'active' || !alive.current) return;
      // Navigation focus does not change when a suspended app returns after midnight.
      if (running.current) { refreshQueued.current = true; return; }
      clearTimeout(notificationTimer.current);
      notificationTimer.current = setTimeout(() => { notificationTimer.current = undefined; if (alive.current) void refresh(); }, 80);
    });
    return () => { unsubscribe?.(); foreground?.remove(); };
  }, [refresh, subscribe, lifecycleManaged]);
  useEffect(() => {
    if (!screenModel || lifecycleManaged) return;
    const zones = [screenModel.plan.timeZone, ...(screenModel.privateOverlay?.status === 'ready' ? [screenModel.privateOverlay.timeZone] : [])];
    const delay = Math.min(...zones.map((zone) => millisecondsUntilNextSharedDay(new Date(), zone)));
    const timer = setTimeout(() => { if (!alive.current) return; if (running.current) refreshQueued.current = true; else void refresh(); }, delay);
    return () => clearTimeout(timer);
  }, [screenModel, refresh, lifecycleManaged]);
  const perform = async (work: () => Promise<unknown>, invalidate = true): Promise<V2MutationOutcome> => {
    if (running.current) return { committed: false, refreshed: false, error: new Error('保存中の操作が終わってから、もう一度お試しください。') };
    running.current = true; generation.current++; clearTimeout(notificationTimer.current); setBusy(true); setError(null);
    let failure: unknown; let failed = false;
    try { await work(); } catch (cause) { failed = true; failure = cause; }
    if (invalidate) session?.invalidate?.();
    let loaded = false;
    try {
      mutationRead.current = true; loaded = await refresh();
      if (alive.current) {
        if (failed) setError(failure instanceof Error ? failure.message : '操作を完了できませんでした。');
        else if (!loaded) setError('表示を更新できませんでした。画面を開き直して現在の状態を確認してください。');
      }
    } finally {
      mutationRead.current = false; running.current = false; if (alive.current) setBusy(false);
      if (refreshQueued.current && alive.current) { refreshQueued.current = false; void refresh(); }
    }
    return { committed: !failed, refreshed: loaded, ...(failed ? { error: failure } : {}) };
  };
  const feedback: CompletionFeedback = { values: completionValues,
    supports: kind => Boolean(kind === 'shared' ? sharedCompletion : personalCompletion),
    request: (key, completed, target) => {
      try {
        const runtime = target.kind === 'shared' ? sharedCompletion : personalCompletion;
        if (!runtime) throw new Error('完了操作の保存先を確認できません。');
        const targetKey = target.kind === 'shared' ? key : personalCompletionKey(target.command.revision);
        const accepted = runtime.queue.request(targetKey, target, completed);
        if (accepted && view === 'home') startTransition(() => {
          setLastUndo(completed ? { queuedKey: targetKey, undo: async () => runtime.queue.request(targetKey, target, false) } : null);
        });
        return accepted;
      } catch { setError('完了操作の保存先を確認できません。'); return false; }
    },
    run: async (key, completed, work) => {
    if (running.current || !alive.current) return;
    const epoch = feedbackEpoch.current;
    setLastUndo(null);
    let undo: (() => Promise<unknown>) | undefined;
    setCompletionValues(values => new Map(values).set(key, completed));
    const result = await perform(async () => { const value = await work(); if (value && typeof value === 'object' && 'undo' in value && typeof value.undo === 'function') undo = value.undo as () => Promise<unknown>; });
    if (alive.current && epoch === feedbackEpoch.current && result.committed && result.refreshed && undo && view === 'home') setLastUndo({ undo });
    if (alive.current && epoch === feedbackEpoch.current && (!result.committed || result.refreshed)) {
      setCompletionValues(values => { const next = new Map(values); next.delete(key); return next; });
    }
  } };
  const run = async (work: () => Promise<unknown>) => { await perform(work); };
  const groupName = typeof screenModel?.plan.commonSettings.name === 'string' ? screenModel.plan.commonSettings.name : workspaceName ?? '共有グループ';
  const actionError = error ?? sharedIntents.error ?? personalIntents.error;
  const retryCompletion = sharedIntents.failed.size || personalIntents.failed.size ? <AppButton title="保存を再試行" variant="quiet" compact
    onPress={() => { sharedCompletion?.queue.retryFailed(); personalCompletion?.queue.retryFailed(); }} /> : null;
  const notice = purpose === 'development' || workspaceError || actionError ? <View style={styles.notice}>
    {purpose === 'development' ? <Text style={styles.caption}>検査用の独立したデータです。既存データやログイン中のアカウントを使わず、共有操作をクラウドへ送信しません。</Text> : null}
    {workspaceError ? <Text accessibilityRole="alert" style={styles.error}>{workspaceError}</Text> : null}
    {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
    {retryCompletion}
  </View> : null;
  if ((!screenModel || !session) && (view === 'details' || view === 'configuration')) return <V2ScreenFrame purpose={purpose} startupReady={Boolean(error)} style={styles.safe} edges={['top']}>
    <NavigationHeader><View style={styles.settingsHeader}><BackButton onPress={onBack} /><Text style={styles.settingsHeaderTitle}>家事ごとの設定</Text></View></NavigationHeader>
    <View style={styles.page}>{error ? <><Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></> : <ActivityIndicator color={palette.accent} />}</View>
  </V2ScreenFrame>;
  if (!screenModel || !session) return <V2ScreenFrame purpose={purpose} startupReady={Boolean(error)} style={styles.safe}>{notice}<ActivityIndicator color={palette.accent} />
    <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></V2ScreenFrame>;
  // Strip local composition before passing the common model to shared forms and actions.
  const { personal, privateValue, model } = composition!;
  const privateOverlay = privateOverlayForViewer(privateValue, model.viewerUserId);
  const controller = session.controller;
  if (applianceId && (view === 'appliance' || view === 'applianceReview') && model.appliances?.detail?.row.id !== applianceId) return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <NavigationHeader><BackButton onPress={onBack} /></NavigationHeader>{notice}<Text style={styles.error}>対象の共有家電を表示できません。一覧から開き直してください。</Text>
    <AppButton title="家電を再読込" disabled={busy} onPress={() => void refresh()} />
  </V2ScreenFrame>;
  if (view === 'appliances') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2ApplianceLibrary model={model} personal={personalGuide?.snapshot.appliances} personalDatabase={personalGuide?.database} busy={busy}
      header={notice}
      onOpen={onAppliance} onReview={onApplianceReview} onPersonal={onPersonalAppliance} onPersonalReview={onPersonalApplianceReview} />
  </V2ScreenFrame>;
  if (view === 'appliance' || view === 'applianceReview') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2ApplianceScreen key={`${view}:${applianceId ?? 'new'}`} model={model} mode={view} applianceId={applianceId} actions={controller.actions} busy={busy} perform={perform}
      header={notice} personalDatabase={personalGuide?.database} onBack={onBack} onOpen={onAppliance} onReview={onApplianceReview} onConfiguration={onConfiguration} onDetails={onDetails} />
  </V2ScreenFrame>;
  if (view === 'waste') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2WasteScreen model={model} actions={controller.actions} busy={busy} perform={perform} header={notice} onBack={onBack} />
  </V2ScreenFrame>;
  if (view === 'dateRights') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2DateRightsEditor model={model} choreId={choreId ?? ''} controller={controller} onBack={onBack} onGroupPolicy={onGroupPolicy} header={notice}
      onSaved={async () => { if (!await refresh()) throw new Error('保存済みです。表示を更新するため画面を開き直してください。'); }} />
  </V2ScreenFrame>;
  if (view === 'groupPolicy') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2GroupPolicyEditor model={model} controller={controller} onBack={onBack} header={notice}
      onSaved={async () => { if (!await refresh()) throw new Error('保存済みです。表示を更新するため画面を開き直してください。'); }} />
  </V2ScreenFrame>;
  if (view === 'chores' || view === 'guide') return <ChoreLibraryPane
    library={<V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
      <V2ChoreList model={model} busy={busy} onDetails={onDetails ?? onConfiguration} onConfiguration={onConfiguration} onAdd={onAddChore} personal={personalGuide} onOpen={onGuide} libraryState={libraryState}
        header={<View style={{ gap: 14 }}><ScreenHeading title="家事一覧" />{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>} />
    </V2ScreenFrame>}
    detail={view === 'guide' ? <V2ChoreBook key={`${guideSource}:${choreId}`} model={model} personal={personalGuide} selectedId={choreId} source={guideSource} onBack={onBack} onConfiguration={onConfiguration} groupName={groupName} actions={controller.actions} perform={perform} hasTabBar /> : null} />;
  if (view === 'addChore') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    {calendarAdd && !calendarRegistrationDate(anchorDate) ? <><BackButton onPress={onBack} /><Text accessibilityRole="alert" style={styles.error}>家事を登録する日付を選び直してください。</Text></> : <V2AddChore model={model} actions={controller.actions} busy={busy} run={run} header={notice} onBack={onBack} onCreated={onChoreCreated ?? onDetails ?? onConfiguration}
      calendarDate={calendarAdd ? calendarRegistrationDate(anchorDate) : undefined}
      onOpenScheduled={(choreId, date) => {
        const rows = [...model.plan.occurrences, ...(model.calendarLong ?? [])].filter(round => round.choreId === choreId && round.activeInPeriod)
          .flatMap(round => round.subjects.filter(subject => subject.required && (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId))
            .map(subject => ({ round, subject, distance: Math.abs(daysBetween(subject.suggestedDate, date)) })));
        rows.sort((a, b) => a.distance - b.distance || a.round.anchorDate.localeCompare(b.round.anchorDate));
        const next = rows[0];
        if (!next) { setError('この家事の予定を取得できませんでした。カレンダーから予定のある日を開いてください。'); return; }
        if (next.subject.suggestedDate === date || next.subject.completed) onRound?.(next.round.id, next.subject.id, next.round.anchorDate);
        else onDate?.(next.round.id, next.subject.id, date, next.round.anchorDate);
      }} />}
  </V2ScreenFrame>;
  if (view === 'advancedSettings') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2ChoreAdvancedSettings key={`${model.viewerUserId}:${model.plan.groupId}:${choreId}`} model={model} controller={controller} choreId={choreId ?? ''} onBack={onBack}
      development={purpose === 'development'} header={notice} onSaved={async () => { session.invalidate?.(); if (!await refresh()) throw new Error('保存済みです。表示を開き直してください。'); }} />
  </V2ScreenFrame>;
  if (view === 'details' || view === 'configuration') return <V2ChoreSettingsBook key={`${model.viewerUserId}:${model.plan.groupId}`}
    model={model} session={session} choreId={choreId} selection={settingsSelection} groupName={groupName} onBack={onBack} development={purpose === 'development'}
    onSaved={async () => { session.invalidate?.(); if (!await refresh()) throw new Error('保存済みです。表示を更新するため再読込してください。'); }} />;
  if (view === 'history') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2HistoryContent model={model} choreId={choreId} personal={personalGuide} actions={controller.actions} busy={busy} run={run} onBack={onBack} notice={notice} />
  </V2ScreenFrame>;
  if (!personal) return <V2ScreenFrame purpose={purpose} style={styles.safe}>{notice}<Text style={styles.body}>本人の推奨日を読み込めませんでした。</Text>
    <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></V2ScreenFrame>;
  if (view === 'calendar') {
    const month = calendarMonth ?? v2CalendarMonth(model.plan.range.asOfDate).month;
    const selectMonth = async (day: LocalDate, selectedDate?: LocalDate, forceRead = false) => {
      if (!alive.current) return;
      try {
        const next = v2CalendarMonth(day); setCalendarMonth(next.month);
        // Browsing another month never changes the selected day to its first day.
        if (selectedDate) setCalendarDay(selectedDate);
        const through = calendarChoreDisplayThrough(model.plan.range.asOfDate);
        // Appointments are already in the independent calendar cache. Browsing
        // them must not request a distant shared/private Scheduler projection.
        if (next.month > through) return;
        const requiredThrough = next.through < through ? next.through : through;
        const wasteCovered = model.waste?.calendarPolicy?.complete === true || Boolean(model.waste && model.waste.range.from <= next.from && requiredThrough <= model.waste.range.through);
        const covered = model.plan.range.from <= next.from && requiredThrough <= model.plan.range.through
          && wasteCovered
          && (privateOverlay?.status !== 'ready' || privateOverlay.range.from <= next.from && requiredThrough <= privateOverlay.range.through);
        if (covered && !forceRead) return;
        const range = v2CalendarDisplayRange(next.month, model.plan.range);
        readOptions.current = { calendarMonth: next.month, calendarRange: { ...range, through: range.through < through ? range.through : through }, waste: true, wasteCalendarPolicy: true };
        if (running.current) { refreshQueued.current = true; return; }
        await perform(async () => {}, false);
      } catch (cause) { setError(cause instanceof Error ? cause.message : '表示する月を確認してください。'); }
    };
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2Calendar model={model} personal={personal} privateOverlay={privateOverlay} privateSource={session.privateTasks} month={month}
      selectedDate={calendarDay ?? model.plan.range.asOfDate} feedback={feedback} busy={busy} actions={controller.actions} run={run} perform={perform} local={localCalendar} onNavigate={onCalendarNavigate} onGuide={onGuide} workspaceName={groupName}
      onMonth={selectMonth} onReloadMonth={day => void selectMonth(day, undefined, true)}
      onSelectDate={(day) => { if (day.slice(0, 7) === month.slice(0, 7)) setCalendarDay(day); else void selectMonth(day, day); }}
      onRound={(id, subject, anchor) => onRound?.(id, subject, anchor)} readOwnCalendar={session.readOwnCalendar}
      onDate={onDate ? (id, subject, clickedDate, anchor) => onDate(id, subject, clickedDate, anchor) : undefined}
      header={purpose === 'development' ? <View>{notice}{error ? <AppButton title="この月を再読込" compact variant="quiet" disabled={busy} onPress={() => void selectMonth(month, undefined, true)} /> : null}</View>
        : workspaceError || error ? <View style={{ padding: 8 }}><Text accessibilityRole="alert" style={styles.error}>{workspaceError ?? error}</Text><AppButton title="この月を再読込" compact variant="quiet" disabled={busy} onPress={() => void selectMonth(month, undefined, true)} /></View> : undefined} /></V2ScreenFrame>;
  }
  if (view === 'assignmentRequests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <NavigationHeader><BackButton onPress={onBack} disabled={busy} /></NavigationHeader>
    <V2AssignmentRequests model={model} actions={controller.actions} busy={busy} run={run}
      onResolve={onAssignment ? (id, day) => onAssignment(id, model.plan.occurrences.find(entry => entry.id === id)?.subjects[0]?.id, day) : undefined}
      header={<View style={{ gap: 16 }}>{notice}<ScreenHeading title="担当の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'requests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <NavigationHeader><BackButton onPress={onBack} disabled={busy} /></NavigationHeader>
    <V2DateRequests model={model} actions={controller.actions} busy={busy} run={run} readOwnCalendar={session.readOwnCalendar}
      header={<View style={{ gap: 16 }}>{notice}<ScreenHeading title="日時の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'round' || view === 'date' || view === 'assignment') {
    const round = model.plan.occurrences.find((entry) => entry.id === occurrenceId);
    const subject = round?.subjects.find((entry) => entry.id === subjectId) ?? (view === 'assignment' ? round?.subjects[0] : undefined);
    const chore = round ? model.plan.chores.find((entry) => entry.id === round.choreId) : undefined;
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2FormScrollView contentContainerStyle={styles.page} header={view === 'date' && calendarRegistrationDate(targetDate)
      ? <SettingsHeader title="家事の日付変更" onBack={onBack} backDisabled={busy} /> : <BackButton onPress={onBack} disabled={busy} />}>
      {notice}
      {round && subject ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === round.choreId)?.name ?? '共有家事'} />
        {view === 'assignment' ? <V2AssignmentForm model={model} round={round} actions={controller.actions} busy={busy} run={run} />
          : view === 'date' ? <V2DateForm model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} readOwnCalendar={session.readOwnCalendar} initialDate={calendarRegistrationDate(targetDate)} onSaved={targetDate ? onCalendar : undefined} /> : <><V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} feedback={feedback} showActions
          onDate={onDate ? () => onDate(round.id, subject.id) : undefined}
          onAssignment={onAssignment ? () => onAssignment(round.id, subject.id) : undefined}
          onAssignmentRequest={onAssignment ? () => onAssignment(round.id, subject.id) : undefined}
          recommendation={personal.recommendations.find((entry) => entry.subjectOccurrenceId === subject.id)} onOpen={() => (onDetails ?? onConfiguration)(round.choreId)} />
        {chore ? <AccordionSection title="家事の手順" expanded={proceduresOpen} onToggle={() => setProceduresOpen((value) => !value)}>
          <V2ChoreProcedures chore={chore} />
          {onDetails ? <AppButton title="家事名・手順を編集" compact variant="quiet" disabled={busy} onPress={() => onDetails(round.choreId)} /> : null}
        </AccordionSection> : null}
        <V2CompletionForm model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} /></>}
        <AppButton title="共通の設定を開く" variant="quiet" disabled={busy} onPress={() => onConfiguration(round.choreId)} /></>
        : <Text style={styles.body}>対象の家事回を表示できません。前の画面で現在の家事回を選んでください。</Text>}
    </V2FormScrollView></V2ScreenFrame>;
  }
  if (!home) return null;
  const { listRows, expiredCount, recommendations, total, done, summary } = home;
  const card = (round: V2PlannedOccurrence, subject: V2SubjectPlan, showHomeSource?: boolean) => <V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} feedback={feedback} home showHomeSource={showHomeSource}
    recommendation={recommendations.get(subject.id)}
    onOpen={() => onGuide ? onGuide(round.choreId, 'shared') : onRound ? onRound(round.id, subject.id) : onConfiguration(round.choreId)} />;
  return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <View style={homeHeaderContainerStyle(groupName)}><HomeHeader today={model.plan.range.asOfDate} birthdayDate={privateOverlay?.status === 'ready' ? privateOverlay.today : personalGuide?.snapshot.today} workspaceName={groupName} onGroup={onManage ?? onBack} /></View>
    <HomeMotionList data={listRows} keyExtractor={(entry) => entry.key} contentContainerStyle={[styles.page, styles.homeContent]} initialNumToRender={8}
      ListHeaderComponent={<>
        <HomeProgress summary={summary} total={total} done={done} />
        {workspaceError || actionError || display.error ? <Text accessibilityRole="alert" style={styles.error}>{actionError ?? workspaceError ?? display.error}</Text> : null}
        {purpose === 'workspace' ? retryCompletion : null}
        <SectionHeading title="今日の家事" trailing={<LoadSortButton order={display.order} onPress={display.toggle} />} />
        <V2PrivateTaskNotice overlay={privateOverlay} sharedTimeZone={model.plan.timeZone} />
        {privateOverlay?.status === 'ready' && privateOverlay.today !== model.plan.range.asOfDate ? <Text style={styles.caption}>個人の今日：{privateOverlay.today} · 共有の今日：{model.plan.range.asOfDate}</Text> : null}
        {model.waste?.rows.some(row => !row.deleted && row.needsReview) ? <Text style={styles.error}>確認が必要なゴミ収集日があります。共有のゴミ収集日で候補を確認してください。</Text> : null}
</>}
      renderItem={({ item }) => {
        if (item.kind === 'expiredHeading') return <HomeExpiredHeading count={expiredCount} expanded={expiredExpanded} onToggle={() => setExpiredExpanded(value => !value)} />;
        if (item.kind === 'weeks') return <HomeWeekSwitcher scope={weekScope} onChange={setWeekScope} />;
        if (item.kind === 'upcomingDate') return <HomeUpcomingDate date={item.date} />;
        if (item.kind === 'emptyToday') return <Card><Text style={styles.body}>{privateOverlay?.status === 'unavailable' ? '今日の共有家事はありません。' : '今日の家事はありません。'}</Text></Card>;
        if (item.kind === 'emptyWeek') return <Text style={[styles.caption, styles.emptyWeek]}>{weekScope === 'current' ? '今週の残りの' : '来週の'}{privateOverlay?.status === 'unavailable' ? '共有家事' : '家事'}はありません。</Text>;
        if (item.kind !== 'today' && item.kind !== 'upcoming' && item.kind !== 'expired') return null;
        const row = item.item;
        const showSource = item.kind === 'today' && item.showSource;
        return row.source === 'waste' ? <V2WasteOccurrence entry={row.entry} home />
          : row.source === 'personal' ? <V2PrivateTaskCard row={row.row} onOpen={onGuide ? () => onGuide(row.row.chore.id, 'personal') : undefined} source={session.privateTasks} busy={busy} run={run} feedback={feedback} home mixedSources
            showHomeSource={showSource} /> : card(row.round, row.subject, showSource);
      }}
      ListFooterComponent={<View style={styles.footer}>
        {purpose === 'development' ? notice : null}
        <HomeLinks onHistory={onHistory} onWaste={onWaste} />
        {purpose === 'development' ? <View style={{ gap: 8 }}>{onRequests ? <AppButton title="日時の変更申請" onPress={onRequests} /> : null}{onAssignmentRequests ? <AppButton title="担当の変更申請" onPress={onAssignmentRequests} /> : null}</View> : null}
        {purpose === 'development' ? <Card><SectionHeading title="設定を検査" />{model.configurations.map((entry) =>
          <AppButton key={entry.choreId} title={`「${model.plan.chores.find((chore) => chore.id === entry.choreId)?.name ?? '家事'}」の設定`} variant="quiet" disabled={busy} onPress={() => onConfiguration(entry.choreId)} />)}</Card> : null}
      </View>} />
    {lastUndo && !undoFailed ? <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(insets.bottom, 8) }}><CompletionToast busy={busy && !lastUndo.queuedKey} onUndo={() => {
      if ((!lastUndo.queuedKey && running.current) || !alive.current) return; const receipt = lastUndo;
      if (receipt.queuedKey) void receipt.undo().then(accepted => {
        if (accepted !== false && alive.current) setLastUndo(current => current === receipt ? null : current);
      }).catch(() => { if (alive.current) setError('取り消しを保存できませんでした。もう一度お試しください。'); });
      else { setLastUndo(null); void perform(receipt.undo); }
    }} /></View> : null}
  </V2ScreenFrame>;
}
/** A visible, fixed QA banner also lets native automation fail closed after scrolling long instructions. */
function V2ScreenFrame({ purpose, children, startupReady = true, ...props }: ComponentProps<typeof SafeAreaView> & { purpose: V2GroupScreenProps['purpose']; startupReady?: boolean }) {
  useLayoutEffect(() => { if (startupReady) finishStartupDisplay(); }, [startupReady]);
  return <SafeAreaView {...props} onLayout={startupReady ? finishStartupDisplay : undefined}>{purpose === 'development' ? <Text style={styles.qaScope}>開発用・端末内プレビュー</Text> : null}{children}</SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, page: { padding: 16, gap: 10, paddingBottom: 40 },
  homeContent: { paddingTop: 4 },
  emptyWeek: { ...typography.body, color: palette.muted, paddingVertical: 10 },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  settingsHeaderTitle: { ...typography.body, color: palette.ink, fontWeight: '700', flex: 1 },
  qaScope: { ...typography.caption, color: palette.warning, paddingHorizontal: 16, paddingVertical: 4 },
  notice: { padding: 12, gap: 4, borderWidth: 1, borderRadius: 12, borderColor: palette.border }, noticeTitle: { ...typography.label, fontWeight: '600', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, body: { ...typography.body, color: palette.ink }, error: { ...typography.caption, color: palette.warning }, footer: { gap: 16, paddingTop: 12 },
});
