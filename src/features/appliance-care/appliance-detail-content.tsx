import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';

import { ProcedureStep } from '../../components/procedure-step';
import { AppButton, BackButton, Card, NavigationHeader, navigationHeaderMetrics, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';
import { isRenderableApplianceAnalysis } from './analysis-validation';
import { applianceDisplayName } from './display-name';
import { applianceAnalysisDate } from './analysis-date';

export function ApplianceDetailContent({ context, returnTo, error }: {
  context: ApplianceCareReviewContext;
  returnTo?: '/manual' | '/chores';
  error?: string;
}) {
  const { appliance, chores } = context;
  const goBack = () => returnTo ? router.dismissTo(returnTo) : router.back();
  const reanalyze = () => router.push({ pathname: '/manual/appliance-care', params: { applianceId: appliance.id, returnTo: returnTo ?? '/manual' } });
  if (!isRenderableApplianceAnalysis(appliance.analysis)) return <SafeAreaView style={styles.safeArea} edges={['top']}>
    <NavigationHeader><BackButton accessibilityLabel="一覧へ戻る" onPress={goBack} /></NavigationHeader><View style={styles.listContent}><ScreenHeading title="お手入れ方法" />
      {error ? <Text style={styles.invalidLink}>{error}</Text> : null}
      <Card><Text accessibilityRole="alert" style={styles.body}>解析結果に確認が必要な項目があります。保存された内容は保持しています。再解析して内容を確認してください。</Text>
        <AppButton title="この家電を再解析" variant="secondary" onPress={reanalyze} /></Card>
    </View>
  </SafeAreaView>;
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View testID="appliance-detail-header" style={styles.backHeader}><BackButton accessibilityLabel="一覧へ戻る" onPress={goBack} /><Text style={styles.modelTitle}>お手入れ方法</Text></View>
      <FlatList
        data={appliance.analysis.tasks}
        keyExtractor={(task, index) => `${index}-${task.name}`}
        initialNumToRender={1}
        maxToRenderPerBatch={1}
        windowSize={3}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={<View style={styles.listHeader}>
        {error ? <Text style={styles.invalidLink}>{error}</Text> : null}
        <ScreenHeading title={applianceDisplayName(appliance, appliance.displayName)} />
        <SectionHeading title="お手入れ項目" trailing={<Text style={styles.note}>{appliance.analysis.tasks.length}件</Text>} />
        </View>}
        renderItem={({ item: task, index }) => {
          const chore = chores.find((item) => item.applianceTaskName === task.name);
          return <MaintenanceTaskCard task={task} chore={chore} index={index} />;
        }}
        ListFooterComponent={<View style={styles.listHeader}>
          <Text style={styles.note}>最終解析：{applianceAnalysisDate(appliance.analysis.analyzedAt)}</Text>
          <AppButton title="この家電を再解析" onPress={reanalyze} variant="quiet" />
        </View>}
      />
    </SafeAreaView>
  );
}

export function MaintenanceTaskCard({ task, chore, index, schedule }: {
  task: ApplianceCareReviewContext['appliance']['analysis']['tasks'][number];
  chore?: ChoreDefinition;
  index: number;
  /** Shared workspaces supply their own cadence status; a maker interval is not a shared schedule. */
  schedule?: ReactNode;
}) {
  const manufacturerDays = task.recommendedIntervalDays;
  const userDays = chore?.userIntervalDays ?? chore?.recommendedCycleDays;
  const noSchedule = manufacturerDays === undefined && userDays === undefined;
  return (
    <Card>
      <Text style={styles.taskIndex}>お手入れ {String(index + 1).padStart(2, '0')}</Text>
      <Text style={styles.taskTitle}>{task.name}</Text>
      {schedule !== undefined ? schedule : noSchedule ? (
        <View style={styles.noSchedule}>
          <Text style={styles.noScheduleTitle}>定期予定なし</Text>
          {task.recommendedConditions?.map((condition) => <Text key={condition} style={styles.body}>メーカー指定：「{condition}」</Text>)}
          <Text style={styles.body}>メーカーから具体的な周期が指定されていないため、カレンダー・自動予定・定期通知には登録されません。</Text>
        </View>
      ) : (
        <View style={styles.intervalBlock}>
          {manufacturerDays !== undefined ? <Text style={styles.body}>メーカー推奨：{manufacturerDays}日</Text> : <Text style={styles.body}>メーカー指定：具体的周期なし</Text>}
          {userDays !== undefined && userDays !== manufacturerDays ? <Text style={styles.body}>あなたの設定：{userDays}日</Text> : null}
          <Text style={styles.intervalActual}>予定周期：{userDays ?? manufacturerDays}日</Text>
          {chore ? <Text style={styles.note}>{chore.enabled ? '家事一覧・カレンダーに登録済み' : '予定はオフです。家事一覧から変更できます。'}</Text> : <Text style={styles.note}>解析項目は保存済みですが、家事予定には登録していません。</Text>}
        </View>
      )}
      {task.recommendedConditions?.length && (schedule !== undefined || !noSchedule) ? task.recommendedConditions.map((condition) => <Text key={condition} style={styles.body}>メーカー指定条件：{condition}</Text>) : null}
      <SectionHeading title="手順" level="subsection" />
      {task.steps.map((step, stepIndex) => <ProcedureStep key={`${stepIndex}-${step}`} step={step} index={stepIndex} />)}
      <Text style={styles.body}>必要な道具：{task.tools.length ? task.tools.join('、') : '記載なし'}</Text>
      {task.safetyCautions.length > 0 ? (
        <View style={styles.cautionBox}>
          <Text style={styles.cautionTitle}>安全上の注意・禁止事項</Text>
          {task.safetyCautions.map((caution) => <Text key={caution} style={styles.cautionText}>• {caution}</Text>)}
        </View>
      ) : null}
      {task.estimatedMinutes !== undefined ? <Text style={styles.note}>メーカー記載の所要時間：約{task.estimatedMinutes}分</Text> : null}

    </Card>
  );
}

const styles = StyleSheet.create({
  backHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, ...navigationHeaderMetrics, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, backgroundColor: palette.background },
  safeArea: { flex: 1, backgroundColor: palette.background },
  listContent: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36, gap: 15 },
  listHeader: { gap: 15 },
  modelTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  taskIndex: { ...typography.caption, color: palette.accent, fontWeight: '800', letterSpacing: 1 },
  taskTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  body: { ...typography.body, color: palette.muted },
  note: { ...typography.caption, color: palette.muted },
  intervalBlock: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: palette.surface },
  intervalActual: { ...typography.body, color: palette.accent, fontWeight: '800' },
  noSchedule: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: palette.goldSoft, borderWidth: 1, borderColor: palette.border },
  noScheduleTitle: { ...typography.label, color: palette.gold, fontWeight: '800' },
  cautionBox: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: palette.warningSoft },
  cautionTitle: { ...typography.label, color: palette.warning, fontWeight: '800' },
  cautionText: { ...typography.body, color: palette.warning },
  link: { ...typography.label, color: palette.accent, fontWeight: '700', textDecorationLine: 'underline' },
  invalidLink: { ...typography.caption, color: palette.muted },
});
