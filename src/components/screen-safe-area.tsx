import type { ComponentProps } from 'react';
import { Platform, StatusBar, StyleSheet } from 'react-native';
import { SafeAreaView as NativeSafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EdgeMode, EdgeRecord } from 'react-native-safe-area-context';

/** Android's native safe-area view can report zero at a full-screen tab boundary. */
export function SafeAreaView({ edges, style, ...props }: ComponentProps<typeof NativeSafeAreaView>) {
  const insets = useSafeAreaInsets();
  if (Platform.OS !== 'android') return <NativeSafeAreaView {...props} edges={edges} style={style} />;
  const modes: EdgeRecord = edges === undefined ? { top: 'additive', right: 'additive', bottom: 'additive', left: 'additive' }
    : Array.isArray(edges) ? Object.fromEntries(edges.map(edge => [edge, 'additive'])) as EdgeRecord : edges as EdgeRecord;
  const top: EdgeMode = modes.top ?? 'off';
  if (top === 'off') return <NativeSafeAreaView {...props} edges={edges} style={style} />;
  const own = StyleSheet.flatten(style);
  const padding = own?.paddingTop ?? own?.paddingVertical ?? own?.padding ?? 0;
  const safeTop = Math.max(insets.top, StatusBar.currentHeight ?? 0);
  const ownTop = typeof padding === 'number' ? padding : 0;
  // Maximum mode prevents adding the inset twice when the native view is correct.
  const paddingTop = top === 'maximum' ? Math.max(ownTop, safeTop) : ownTop + safeTop;
  return <NativeSafeAreaView {...props} edges={{ ...modes, top: 'maximum' }} style={[style, { paddingTop }]} />;
}
