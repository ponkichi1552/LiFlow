import { StyleSheet, Text, View } from 'react-native';

import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import { formatJapaneseDate, localDateFromDate, localDateFromISODateTime, monthKey } from '@/domain/scheduling/local-date';
import { PlannerLoadState } from '@/components/planner-load-state';
import type { usePlannerData } from '@/hooks/use-planner-data';
import { router } from 'expo-router';
import { parseSharedMirrorEntryId } from '@/features/planner/common-chore-links';
import { SettingsAudience } from '@/components/settings-audience';

export function PlannerHistoryContent({ data, requestedChoreId }: {
  data: Pick<ReturnType<typeof usePlannerData>, 'snapshot' | 'loading' | 'error' | 'refresh'>; requestedChoreId?: string;
}) {
  const { snapshot, loading, error, refresh } = data;
  if (loading || !snapshot) return <PlannerLoadState title="実施履歴" message="履歴を読み込んでいます。" error={error} retry={refresh} />;

  const choresById = new Map(snapshot.chores.map((chore) => [chore.id, chore]));
  const selectedChore = requestedChoreId ? choresById.get(requestedChoreId) : undefined;
  const completions = requestedChoreId
    ? snapshot.completions.filter((item) => item.choreId === requestedChoreId)
    : snapshot.completions;
  const thisMonth = monthKey(snapshot.today ?? localDateFromDate(new Date()));
  const completedThisMonth = completions.filter((item) =>
    item.outcome === 'completed' && monthKey(item.completedLocalDate ?? localDateFromISODateTime(item.completedAt)) === thisMonth,
  ).length;

  return (
    <Page>
      <BackButton onPress={() => router.back()} />
      <SettingsAudience groupName={snapshot.sharing ? snapshot.household.name : undefined} />
      <ScreenHeading eyebrow="HISTORY" title={selectedChore ? `${selectedChore.name}の履歴` : '実施履歴'} description="完了と未完了の記録を端末内に保存します。" />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
      <Card style={styles.summary}>
        <View><Text style={styles.summaryLabel}>今月の完了</Text><Text style={styles.summaryValue}>{completedThisMonth}<Text style={styles.summaryUnit}>件</Text></Text></View>
        <Text style={styles.summaryNote}>完了日を基準に次の周期を計算します。</Text>
      </Card>
      <SectionHeading title="最近の記録" trailing={<Text style={styles.count}>{completions.length}件</Text>} />
      {completions.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyMark}>✓</Text>
          <Text style={styles.emptyTitle}>家事の状態を記録できます</Text>
          <Text style={styles.emptyText}>{selectedChore ? `${selectedChore.name}の完了・未完了を記録すると、ここに表示されます。` : '家事の説明から「完了」または「未完了」を記録すると、日付と一緒に保存されます。'}</Text>
          <AppButton title="今日の家事を見る" onPress={() => router.push('/')} variant="secondary" />
        </Card>
      ) : completions.slice(0, 100).map((completion) => {
        const chore = choresById.get(completion.choreId);
        const date = completion.completedLocalDate ?? localDateFromISODateTime(completion.completedAt);
        const isCompleted = completion.outcome === 'completed';
        return (
          <Card key={completion.id} style={styles.historyCard}>
            <View style={[styles.checkMark, !isCompleted && styles.incompleteMark]}>
              <Text style={[styles.checkText, !isCompleted && styles.incompleteText]}>{isCompleted ? '✓' : '×'}</Text>
            </View>
            <View style={styles.copy}>
              <Text style={styles.choreName}>{chore?.name ?? '家事'}</Text>
              <Text style={styles.meta}>
                {isCompleted ? '完了' : '未完了'} · {formatJapaneseDate(date, { year: true, weekday: true })}
              </Text>
            </View>
            <Text style={styles.source}>{parseSharedMirrorEntryId(completion.scheduleEntryId) ? '共有' : completion.source === 'notification' ? '通知' : completion.source === 'widget' ? 'ウィジェット' : completion.source === 'googleTasks' ? 'Google Tasks' : 'アプリ'}</Text>
          </Card>
        );
      })}
      {completions.length > 100 ? <Text style={styles.footnote}>最新の100件を表示しています。</Text> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: palette.accentSoft, borderColor: palette.border },
  summaryLabel: { ...typography.label, color: palette.accent, fontWeight: '700' },
  summaryValue: { ...typography.title, color: palette.ink, fontWeight: '800' },
  summaryUnit: { ...typography.caption, fontWeight: '600' },
  summaryNote: { ...typography.caption, maxWidth: 145, color: palette.muted },
  count: { ...typography.caption, color: palette.muted },
  emptyCard: { alignItems: 'center', paddingVertical: 26 },
  emptyMark: { color: palette.accent, fontSize: 30, fontWeight: '700' },
  emptyTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  emptyText: { ...typography.body, color: palette.muted, textAlign: 'center' },
  historyCard: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 14 },
  checkMark: { width: 32, height: 32, borderRadius: 11, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' },
  checkText: { color: palette.accent, fontSize: 18, fontWeight: '800' },
  incompleteMark: { backgroundColor: palette.warningSoft },
  incompleteText: { color: palette.warning },
  copy: { flex: 1, gap: 3 },
  choreName: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  meta: { ...typography.caption, color: palette.muted },
  source: { ...typography.caption, color: palette.muted },
  footnote: { ...typography.caption, color: palette.muted, textAlign: 'center' },
  error: { ...typography.label, color: palette.warning },
});
