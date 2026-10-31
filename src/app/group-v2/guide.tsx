import { Redirect, useLocalSearchParams } from 'expo-router';
export default function SharedChoreGuideRoute() {
  const { choreId, source, returnTo } = useLocalSearchParams<{ choreId?: string; source?: string; returnTo?: string }>();
  return <Redirect href={{ pathname: '/(tabs)/guide', params: { choreId, source, returnTo } }} />;
}
