import { useLocalCalendar } from '../../src/features/calendar/use-local-calendar';
import { useSQLiteContext } from 'expo-sqlite';
import { Text } from 'react-native';
export default function Readout({ includeGroupDrafts = false }: { includeGroupDrafts?: boolean }) {
  const local = useLocalCalendar(useSQLiteContext(), includeGroupDrafts);
  return <Text>{local.snapshot.events.map(row => row.title).join(',')}|{local.snapshot.drafts?.map(row => row.value.title).join(',')}</Text>;
}
