import { useLocalSearchParams } from 'expo-router';
import { usePlannerData } from '@/hooks/use-planner-data';
import { ChoreSettingsBook } from '@/features/settings/chore-settings-screen';

export default function ChoreSettingsScreen() {
  const params = useLocalSearchParams<{ id: string; source?: string; matchName?: string; matchCategory?: string }>();
  const choreId = Array.isArray(params.id) ? params.id[0] : params.id;
  const data = usePlannerData({ personal: params.source === 'personal' });
  const selection = typeof params.matchName === 'string' && typeof params.matchCategory === 'string'
    ? { name: params.matchName, category: params.matchCategory } : undefined;
  return <ChoreSettingsBook key={params.source ?? 'current'} choreId={choreId} selection={selection} data={data} />;
}
