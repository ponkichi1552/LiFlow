import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';

import { ProcedureStep } from '../../components/procedure-step';
import { AppButton, Card, NavigationHeader, palette, typography } from '@/components/planner-ui';
import { SettingsHeader } from '@/components/settings-header';
import { SettingsAction } from '@/components/settings-controls';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import { choreCadenceLabel, registeredChoreCycleDays } from '../../domain/chores/cycle-policy';
import type { ApplianceCareReviewContext, ApplianceTaskCycleChange } from '@/platform/storage/repository';
import { isRenderableApplianceAnalysis } from './analysis-validation';
import { applianceDisplayName, appliancePrimaryName, applianceSecondaryLabel } from './display-name';
import { applianceAnalysisDate } from './analysis-date';
import { ApplianceTaskBook } from './appliance-task-book';
import { manualModelPageLabel } from './manual-model-pages';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ApplianceManualAction } from './appliance-manual-action';
import { ApplianceCycleEditor } from './appliance-cycle-editor';
import { applianceTaskCadenceKey, findApplianceTaskChore } from './persistence-policy';

export function ApplianceDetailContent({ context, returnTo, error, database, onSaveCycle, onReload }: {
  context: ApplianceCareReviewContext;
  returnTo?: '/manual' | '/chores';
  error?: string;
  database?: SQLiteDatabase;
  onSaveCycle?(change: ApplianceTaskCycleChange): Promise<void>;
  onReload?(): void;
}) {
  const { appliance, chores, frequencyMode = 'balanced' } = context;
  const [editing, setEditing] = useState<{ change: Omit<ApplianceTaskCycleChange, 'days'>; initialDays?: number }>();
  const manualDigest = appliance.analysis?.manualSource?.sha256;
  const productName = applianceDisplayName(appliance, appliance.displayName);
  const primaryName = appliancePrimaryName(appliance, productName);
  const secondaryName = applianceSecondaryLabel(primaryName, [productName, ...(appliance.productName ? [applianceDisplayName(appliance)] : [])]);
  const modelPage = appliance.analysis?.manualSource && manualModelPageLabel(appliance.modelNumber, appliance.analysis.modelPages);
  const goBack = () => returnTo ? router.dismissTo(returnTo) : router.back();
  const reanalyze = () => router.push({ pathname: '/manual/appliance-care', params: { applianceId: appliance.id, returnTo: returnTo ?? '/manual' } });
  if (!isRenderableApplianceAnalysis(appliance.analysis)) return <SafeAreaView style={styles.safeArea} edges={['top']}>
    <NavigationHeader><SettingsHeader title="お手入れ方法" backAccessibilityLabel="一覧へ戻る" onBack={goBack} /></NavigationHeader><View style={styles.listContent}>
      {error ? <Text style={styles.invalidLink}>{error}</Text> : null}
      <Card><Text accessibilityRole="alert" style={styles.body}>解析結果に確認が必要な項目があります。保存された内容は保持しています。再解析して内容を確認してください。</Text>
        {database && manualDigest ? <ApplianceManualAction database={database} digest={manualDigest} label={primaryName} accessKey={appliance.id} /> : null}
        <AppButton title="この家電を再解析" variant="secondary" onPress={reanalyze} /></Card>
    </View>
  </SafeAreaView>;
  return <><ApplianceTaskBook tasks={appliance.analysis.tasks} label={primaryName} hasTabBar
        onBack={goBack} backAccessibilityLabel="一覧へ戻る" header={<View style={styles.listHeader}>
        {error ? <Text style={styles.invalidLink}>{error}</Text> : null}
        <Text accessibilityRole="header" style={styles.modelTitle}>{primaryName}</Text>
        {secondaryName ? <Text style={styles.note}>{secondaryName}</Text> : null}
        {modelPage ? <Text style={styles.note}>{modelPage}</Text> : null}
        {database && manualDigest ? <ApplianceManualAction database={database} digest={manualDigest} label={primaryName} accessKey={appliance.id} /> : null}
        <Text style={styles.note}>お手入れ {appliance.analysis.tasks.length}項目</Text>
        </View>}
        renderTask={task => {
          const chore = findApplianceTaskChore(appliance, chores, task.name);
          const edit = onSaveCycle ? () => {
            if (chore?.personalSchedule?.once || chore?.personalSchedule?.monthlyDay !== undefined) {
              router.push({ pathname: '/settings/chore/[id]', params: { id: chore.id, source: 'personal' } });
            } else setEditing({ change: { taskName: task.name, analysisUpdatedAt: appliance.updatedAt, expectedCadence: applianceTaskCadenceKey(chore) },
              initialDays: chore ? registeredChoreCycleDays(chore, frequencyMode) : undefined });
          } : undefined;
          return <MaintenanceTaskCard task={task} chore={chore} frequencyMode={frequencyMode} onCycleEdit={edit} />;
        }}
        footer={<View style={styles.listHeader}>
          <Text style={styles.note}>最終解析：{applianceAnalysisDate(appliance.analysis.analyzedAt)}</Text>
          <AppButton title="この家電を再解析" onPress={reanalyze} variant="quiet" />
        </View>}
      />{editing && onSaveCycle ? <ApplianceCycleEditor taskName={editing.change.taskName} initialDays={editing.initialDays}
        onSave={days => onSaveCycle({ ...editing.change, days })} onReload={onReload} onClose={() => setEditing(undefined)} /> : null}</>;
}

export function MaintenanceTaskCard({ task, chore, schedule, frequencyMode = 'balanced', onCycleEdit }: {
  task: ApplianceCareReviewContext['appliance']['analysis']['tasks'][number];
  chore?: ChoreDefinition;
  /** Shared workspaces supply their own cadence status; a maker interval is not a shared schedule. */
  schedule?: ReactNode;
  frequencyMode?: FrequencyMode;
  onCycleEdit?(): void;
}) {
  const manufacturerDays = task.recommendedIntervalDays;
  const actualDays = chore ? registeredChoreCycleDays(chore, frequencyMode) : undefined;
  const scheduled = chore && (actualDays !== undefined || chore.personalSchedule?.once || chore.personalSchedule?.monthlyDay !== undefined);
  return (
    <Card>
      <Text accessibilityRole="header" style={styles.taskTitle}>{task.name}</Text>
      {schedule === undefined ? <View style={styles.cadence}>
        <Text style={[styles.note, styles.cadenceText]}>{scheduled ? `${choreCadenceLabel(chore, frequencyMode)}${chore.enabled ? '' : '（オフ）'}` : '定期予定なし'}</Text>
        {onCycleEdit ? <SettingsAction title={scheduled ? '周期を変更' : '周期を設定'} intent="auxiliary" onPress={onCycleEdit} /> : null}
      </View> : null}
      {task.recommendedConditions?.length || manufacturerDays !== undefined ? <View style={styles.supportingBlock}>
        <Text style={styles.supportingTitle}>実施の目安</Text>
        {manufacturerDays !== undefined ? <Text style={styles.body}>メーカー推奨：{manufacturerDays}日</Text> : null}
        {task.recommendedConditions?.map((condition) => <Text key={condition} style={styles.body}>• {condition}</Text>)}
      </View> : null}
      {task.steps.map((step, stepIndex) => <ProcedureStep key={`${stepIndex}-${step}`} step={step} index={stepIndex} />)}
      {task.tools.length ? <View style={styles.supportingBlock}><Text style={styles.supportingTitle}>必要な道具</Text><Text style={styles.body}>{task.tools.join('、')}</Text></View> : null}
      {task.safetyCautions.length > 0 ? (
        <View style={styles.cautionBox}>
          <Text style={styles.cautionTitle}>安全上の注意・禁止事項</Text>
          {task.safetyCautions.map((caution) => <Text key={caution} style={styles.cautionText}>• {caution}</Text>)}
        </View>
      ) : null}
      {task.estimatedMinutes !== undefined ? <Text style={styles.note}>メーカー記載の所要時間：約{task.estimatedMinutes}分</Text> : null}
      {schedule}
    </Card>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  listContent: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36, gap: 15 },
  listHeader: { gap: 15 },
  modelTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  taskTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  body: { ...typography.body, color: palette.muted },
  note: { ...typography.caption, color: palette.muted },
  cadence: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cadenceText: { flexShrink: 1 },
  supportingBlock: { gap: 4, marginTop: 4 },
  supportingTitle: { ...typography.label, color: palette.ink, fontWeight: '700' },
  cautionBox: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: palette.warningSoft },
  cautionTitle: { ...typography.label, color: palette.warning, fontWeight: '800' },
  cautionText: { ...typography.body, color: palette.warning },
  invalidLink: { ...typography.caption, color: palette.muted },
});
