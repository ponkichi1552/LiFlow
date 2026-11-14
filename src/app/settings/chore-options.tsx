import { Redirect, useLocalSearchParams } from 'expo-router';
import { usePlannerData } from '../../hooks/use-planner-data';
import { PlannerLoadState } from '../../components/planner-load-state';
import { ChoreAdvancedSettings } from '../../features/settings/chore-advanced-settings';
import { updateChoreSettings } from '../../platform/storage/repository';
import { hasChoreScheduleSettings } from '../../domain/chores/cycle-policy';
import { localDateFromDate } from '../../domain/scheduling/local-date';

export default function PersonalChoreOptionsRoute() {
  const { choreId } = useLocalSearchParams<{ choreId: string }>();
  // A private editor must never acquire the shared adapter from the current workspace.
  const data = usePlannerData({ personal: true });
  if (!data.snapshot) return <PlannerLoadState title="詳細設定" message="設定を読み込んでいます。" error={data.error} retry={data.refresh} />;
  const chore = data.snapshot.chores.find(value => value.id === choreId && !value.archived);
  if (!chore) return <Redirect href="/settings?section=chores" />;
  if (!hasChoreScheduleSettings(chore)) return <Redirect href={{ pathname: '/(tabs)/guide', params: { choreId: chore.id, source: 'personal' } }} />;
  return <ChoreAdvancedSettings key={chore.id} chore={chore} today={data.snapshot.today ?? localDateFromDate(new Date())} save={async patch => {
    if (await updateChoreSettings(data.database, chore.id, patch)) await data.refresh();
  }} />;
}
