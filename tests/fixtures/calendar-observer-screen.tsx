import { LocalCalendarProvider, useLocalCalendar } from '../../src/features/calendar/use-local-calendar';
import { useSQLiteContext } from 'expo-sqlite';
import { Pressable, Text } from 'react-native';
function Readout() {
  const local = useLocalCalendar(useSQLiteContext(), true);
  return <><Text>{local.snapshot.events.map(row => row.title).join(',')}{local.error ?? ''}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="refresh" onPress={local.refresh} /></>;
}
export default function Observer() { return <LocalCalendarProvider><Readout /></LocalCalendarProvider>; }
