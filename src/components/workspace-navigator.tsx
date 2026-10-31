import { Stack } from 'expo-router';
import { useWorkspace } from '../hooks/use-workspace';

/** All workspaces use the same tabs; group data stays in its own repository. */
export function WorkspaceNavigator() {
  const { active } = useWorkspace(); const v2 = active?.protocol === 2;
  return <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    <Stack.Protected guard={!v2} redirectTo="/">
      <Stack.Screen name="chores" options={{ headerShown: false, animationTypeForReplace: 'pop' }} />
      <Stack.Screen name="waste" options={{ headerShown: false }} />
    </Stack.Protected>
    <Stack.Protected guard={v2} redirectTo="/sharing"><Stack.Screen name="group-v2" options={{ headerShown: false }} /></Stack.Protected>
    <Stack.Screen name="settings" />
    <Stack.Screen name="settings/chore/[id]" options={{ headerShown: false }} />
    <Stack.Screen name="history" />
    <Stack.Screen name="help" options={{ headerShown: false }} />
    <Stack.Screen name="calendar-repeat" options={{ headerShown: false }} />
    <Stack.Screen name="sharing" options={{ headerShown: false }} />
  </Stack>;
}
