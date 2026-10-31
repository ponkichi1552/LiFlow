import { Redirect, useLocalSearchParams } from 'expo-router';

export default function SharedChoreListRoute() { const params = useLocalSearchParams(); return <Redirect href={{ pathname: '/(tabs)/guide', params }} />; }
