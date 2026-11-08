import type { ReactNode } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { NavigationHeader, palette, typography } from '../../../components/planner-ui';
import { SettingsHeader } from '../../../components/settings-header';
import { HistoryDayHeading } from '../../../components/history-day-heading';
import { HistoryOverview, HistoryRecordRow } from '../../../components/history-record-row';
import { groupHistoryByDay } from '../../planner/history-groups';
import { completionHistoryDay } from '../../planner/history-selection';
import { selectPersonalHistory } from '../../planner/personal-history-selection';
import { PersonalHistoryRecord } from '../../planner/personal-history-record';
import { sharedLocalDate } from '../group-clock';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { PersonalGuideSource } from './chore-book';
import { v2CanShowCompletion } from './round-visibility';
import { V2CompletionHistoryCard } from './completion-history-card';
import { v2MemberLabels } from './member-labels';

export function V2HistoryContent({ model, choreId, personal, actions, busy, run, onBack, notice }: {
  model: V2GroupScreenModel; choreId?: string; personal?: PersonalGuideSource;
  actions: V2GroupController['actions']; busy: boolean; run: (work: () => Promise<unknown>) => Promise<void>;
  onBack: () => void; notice?: ReactNode;
}) {
  // Visibility is applied before grouping/counting. Private learning mirrors must not reveal hidden group facts.
  const current = model.plan.history.filter(record => record.active && (!choreId || record.choreId === choreId) && v2CanShowCompletion(model, record));
  const legacy = (model.legacyHistory ?? []).filter(record => record.active && (!choreId || record.choreId === choreId)
    && (model.viewerUserId === model.adminUserId || model.plan.policy?.showCompletionStatus
      || record.performerUserId === model.viewerUserId || record.recorderUserId === model.viewerUserId));
  const personalRows = !choreId && personal ? selectPersonalHistory(personal.snapshot.completions, { groupId: model.plan.groupId, limit: Infinity }) : [];
  const history = [
    ...current.map(record => ({ kind: 'current' as const, record, date: sharedLocalDate(new Date(record.performedAt), model.plan.timeZone), at: record.performedAt, id: `shared:${record.operationId}` })),
    ...legacy.map(record => ({ kind: 'legacy' as const, record, date: sharedLocalDate(new Date(record.performedAt), model.plan.timeZone), at: record.performedAt, id: `legacy:${record.operationId}` })),
    ...personalRows.slice(0, 100).map(record => ({ kind: 'personal' as const, record, date: completionHistoryDay(record, personal?.snapshot.timeZone), at: record.completedAt, id: `personal:${record.id}` })),
  ];
  const groups = groupHistoryByDay(history, item => ({ id: item.id, date: item.date, timestamp: item.at }));
  const rows = groups.flatMap(group => [{ kind: 'date' as const, id: `day:${group.date}`, date: group.date, showMonth: group.showMonth }, ...group.records]);
  const month = model.plan.range.asOfDate.slice(0, 7);
  const inMonth = (at: string) => sharedLocalDate(new Date(at), model.plan.timeZone).startsWith(month);
  const completedThisMonth = current.filter(record => record.active && record.outcome === 'completed' && record.acceptance !== 'pending' && record.acceptance !== 'rejected' && !record.approvalConflictIds.length && inMonth(record.performedAt)).length
    + legacy.filter(record => record.active && record.outcome === 'completed' && inMonth(record.performedAt)).length
    + personalRows.filter(record => record.outcome === 'completed' && completionHistoryDay(record, personal?.snapshot.timeZone).startsWith(month)).length;
  const personalChores = new Map(personal?.snapshot.chores.map(chore => [chore.id, chore.name]));
  const nameOf = v2MemberLabels(model.plan.members);
  return <>
    <NavigationHeader><SettingsHeader title="実施履歴" onBack={onBack} /></NavigationHeader>
    <FlatList data={rows} keyExtractor={item => item.id} contentContainerStyle={styles.page} initialNumToRender={12}
      ListHeaderComponent={<View style={styles.heading}>{notice}{choreId ? <Text style={styles.chore}>{model.plan.chores.find(chore => chore.id === choreId)?.name ?? '以前の家事'}</Text> : null}
        {history.length ? <HistoryOverview completedThisMonth={completedThisMonth} /> : null}</View>}
      ListEmptyComponent={<Text style={styles.empty}>表示する実施記録はありません。</Text>}
      ListFooterComponent={personalRows.length > 100 ? <Text style={styles.note}>個人の履歴は最新の100件を表示しています。</Text> : undefined}
      renderItem={({ item }) => item.kind === 'date' ? <HistoryDayHeading date={item.date} showMonth={item.showMonth} />
        : item.kind === 'current' ? <V2CompletionHistoryCard grouped model={model} record={item.record} actions={actions} busy={busy} run={run} />
          : item.kind === 'personal' ? <PersonalHistoryRecord completion={item.record} name={personalChores.get(item.record.choreId) ?? '家事'} timeZone={personal?.snapshot.timeZone} />
            : <HistoryRecordRow name={item.record.choreName} time={new Date(item.record.performedAt).toLocaleTimeString('ja-JP', { timeZone: model.plan.timeZone, hour: '2-digit', minute: '2-digit' })}
              status={item.record.outcome === 'completed' ? undefined : '未実施の記録'}
              details={item.record.performerUserId ? <><Text style={styles.note}>当時の担当者：記録なし</Text><Text style={styles.note}>実施者：{nameOf(item.record.performerUserId)}</Text></> : undefined} />}
    />
  </>;
}
const styles = StyleSheet.create({
  page: { padding: 18, paddingTop: 10, paddingBottom: 40 }, heading: { gap: 10 },
  chore: { ...typography.body, color: palette.ink, fontWeight: '600' },
  empty: { ...typography.body, color: palette.muted, paddingVertical: 12 },
  note: { ...typography.caption, color: palette.muted, paddingTop: 12 },
});
