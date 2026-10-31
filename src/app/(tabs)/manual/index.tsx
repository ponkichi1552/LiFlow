import { router } from 'expo-router';
import { Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WorkspaceTab } from '@/components/workspace-tab';
import { palette, typography } from '@/components/planner-ui';
import { PlannerLoadState } from '@/components/planner-load-state';
import { ApplianceLibrary } from '@/features/appliance-care/appliance-library';
import { usePlannerData } from '@/hooks/use-planner-data';

export default function ManualScreen() {
  return <WorkspaceTab view="appliances"><PersonalManualScreen /></WorkspaceTab>;
}

function PersonalManualScreen() {
  const { snapshot, error, refresh } = usePlannerData({ personal: true });
  if (!snapshot) return <PlannerLoadState title="家電" message="家電を読み込んでいます。" error={error} retry={refresh} />;
  return <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: palette.background }}>
    <ApplianceLibrary items={snapshot.appliances.map(appliance => ({ ...appliance, source: 'personal' as const }))}
      header={error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
      onOpen={(_source, id) => router.push({ pathname: '/manual/appliances/[id]', params: { id, returnTo: '/manual' } })}
      onAdd={(_source, productName) => router.push({ pathname: '/manual/appliance-care', params: { productName, returnTo: '/manual' } })} />
  </SafeAreaView>;
}
