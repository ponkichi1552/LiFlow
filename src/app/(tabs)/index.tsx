import { Tabs, router } from 'expo-router';
import { WorkspaceTab } from '@/components/workspace-tab';
import { useCallback, useContext, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionLabel, AppButton, Card, Page, SectionHeading, palette, typography } from '@/components/planner-ui';
import { plannerTabBarLayout } from '@/components/planner-tab-bar';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { WasteOccurrenceCard } from '@/components/waste-occurrence-card';
import { PlannerLoadState } from '@/components/planner-load-state';
import { FirstRunSetup } from '@/features/onboarding/first-run-setup';
import { selectDateTasks, type DateTask } from '@/domain/scheduling/date-tasks';
import { addDays, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import type { ChoreCompletion } from '@/domain/chores/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useWasteOccurrenceToggle } from '@/features/waste/use-waste-occurrence-toggle';
import { WeatherAttribution } from '@/components/data-credits';
import { useTaskCompletion } from '@/hooks/use-task-completion';
import { useHomeClock } from '@/hooks/use-home-clock';
import { homeSummary } from '@/features/planner/home-summary';
import { HomeHeader, HomeLinks, HomeProgress, HomeWeekSwitcher, HomeUpcomingDate, LoadSortButton, CompletionToast } from '@/components/home-ui';
import { useHomeDisplay } from '@/hooks/use-home-display';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { homeUpcomingTasks, homeUpcomingRange, homeTaskRows, orderHomeTaskRows, type HomeTaskRow, type HomeWeekScope } from '@/features/planner/home-presentation';
import { isTaskUrgent } from '@/domain/scheduling/task-priority';
import { commonChoreLinks } from '@/features/planner/common-chore-links';
import { useCommonChoreHistory } from '@/hooks/use-common-chore-history';

export default function HomeScreen() {
  return <WorkspaceTab view="home"><PersonalHomeScreen /></WorkspaceTab>;
}

function PersonalHomeScreen() {
  const insets = useSafeAreaInsets();
  const workspace = useContext(WorkspaceContext);
  const display = useHomeDisplay();
  const scoped = usePlannerData();
  const { snapshot, error, refresh, database, readError } = scoped;
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
  const wasteVisibility = useWasteOccurrenceToggle(database, refresh);
  const personalWasteVisibility = useWasteOccurrenceToggle(personal.database, personal.refresh);
  const actionError = completion.error;
  const [weekScope, setWeekScope] = useState<HomeWeekScope>('current');
  const today = snapshot?.today ?? localDateFromDate(new Date());
  const personalToday = personal.snapshot?.today ?? localDateFromDate(clock);
  const commonIds = new Set(combined ? commonChoreLinks(personal.snapshot?.chores ?? [], snapshot?.chores ?? []).map(link => link.personalChoreId) : []);
  const sources = snapshot ? [{ snapshot, source: snapshot.sharing ? 'shared' as const : 'personal' as const, today },
    ...(combined && personal.snapshot?.settings.setupCompleted ? [{ snapshot: { ...personal.snapshot, chores: personal.snapshot.chores.filter(chore => !commonIds.has(chore.id)) }, source: 'personal' as const, today: personalToday }] : [])] : [];
  const projectRows = (rows: HomeTaskRow[], records: ChoreCompletion[]) => {
    const tasks = completion.project(rows.map(row => row.task), records);
    return rows.map((row, index) => ({ ...row, task: tasks[index] }));
  };
  const { from: periodStart, through: periodEnd } = homeUpcomingRange(today, weekScope);
  const upcomingByDate = (() => {
    const groups: [LocalDate, HomeTaskRow[]][] = [];
    if (!snapshot) return groups;
    const firstVisibleDate = periodStart;
    const upcoming = sources.flatMap(scope => {
      const from = firstVisibleDate > scope.today ? firstVisibleDate : addDays(scope.today, 1);
      return projectRows(homeTaskRows(homeUpcomingTasks(scope.snapshot.scheduleEntries, scope.snapshot.completions, from, periodEnd, scope.snapshot.chores), scope.snapshot.chores, scope.source, scope.today), scope.snapshot.completions);
    });
    for (let date = firstVisibleDate; date <= periodEnd; date = addDays(date, 1)) {
      const tasks = orderHomeTaskRows(upcoming.filter(row => row.task.suggestedDate === date), today, display.order);
      if (tasks.length) groups.push([date, tasks]);
    }
    return groups;
  })();

  if (!snapshot) {
    return <><Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} /><PlannerLoadState title="今日の家事" message="今日の家事を読み込んでいます。" error={error} retry={refresh} /></>;
  }

  if (!snapshot.settings.setupCompleted) {
    return (
      <>
        <Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} />
        <FirstRunSetup snapshot={snapshot} onComplete={refresh} loadError={error} />
      </>
    );
  }

  const orderedDueToday = orderHomeTaskRows(sources.flatMap(scope => projectRows(homeTaskRows(
    selectDateTasks(scope.snapshot.scheduleEntries, scope.snapshot.completions, scope.today, 3, scope.snapshot.chores), scope.snapshot.chores, scope.source, scope.today), scope.snapshot.completions)), today, display.order);
  const todayTotal = orderedDueToday.length;
  const todayDone = orderedDueToday.filter(row => row.task.completed).length;
  const summary = homeSummary(todayTotal, todayDone);
  const todayWaste = sources.flatMap(scope => scope.snapshot.upcomingWasteDates.filter(occurrence => occurrence.date === scope.today)
    .map(occurrence => ({ occurrence, source: scope.source, key: `${scope.snapshot.household.id}:${occurrence.scheduleId}:${occurrence.date}`,
      visibility: combined && scope.source === 'personal' ? personalWasteVisibility : wasteVisibility })));
  const groupName = workspace?.active ? workspace.group?.displayName ?? snapshot.household.name : snapshot.household.name;
  const renderTask = (row: HomeTaskRow, last: boolean) => {
    const { task, chore, source } = row;
    const region = combined && source === 'personal' && personal.snapshot?.timeZone !== snapshot.timeZone ? personal.snapshot?.timeZone : undefined;
    return <Animated.View key={row.key} layout={LinearTransition.duration(240)}>
      <TaskCheckboxRow chore={chore} home lastInList={last} completed={task.completed} source={source} mixedSources={combined}
        contextLabel={combined ? source === 'personal' ? '個人' : groupName : undefined} detail={region}
        executionWindow={task.entry ? { start: task.entry.windowStart, end: task.entry.windowEnd } : task.completion?.scheduledWindowStart && task.completion?.scheduledWindowEnd ? { start: task.completion.scheduledWindowStart, end: task.completion.scheduledWindowEnd } : undefined}
        urgent={isTaskUrgent({ completed: task.completed, load: chore.load, recommendedDate: task.suggestedDate, windowEnd: task.entry?.windowEnd ?? task.completion?.scheduledWindowEnd }, row.today)}
        onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'home', ...(combined ? { source: source === 'personal' ? 'personal' : undefined } : {}) } })}
        onToggle={completion.canToggle(task) ? () => void completion.toggle(task) : undefined} />
    </Animated.View>;
  };

  return (
    <>
      <Tabs.Screen options={{ tabBarStyle: { ...plannerTabBarLayout(insets.bottom), backgroundColor: palette.surface, borderTopColor: palette.border, borderTopWidth: 1 } }} />
      <Page header={<HomeHeader today={today} workspaceName={snapshot.sharing ? groupName : undefined} />} contentStyle={styles.homePage} floatingFooter footerHasTabBar footer={completion.undoAvailable ? <CompletionToast onUndo={() => void completion.undoLast()} /> : undefined}>
        {error || actionError ? <Card><Text style={styles.error}>{actionError ?? error}</Text><AppButton title="表示を再読込" variant="quiet" compact
          disabled={completion.pending.size > 0 || completion.reading} onPress={() => void completion.retryRead()} /></Card> : null}

      <HomeProgress summary={summary} total={todayTotal} done={todayDone} />
      {combined && personalToday !== today ? <Text style={styles.noticeBody}>個人の今日：{formatJapaneseDate(personalToday, { weekday: true })} · {personal.snapshot?.timeZone}</Text> : null}
      {combined && (personal.loading || personal.error || !personal.snapshot) ? <Card><Text style={styles.noticeBody}>{personal.error ? '個人の家事を読み込めませんでした。保存したデータは保持しています。' : '個人の家事を読み込んでいます。'}</Text>
        {personal.error ? <AppButton title="個人の家事を再読込" variant="quiet" compact onPress={() => void personal.refresh()} /> : null}</Card> : null}
      {display.error ? <Text accessibilityRole="alert" style={styles.error}>{display.error}</Text> : null}
      {commonHistory.error ? <Card><Text accessibilityRole="alert" style={styles.error}>{commonHistory.error}</Text><AppButton title="個人側への反映を再試行" variant="quiet" compact onPress={() => void commonHistory.sync().catch(() => {})} /></Card> : null}

      {snapshot.weatherOutcome === 'adjusted' ? (
        <Card style={styles.weatherNotice}>
          <Text style={styles.noticeTitle}>天気に合わせて洗濯予定を調整しました</Text>
          <Text style={styles.noticeBody}>{snapshot.weatherAdjustmentCount}件の予定を見直しています。</Text>
          <WeatherAttribution />
        </Card>
      ) : snapshot.weatherOutcome === 'unavailable' ? (
        <Card style={styles.weatherNotice}>
          <Text style={styles.noticeTitle}>天気予報を取得できませんでした</Text>
          <Text style={styles.noticeBody}>通常の家事予定を表示しています。</Text>
        </Card>
      ) : null}

      {todayWaste.map(({ occurrence, visibility, key, source }) => (
        <WasteOccurrenceCard key={key} occurrence={occurrence} home source={combined ? source : undefined}
          busy={visibility.busyKeys.has(`${occurrence.scheduleId}:${occurrence.date}`)}
          onToggle={() => void visibility.toggle(occurrence, false)} />
      ))}
      {wasteVisibility.error ? <Text style={styles.error}>{wasteVisibility.error}</Text> : null}
      {combined && personalWasteVisibility.error ? <Text style={styles.error}>{personalWasteVisibility.error}</Text> : null}

      <SectionHeading title="今日の家事" trailing={<LoadSortButton order={display.order} onPress={display.toggle} />} />
      {todayTotal > 0 ? <View style={styles.taskList}>{orderedDueToday.map((row, index) => renderTask(row, index === orderedDueToday.length - 1))}</View> : null}
      {todayTotal === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>今日の予定はありません</Text>
          <Text style={styles.emptyBody}>家事一覧から予定や頻度を調整できます。</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="家事一覧を見る" onPress={() => router.push('/chores')}><ActionLabel label="家事一覧を見る" style={styles.textLink} /></Pressable>
        </Card>
      ) : null}

      <HomeWeekSwitcher scope={weekScope} onChange={setWeekScope} />

      {upcomingByDate.length ? upcomingByDate.map(([date, entries]) => (
        <View key={date} style={styles.dayGroup}>
          <HomeUpcomingDate date={date} />
          <View style={styles.taskList}>{entries.map((row, index) => renderTask(row, index === entries.length - 1))}</View>
        </View>
      )) : (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyBody}>{weekScope === 'current' ? '今週の予定はありません。' : '来週の予定はありません。'}</Text>
        </Card>
      )}

      <HomeLinks onHistory={() => router.push('/history')} onWaste={() => router.push('/waste')} />
      </Page>
    </>
  );
}

const styles = StyleSheet.create({
  taskList: { borderWidth: 1, borderColor: palette.border, borderRadius: 14, overflow: 'hidden' },
  homePage: { gap: 12, paddingTop: 8, paddingBottom: 80 },
  weatherNotice: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, gap: 4 },
  noticeTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  noticeBody: { ...typography.body, color: palette.muted },
  emptyCard: { paddingVertical: 18 },
  emptyTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  emptyBody: { ...typography.body, color: palette.muted },
  textLink: { ...typography.label, color: palette.accent, fontWeight: '700', paddingVertical: 10 },
  dayGroup: { gap: 9, marginTop: 2 },
  error: { ...typography.label, color: palette.warning },
});
