import { router } from 'expo-router';
import { Text } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { WorkspaceTab } from '@/components/workspace-tab';
import { palette, typography } from '@/components/planner-ui';
import { PlannerLoadState } from '@/components/planner-load-state';
import { ApplianceLibrary } from '@/features/appliance-care/appliance-library';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useWorkspace } from '@/hooks/use-workspace';
import { useAnalysisWorkList } from '@/features/appliance-care/use-analysis-work';
import { AnalysisWorkRows } from '@/features/appliance-care/analysis-work-rows';
import { finishStartupDisplay } from '@/platform/diagnostics/startup-splash';

export default function ManualScreen() {
  return <WorkspaceTab view="appliances"><PersonalManualScreen /></WorkspaceTab>;
}

function PersonalManualScreen() {
  const { database, snapshot, error, refresh } = usePlannerData({ personal: true });
  const { userId } = useWorkspace();
  const analysis = useAnalysisWorkList(database, userId);
  const hasAnalysis = analysis.items.length > 0 || Boolean(analysis.failed);
  const openAnalysis = (applianceId?: string, workId?: string) => router.push({ pathname: '/manual/appliance-care', params: { applianceId, ...(workId ? { workId } : {}), returnTo: '/manual' } });
  if (!snapshot && !hasAnalysis) return <PlannerLoadState title="家電" message="家電を読み込んでいます。" error={error} retry={refresh} />;
  return <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: palette.background }} onLayout={finishStartupDisplay}>
    <ApplianceLibrary items={(snapshot?.appliances ?? []).map(appliance => ({ ...appliance, source: 'personal' as const }))} personalReady={Boolean(snapshot)} hasAnalysis={hasAnalysis}
      header={<>{error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
        <AnalysisWorkRows items={analysis.items} onRetry={analysis.failed ? analysis.retry : undefined}
          onOpen={item => openAnalysis(item.applianceId, item.id)} /></>}
      onOpen={(_source, id) => router.push({ pathname: '/manual/appliances/[id]', params: { id, returnTo: '/manual' } })}
      onAdd={() => openAnalysis()} />
  </SafeAreaView>;
}
