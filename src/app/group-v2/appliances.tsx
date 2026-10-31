import { Redirect, useLocalSearchParams } from 'expo-router';

export default function AppliancesRoute() { const params = useLocalSearchParams(); return <Redirect href={{ pathname: '/(tabs)/manual', params }} />; }
