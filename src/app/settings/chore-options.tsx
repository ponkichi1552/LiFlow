import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { usePlannerData } from '../../hooks/use-planner-data';
import { PlannerLoadState } from '../../components/planner-load-state';
import { SettingsHeader } from '../../components/settings-header';
import { ChoreAdvancedSettings } from '../../features/settings/chore-advanced-settings';
import { updateChoreSettings } from '../../platform/storage/repository';
import { hasChoreScheduleSettings } from '../../domain/chores/cycle-policy';
import { localDateFromDate } from '../../domain/scheduling/local-date';
import { backOrReplace, personalChoreSettings } from '../../features/settings/settings-back';

export default function PersonalChoreOptionsRoute() {
  const { choreId } = useLocalSearchParams<{ choreId: string }>();
  // A private editor must never acquire the shared adapter from the current workspace.
  const data = usePlannerData({ personal: true });
  if (!data.snapshot) return <PlannerLoadState header={<SettingsHeader title="詳細設定" onBack={() => backOrReplace(router, personalChoreSettings)} />}
    message="設定を読み込んでいます。" error={data.error} retry={data.refresh} />;
  const chore = data.snapshot.chores.find(value => value.id === choreId && !value.archived);
  if (!chore) return <Redirect href={personalChoreSettings} />;
  if (!hasChoreScheduleSettings(chore)) return <Redirect href={{ pathname: '/(tabs)/guide', params: { choreId: chore.id, source: 'personal' } }} />;
  const onBack = () => backOrReplace(router, { pathname: '/settings/chore/[id]', params: { id: chore.id, source: 'personal' } });
  return <ChoreAdvancedSettings key={chore.id} chore={chore} today={data.snapshot.today ?? localDateFromDate(new Date())} onBack={onBack} save={async patch => {
    if (await updateChoreSettings(data.database, chore.id, patch)) await data.refresh();
  }} />;
}
