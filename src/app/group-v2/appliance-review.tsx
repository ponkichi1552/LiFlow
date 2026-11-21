import { Redirect, useLocalSearchParams } from 'expo-router';

export default function ApplianceReviewRoute() {
  const params = useLocalSearchParams();
  return <Redirect href={{ pathname: '/manual/shared-review', params }} />;
}
