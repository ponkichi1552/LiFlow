import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Page, palette, typography } from '@/components/planner-ui';
import { SettingsHeader } from '@/components/settings-header';
import { HistoryDayHeading } from '@/components/history-day-heading';
import { HistoryOverview } from '@/components/history-record-row';
import { localDateFromDate, monthKey } from '@/domain/scheduling/local-date';
import { PlannerLoadState } from '@/components/planner-load-state';
import type { usePlannerData } from '@/hooks/use-planner-data';
import { groupHistoryByDay } from './history-groups';
import { completionHistoryDay } from './history-selection';
import { selectPersonalHistory } from './personal-history-selection';
import { PersonalHistoryRecord } from './personal-history-record';

export function PlannerHistoryContent({ data, requestedChoreId }: {
  data: Pick<ReturnType<typeof usePlannerData>, 'snapshot' | 'loading' | 'error' | 'refresh'>; requestedChoreId?: string;
}) {
  const { snapshot, loading, error, refresh } = data;
  if (loading || !snapshot) return <PlannerLoadState title="実施履歴" message="履歴を読み込んでいます。" error={error} retry={refresh} />;
  const choresById = new Map(snapshot.chores.map(chore => [chore.id, chore]));
  const selectedChore = requestedChoreId ? choresById.get(requestedChoreId) : undefined;
  const completions = snapshot.completions.filter(item => item.outcome === 'completed' && (!requestedChoreId || item.choreId === requestedChoreId));
  const thisMonth = monthKey(snapshot.today ?? localDateFromDate(new Date()));
  const completedThisMonth = completions.filter(item => item.outcome === 'completed' && monthKey(completionHistoryDay(item, snapshot.timeZone)) === thisMonth).length;
  const recent = selectPersonalHistory(completions);
  const groups = groupHistoryByDay(recent, item => ({ id: item.id, timestamp: item.completedAt, date: completionHistoryDay(item, snapshot.timeZone) }));
  return <Page header={<SettingsHeader title="実施履歴" onBack={() => router.back()} />} contentStyle={styles.page}>
    {selectedChore ? <Text style={styles.chore}>{selectedChore.name}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {completions.length ? <HistoryOverview completedThisMonth={completedThisMonth} /> : <Text style={styles.empty}>実施履歴はありません。</Text>}
    {groups.map(group => <View key={group.date}>
      <HistoryDayHeading date={group.date} showMonth={group.showMonth} />
      {group.records.map(completion => <PersonalHistoryRecord key={completion.id} completion={completion}
        name={choresById.get(completion.choreId)?.name ?? '家事'} timeZone={snapshot.timeZone} />)}
    </View>)}
    {completions.length > 100 ? <Text style={styles.footnote}>最新の100件を表示しています。</Text> : null}
  </Page>;
}
const styles = StyleSheet.create({
  page: { paddingTop: 10, gap: 12 }, chore: { ...typography.body, color: palette.ink, fontWeight: '600' },
  empty: { ...typography.body, color: palette.muted, paddingVertical: 12 },
  footnote: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning },
});
