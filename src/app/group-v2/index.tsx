import { Redirect, useLocalSearchParams } from 'expo-router';

export default function V2HomeRoute() { const params = useLocalSearchParams(); return <Redirect href={{ pathname: '/(tabs)', params }} />; }
