import { StyleSheet, View } from 'react-native';

import { calendarCountColor, calendarDotCount } from '@/domain/calendar/count-colors';
import type { CalendarCountColors } from '@/domain/shared/types';

export function CalendarTaskCountIndicator({ count, colors, selected = false }: {
  count: number;
  colors: CalendarCountColors;
  selected?: boolean;
}) {
  const color = calendarCountColor(count, colors);
  if (!color) return <View style={styles.container} />;

  const dotCount = calendarDotCount(count);
  return (
    <View style={styles.container}>
      {Array.from({ length: dotCount }, (_, index) => (
        <View key={index} style={[styles.dot, { backgroundColor: color }, selected && styles.selectedMarker]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { minHeight: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  selectedMarker: { borderColor: '#FFFFFF', borderWidth: 0.5 },
});
