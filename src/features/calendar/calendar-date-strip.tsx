import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { addDays, daysBetween, formatJapaneseDate, parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { weekStart } from './layout';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { japanesePublicHoliday } from './holiday-label';
import { plannerColorsForScheme } from '../../components/planner-theme';

/** The date selector and timeline headings describe the same selected interval. */
export function CalendarDateStrip({ date, today, days, onSelect }: {
  date: LocalDate; today: LocalDate; days: 1 | 2 | 3; onSelect(date: LocalDate): void;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const colors = plannerColorsForScheme(useColorScheme());
  // Keep the complete selected interval visible when it crosses Saturday.
  const first = addDays(weekStart(date), Math.max(0, parseLocalDate(date).getUTCDay() + days - 7));
  const last = addDays(date, days - 1);
  return <View style={styles.week}>{Array.from({ length: 7 }, (_, index) => {
    const day = addDays(first, index); const selected = date <= day && day <= last; const holiday = japanesePublicHoliday(day);
    const current = day === today; const focused = day === date;
    const status = [current ? '今日' : '', focused ? '選択日' : selected ? `表示中の${daysBetween(date, day) + 1}日目` : ''].filter(Boolean).join('、');
    return <Pressable key={day} accessibilityRole="button" accessibilityLabel={`${formatJapaneseDate(day, { year: true, weekday: true })}を表示${holiday ? `、祝日：${holiday}` : ''}`}
      accessibilityState={{ selected }} accessibilityValue={status ? { text: status } : undefined} onPress={() => onSelect(day)} style={({ pressed }) => [styles.cell, pressed && { opacity: .65 }]}>
      <Text style={styles.weekday}>{['日', '月', '火', '水', '木', '金', '土'][parseLocalDate(day).getUTCDay()]}</Text>
      <View style={[styles.number, selected && styles.range, selected && day === date && styles.rangeStart, selected && day === last && styles.rangeEnd]}>
        <Text style={[styles.date, holiday && { color: palette.warning }, current && { color: colors.calendarToday }, focused && styles.selectedDate]}>{Number(day.slice(-2))}</Text>
      </View>
    </Pressable>;
  })}</View>;
}
const baseStyles = StyleSheet.create({
  week: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border, paddingVertical: 4 },
  cell: { flex: 1, minHeight: 58, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 3 },
  weekday: { ...typography.calendarLabel, color: palette.muted },
  number: { width: '100%', minHeight: 36, justifyContent: 'center', alignItems: 'center' },
  date: { ...typography.calendarDate, color: palette.ink, fontWeight: '600' },
  range: { backgroundColor: palette.accentSoft }, rangeStart: { borderTopLeftRadius: 18, borderBottomLeftRadius: 18 }, rangeEnd: { borderTopRightRadius: 18, borderBottomRightRadius: 18 },
  selectedDate: { color: palette.accent, fontWeight: '700' },
});
