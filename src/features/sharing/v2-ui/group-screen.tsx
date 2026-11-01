import { V2ChoreSettingsBook } from './chore-settings-book';
import { useChoreLibraryState } from '../../chores/chore-library';
import { v2HomeUpcomingRows, type V2HomeUpcomingRow } from './home-upcoming';
import { homeUpcomingRange, type HomeWeekScope } from '../../planner/home-presentation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, BackButton, Card, NavigationHeader, palette, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { V2RoundCard } from './round-card';
import { V2DateForm } from './date-form';
import { V2CompletionForm } from './completion-form';
import { V2DateRequests } from './date-requests';
import { V2AssignmentForm } from './assignment-form';
import { V2AssignmentRequests } from './assignment-requests';
import { V2Calendar } from './calendar';
import { v2CalendarMonth, v2CalendarProjection } from './calendar-projection';
import { v2CalendarDisplayRange } from './calendar-range';
import type { WorkspaceDisplayValue } from './workspace-display-store';
import type { LocalDate } from '../../../domain/shared/types';
import { V2CompletionHistoryCard } from './completion-history-card';
import { V2FormScrollView } from './form-controls';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2GroupUiSession } from './screen-session';
import { millisecondsUntilNextSharedDay, sharedLocalDate } from '../group-clock';
import { privateOverlayForViewer } from './private-overlay';
import { V2PrivateTaskCard, V2PrivateTaskNotice } from './private-task-card';
import { V2ChoreList } from './chore-list';
import { V2AddChore } from './add-chore';
import { V2ChoreProcedures } from './chore-procedures';
import { V2GroupPolicyEditor } from './group-policy-editor';
import { createV2RoundVisibility, v2CanShowCompletion } from './round-visibility';
import { V2DateRightsEditor } from './date-rights-editor';
import type { V2MutationOutcome } from './mutation-outcome';
import { V2WasteScreen } from './waste-screen';
import { V2WasteOccurrence } from './waste-occurrence';
import { V2ApplianceScreen } from './appliance-screen';
import { V2ApplianceLibrary } from './appliance-library';
import { V2ChoreBook, type PersonalGuideSource } from './chore-book';
import { orderTaskRows } from './task-order';
import type { CompletionFeedback } from './completion-feedback';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { HomeHeader, HomeLinks, HomeProgress, HomeWeekSwitcher, HomeUpcomingDate, LoadSortButton, CompletionToast } from '../../../components/home-ui';
import { finishStartupDisplay } from '../../../platform/diagnostics/startup-splash';
import { useHomeDisplay } from '../../../hooks/use-home-display';
import { homeSummary } from '../../planner/home-summary';
import { groupHistoryByDay } from '../../planner/history-groups';
import { HistoryDayHeading } from '../../../components/history-day-heading';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import type { PlannerCalendarProps } from '../../calendar/planner-calendar';

export interface V2GroupScreenProps {
  initialDisplay?: WorkspaceDisplayValue;
  lifecycleManaged?: boolean;
  localCalendar?: LocalCalendarBinding; onCalendarNavigate?: PlannerCalendarProps['onNavigate'];
  purpose: 'development' | 'workspace'; workspaceName?: string; workspaceError?: string; onManage?: () => void;
  subscribe?: (changed: () => void) => () => void;
  loadSession: () => Promise<V2GroupUiSession>; view: 'home' | 'configuration' | 'history' | 'round' | 'date' | 'requests' | 'assignment' | 'assignmentRequests' | 'calendar' | 'chores' | 'details' | 'addChore' | 'groupPolicy' | 'dateRights' | 'waste' | 'appliances' | 'appliance' | 'applianceReview' | 'guide'; choreId?: string; applianceId?: string;
  occurrenceId?: string; subjectId?: string; anchorDate?: string; onRound?: (occurrenceId: string, subjectId: string, anchorDate?: string) => void; onDate?: (occurrenceId: string, subjectId: string) => void;
  onBack: () => void; onConfiguration: (choreId: string) => void; onHistory: () => void; onRequests?: () => void;
  onAssignment?: (occurrenceId: string, subjectId: string) => void; onAssignmentRequests?: () => void;
  onCalendar?: () => void; personalGuide?: PersonalGuideSource; guideSource?: 'shared' | 'personal'; onGuide?: (choreId: string, source: 'shared' | 'personal') => void;
  onManageChores?: () => void; onDetails?: (choreId: string) => void; onAddChore?: () => void; onChoreCreated?: (choreId: string) => void;
  onGroupPolicy?: () => void; onNotifications?: () => void; onGoogleTasks?: () => void; onPersonalCopy?: () => void;
  onDateRights?: (choreId: string) => void;
  onWaste?: () => void;
  onAppliances?: () => void; onAppliance?: (id: string) => void; onApplianceReview?: (id?: string, productName?: string) => void;
  onPersonalAppliance?: (id: string) => void; initialProductName?: string;
}

export function readOptionsForView(view: V2GroupScreenProps['view'], anchorDate?: string, choreId?: string, applianceId?: string): Parameters<V2GroupUiSession['readModel']>[0] {
  if (view === 'appliances' || view === 'appliance' || view === 'applianceReview') return { management: true, appliances: true, applianceId };
  if (view === 'waste') return { management: true, waste: true };
  if (view === 'groupPolicy') return { management: true, groupPolicy: true };
  if (view === 'dateRights') return { management: true, permissionsChoreId: choreId };
  if (view === 'details' || view === 'configuration') return { management: true, choreSettings: true };
  if (view === 'guide' || view === 'chores') return undefined;
  if (view === 'addChore') return { management: true };
  if (anchorDate) return { focusDate: anchorDate, ...(['calendar', 'home'].includes(view) ? { waste: true } : {}) };
  return view === 'calendar' ? { calendarMonth: 'current', waste: true } : view === 'home' ? { waste: true } : undefined;
}

export function V2GroupScreen({ purpose, workspaceName, workspaceError, onManage, subscribe, loadSession, view, choreId, applianceId, onBack, onConfiguration, onHistory, onRequests, occurrenceId, subjectId, onRound, onDate, onAssignment, onAssignmentRequests, onCalendar, anchorDate, onManageChores, onDetails, onAddChore, onChoreCreated, onGroupPolicy, onNotifications, onGoogleTasks, onPersonalCopy, onDateRights, onWaste, onAppliances, onAppliance, onApplianceReview, localCalendar, onCalendarNavigate, onGuide, personalGuide, guideSource, onPersonalAppliance, initialProductName, initialDisplay, lifecycleManaged = false }: V2GroupScreenProps) {
  const libraryState = useChoreLibraryState();
  const [session, setSession] = useState<V2GroupUiSession | null>(initialDisplay?.session ?? null); const [screenModel, setModel] = useState<Awaited<ReturnType<V2GroupUiSession['readModel']>> | null>(initialDisplay?.model ?? null);
  const composition = useMemo(() => {
    if (!screenModel) return null;
    const { personal, privateOverlay: privateValue, ...model } = screenModel; return { personal, privateValue, model };
  }, [screenModel]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [weekScope, setWeekScope] = useState<HomeWeekScope>('current');
  const [proceduresOpen, setProceduresOpen] = useState(true);
  const [completionValues, setCompletionValues] = useState(new Map<string, boolean>());
  const homeProjection = useMemo(() => view === 'home' && composition
    ? v2CalendarProjection(composition.model, composition.personal, completionValues) : null, [view, composition, completionValues]);
  const feedbackEpoch = useRef(0);
  const display = useHomeDisplay();
  const insets = useSafeAreaInsets();
  const [lastUndo, setLastUndo] = useState<{ undo: () => Promise<unknown> } | null>(null);
  useEffect(() => { if (!lastUndo) return; const timer = setTimeout(() => setLastUndo(null), 6500); return () => clearTimeout(timer); }, [lastUndo]);
  const alive = useRef(false); const generation = useRef(0); const running = useRef(false);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mutationRead = useRef(false); const refreshQueued = useRef(false);
  const readOptions = useRef(readOptionsForView(view, anchorDate, choreId, applianceId));
  const readBinding = useRef({ anchorDate, view, choreId, applianceId });
  const [calendarMonth, setCalendarMonth] = useState<LocalDate | null>(null); const [calendarDay, setCalendarDay] = useState<LocalDate | null>(null);
  const refresh = useCallback(async () => {
    clearTimeout(notificationTimer.current); notificationTimer.current = undefined;
    const revision = ++generation.current;
    try {
      const preview = await loadSession(); const value = await preview.readModel(readOptions.current);
      if (alive.current && generation.current === revision) {
        setSession(preview); setModel(value); setError(null);
        setCompletionValues(values => values.size ? new Map() : values);
        return true;
      } return false;
    } catch (cause) { if (alive.current && generation.current === revision) setError(cause instanceof Error ? cause.message : '共有データを読み込めませんでした。'); return false; }
  }, [loadSession]);
  useFocusEffect(useCallback(() => {
    alive.current = true;
    if (readBinding.current.anchorDate !== anchorDate || readBinding.current.view !== view || readBinding.current.choreId !== choreId || readBinding.current.applianceId !== applianceId) {
      readOptions.current = readOptionsForView(view, anchorDate, choreId, applianceId);
      readBinding.current = { anchorDate, view, choreId, applianceId };
    }
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
    void refresh(); return () => { alive.current = false; setLastUndo(null); feedbackEpoch.current++; setCompletionValues(new Map()); generation.current++; clearTimeout(notificationTimer.current); refreshQueued.current = false; unsubscribe?.(); foreground?.remove(); };
  }, [refresh, anchorDate, subscribe, view, choreId, applianceId, lifecycleManaged]));
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
  const feedback: CompletionFeedback = { values: completionValues, run: async (key, completed, work) => {
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
  const notice = purpose === 'development' || workspaceError || error ? <View style={styles.notice}>
    {purpose === 'development' ? <Text style={styles.caption}>検査用の独立したデータです。既存データやログイン中のアカウントを使わず、共有操作をクラウドへ送信しません。</Text> : null}
    {workspaceError ? <Text accessibilityRole="alert" style={styles.error}>{workspaceError}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
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
    <V2ApplianceLibrary model={model} personal={personalGuide?.snapshot.appliances} busy={busy}
      header={notice}
      onOpen={onAppliance} onReview={onApplianceReview} onPersonal={onPersonalAppliance} />
  </V2ScreenFrame>;
  if (view === 'appliance' || view === 'applianceReview') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2ApplianceScreen key={`${view}:${applianceId ?? initialProductName ?? 'new'}`} initialProductName={initialProductName} model={model} mode={view} applianceId={applianceId} actions={controller.actions} busy={busy} perform={perform}
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
  if (view === 'guide') return <V2ChoreBook key={`${guideSource}:${choreId}`} model={model} personal={personalGuide} selectedId={choreId} source={guideSource} onBack={onBack} onRound={onRound} onConfiguration={onConfiguration} groupName={groupName} actions={controller.actions} perform={perform} hasTabBar />;
  if (view === 'chores') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2ChoreList model={model} busy={busy} onDetails={onDetails ?? onConfiguration} onConfiguration={onConfiguration} onAdd={onAddChore} personal={personalGuide} onOpen={onGuide} libraryState={libraryState}
      header={<View style={{ gap: 14 }}><ScreenHeading title="家事一覧" />{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>} />
  </V2ScreenFrame>;
  if (view === 'addChore') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2AddChore actions={controller.actions} busy={busy} run={run} header={notice} onBack={onBack} onCreated={onChoreCreated ?? onDetails ?? onConfiguration} />
  </V2ScreenFrame>;
  if (view === 'details' || view === 'configuration') return <V2ChoreSettingsBook key={`${model.viewerUserId}:${model.plan.groupId}`}
    model={model} session={session} choreId={choreId} groupName={groupName} onBack={onBack} development={purpose === 'development'}
    onSaved={async () => { session.invalidate?.(); if (!await refresh()) throw new Error('保存済みです。表示を更新するため再読込してください。'); }} />;
  if (view === 'history') {
    const historyRows = [
      ...model.plan.history.filter(record => (!choreId || record.choreId === choreId) && v2CanShowCompletion(model, record)).map(record => ({ kind: 'current' as const, record })),
      ...(model.legacyHistory ?? []).filter(record => (!choreId || record.choreId === choreId) && (model.viewerUserId === model.adminUserId || model.plan.policy?.showCompletionStatus
        || record.performerUserId === model.viewerUserId || record.recorderUserId === model.viewerUserId)).map(record => ({ kind: 'legacy' as const, record })),
    ].sort((a, b) => b.record.performedAt.localeCompare(a.record.performedAt) || a.record.operationId.localeCompare(b.record.operationId));
    const groups = groupHistoryByDay(historyRows, item => ({ id: item.record.operationId, timestamp: item.record.performedAt, date: sharedLocalDate(new Date(item.record.performedAt), model.plan.timeZone) }));
    const rows = groups.flatMap(group => [{ kind: 'date' as const, id: group.date, date: group.date, showMonth: group.showMonth }, ...group.records.map(value => ({ ...value, id: value.record.operationId }))]);
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
      <NavigationHeader><BackButton onPress={onBack} disabled={busy} /></NavigationHeader>
      <FlatList data={rows} keyExtractor={item => item.id} contentContainerStyle={styles.page} initialNumToRender={8}
        ListHeaderComponent={<>{notice}<ScreenHeading title="実施履歴" /></>}
        ListEmptyComponent={<Card><Text style={styles.body}>表示する実施記録はありません。</Text></Card>}
        renderItem={({ item }) => item.kind === 'date' ? <HistoryDayHeading date={item.date} showMonth={item.showMonth} /> : item.kind === 'current' ? <V2CompletionHistoryCard grouped model={model} record={item.record} actions={controller.actions} busy={busy} run={run} />
          : <Card><SectionHeading title={item.record.choreName} />
            <Text style={styles.body}>{!item.record.active ? '取消済み' : item.record.outcome === 'completed' ? '実施済み' : '未実施の記録'}</Text>
            <Text style={styles.caption}>{new Date(item.record.performedAt).toLocaleTimeString('ja-JP', { timeZone: model.plan.timeZone, hour: '2-digit', minute: '2-digit' })}</Text>
            <Text style={styles.caption}>実施者：{item.record.performerUserId ? model.plan.members.find(member => member.userId === item.record.performerUserId)?.displayName ?? '以前のメンバー' : '記録なし'}</Text>
          </Card>} />
    </V2ScreenFrame>;
  }
  if (!personal) return <V2ScreenFrame purpose={purpose} style={styles.safe}>{notice}<Text style={styles.body}>本人の推奨日を読み込めませんでした。</Text>
    <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></V2ScreenFrame>;
  if (view === 'calendar') {
    const month = calendarMonth ?? v2CalendarMonth(model.plan.range.asOfDate).month;
    const selectMonth = async (day: LocalDate, selectedDate?: LocalDate) => {
      if (!alive.current) return;
      try {
        const next = v2CalendarMonth(day); setCalendarMonth(next.month);
        // Browsing another month never changes the selected day to its first day.
        if (selectedDate) setCalendarDay(selectedDate);
        const covered = model.plan.range.from <= next.from && next.through <= model.plan.range.through
          && model.waste && model.waste.range.from <= next.from && next.through <= model.waste.range.through
          && (privateOverlay?.status !== 'ready' || privateOverlay.range.from <= next.from && next.through <= privateOverlay.range.through);
        if (covered) return;
        readOptions.current = { calendarMonth: next.month, calendarRange: v2CalendarDisplayRange(next.month, model.plan.range), waste: true };
        if (running.current) { refreshQueued.current = true; return; }
        await perform(async () => {}, false);
      } catch (cause) { setError(cause instanceof Error ? cause.message : '表示する月を確認してください。'); }
    };
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2Calendar model={model} personal={personal} privateOverlay={privateOverlay} privateSource={session.privateTasks} month={month}
      selectedDate={calendarDay ?? model.plan.range.asOfDate} feedback={feedback} busy={busy} actions={controller.actions} run={run} perform={perform} local={localCalendar} onNavigate={onCalendarNavigate} onGuide={onGuide} workspaceName={groupName}
      onMonth={selectMonth} onSelectDate={(day) => { if (day.slice(0, 7) === month.slice(0, 7)) setCalendarDay(day); else void selectMonth(day, day); }}
      onRound={(id, subject, anchor) => onRound?.(id, subject, anchor)}
      header={purpose === 'development' ? <View>{notice}{error ? <AppButton title="この月を再読込" compact variant="quiet" disabled={busy} onPress={() => void selectMonth(month)} /> : null}</View>
        : workspaceError || error ? <View style={{ padding: 8 }}><Text accessibilityRole="alert" style={styles.error}>{workspaceError ?? error}</Text><AppButton title="この月を再読込" compact variant="quiet" disabled={busy} onPress={() => void selectMonth(month)} /></View> : undefined} /></V2ScreenFrame>;
  }
  if (view === 'assignmentRequests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <NavigationHeader><BackButton onPress={onBack} disabled={busy} /></NavigationHeader>
    <V2AssignmentRequests model={model} actions={controller.actions} busy={busy} run={run}
      onResolve={onAssignment ? (id) => { const round = model.plan.occurrences.find((entry) => entry.id === id); if (round?.subjects[0]) onAssignment(id, round.subjects[0].id); } : undefined}
      header={<View style={{ gap: 16 }}>{notice}<ScreenHeading title="担当の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'requests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <NavigationHeader><BackButton onPress={onBack} disabled={busy} /></NavigationHeader>
    <V2DateRequests model={model} actions={controller.actions} busy={busy} run={run} readOwnCalendar={session.readOwnCalendar}
      header={<View style={{ gap: 16 }}>{notice}<ScreenHeading title="日時の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'round' || view === 'date' || view === 'assignment') {
    const round = model.plan.occurrences.find((entry) => entry.id === occurrenceId); const subject = round?.subjects.find((entry) => entry.id === subjectId);
    const chore = round ? model.plan.chores.find((entry) => entry.id === round.choreId) : undefined;
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2FormScrollView contentContainerStyle={styles.page} header={<BackButton onPress={onBack} disabled={busy} />}>
      {notice}
      {round && subject ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === round.choreId)?.name ?? '共有家事'} />
        {view === 'assignment' ? <V2AssignmentForm model={model} round={round} actions={controller.actions} busy={busy} run={run} />
          : view === 'date' ? <V2DateForm model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} readOwnCalendar={session.readOwnCalendar} /> : <><V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} feedback={feedback} showActions
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
  const recommendations = new Map(personal.recommendations.map((entry) => [entry.subjectOccurrenceId, entry]));
  const card = (round: V2PlannedOccurrence, subject: V2SubjectPlan) => <V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} feedback={feedback} home={view === 'home'}
    recommendation={recommendations.get(subject.id)}
    onOpen={() => onGuide ? onGuide(round.choreId, 'shared') : onRound ? onRound(round.id, subject.id) : onConfiguration(round.choreId)} />;
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => subject.required && (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId)).map((subject) => ({ round, subject })));
  const projection = homeProjection ?? v2CalendarProjection(model, personal, completionValues);
  const today = projection.byDate.get(model.plan.range.asOfDate) ?? [];
  const visibility = createV2RoundVisibility(model);
  const choreById = new Map(model.plan.chores.map(chore => [chore.id, chore]));
  const homeRows = orderTaskRows([...(model.waste?.occurrences ?? []).filter(entry => entry.occurrence.date === model.plan.range.asOfDate && entry.hidden !== true)
    .map(entry => ({ source: 'waste' as const, key: `waste:${entry.key}`, entry })),
    ...today.map((entry) => ({ source: 'shared' as const, key: `shared:${entry.subject.id}`, ...entry })),
    ...(privateOverlay?.status === 'ready' ? privateOverlay.home : []).map((row) => ({ source: 'personal' as const, key: row.key, row }))], model.plan.range.asOfDate, item => item.source === 'personal'
      ? { completed: completionValues.get(item.key) ?? item.row.completed, load: item.row.chore.load, estimatedMinutes: item.row.chore.estimatedMinutes, recommendedDate: item.row.suggestedDate, windowEnd: item.row.windowEnd, asOfDate: privateOverlay?.status === 'ready' ? privateOverlay.today : undefined }
      : item.source === 'shared' ? { completed: visibility(item.round, item.subject).showStatus && (completionValues.get(item.key) ?? item.subject.completed),
        load: choreById.get(item.round.choreId)?.load ?? 'light', estimatedMinutes: choreById.get(item.round.choreId)?.estimatedMinutes, recommendedDate: recommendations.get(item.subject.id)?.date ?? item.subject.suggestedDate, windowEnd: item.subject.executionWindowEnd }
        : { completed: false, load: 'light', recommendedDate: model.plan.range.asOfDate }, display.order);
  const upcoming = v2HomeUpcomingRows(model, projection, privateOverlay, homeUpcomingRange(model.plan.range.asOfDate, weekScope), display.order, completionValues);
  const expired = entries.filter(({ subject }) => subject.showExpiredOnHome);
  type HomeListItem = { kind: 'today'; key: string; item: typeof homeRows[number] } | { kind: 'upcoming'; key: string; item: V2HomeUpcomingRow }
    | { kind: 'weeks' | 'emptyToday' | 'emptyWeek' | 'expiredHeading'; key: string } | { kind: 'upcomingDate'; key: string; date: LocalDate }
    | { kind: 'expired'; key: string; round: V2PlannedOccurrence; subject: V2SubjectPlan };
  const listRows: HomeListItem[] = [
    ...(homeRows.length ? homeRows.map(item => ({ kind: 'today' as const, key: `today:${item.key}`, item })) : [{ kind: 'emptyToday' as const, key: 'emptyToday' }]),
    ...(expired.length ? [{ kind: 'expiredHeading' as const, key: 'expiredHeading' }, ...expired.map(item => ({ ...item, kind: 'expired' as const, key: `expired:${item.subject.id}` }))] : []),
    { kind: 'weeks', key: 'weeks' },
    ...upcoming.flatMap(({ date, rows }): HomeListItem[] => [{ kind: 'upcomingDate', key: `date:${date}`, date }, ...rows.map(item => ({ kind: 'upcoming' as const, key: `upcoming:${item.key}`, item }))]),
    ...(!upcoming.length ? [{ kind: 'emptyWeek' as const, key: 'emptyWeek' }] : []),
  ];
  const total = homeRows.filter(item => item.source !== 'waste').length;
  const done = homeRows.filter(item => item.source === 'personal' ? completionValues.get(item.key) ?? item.row.completed
    : item.source === 'shared' && visibility(item.round, item.subject).showStatus && (completionValues.get(item.key) ?? item.subject.completed)).length;
  const summary = homeSummary(total, done);
  return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <View style={styles.homeHeader}><HomeHeader today={model.plan.range.asOfDate} workspaceName={typeof model.plan.commonSettings.name === 'string' ? model.plan.commonSettings.name : workspaceName ?? '共有グループ'} onGroup={onManage ?? onBack} /></View>
    <Animated.FlatList data={listRows} itemLayoutAnimation={LinearTransition.duration(240)} keyExtractor={(entry) => entry.key} contentContainerStyle={styles.page} initialNumToRender={8}
      ListHeaderComponent={<>
        <HomeProgress summary={summary} total={total} done={done} />
        {workspaceError || error || display.error ? <Text accessibilityRole="alert" style={styles.error}>{workspaceError ?? error ?? display.error}</Text> : null}
        <SectionHeading title="今日の家事" trailing={<LoadSortButton order={display.order} onPress={display.toggle} />} />
        <V2PrivateTaskNotice overlay={privateOverlay} sharedTimeZone={model.plan.timeZone} />
        {privateOverlay?.status === 'ready' && privateOverlay.today !== model.plan.range.asOfDate ? <Text style={styles.caption}>個人の今日：{privateOverlay.today} · 共有の今日：{model.plan.range.asOfDate}</Text> : null}
        {model.waste?.rows.some(row => !row.deleted && row.needsReview) ? <Text style={styles.error}>確認が必要なゴミ収集日があります。共有のゴミ収集日で候補を確認してください。</Text> : null}
</>}
      renderItem={({ item }) => {
        if (item.kind === 'expiredHeading') return <Text accessibilityRole="header" style={styles.expiredHeading}>期限を過ぎた家事（{expired.length}件）</Text>;
        if (item.kind === 'expired') return card(item.round, item.subject);
        if (item.kind === 'weeks') return <HomeWeekSwitcher scope={weekScope} onChange={setWeekScope} />;
        if (item.kind === 'upcomingDate') return <HomeUpcomingDate date={item.date} />;
        if (item.kind === 'emptyToday') return <Card><Text style={styles.body}>{privateOverlay?.status === 'unavailable' ? '今日の共有家事はありません。個人家事は未取得です。' : '今日の家事はありません。'}</Text></Card>;
        if (item.kind === 'emptyWeek') return <Card><Text style={styles.body}>{privateOverlay?.status === 'unavailable' ? '共有家事の予定はありません。個人家事は未取得です。' : weekScope === 'current' ? '今週の予定はありません。' : '来週の予定はありません。'}</Text></Card>;
        if (item.kind !== 'today' && item.kind !== 'upcoming') return null;
        const row = item.item;
        return row.source === 'waste' ? <V2WasteOccurrence entry={row.entry} actions={controller.actions} busy={busy} run={run} />
          : row.source === 'personal' ? <V2PrivateTaskCard row={row.row} onOpen={onGuide ? () => onGuide(row.row.chore.id, 'personal') : undefined} source={session.privateTasks} busy={busy} run={run} feedback={feedback} home mixedSources /> : card(row.round, row.subject);
      }}
      ListFooterComponent={<View style={styles.footer}>
        {purpose === 'development' ? notice : null}
        <HomeLinks onHistory={onHistory} onWaste={onWaste} />
        {purpose === 'development' ? <View style={{ gap: 8 }}>{onRequests ? <AppButton title="日時の変更申請" onPress={onRequests} /> : null}{onAssignmentRequests ? <AppButton title="担当の変更申請" onPress={onAssignmentRequests} /> : null}</View> : null}
        {purpose === 'development' ? <Card><SectionHeading title="設定を検査" />{model.configurations.map((entry) =>
          <AppButton key={entry.choreId} title={`「${model.plan.chores.find((chore) => chore.id === entry.choreId)?.name ?? '家事'}」の設定`} variant="quiet" disabled={busy} onPress={() => onConfiguration(entry.choreId)} />)}</Card> : null}
      </View>} />
    {lastUndo ? <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(insets.bottom, 8) }}><CompletionToast busy={busy} onUndo={() => {
      if (running.current || !alive.current) return; const receipt = lastUndo; setLastUndo(null); void perform(receipt.undo);
    }} /></View> : null}
  </V2ScreenFrame>;
}
/** A visible, fixed QA banner also lets native automation fail closed after scrolling long instructions. */
function V2ScreenFrame({ purpose, children, startupReady = true, ...props }: ComponentProps<typeof SafeAreaView> & { purpose: V2GroupScreenProps['purpose']; startupReady?: boolean }) {
  useLayoutEffect(() => { if (startupReady) finishStartupDisplay(); }, [startupReady]);
  return <SafeAreaView {...props} onLayout={startupReady ? finishStartupDisplay : undefined}>{purpose === 'development' ? <Text style={styles.qaScope}>開発用・端末内プレビュー</Text> : null}{children}</SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, page: { padding: 16, gap: 10, paddingBottom: 40 },
  homeHeader: { paddingHorizontal: 18, paddingVertical: 6, minHeight: 60, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  expiredHeading: { ...typography.label, color: palette.muted, fontWeight: '600', marginTop: 12 },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  settingsHeaderTitle: { ...typography.body, color: palette.ink, fontWeight: '700', flex: 1 },
  qaScope: { ...typography.caption, color: palette.warning, paddingHorizontal: 16, paddingVertical: 4 },
  notice: { padding: 12, gap: 4, borderWidth: 1, borderRadius: 12, borderColor: palette.border }, noticeTitle: { ...typography.label, fontWeight: '600', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, body: { ...typography.body, color: palette.ink }, error: { ...typography.caption, color: palette.warning }, footer: { gap: 16, paddingTop: 12 },
});
