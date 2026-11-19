import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionLabel, Card, NavigationHeader, SectionHeading, palette, typography } from '../../../components/planner-ui';
import { HomeHeaderContent, homeHeaderContainerStyle, HomeLinks, HomeProgress, HomeWeekSwitcher,
  HomeUpcomingDate, HomeExpiredHeading, LoadSortButton, CompletionToast } from '../../../components/home-ui';
import { HomeMotionList } from '../../../components/home-row-motion';
import { SettingsHeader } from '../../../components/settings-header';
import { WasteOccurrenceCard } from '../../../components/waste-occurrence-card';
import { HistoryRecordRow } from '../../../components/history-record-row';
import { TaskCheckboxRow } from '../../../components/task-checkbox-row';
import type { ChoreDefinition } from '../../../domain/chores/types';
import { isTaskUrgent, type LoadOrder } from '../../../domain/scheduling/task-priority';
import type { HomeWeekScope } from '../../planner/home-presentation';
import { ChoreGuide } from '../../chores/chore-guide';
import { ChoreLibraryPane } from '../../chores/chore-library';
import { PersonalHistoryRecord } from '../../planner/personal-history-record';
import { HELP_SECTIONS } from '../../help/help-content';
import { V2RoundCard } from '../../sharing/v2-ui/round-card';
import { V2PrivateTaskCard, V2PrivateTaskNotice } from '../../sharing/v2-ui/private-task-card';
import { V2WasteOccurrence } from '../../sharing/v2-ui/waste-occurrence';
import { buildHomeRows } from '../../sharing/v2-ui/home-rows';
import { v2MemberLabels } from '../../sharing/v2-ui/member-labels';
import { v2CanShowCompletion } from '../../sharing/v2-ui/round-visibility';
import { homeReviewData, homeReviewGroup, homeReviewToday, homeReviewViewer, type HomeReviewEdits } from './home-review-data';

export { homeReviewScenarios } from './home-review-data';
type Panel = 'ヘルプ' | 'グループ' | '設定' | '実施履歴' | 'ゴミ収集日' | '家事一覧' | '天気予報の出典' | ChoreDefinition;
const runLocal = async (work: () => Promise<unknown>) => { await work(); };
const noPending = new Map<string, boolean>();

export function HomeReview({ scenario }: { scenario: string }) {
  return <HomeReviewSession key={scenario} scenario={scenario} />;
}

function HomeReviewSession({ scenario }: { scenario: string }) {
  const [edits, setEdits] = useState<HomeReviewEdits>(() => ({ completed: new Map(), assignees: new Map() }));
  const [scope, setScope] = useState<HomeWeekScope>('current');
  const [order, setOrder] = useState<LoadOrder>('heavy');
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const fixture = useMemo(() => homeReviewData(scenario, edits), [scenario, edits]);
  const { model, personal, snapshot, overlay, shared } = fixture;
  const home = useMemo(() => buildHomeRows(model, personal, overlay, scope, order, noPending, expanded),
    [model, personal, overlay, scope, order, expanded]);
  const toggleOrder = () => setOrder(value => value === 'heavy' ? 'light' : 'heavy');
  const complete = (id: string, value: boolean) => {
    setEdits(current => ({ ...current, completed: new Map(current.completed).set(id, value) }));
    setUndo(value ? id : null);
    return true;
  };
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 6500);
    return () => clearTimeout(timer);
  }, [undo]);

  const { recommendations, summary, total, done, expiredCount, listRows } = home;
  const renderRow = (item: typeof listRows[number], index: number) => {
    if (item.kind === 'weeks') return <HomeWeekSwitcher scope={scope} onChange={setScope} />;
    if (item.kind === 'upcomingDate') return <HomeUpcomingDate date={item.date} />;
    if (item.kind === 'expiredHeading') return <HomeExpiredHeading count={expiredCount} expanded={expanded} onToggle={() => setExpanded(value => !value)} />;
    if (item.kind === 'emptyWeek') return <Text style={styles.muted}>{overlay.status === 'unavailable' ? '共有家事の予定はありません。個人家事は未取得です。'
      : scope === 'current' ? '今週の残りの家事はありません。' : '来週の家事はありません。'}</Text>;
    if (item.kind === 'emptyToday') return shared
      ? <Card><Text style={styles.body}>{overlay.status === 'unavailable' ? '今日の共有家事はありません。個人家事は未取得です。' : '今日の家事はありません。'}</Text></Card>
      : <Card><Text style={styles.strong}>今日の予定はありません</Text><Text style={styles.muted}>家事一覧から予定や頻度を調整できます。</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="家事一覧を見る" onPress={() => setPanel('家事一覧')}><ActionLabel label="家事一覧を見る" style={styles.link} /></Pressable></Card>;
    if (!('item' in item)) return null;
    const row = item.item;
    if (row.source === 'waste') return <V2WasteOccurrence entry={row.entry} home />;
    if (row.source === 'personal') {
      const { chore, completed, entryId, windowStart, windowEnd, seasonalWork, suggestedDate } = row.row;
      if (!shared) return <TaskCheckboxRow chore={chore} source="personal" home completed={completed} seasonalWork={seasonalWork}
        lastInList={listRows[index + 1]?.kind !== item.kind}
        urgent={isTaskUrgent({ completed, load: chore.load, recommendedDate: suggestedDate, windowStart, windowEnd }, homeReviewToday)}
        executionWindow={windowStart && windowEnd ? { start: windowStart, end: windowEnd } : undefined}
        onOpen={() => setPanel(chore)} onToggle={entryId ? () => complete(entryId, !completed) : undefined} />;
      return <V2PrivateTaskCard row={row.row} busy={false} home mixedSources run={runLocal} onOpen={() => setPanel(chore)}
        feedback={{ values: noPending, supports: () => Boolean(entryId), request: (_key, value) => Boolean(entryId && complete(entryId, value)),
          run: (_key, _completed, work) => runLocal(work) }} />;
    }
    const { round, subject } = row;
    const chore = model.plan.chores.find(value => value.id === round.choreId);
    if (!chore) return null;
    const assign = async (ids: readonly string[]) => {
      setEdits(current => ({ ...current, assignees: new Map(current.assignees).set(round.id, ids) }));
      return [];
    };
    const actions: ComponentProps<typeof V2RoundCard>['actions'] = {
      claim: () => assign([homeReviewViewer]), releaseClaim: () => assign([]),
      complete: async () => { complete(round.id, true); return []; },
      undoMany: async () => { complete(round.id, false); return []; },
      // Assignment requests belong to the round detail screen. The Home card exposes only "担う".
      requestAssignment: async () => { throw new Error('担当変更の申請はこの確認画面の対象外です。'); },
    };
    return <V2RoundCard home model={model} round={round} subject={subject} actions={actions} busy={false} run={runLocal}
      recommendation={recommendations.get(subject.id)} onOpen={() => setPanel({ ...chore, householdId: model.plan.groupId })}
      feedback={{ values: noPending, supports: () => true, request: (_key, value) => complete(round.id, value),
        run: (_key, _value, work) => runLocal(work) }} />;
  };
  const groupName = shared ? homeReviewGroup : undefined;
  const list = <View style={styles.frame}>
    <View style={homeHeaderContainerStyle(groupName)}><HomeHeaderContent today={homeReviewToday} workspaceName={groupName} birthday={fixture.birthday}
      onHelp={() => setPanel('ヘルプ')} onGroup={() => setPanel('グループ')} onSettings={() => setPanel('設定')} /></View>
    <HomeMotionList data={listRows} keyExtractor={row => row.key} renderItem={({ item, index }) => renderRow(item, index)}
      initialNumToRender={8} contentContainerStyle={shared ? styles.groupList : styles.personalList}
      ListHeaderComponent={<View style={shared ? undefined : styles.personalHeader}>
        <HomeProgress total={total} done={done} summary={summary} />
        {snapshot.weatherOutcome === 'adjusted' || snapshot.weatherOutcome === 'unavailable' ? <Card style={styles.weather}>
          <Text style={styles.strong}>{snapshot.weatherOutcome === 'adjusted' ? '天気に合わせて洗濯予定を調整しました' : '天気予報を取得できませんでした'}</Text>
          <Text style={styles.muted}>{snapshot.weatherOutcome === 'adjusted' ? `${snapshot.weatherAdjustmentCount}件の予定を見直しています。` : '通常の家事予定を表示しています。'}</Text>
          {snapshot.weatherOutcome === 'adjusted' ? <Pressable accessibilityRole="link" onPress={() => setPanel('天気予報の出典')} style={styles.credit}><Text style={styles.creditText}>Weather data: MET Norway · CC BY 4.0 ↗</Text></Pressable> : null}
        </Card> : null}
        {snapshot.upcomingWasteDates.map(occurrence => <WasteOccurrenceCard key={occurrence.scheduleId} occurrence={occurrence} home />)}
        <SectionHeading title="今日の家事" trailing={<LoadSortButton order={order} onPress={toggleOrder} />} />
        {shared ? <V2PrivateTaskNotice overlay={overlay} sharedTimeZone={model.plan.timeZone} /> : null}
        {shared && overlay.status === 'ready' && overlay.today !== homeReviewToday ? <Text style={styles.caption}>個人の今日：{overlay.today} · 共有の今日：{homeReviewToday}</Text> : null}
      </View>}
      ListFooterComponent={<HomeLinks onHistory={() => setPanel('実施履歴')} onWaste={() => setPanel('ゴミ収集日')} />} />
    {undo ? <View pointerEvents="box-none" style={styles.toast}><CompletionToast onUndo={() => complete(undo, false)} /></View> : null}
  </View>;
  return <ChoreLibraryPane library={list} detail={panel
    ? <ReviewPanel panel={panel} fixture={fixture} order={order} onSort={toggleOrder} onBack={() => setPanel(null)} /> : null} />;
}

/** Auxiliary actions stay inside the selected fictional household. */
function ReviewPanel({ panel, fixture, order, onSort, onBack }: {
  panel: Panel; fixture: ReturnType<typeof homeReviewData>; order: LoadOrder; onSort: () => void; onBack: () => void;
}) {
  const { snapshot, model } = fixture;
  const nameOf = v2MemberLabels(model.plan.members);
  const history = model.plan.history.filter(record => record.active && v2CanShowCompletion(model, record));
  return <View style={styles.frame}><NavigationHeader><SettingsHeader title={typeof panel === 'string' ? panel : '家事の説明'} onBack={onBack} /></NavigationHeader>
    <ScrollView contentContainerStyle={styles.panel}>
      {typeof panel !== 'string' ? <ChoreGuide chore={panel} mode="balanced" /> : null}
      {panel === 'ヘルプ' ? <Text style={styles.body}>{HELP_SECTIONS[0].paragraphs[0]} 家事名を押すと、手順や道具を確認できます。</Text> : null}
      {panel === 'グループ' ? fixture.shared ? <><SectionHeading title={homeReviewGroup} />
        {model.plan.members.map(member => <Text style={styles.body} key={member.userId}>{member.displayName}{member.userId === homeReviewViewer ? '（自分）' : ''}</Text>)}</>
        : <Text style={styles.muted}>参加中のグループはありません。</Text> : null}
      {panel === '設定' ? <SectionHeading title="家事の並び順" trailing={<LoadSortButton order={order} onPress={onSort} />} /> : null}
      {panel === '家事一覧' ? <Text style={styles.muted}>予定に追加した家事はありません。</Text> : null}
      {panel === '天気予報の出典' ? <Text style={styles.body}>MET Norway · CC BY 4.0</Text> : null}
      {panel === 'ゴミ収集日' ? fixture.waste.length ? fixture.waste.map(occurrence => <WasteOccurrenceCard key={occurrence.scheduleId} occurrence={occurrence} listRow />)
        : <Text style={styles.muted}>登録したゴミ収集日はありません。</Text> : null}
      {panel === '実施履歴' ? <>
        {!snapshot.completions.length && !history.length ? <Text style={styles.muted}>実施履歴はありません。</Text> : null}
        {snapshot.completions.map(record => <PersonalHistoryRecord key={record.id} completion={record} timeZone={snapshot.timeZone} name={snapshot.chores.find(chore => chore.id === record.choreId)?.name ?? '家事'} />)}
        {history.map(record => <HistoryRecordRow key={record.operationId} name={model.plan.chores.find(chore => chore.id === record.choreId)?.name ?? '家事'}
          time={new Date(record.performedAt).toLocaleTimeString('ja-JP', { timeZone: model.plan.timeZone, hour: '2-digit', minute: '2-digit' })}
          status={record.acceptance === 'pending' ? '代行の承認待ち' : undefined} attention={record.acceptance === 'pending'}
          details={<><Text style={styles.caption}>当時の担当者：{record.originalAssigneeIds.map(nameOf).join('・') || '未確定'}</Text><Text style={styles.caption}>実施者：{nameOf(record.performerUserId)}</Text></>} />)}
      </> : null}
    </ScrollView></View>;
}
const styles = StyleSheet.create({
  frame: { flex: 1, minHeight: 0, backgroundColor: palette.background },
  groupList: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 40, gap: 10 },
  personalList: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 80 },
  personalHeader: { gap: 12 }, panel: { gap: 12, padding: 18, paddingBottom: 40 },
  body: { ...typography.body, color: palette.ink }, muted: { ...typography.body, color: palette.muted, paddingVertical: 6 },
  caption: { ...typography.caption, color: palette.muted }, strong: { ...typography.body, fontWeight: '700', color: palette.ink },
  link: { ...typography.label, color: palette.accent, fontWeight: '700', paddingVertical: 10 },
  weather: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, gap: 4 },
  credit: { minHeight: 44, justifyContent: 'center' }, creditText: { ...typography.caption, color: palette.accent, textDecorationLine: 'underline' },
  toast: { position: 'absolute', bottom: 8, left: 0, right: 0 },
});
