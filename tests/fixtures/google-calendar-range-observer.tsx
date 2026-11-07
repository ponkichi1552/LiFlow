import { useLayoutEffect } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { Text } from 'react-native';
import { usePersonalGoogleSync } from '../../src/features/calendar/use-personal-google-sync';
const ready = async () => {};
export default function Readout() {
  const request = usePersonalGoogleSync(useSQLiteContext(), ready);
  useLayoutEffect(() => { request('2028-01-01', '2028-01-31'); }, [request]);
  return <Text>range</Text>;
}
