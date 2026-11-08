import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { addDays, formatJapaneseDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { weekStart } from './layout';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';

/** The date selector and timeline headings describe the same selected interval. */
export function CalendarDateStrip({ date, today, days, onSelect }: {
  date: LocalDate; today: LocalDate; days: 1 | 2; onSelect(date: LocalDate): void;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const first = weekStart(date); const last = addDays(date, days - 1);
  return <View style={styles.week}>{Array.from({ length: 7 }, (_, index) => {
    const day = addDays(first, index); const selected = date <= day && day <= last;
    return <Pressable key={day} accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true, weekday: true })}を表示`}
      accessibilityState={{ selected }} onPress={() => onSelect(day)} style={({ pressed }) => [styles.cell, pressed && { opacity: .65 }]}>
      <Text style={styles.weekday}>{['日', '月', '火', '水', '木', '金', '土'][index]}</Text>
      <View style={[styles.number, selected && styles.range, day === today && styles.today, day === date && styles.selected]}>
        <Text style={[styles.date, day === today && { color: palette.accent }, day === date && { color: palette.accentInk }]}>{Number(day.slice(-2))}</Text>
      </View>
    </Pressable>;
  })}</View>;
}
const baseStyles = StyleSheet.create({
  week: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border, paddingVertical: 4 },
  cell: { flex: 1, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 3 },
  weekday: { ...typography.calendarLabel, color: palette.muted },
  number: { minWidth: 36, minHeight: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  date: { ...typography.calendarDate, color: palette.ink, fontWeight: '600' },
  range: { backgroundColor: palette.accentSoft }, today: { borderColor: palette.accent }, selected: { backgroundColor: palette.accent },
});
