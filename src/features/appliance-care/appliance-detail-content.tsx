import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ProcedureStep } from '../../components/procedure-step';
import { AppButton, BackButton, Card, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import { applianceCategoryLabel } from '@/features/appliance-care/categories';
import { isOfficialApplianceUrl } from '@/features/appliance-care/official-url';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';
import { isUploadedManualReference } from './manual-source';
import { isRenderableApplianceAnalysis } from './analysis-validation';

export function ApplianceDetailContent({ context, returnTo, error }: {
  context: ApplianceCareReviewContext;
  returnTo?: '/manual' | '/chores';
  error?: string;
}) {
  const { appliance, chores } = context;
  const goBack = () => returnTo ? router.dismissTo(returnTo) : router.back();
  const reanalyze = () => router.push({ pathname: '/manual/appliance-care', params: { applianceId: appliance.id, returnTo: returnTo ?? '/manual' } });
  if (!isRenderableApplianceAnalysis(appliance.analysis)) return <SafeAreaView style={styles.safeArea} edges={['top']}>
    <View style={styles.listContent}><BackButton accessibilityLabel="一覧へ戻る" onPress={goBack} /><ScreenHeading title="お手入れ方法" />
      {error ? <Text style={styles.invalidLink}>{error}</Text> : null}
      <Card><Text accessibilityRole="alert" style={styles.body}>解析結果に確認が必要な項目があります。保存された内容は保持しています。再解析して内容を確認してください。</Text>
        <AppButton title="この家電を再解析" variant="secondary" onPress={reanalyze} /></Card>
    </View>
  </SafeAreaView>;
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View testID="appliance-detail-header" style={styles.backHeader}><BackButton accessibilityLabel="一覧へ戻る" onPress={goBack} /><Text style={styles.modelTitle}>{appliance.modelNumber}</Text></View>
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
        <ScreenHeading eyebrow={appliance.manufacturer} title="お手入れ方法" description={`${appliance.displayName}の${appliance.analysis.manualSource ? '選択した説明書を解析した' : '公式資料から確認した'}内容です。`} />
        <Card style={styles.productCard}>
          <Text style={styles.productMeta}>メーカー {appliance.manufacturer} · 型番 {appliance.modelNumber}</Text>
          {appliance.category ? <Text style={styles.body}>カテゴリ：{applianceCategoryLabel(appliance.category)}</Text> : null}
          {appliance.officialProductUrl ? <OfficialLink manufacturer={appliance.manufacturer} title="公式製品情報を見る ↗" url={appliance.officialProductUrl} /> : null}
          <OfficialLink manufacturer={appliance.manufacturer} title="公式取扱説明書を見る ↗" url={appliance.officialManualUrl} />
          <Text style={styles.note}>最終解析：{appliance.analysis.analyzedAt}</Text>
          <AppButton title="この家電を再解析" onPress={reanalyze} variant="secondary" />
        </Card>

        <SectionHeading title="お手入れ項目" trailing={<Text style={styles.note}>{appliance.analysis.tasks.length}件</Text>} />
        </View>}
        renderItem={({ item: task, index }) => {
          const chore = chores.find((item) => item.applianceTaskName === task.name);
          return <MaintenanceTaskCard task={task} chore={chore} manufacturer={appliance.manufacturer} index={index} />;
        }}
      />
    </SafeAreaView>
  );
}

export function MaintenanceTaskCard({ task, chore, manufacturer, index, schedule }: {
  task: ApplianceCareReviewContext['appliance']['analysis']['tasks'][number];
  chore?: ChoreDefinition;
  manufacturer: string;
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
      {task.evidence.map((evidence, evidenceIndex) => (
        <OfficialLink key={`${evidence.url}-${evidenceIndex}`} manufacturer={manufacturer} title={`出典を見る${evidence.pageOrSection ? ` · ${evidence.pageOrSection}` : ''} ↗`} url={evidence.url} />
      ))}
    </Card>
  );
}

export function OfficialLink({ manufacturer, title, url }: { manufacturer: string; title: string; url: string }) {
  if (isUploadedManualReference(url)) return <Text style={styles.note}>選択した説明書PDF{title.includes(' · ') ? ` · ${title.split(' · ')[1].replace(' ↗', '')}` : ''}（PDF原本は保存していません）</Text>;
  const valid = isOfficialApplianceUrl(url, manufacturer);
  if (!valid) return <Text style={styles.invalidLink}>公式URLを検証できないため開けません</Text>;
  return <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => undefined)}><Text style={styles.link}>{title}</Text></Pressable>;
}

const styles = StyleSheet.create({
  backHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, backgroundColor: palette.surface },
  safeArea: { flex: 1, backgroundColor: palette.background },
  listContent: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36, gap: 15 },
  listHeader: { gap: 15 },
  modelTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  productCard: { backgroundColor: palette.accentSoft, borderColor: palette.border },
  productMeta: { ...typography.label, color: palette.ink, fontWeight: '700' },
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
