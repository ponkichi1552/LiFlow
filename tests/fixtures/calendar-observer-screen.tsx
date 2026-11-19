import { LocalCalendarProvider, useLocalCalendar } from '../../src/features/calendar/use-local-calendar';
import { useSQLiteContext } from 'expo-sqlite';
import { Pressable, Text } from 'react-native';
function Readout({ observeOnly }: { observeOnly: boolean }) {
  const local = useLocalCalendar(useSQLiteContext(), true, observeOnly);
  return <><Text>{local.snapshot.events.map(row => row.title).join(',')}{local.error ?? ''}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="refresh" onPress={local.refresh} /></>;
}
export default function Observer({ observeOnly = false }: { observeOnly?: boolean }) {
  return <LocalCalendarProvider><Readout observeOnly={observeOnly} /></LocalCalendarProvider>;
}
