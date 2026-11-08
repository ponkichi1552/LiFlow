import { StyleSheet, View, useColorScheme } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { plannerColorsForScheme } from './planner-theme';

/** A passive position indicator. The separate chapter rail remains the navigation control. */
export function ChoreScrollIndicator({ progress, fraction, opacity }: {
  progress: SharedValue<number>; fraction: SharedValue<number>; opacity: SharedValue<number>;
}) {
  const trackHeight = useSharedValue(0);
  const colors = plannerColorsForScheme(useColorScheme());
  const thumb = useAnimatedStyle(() => {
    const track = trackHeight.get();
    const height = Math.min(track, Math.max(32, track * fraction.get()));
    return { height, opacity: opacity.get(), transform: [{ translateY: Math.max(0, track - height) * progress.get() }] };
  });
  return <View pointerEvents="none" accessible={false} style={styles.track}
    onLayout={event => { trackHeight.set(event.nativeEvent.layout.height); }}>
    <Animated.View style={[styles.thumb, { backgroundColor: colors.muted }, thumb]} />
  </View>;
}
const styles = StyleSheet.create({
  track: { position: 'absolute', top: 4, bottom: 4, right: 2, width: 3 },
  thumb: { width: 3, borderRadius: 2 },
});
