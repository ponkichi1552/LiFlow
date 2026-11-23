import { Redirect, Tabs, router } from 'expo-router';
import { WorkspaceTab } from '@/components/workspace-tab';
import { useCallback, useContext, useState } from 'react';
import { Platform, Settings, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { HomeMotionRow, HomeRowMotionScope } from '@/components/home-row-motion';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppButton, Card, Page, SectionHeading, palette, typography } from '@/components/planner-ui';
import { plannerTabBarLayout } from '@/components/planner-tab-bar';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { PlannerLoadState } from '@/components/planner-load-state';
import { FirstRunSetup } from '@/features/onboarding/first-run-setup';
import { selectDateTasks, type DateTask } from '@/domain/scheduling/date-tasks';
import { addDays, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import type { ChoreCompletion } from '@/domain/chores/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useTaskCompletion } from '@/hooks/use-task-completion';
import { useHomeClock } from '@/hooks/use-home-clock';
import { homeSummary } from '@/features/planner/home-summary';
import { HomeHeader, homeHeaderContainerStyle, HomeLinks, HomeEmptyChores, HomeProgress, HomeWasteLabels, HomeWeekSwitcher, HomeUpcomingDate, HomeExpiredHeading, LoadSortButton, CompletionToast } from '@/components/home-ui';
import { useHomeDisplay } from '@/hooks/use-home-display';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { homeUpcomingTasks, homeUpcomingRange, homeTaskRows, orderHomeTaskRows, isHomeTaskExpired, type HomeTaskRow, type HomeWeekScope } from '@/features/planner/home-presentation';
import { isTaskUrgent } from '@/domain/scheduling/task-priority';
import { commonChoreLinks } from '@/features/planner/common-chore-links';
import { useCommonChoreHistory } from '@/hooks/use-common-chore-history';
import { plannerColorsForScheme } from '@/components/planner-theme';
import { uiReviewBuild } from '@/features/development/ui-review/enabled';

export default function HomeScreen() {
  if (uiReviewBuild) {
    const area: unknown = Platform.OS === 'ios' ? Settings.get('LiFlowUiReviewArea') : undefined;
    const scenario: unknown = Platform.OS === 'ios' ? Settings.get('LiFlowUiReviewScenario') : undefined;
    return <Redirect href={{ pathname: '/development/ui-review', params: {
      ...(typeof area === 'string' ? { area } : {}),
      ...(typeof scenario === 'string' ? { scenario } : {}),
    } }} />;
  }
  return <WorkspaceTab view="home"><PersonalHomeScreen /></WorkspaceTab>;
}

function PersonalHomeScreen() {
  const colors = plannerColorsForScheme(useColorScheme());
  const taskListStyle = [styles.taskList, { borderColor: colors.border }];
  const insets = useSafeAreaInsets();
  const workspace = useContext(WorkspaceContext);
  const display = useHomeDisplay();
  const scoped = usePlannerData();
  const { snapshot, error, retrying, refresh, database, readError } = scoped;
  const personal = usePlannerData({ personal: true });
  const combined = Boolean(snapshot?.sharing && personal.database !== database);
  const commonHistory = useCommonChoreHistory({ workspace: combined ? workspace?.active ?? null : null, userId: workspace?.userId ?? null, shared: scoped, personal });
  const syncCommonHistory = commonHistory.sync;
  const authorizeCommon = commonHistory.assertAccess;
  const readPersonalSnapshot = personal.readSnapshot; const readSharedSnapshot = scoped.readSnapshot; const personalReadError = personal.readError;
  const assertUncommonPersonalAccess = useCallback(async (task?: DateTask) => {
    await authorizeCommon(); const failure = personalReadError?.(); if (failure) throw new Error(failure);
    if (task && commonChoreLinks(readPersonalSnapshot()?.chores ?? [], readSharedSnapshot()?.chores ?? []).some(link => link.personalChoreId === task.choreId)) {
      throw new Error('この家事は共有の設定に変わりました。表示を更新して共通の行から操作してください。');
    }
  }, [authorizeCommon, readPersonalSnapshot, readSharedSnapshot, personalReadError]);
  const refreshHome = useCallback(async () => { await refresh(); const failure = readError?.(); if (failure) throw new Error(failure); await syncCommonHistory(); }, [refresh, readError, syncCommonHistory]);
  const completion = useTaskCompletion(database, refreshHome, readError, combined ? { ...personal, isCurrent: commonHistory.isCurrent, assertAccess: assertUncommonPersonalAccess } : undefined, snapshot?.household);
  const clock = useHomeClock(snapshot?.timeZone);
  const actionError = completion.error;
  const [weekScope, setWeekScope] = useState<HomeWeekScope>('current');
  const [expiredExpanded, setExpiredExpanded] = useState(false);
  const today = snapshot?.today ?? localDateFromDate(new Date());
  const personalToday = personal.snapshot?.today ?? localDateFromDate(clock);
  const commonIds = new Set(combined ? commonChoreLinks(personal.snapshot?.chores ?? [], snapshot?.chores ?? []).map(link => link.personalChoreId) : []);
  const sources = snapshot ? [{ snapshot, source: snapshot.sharing ? 'shared' as const : 'personal' as const, today },
    ...(combined && personal.snapshot?.settings.setupCompleted ? [{ snapshot: { ...personal.snapshot, chores: personal.snapshot.chores.filter(chore => !commonIds.has(chore.id)) }, source: 'personal' as const, today: personalToday }] : [])] : [];
  const projectRows = (rows: HomeTaskRow[], records: ChoreCompletion[]) => {
    const tasks = completion.project(rows.map(row => row.task), records);
    return rows.map((row, index) => ({ ...row, task: tasks[index] }));
  };
  const orderedHomeRows = orderHomeTaskRows(sources.flatMap(scope => projectRows(homeTaskRows(
    selectDateTasks(scope.snapshot.scheduleEntries, scope.snapshot.completions, scope.today, 3, scope.snapshot.chores, true), scope.snapshot.chores, scope.source, scope.today), scope.snapshot.completions)), today, display.order);
  const homeKeys = new Set(orderedHomeRows.map(row => row.key));
  const { from: periodStart, through: periodEnd } = homeUpcomingRange(today, weekScope);
  const throughNextWeek = homeUpcomingRange(today, 'next').through;
  const upcoming = sources.flatMap(scope => {
    const from = addDays(scope.today >= today ? scope.today : today, 1);
    return projectRows(homeTaskRows(homeUpcomingTasks(scope.snapshot.scheduleEntries, scope.snapshot.completions, from, throughNextWeek, scope.snapshot.chores), scope.snapshot.chores, scope.source, scope.today), scope.snapshot.completions)
      .filter(row => !homeKeys.has(row.key));
  });
  const upcomingByDate: [LocalDate, HomeTaskRow[]][] = [];
  for (let day = periodStart; day <= periodEnd; day = addDays(day, 1)) {
    const tasks = orderHomeTaskRows(upcoming.filter(row => row.task.suggestedDate === day), today, display.order);
    if (tasks.length) upcomingByDate.push([day, tasks]);
  }

  if (!snapshot) {
    return <><Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} /><PlannerLoadState title="今日の家事" message="家事を読み込んでいます。"
      error={error && !retrying ? '端末に保存した家事を表示できませんでした。' : null} startupReady={Boolean(error)} /></>;
  }

  if (!snapshot.settings.setupCompleted) {
    return (
      <>
        <Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} />
        <FirstRunSetup snapshot={snapshot} onComplete={refresh} loadError={retrying ? null : error} />
      </>
    );
  }

  const expiredRows: HomeTaskRow[] = []; const orderedDueToday: HomeTaskRow[] = [];
  for (const row of orderedHomeRows) (isHomeTaskExpired(row.task.completed, row.task.entry?.windowEnd ?? row.task.completion?.scheduledWindowEnd, row.today) ? expiredRows : orderedDueToday).push(row);
  const todayTotal = orderedDueToday.length;
  const onlyExpired = todayTotal === 0 && expiredRows.length > 0;
  const showExpired = onlyExpired || expiredExpanded;
  const todayDone = orderedDueToday.filter(row => row.task.completed).length;
  const summary = homeSummary(todayTotal, todayDone);
  const todayWaste = sources.flatMap(scope => scope.snapshot.upcomingWasteDates.filter(occurrence => occurrence.date === scope.today)
    .map(occurrence => ({ occurrence, source: scope.source, key: `${scope.snapshot.household.id}:${occurrence.scheduleId}:${occurrence.date}` })));
  const upcomingKnown = !error && (!combined || !personal.loading && !personal.error && Boolean(personal.snapshot));
  const showUpcoming = upcoming.length > 0 || !upcomingKnown;
  const visibleSources = new Set([...orderedDueToday, ...(showExpired ? expiredRows : []), ...upcomingByDate.flatMap(([, rows]) => rows)].map(row => row.source));
  const mixedSources = visibleSources.size > 1;
  const needsChoreSetup = !sources.some(scope => scope.snapshot.chores.some(chore => chore.enabled && !chore.archived));
  const groupName = workspace?.active ? workspace.group?.displayName ?? snapshot.household.name : snapshot.household.name;
  const renderTask = (row: HomeTaskRow, index: number, last: boolean, overdue = false, sectionDate = today) => {
    const { task, chore, source } = row;
    const differentDay = !overdue && sectionDate === today && row.today !== today;
    return <HomeMotionRow key={row.key} index={index}>
      <TaskCheckboxRow chore={chore} home lastInList={last} completed={task.completed} source={source} mixedSources={mixedSources} overdue={overdue}
        seasonalWork={task.entry?.seasonalWork ?? task.completion?.seasonalWork}
        contextLabel={combined ? source === 'personal' ? '個人' : groupName : undefined}
        detail={differentDay ? formatJapaneseDate(row.today, { year: row.today.slice(0, 4) !== today.slice(0, 4) }) : undefined}
        executionWindow={task.entry ? { start: task.entry.windowStart, end: task.entry.windowEnd } : task.completion?.scheduledWindowStart && task.completion?.scheduledWindowEnd ? { start: task.completion.scheduledWindowStart, end: task.completion.scheduledWindowEnd } : undefined}
        urgent={isTaskUrgent({ completed: task.completed, load: chore.load, recommendedDate: task.suggestedDate, windowStart: task.entry?.windowStart ?? task.completion?.scheduledWindowStart, windowEnd: task.entry?.windowEnd ?? task.completion?.scheduledWindowEnd }, row.today)}
        onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'home', ...(combined ? { source: source === 'personal' ? 'personal' : undefined } : {}) } })}
        onToggle={completion.canToggle(task) ? () => void completion.toggle(task) : undefined} />
    </HomeMotionRow>;
  };

  return (
    <HomeRowMotionScope>
      <Tabs.Screen options={{ tabBarStyle: { ...plannerTabBarLayout(insets.bottom), backgroundColor: palette.surface, borderTopColor: palette.border, borderTopWidth: 1 } }} />
      <Page header={<HomeHeader today={today} workspaceName={snapshot.sharing ? groupName : undefined} />} headerStyle={homeHeaderContainerStyle(snapshot.sharing ? groupName : undefined)} contentStyle={styles.homePage} floatingFooter footerHasTabBar footer={completion.undoAvailable ? <CompletionToast onUndo={() => void completion.undoLast()} /> : undefined}>
        {actionError ? <Card><Text accessibilityRole="alert" style={styles.error}>{actionError}</Text><AppButton title={completion.recoveryLabel ?? '表示を再読込'} variant="quiet" compact
          disabled={completion.pending.size > 0 || completion.reading} onPress={() => void completion.retryRead()} /></Card> : null}
        {error && !retrying && !actionError ? <Text accessibilityRole="alert" style={styles.error}>最新の家事を表示できませんでした。</Text> : null}

      <HomeProgress summary={summary} total={todayTotal} done={todayDone} />
      {combined && (personal.error && !personal.retrying || !personal.snapshot && !personal.error) ?
        <Text accessibilityRole={personal.error ? 'alert' : undefined} style={styles.noticeBody}>{personal.error ? '最新の個人家事を表示できませんでした。' : '個人の家事を読み込んでいます。'}</Text> : null}
      {display.error ? <Text accessibilityRole="alert" style={styles.error}>{display.error}</Text> : null}
      {commonHistory.error ? <Card><Text accessibilityRole="alert" style={styles.error}>{commonHistory.error}</Text><AppButton title="個人側への反映を再試行" variant="quiet" compact onPress={() => void commonHistory.sync().catch(() => {})} /></Card> : null}

      <HomeWasteLabels entries={todayWaste.map(({ occurrence, key, source }) => ({ key, label: occurrence.label, source }))} />

      {todayTotal || expiredRows.length ? <SectionHeading title={onlyExpired ? '期限を過ぎた家事' : '今日の家事'} trailing={todayTotal > 1 || expiredRows.length > 1
        ? <LoadSortButton order={display.order} onPress={display.toggle} /> : undefined} /> : null}
      {todayTotal > 0 ? <View style={taskListStyle}>{orderedDueToday.map((row, index) => renderTask(row, index, index === orderedDueToday.length - 1))}</View> : null}
      {todayTotal === 0 && expiredRows.length === 0 ? (
        <HomeEmptyChores message={!upcomingKnown ? '表示できる今日の家事はありません。' : needsChoreSetup ? '家事が未設定' : '今日の家事はありません。'}
          action={needsChoreSetup && upcomingKnown ? { title: '家事を選ぶ', onPress: () => router.push('/chores') } : undefined} />
      ) : null}

      {expiredRows.length ? <View>
        {!onlyExpired ? <HomeExpiredHeading count={expiredRows.length} expanded={expiredExpanded} onToggle={() => setExpiredExpanded(value => !value)} /> : null}
        {showExpired ? <View style={taskListStyle}>{expiredRows.map((row, index) => renderTask(row, index, index === expiredRows.length - 1, true))}</View> : null}
      </View> : null}

      {showUpcoming ? <HomeWeekSwitcher scope={weekScope} onChange={setWeekScope} /> : null}

      {upcomingByDate.length ? upcomingByDate.map(([date, entries]) => (
        <View key={date} style={styles.dayGroup}>
          <HomeUpcomingDate date={date} today={today} />
          <View style={taskListStyle}>{entries.map((row, index) => renderTask(row, index, index === entries.length - 1, false, date))}</View>
        </View>
      )) : showUpcoming && upcomingKnown ? (
        <Text style={[styles.emptyBody, styles.emptyWeek]}>{weekScope === 'current' ? '今週の残りの家事はありません。' : '来週の家事はありません。'}</Text>
      ) : null}

      <HomeLinks onHistory={() => router.push('/history')} onWaste={() => router.push('/waste')} />
      </Page>
    </HomeRowMotionScope>
  );
}

const styles = StyleSheet.create({
  taskList: { overflow: 'hidden' },
  homePage: { gap: 12, paddingTop: 4, paddingBottom: 80 },
  noticeBody: { ...typography.body, color: palette.muted },
  emptyBody: { ...typography.body, color: palette.muted },
  emptyWeek: { paddingVertical: 10 },
  dayGroup: { gap: 9, marginTop: 2 },
  error: { ...typography.label, color: palette.warning },
});
