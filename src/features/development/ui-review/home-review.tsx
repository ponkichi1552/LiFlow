import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { NavigationHeader, SectionHeading, palette, typography } from '../../../components/planner-ui';
import { HomeHeaderContent, homeHeaderContainerStyle, HomeLinks, HomeEmptyChores, HomeProgress, HomeWeekSwitcher,
  HomeUpcomingDate, HomeExpiredHeading, HomeWasteLabels, LoadSortButton, CompletionToast } from '../../../components/home-ui';
import { HomeMotionList } from '../../../components/home-row-motion';
import { SettingsHeader } from '../../../components/settings-header';
import { WasteOccurrenceCard } from '../../../components/waste-occurrence-card';
import { HistoryRecordRow } from '../../../components/history-record-row';
import { TaskCheckboxRow } from '../../../components/task-checkbox-row';
import type { ChoreDefinition } from '../../../domain/chores/types';
import { groupChores } from '../../../domain/chores/chore-groups';
import { planPersonalCatalogToggles } from '../../../domain/chores/personal-catalog';
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
import { FirstRunSetupForm } from '../../onboarding/first-run-setup';
import { ChoreToggleList } from '../../settings/chore-toggle-list';

export { homeReviewScenarios } from './home-review-data';
type Panel = 'ヘルプ' | 'グループ' | '設定' | '実施履歴' | 'ゴミ収集日' | '家事一覧' | ChoreDefinition;
const runLocal = async (work: () => Promise<unknown>) => { await work(); };
const noPending = new Map<string, boolean>();

export function HomeReview(props: { scenario: string; onExit?(): void }) {
  return <HomeReviewSession key={props.scenario} {...props} />;
}

function HomeReviewSession({ scenario, onExit }: { scenario: string; onExit?(): void }) {
  const [edits, setEdits] = useState<HomeReviewEdits>(() => ({ completed: new Map(), assignees: new Map() }));
  const [scope, setScope] = useState<HomeWeekScope>('current');
  const [order, setOrder] = useState<LoadOrder>('heavy');
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [showPersonalSetup, setShowPersonalSetup] = useState(false);
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

  const { recommendations, summary, total, done, expiredCount, onlyExpired, listRows, mixedSources } = home;
  const needsPersonalSetup = shared && overlay.status === 'ready' && !overlay.setupCompleted;
  const noPersonalChores = !shared && !snapshot.chores.some(chore => chore.enabled && !chore.archived);
  const personalSetup = needsPersonalSetup ? { title: '個人の家事を設定', onPress: () => setShowPersonalSetup(true) } : undefined;
  const sharedOnly = shared && (needsPersonalSetup || overlay.status === 'unavailable');
  if (showPersonalSetup) return <FirstRunSetupForm snapshot={snapshot} referenceDate={snapshot.today}
    exitAccessibilityLabel="ホームに戻る" onExit={() => setShowPersonalSetup(false)}
    persist={async submission => setEdits(current => ({ ...current, personalSetup: submission }))}
    onComplete={async () => setShowPersonalSetup(false)} />;
  const sortButton = total > 1 || expiredCount > 1 ? <LoadSortButton order={order} onPress={toggleOrder} /> : undefined;
  const renderRow = (item: typeof listRows[number], index: number) => {
    if (item.kind === 'weeks') return <HomeWeekSwitcher scope={scope} onChange={setScope} />;
    if (item.kind === 'upcomingDate') return <HomeUpcomingDate date={item.date} today={homeReviewToday} />;
    if (item.kind === 'expiredHeading') return onlyExpired
      ? <SectionHeading title="期限を過ぎた家事" trailing={sortButton} />
      : <HomeExpiredHeading count={expiredCount} expanded={expanded} onToggle={() => setExpanded(value => !value)} />;
    if (item.kind === 'emptyWeek') return <Text style={styles.muted}>{scope === 'current' ? '今週の残りの' : '来週の'}{sharedOnly ? '共有家事' : '家事'}はありません。</Text>;
    if (item.kind === 'emptyToday') return <HomeEmptyChores
      message={noPersonalChores ? '家事が未設定' : sharedOnly ? '今日の共有家事はありません。' : '今日の家事はありません。'}
      action={noPersonalChores ? { title: '家事を選ぶ', onPress: () => setPanel('家事一覧') } : personalSetup} />;
    if (!('item' in item)) return null;
    const row = item.item;
    const showSource = item.kind === 'today' && item.showSource;
    if (row.source === 'waste') return <V2WasteOccurrence entry={row.entry} inline />;
    if (row.source === 'personal') {
      const { chore, completed, entryId, windowStart, windowEnd, seasonalWork, suggestedDate } = row.row;
      if (!shared) return <TaskCheckboxRow chore={chore} source="personal" home completed={completed} seasonalWork={seasonalWork} overdue={item.kind === 'expired'}
        lastInList={listRows[index + 1]?.kind !== item.kind}
        urgent={isTaskUrgent({ completed, load: chore.load, recommendedDate: suggestedDate, windowStart, windowEnd }, homeReviewToday)}
        executionWindow={windowStart && windowEnd ? { start: windowStart, end: windowEnd } : undefined}
        onOpen={() => setPanel(chore)} onToggle={entryId ? () => complete(entryId, !completed) : undefined} />;
      return <V2PrivateTaskCard row={row.row} busy={false} home mixedSources={mixedSources} run={runLocal} onOpen={() => setPanel(chore)}
        homeDate={item.kind === 'today' ? homeReviewToday : undefined} showHomeSource={showSource} overdue={item.kind === 'expired'}
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
    return <V2RoundCard home homeDate={item.kind === 'upcoming' && item.item.source === 'shared' ? item.item.date : undefined} mixedSources={mixedSources} model={model} round={round} subject={subject} actions={actions} busy={false} run={runLocal}
      showHomeSource={showSource} overdue={item.kind === 'expired'}
      recommendation={recommendations.get(subject.id)} onOpen={() => setPanel({ ...chore, householdId: model.plan.groupId })}
      feedback={{ values: noPending, supports: () => true, request: (_key, value) => complete(round.id, value),
        run: (_key, _value, work) => runLocal(work) }} />;
  };
  const groupName = shared ? homeReviewGroup : undefined;
  const list = <View style={styles.frame}>
    {onExit ? <NavigationHeader><SettingsHeader title="ホーム"
      backAccessibilityLabel="UI確認用データ一覧へ戻る" onBack={onExit} /></NavigationHeader> : null}
    <View style={homeHeaderContainerStyle(groupName)}><HomeHeaderContent today={homeReviewToday} workspaceName={groupName} birthday={fixture.birthday}
      onHelp={() => setPanel('ヘルプ')} onGroup={() => setPanel('グループ')} onSettings={() => setPanel('設定')} /></View>
    <HomeMotionList data={listRows} keyExtractor={row => row.key} renderItem={({ item, index }) => renderRow(item, index)}
      initialNumToRender={8} contentContainerStyle={shared ? styles.groupList : styles.personalList}
      ListHeaderComponent={<View style={shared ? undefined : styles.personalHeader}>
        <HomeProgress total={total} done={done} summary={summary} />
        <HomeWasteLabels entries={snapshot.upcomingWasteDates.map(occurrence => ({ key: occurrence.scheduleId, label: occurrence.label }))} />
        {total > 0 ? <SectionHeading title="今日の家事" trailing={sortButton} /> : null}
        {shared ? <V2PrivateTaskNotice home overlay={overlay} sharedTimeZone={model.plan.timeZone} /> : null}
      </View>}
      ListFooterComponent={<>{personalSetup && !listRows.some(row => row.kind === 'emptyToday') ? <HomeEmptyChores action={personalSetup} /> : null}
        <HomeLinks onHistory={() => setPanel('実施履歴')} onWaste={() => setPanel('ゴミ収集日')} /></>} />
    {undo ? <View pointerEvents="box-none" style={styles.toast}><CompletionToast onUndo={() => complete(undo, false)} /></View> : null}
  </View>;
  return <ChoreLibraryPane library={list} detail={panel === '家事一覧'
    ? <ReviewChoreSelection chores={snapshot.chores} onBack={() => setPanel(null)} save={async (ids, enabled) => {
      setEdits(current => ({ ...current, enabledChoreIds: planPersonalCatalogToggles(current.enabledChoreIds ?? [], ids, enabled) }));
    }} />
    : panel ? <ReviewPanel panel={panel} fixture={fixture} order={order} onSort={toggleOrder} onBack={() => setPanel(null)} /> : null} />;
}

function ReviewChoreSelection({ chores, onBack, save }: {
  chores: readonly ChoreDefinition[]; onBack(): void; save(ids: string[], enabled: boolean): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(() => new Set(groupChores(chores).slice(0, 1).map(([category]) => category)));
  const [selected, setSelected] = useState<ChoreDefinition>();
  return <ChoreLibraryPane library={<View style={styles.frame}>
    <SettingsHeader title="家事一覧" onBack={onBack} backAccessibilityLabel="ホームに戻る" />
    <ScrollView contentContainerStyle={styles.panel}>
      <ChoreToggleList chores={chores} expanded={expanded} setExpanded={setExpanded} personalSelection save={save}
        onOpen={id => setSelected(chores.find(chore => chore.id === id))} />
    </ScrollView>
  </View>} detail={selected ? <View style={styles.frame}>
    <SettingsHeader title="家事の説明" onBack={() => setSelected(undefined)} backAccessibilityLabel="家事一覧に戻る" />
    <ScrollView contentContainerStyle={styles.panel}><ChoreGuide chore={selected} mode="balanced" /></ScrollView>
  </View> : null} />;
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
  caption: { ...typography.caption, color: palette.muted },
  toast: { position: 'absolute', bottom: 8, left: 0, right: 0 },
});
