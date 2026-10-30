import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { Platform, useColorScheme } from 'react-native';

/** System chrome follows the same OS appearance as the shared Native colors. */
export function PlannerSystemBars() {
  const style = useColorScheme() === 'dark' ? 'light' : 'dark';
  return (
    <>
      <StatusBar style={style} hidden={false} />
      {Platform.OS === 'android' ? <NavigationBar style={style} hidden={false} /> : null}
    </>
  );
}
