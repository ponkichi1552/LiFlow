import { StyleSheet, Text, View } from 'react-native';
import { formatJapaneseDate } from '../domain/scheduling/local-date';
import type { LocalDate } from '../domain/shared/types';
import { palette, typography } from './planner-ui';
export function HistoryDayHeading({ date, showMonth }: { date: LocalDate; showMonth: boolean }) {
  return <View style={styles.heading}>{showMonth ? <Text accessibilityRole="header" style={styles.month}>{Number(date.slice(0, 4))}年{Number(date.slice(5, 7))}月</Text> : null}
    <Text accessibilityRole="header" style={styles.day}>{formatJapaneseDate(date, { weekday: true })}</Text>
  </View>;
}
const styles = StyleSheet.create({ heading: { paddingVertical: 8, gap: 12, backgroundColor: palette.background }, month: { ...typography.section, color: palette.ink, fontWeight: '700' }, day: { ...typography.label, color: palette.muted, fontWeight: '600' } });
