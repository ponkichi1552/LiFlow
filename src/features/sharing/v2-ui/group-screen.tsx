import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, BackButton, Card, palette, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { V2RoundCard } from './round-card';
import { V2ConfigurationEditor } from './configuration-editor';
import { V2DateForm } from './date-form';
import { V2CompletionForm } from './completion-form';
import { V2DateRequests } from './date-requests';
import { V2AssignmentForm } from './assignment-form';
import { V2AssignmentRequests } from './assignment-requests';
import { V2Calendar } from './calendar';
import { v2CalendarMonth } from './calendar-projection';
import type { LocalDate } from '../../../domain/shared/types';
import { V2CompletionHistoryCard } from './completion-history-card';
import { V2FormScrollView } from './form-controls';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2GroupUiSession } from './screen-session';
import { millisecondsUntilNextSharedDay } from '../group-clock';
import { privateOverlayForViewer } from './private-overlay';
import { V2PrivateTaskCard, V2PrivateTaskNotice } from './private-task-card';
import { V2DailyLoadNotice } from './daily-load-notice';
import { V2ChoreDetailsEditor } from './chore-details-editor';
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
import { orderTaskRows } from './task-order';
import type { CompletionFeedback } from './completion-feedback';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useHomeClock } from '../../../hooks/use-home-clock';
import { HomeHeader, HomeProgress, LoadSortButton, CompletionToast } from '../../../components/home-ui';
import { useHomeDisplay } from '../../../hooks/use-home-display';
import { homeSummary } from '../../planner/home-summary';
import { SettingsAudience } from '../../../components/settings-audience';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import type { PlannerCalendarProps } from '../../calendar/planner-calendar';

export interface V2GroupScreenProps {
  localCalendar?: LocalCalendarBinding; onCalendarNavigate?: PlannerCalendarProps['onNavigate'];
  purpose: 'development' | 'workspace'; workspaceName?: string; workspaceError?: string; onManage?: () => void;
  subscribe?: (changed: () => void) => () => void;
  loadSession: () => Promise<V2GroupUiSession>; view: 'home' | 'configuration' | 'history' | 'round' | 'date' | 'requests' | 'assignment' | 'assignmentRequests' | 'calendar' | 'chores' | 'details' | 'addChore' | 'groupPolicy' | 'dateRights' | 'waste' | 'appliances' | 'appliance' | 'applianceReview'; choreId?: string; applianceId?: string;
  occurrenceId?: string; subjectId?: string; anchorDate?: string; onRound?: (occurrenceId: string, subjectId: string, anchorDate?: string) => void; onDate?: (occurrenceId: string, subjectId: string) => void;
  onBack: () => void; onConfiguration: (choreId: string) => void; onHistory: () => void; onRequests?: () => void;
  onAssignment?: (occurrenceId: string, subjectId: string) => void; onAssignmentRequests?: () => void;
  onCalendar?: () => void;
  onManageChores?: () => void; onDetails?: (choreId: string) => void; onAddChore?: () => void; onChoreCreated?: (choreId: string) => void;
  onGroupPolicy?: () => void; onNotifications?: () => void; onGoogleTasks?: () => void; onPersonalCopy?: () => void;
  onDateRights?: (choreId: string) => void;
  onWaste?: () => void;
  onAppliances?: () => void; onAppliance?: (id: string) => void; onApplianceReview?: (id?: string) => void;
}

function readOptionsForView(view: V2GroupScreenProps['view'], anchorDate?: string, choreId?: string, applianceId?: string): Parameters<V2GroupUiSession['readModel']>[0] {
  if (view === 'appliances' || view === 'appliance' || view === 'applianceReview') return { management: true, appliances: true, applianceId };
  if (view === 'waste') return { management: true, waste: true };
  if (view === 'groupPolicy') return { management: true, groupPolicy: true };
  if (view === 'dateRights') return { management: true, permissionsChoreId: choreId };
  if (view === 'details') return { management: true, detailChoreId: choreId };
  if (view === 'chores' || view === 'addChore' || view === 'configuration') return { management: true };
  if (anchorDate) return { focusDate: anchorDate, ...(['calendar', 'home'].includes(view) ? { waste: true } : {}) };
  return view === 'calendar' ? { calendarMonth: 'current', waste: true } : view === 'home' ? { waste: true } : undefined;
}

export function V2GroupScreen({ purpose, workspaceName, workspaceError, onManage, subscribe, loadSession, view, choreId, applianceId, onBack, onConfiguration, onHistory, onRequests, occurrenceId, subjectId, onRound, onDate, onAssignment, onAssignmentRequests, onCalendar, anchorDate, onManageChores, onDetails, onAddChore, onChoreCreated, onGroupPolicy, onNotifications, onGoogleTasks, onPersonalCopy, onDateRights, onWaste, onAppliances, onAppliance, onApplianceReview, localCalendar, onCalendarNavigate }: V2GroupScreenProps) {
  const [session, setSession] = useState<V2GroupUiSession | null>(null); const [screenModel, setModel] = useState<Awaited<ReturnType<V2GroupUiSession['readModel']>> | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [expiredOpen, setExpiredOpen] = useState(false);
  const [proceduresOpen, setProceduresOpen] = useState(true);
  const [completionValues, setCompletionValues] = useState(new Map<string, boolean>());
  const feedbackEpoch = useRef(0);
  const display = useHomeDisplay();
  const insets = useSafeAreaInsets();
  const [lastUndo, setLastUndo] = useState<{ undo: () => Promise<unknown> } | null>(null);
  useEffect(() => { if (!lastUndo) return; const timer = setTimeout(() => setLastUndo(null), 6500); return () => clearTimeout(timer); }, [lastUndo]);
  const clock = useHomeClock(screenModel?.plan.timeZone);
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
      if (alive.current && generation.current === revision) { setSession(preview); setModel(value); setError(null); setCompletionValues(new Map()); } return true;
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
      notificationTimer.current = setTimeout(() => { notificationTimer.current = undefined; if (alive.current) void refresh(); }, 80);
    });
    const foreground = AppState.addEventListener('change', state => {
      if (state !== 'active' || !alive.current) return;
      // Navigation focus does not change when a suspended app returns after midnight.
      if (running.current) { refreshQueued.current = true; return; }
      clearTimeout(notificationTimer.current);
      notificationTimer.current = setTimeout(() => { notificationTimer.current = undefined; if (alive.current) void refresh(); }, 80);
    });
    void refresh(); return () => { alive.current = false; setLastUndo(null); feedbackEpoch.current++; setCompletionValues(new Map()); generation.current++; clearTimeout(notificationTimer.current); refreshQueued.current = false; unsubscribe?.(); foreground.remove(); };
  }, [refresh, anchorDate, subscribe, view, choreId, applianceId]));
  useEffect(() => {
    if (!screenModel) return;
    const zones = [screenModel.plan.timeZone, ...(screenModel.privateOverlay?.status === 'ready' ? [screenModel.privateOverlay.timeZone] : [])];
    const delay = Math.min(...zones.map((zone) => millisecondsUntilNextSharedDay(new Date(), zone)));
    const timer = setTimeout(() => { if (!alive.current) return; if (running.current) refreshQueued.current = true; else void refresh(); }, delay);
    return () => clearTimeout(timer);
  }, [screenModel, refresh]);
  const perform = async (work: () => Promise<unknown>): Promise<V2MutationOutcome> => {
    if (running.current) return { committed: false, refreshed: false, error: new Error('保存中の操作が終わってから、もう一度お試しください。') };
    running.current = true; generation.current++; clearTimeout(notificationTimer.current); setBusy(true); setError(null);
    let failure: unknown; let failed = false;
    try { await work(); } catch (cause) { failed = true; failure = cause; }
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
  const editingSettings = view === 'configuration' || view === 'details';
  const groupName = typeof screenModel?.plan.commonSettings.name === 'string' ? screenModel.plan.commonSettings.name : workspaceName ?? '共有グループ';
  const settingsHeader = purpose === 'workspace' && editingSettings ? <View style={styles.settingsHeader}>
    <Text style={styles.settingsHeaderTitle}>家事ごとの設定</Text><SettingsAudience groupName={groupName} />
  </View> : null;
  const notice = <View style={styles.notice}>
    {purpose === 'workspace' && !editingSettings ? <Text style={styles.noticeTitle}>{typeof screenModel?.plan.commonSettings.name === 'string'
      ? screenModel.plan.commonSettings.name : workspaceName ?? '共有グループ'}</Text> : null}
    <Text style={styles.caption}>{purpose === 'development' ? '検査用の独立したデータです。既存データやログイン中のアカウントを使わず、共有操作をクラウドへ送信しません。' : '端末に保存した変更は、接続後に共有します。申請・回答は受付と必要な承認の完了後に確定します。'}</Text>
    {purpose === 'workspace' && onManage ? <AppButton title="グループの管理・切り替え" variant="quiet" compact onPress={onManage} /> : null}
    {view === 'home' && onGroupPolicy ? <AppButton title="グループのルール" variant="quiet" compact onPress={onGroupPolicy} /> : null}
    {view === 'home' && onNotifications ? <AppButton title="この端末の共有通知" variant="quiet" compact onPress={onNotifications} /> : null}
    {view === 'home' && onGoogleTasks ? <AppButton title="共有家事とGoogle Tasks" variant="quiet" compact onPress={onGoogleTasks} /> : null}
    {view === 'home' && onPersonalCopy ? <AppButton title="個人設定から共有家事を追加" variant="quiet" compact onPress={onPersonalCopy} /> : null}
    {workspaceError ? <Text accessibilityRole="alert" style={styles.error}>{workspaceError}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
  if (!screenModel || !session) return <V2ScreenFrame purpose={purpose} style={styles.safe}>{notice}<ActivityIndicator color={palette.accent} />
    <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></V2ScreenFrame>;
  // Strip local composition before passing the common model to shared forms and actions.
  const { personal, privateOverlay: privateValue, dailyLoad, ...model } = screenModel;
  const privateOverlay = privateOverlayForViewer(privateValue, model.viewerUserId);
  const controller = session.controller;
  if (applianceId && (view === 'appliance' || view === 'applianceReview') && model.appliances?.detail?.row.id !== applianceId) return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    {notice}<BackButton onPress={onBack} /><Text style={styles.error}>対象の共有家電を表示できません。一覧から開き直してください。</Text>
    <AppButton title="家電を再読込" disabled={busy} onPress={() => void refresh()} />
  </V2ScreenFrame>;
  if (view === 'appliances' || view === 'appliance' || view === 'applianceReview') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2ApplianceScreen key={`${view}:${applianceId ?? 'new'}`} model={model} mode={view} applianceId={applianceId} actions={controller.actions} busy={busy} perform={perform}
      header={notice} onBack={onBack} onOpen={onAppliance} onReview={onApplianceReview} onConfiguration={onConfiguration} onDetails={onDetails} />
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
  if (view === 'chores') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2ChoreList model={model} busy={busy} onDetails={onDetails ?? onConfiguration} onConfiguration={onConfiguration} onAdd={onAddChore}
      header={<View style={{ gap: 14 }}>{notice}<BackButton onPress={onBack} /><ScreenHeading title="共有家事の一覧" /></View>} />
  </V2ScreenFrame>;
  if (view === 'addChore') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2AddChore actions={controller.actions} busy={busy} run={run} header={notice} onBack={onBack} onCreated={onChoreCreated ?? onDetails ?? onConfiguration} />
  </V2ScreenFrame>;
  if (view === 'details') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    {settingsHeader}
    <V2ChoreDetailsEditor model={model} choreId={choreId ?? ''} controller={controller} header={notice} onBack={onBack}
      onConfiguration={choreId ? () => onConfiguration(choreId) : undefined}
      onDateRights={choreId && onDateRights ? () => onDateRights(choreId) : undefined}
      onSaved={async () => { if (!await refresh()) throw new Error('保存済みです。表示を更新するため画面を開き直してください。'); }} />
  </V2ScreenFrame>;
  if (view === 'configuration') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    {settingsHeader}
    <V2FormScrollView contentContainerStyle={styles.page}>{notice}
      {choreId && model.configurations.some((entry) => entry.choreId === choreId) ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === choreId)?.name ?? '共有家事'} />
        <V2ConfigurationEditor model={model} choreId={choreId} controller={controller} onSaved={async () => { if (!await refresh()) throw new Error('保存済みです。表示を更新するため画面を開き直してください。'); }} onBack={onBack} /></>
        : <><BackButton onPress={onBack} /><Text style={styles.body}>設定する家事を選んでください。</Text></>}
    </V2FormScrollView>
  </V2ScreenFrame>;
  if (view === 'history') {
    const historyRows = [
      ...model.plan.history.filter(record => (!choreId || record.choreId === choreId) && v2CanShowCompletion(model, record)).map(record => ({ kind: 'current' as const, record })),
      ...(model.legacyHistory ?? []).filter(record => (!choreId || record.choreId === choreId) && (model.viewerUserId === model.adminUserId || model.plan.policy?.showCompletionStatus
        || record.performerUserId === model.viewerUserId || record.recorderUserId === model.viewerUserId)).map(record => ({ kind: 'legacy' as const, record })),
    ].sort((a, b) => b.record.performedAt.localeCompare(a.record.performedAt) || a.record.operationId.localeCompare(b.record.operationId));
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
      <FlatList data={historyRows} keyExtractor={item => item.record.operationId} contentContainerStyle={styles.page} initialNumToRender={8}
        ListHeaderComponent={<>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="実施履歴" /></>}
        ListEmptyComponent={<Card><Text style={styles.body}>表示する実施記録はありません。</Text></Card>}
        renderItem={({ item }) => item.kind === 'current' ? <V2CompletionHistoryCard model={model} record={item.record} actions={controller.actions} busy={busy} run={run} />
          : <Card><SectionHeading title={item.record.choreName} /><Text style={styles.caption}>移行前の記録</Text>
            <Text style={styles.body}>{!item.record.active ? '取消済み' : item.record.outcome === 'completed' ? '実施済み' : '未実施の記録'}</Text>
            <Text style={styles.body}>{new Date(item.record.performedAt).toLocaleString('ja-JP', { timeZone: model.plan.timeZone })}</Text>
            <Text style={styles.caption}>実施者：{item.record.performerUserId ? model.plan.members.find(member => member.userId === item.record.performerUserId)?.displayName ?? '以前のメンバー' : '記録なし'}</Text>
          </Card>} />
    </V2ScreenFrame>;
  }
  if (!personal) return <V2ScreenFrame purpose={purpose} style={styles.safe}>{notice}<Text style={styles.body}>本人の推奨日を読み込めませんでした。</Text>
    <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></V2ScreenFrame>;
  if (view === 'calendar') {
    const month = calendarMonth ?? v2CalendarMonth(model.plan.range.asOfDate).month;
    const selectMonth = async (day: LocalDate, selectedDate?: LocalDate) => {
      if (!alive.current || running.current) return;
      try {
        const next = v2CalendarMonth(day); readOptions.current = { calendarMonth: next.month, waste: true }; setCalendarMonth(next.month);
        // Browsing another month never changes the selected day to its first day.
        if (selectedDate) setCalendarDay(selectedDate);
        await run(async () => {});
      } catch (cause) { setError(cause instanceof Error ? cause.message : '表示する月を確認してください。'); }
    };
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2Calendar model={model} personal={personal} privateOverlay={privateOverlay} privateSource={session.privateTasks} month={month}
      selectedDate={calendarDay ?? model.plan.range.asOfDate} feedback={feedback} busy={busy} actions={controller.actions} run={run} local={localCalendar} onNavigate={onCalendarNavigate} workspaceName={groupName}
      onMonth={selectMonth} onSelectDate={(day) => { if (day.slice(0, 7) === month.slice(0, 7)) setCalendarDay(day); else void selectMonth(day, day); }}
      onRound={(id, subject, anchor) => onRound?.(id, subject, anchor)}
      header={purpose === 'development' ? <View>{notice}{error ? <AppButton title="この月を再読込" compact variant="quiet" disabled={busy} onPress={() => void selectMonth(month)} /> : null}</View>
        : workspaceError || error ? <View style={{ padding: 8 }}><Text accessibilityRole="alert" style={styles.error}>{workspaceError ?? error}</Text><AppButton title="この月を再読込" compact variant="quiet" disabled={busy} onPress={() => void selectMonth(month)} /></View> : undefined} /></V2ScreenFrame>;
  }
  if (view === 'assignmentRequests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2AssignmentRequests model={model} actions={controller.actions} busy={busy} run={run}
      onResolve={onAssignment ? (id) => { const round = model.plan.occurrences.find((entry) => entry.id === id); if (round?.subjects[0]) onAssignment(id, round.subjects[0].id); } : undefined}
      header={<View style={{ gap: 16 }}>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="担当の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'requests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2DateRequests model={model} actions={controller.actions} busy={busy} run={run} readOwnCalendar={session.readOwnCalendar}
      header={<View style={{ gap: 16 }}>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="日時の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'round' || view === 'date' || view === 'assignment') {
    const round = model.plan.occurrences.find((entry) => entry.id === occurrenceId); const subject = round?.subjects.find((entry) => entry.id === subjectId);
    const chore = round ? model.plan.chores.find((entry) => entry.id === round.choreId) : undefined;
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2FormScrollView contentContainerStyle={styles.page}>
      {notice}<BackButton onPress={onBack} disabled={busy} />
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
    onOpen={() => onRound ? onRound(round.id, subject.id) : onConfiguration(round.choreId)} />;
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => subject.required && (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId)).map((subject) => ({ round, subject })));
  const today = entries.filter(({ round, subject }) => round.activeInPeriod && (recommendations.get(subject.id)?.date ?? subject.suggestedDate) === model.plan.range.asOfDate);
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
  const total = homeRows.filter(item => item.source !== 'waste').length;
  const done = homeRows.filter(item => item.source === 'personal' ? completionValues.get(item.key) ?? item.row.completed
    : item.source === 'shared' && visibility(item.round, item.subject).showStatus && (completionValues.get(item.key) ?? item.subject.completed)).length;
  const summary = homeSummary(total, done, clock, model.plan.timeZone);
  const expired = entries.filter(({ subject }) => subject.showExpiredOnHome);
  return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <Animated.FlatList data={homeRows} itemLayoutAnimation={LinearTransition.duration(240)} keyExtractor={(entry) => entry.key} contentContainerStyle={styles.page} initialNumToRender={8}
      ListHeaderComponent={<>
        <HomeHeader today={model.plan.range.asOfDate} workspaceName={typeof model.plan.commonSettings.name === 'string' ? model.plan.commonSettings.name : workspaceName ?? '共有グループ'} onGroup={onManage ?? onBack} />
        <HomeProgress summary={summary} total={total} done={done} />
        {workspaceError || error || display.error ? <Text accessibilityRole="alert" style={styles.error}>{workspaceError ?? error ?? display.error}</Text> : null}
        <SectionHeading title="今日の家事" trailing={<LoadSortButton order={display.order} onPress={display.toggle} />} />
        <V2PrivateTaskNotice overlay={privateOverlay} sharedTimeZone={model.plan.timeZone} />
        <V2DailyLoadNotice assessment={dailyLoad} />
        {privateOverlay?.status === 'ready' && privateOverlay.today !== model.plan.range.asOfDate ? <Text style={styles.caption}>個人の今日：{privateOverlay.today} · 共有の今日：{model.plan.range.asOfDate}</Text> : null}
        <Text style={styles.caption}>{purpose === 'development' ? '検査用の未送信操作' : '送信待ち'}：{model.pendingChanges}件</Text>
        {model.waste?.rows.some(row => !row.deleted && row.needsReview) ? <Text style={styles.error}>確認が必要なゴミ収集日があります。共有のゴミ収集日で候補を確認してください。</Text> : null}
        {purpose === 'workspace' ? <AppButton title="今すぐ同期" variant="quiet" disabled={busy} onPress={() => void run(() => session.controller.sync())} /> : null}</>}
      ListEmptyComponent={<Card><Text style={styles.body}>{privateOverlay?.status === 'unavailable' ? '今日の共有家事はありません。個人家事は未取得です。' : '今日の家事はありません。'}</Text></Card>}
      renderItem={({ item }) => item.source === 'waste' ? <V2WasteOccurrence entry={item.entry} actions={controller.actions} busy={busy} run={run} />
        : item.source === 'personal' ? <V2PrivateTaskCard row={item.row} source={session.privateTasks} busy={busy} run={run} feedback={feedback} home mixedSources={homeRows.some(entry => entry.source === 'shared')} /> : card(item.round, item.subject)}
      ListFooterComponent={<View style={styles.footer}>
        {notice}<BackButton onPress={onBack} disabled={busy} />
        {expired.length ? <AccordionSection title={`期限を過ぎた家事（${expired.length}件）`} expanded={expiredOpen} onToggle={() => setExpiredOpen((value) => !value)}>
          {expired.map(({ round, subject }) => <View key={subject.id}>{card(round, subject)}</View>)}
        </AccordionSection> : null}
        <AppButton title="実施履歴" variant="secondary" disabled={busy} onPress={onHistory} />
        {onCalendar ? <AppButton title="共有カレンダー" variant="secondary" disabled={busy} onPress={onCalendar} /> : null}
        {onRequests ? <AppButton title="日時の変更申請" variant="secondary" disabled={busy} onPress={onRequests} /> : null}
        {onAssignmentRequests ? <AppButton title="担当の変更申請" variant="secondary" disabled={busy} onPress={onAssignmentRequests} /> : null}
        {onManageChores ? <AppButton title="共有家事の一覧・編集" variant="secondary" disabled={busy} onPress={onManageChores} /> : null}
        {onWaste ? <AppButton title="共有のゴミ収集日" variant="secondary" disabled={busy} onPress={onWaste} /> : null}
        {onAppliances ? <AppButton title="共有の家電" variant="secondary" disabled={busy} onPress={onAppliances} /> : null}
        {purpose === 'development' ? <Card><SectionHeading title="設定を検査" />{model.configurations.map((entry) =>
          <AppButton key={entry.choreId} title={`「${model.plan.chores.find((chore) => chore.id === entry.choreId)?.name ?? '家事'}」の設定`} variant="quiet" disabled={busy} onPress={() => onConfiguration(entry.choreId)} />)}</Card> : null}
      </View>} />
    {lastUndo ? <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(insets.bottom, 8) }}><CompletionToast busy={busy} onUndo={() => {
      if (running.current || !alive.current) return; const receipt = lastUndo; setLastUndo(null); void perform(receipt.undo);
    }} /></View> : null}
  </V2ScreenFrame>;
}
/** A visible, fixed QA banner also lets native automation fail closed after scrolling long instructions. */
function V2ScreenFrame({ purpose, children, ...props }: ComponentProps<typeof SafeAreaView> & { purpose: V2GroupScreenProps['purpose'] }) {
  return <SafeAreaView {...props}>{purpose === 'development' ? <Text style={styles.qaScope}>開発用・端末内プレビュー</Text> : null}{children}</SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, page: { padding: 16, gap: 10, paddingBottom: 40 },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 18, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  settingsHeaderTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  qaScope: { ...typography.caption, color: palette.warning, paddingHorizontal: 16, paddingVertical: 4 },
  notice: { padding: 12, gap: 4, borderWidth: 1, borderRadius: 12, borderColor: palette.border }, noticeTitle: { ...typography.label, fontWeight: '600', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, body: { ...typography.body, color: palette.ink }, error: { ...typography.caption, color: palette.warning }, footer: { gap: 16, paddingTop: 12 },
});
