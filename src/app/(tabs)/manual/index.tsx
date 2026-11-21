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
  const openAnalysis = (applianceId?: string) => router.push({ pathname: '/manual/appliance-care', params: { applianceId, returnTo: '/manual' } });
  if (!snapshot) return <PlannerLoadState title="家電" message="家電を読み込んでいます。" error={error} retry={refresh} />;
  return <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: palette.background }} onLayout={finishStartupDisplay}>
    <ApplianceLibrary items={snapshot.appliances.map(appliance => ({ ...appliance, source: 'personal' as const }))}
      header={<>{error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
        <AnalysisWorkRows items={analysis} onOpen={item => openAnalysis(item.applianceId)} /></>}
      onOpen={(_source, id) => router.push({ pathname: '/manual/appliances/[id]', params: { id, returnTo: '/manual' } })}
      onAdd={() => openAnalysis()} />
  </SafeAreaView>;
}
