import { Redirect, useLocalSearchParams } from 'expo-router';

export default function V2CalendarRoute() { const params = useLocalSearchParams(); return <Redirect href={{ pathname: '/(tabs)/explore', params }} />; }
