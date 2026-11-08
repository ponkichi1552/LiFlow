import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { Chevron } from './chevron';
import { typography } from './planner-typography';
import { plannerColorsForScheme } from './planner-theme';
import { monthDates, parseLocalDate, weekdayOf } from '../domain/scheduling/local-date';
import type { LocalDate } from '../domain/shared/types';

/** A bounded, inline month shared by date-based settings; it performs no schedule reads. */
export function CalendarDayPicker({ today, initialDate = today, selected, onSelect, label = '日付カレンダー', describe, selectionHint, caption, disabled = false, isDateDisabled }: {
  today: LocalDate; selected(date: LocalDate): boolean; onSelect(date: LocalDate): void; label?: string;
  initialDate?: LocalDate; isDateDisabled?(date: LocalDate): boolean;
  describe?(date: LocalDate, selected: boolean): string; selectionHint?(selected: boolean): string; caption?: string; disabled?: boolean;
}) {
  const [month, setMonth] = useState(() => `${initialDate.slice(0, 7)}-01` as LocalDate);
  const colors = plannerColorsForScheme(useColorScheme());
  const cells = useMemo(() => {
    const date = parseLocalDate(month); const dates = monthDates(date.getUTCFullYear(), date.getUTCMonth());
    const leading = weekdayOf(month) % 7; const result: (LocalDate | null)[] = [...Array<null>(leading).fill(null), ...dates];
    while (result.length % 7) result.push(null);
    return Array.from({ length: result.length / 7 }, (_, row) => result.slice(row * 7, row * 7 + 7));
  }, [month]);
  const move = (by: number) => setMonth(current => {
    const date = parseLocalDate(current); date.setUTCMonth(date.getUTCMonth() + by); return date.toISOString().slice(0, 10) as LocalDate;
  });
  return <View style={styles.calendar}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}の前の月`} disabled={disabled || month <= '1900-01-01'} onPress={() => move(-1)} style={styles.action}><Chevron direction="left" color={colors.accent} /></Pressable>
      <Text accessibilityRole="header" style={[styles.month, { color: colors.ink }]}>{Number(month.slice(0, 4))}年{Number(month.slice(5, 7))}月</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}の次の月`} disabled={disabled || month >= '2199-12-01'} onPress={() => move(1)} style={styles.action}><Chevron color={colors.accent} /></Pressable>
    </View>
    <View style={styles.week}>{['日', '月', '火', '水', '木', '金', '土'].map(day => <Text key={day} style={[styles.weekday, { color: colors.muted }]}>{day}</Text>)}</View>
    {cells.map((week, index) => <View key={index} style={styles.week}>{week.map((date, column) => {
      if (!date) return <View key={column} style={styles.cell} />;
      const active = selected(date);
      const locked = disabled || isDateDisabled?.(date) === true;
      return <Pressable key={date} accessibilityRole="button" accessibilityLabel={describe?.(date, active) ?? `${date.replaceAll('-', '/')}を選択`}
        accessibilityState={{ selected: active, disabled: locked }} accessibilityHint={selectionHint?.(active)} disabled={locked} onPress={() => { if (!locked) onSelect(date); }} style={[styles.cell, locked && { opacity: 0.35 }]}>
        <View style={[styles.day, active && { backgroundColor: colors.accentSoft }, date === today && { borderWidth: 1, borderColor: colors.accent }]}>
          <Text style={[styles.dayText, { color: active ? colors.accent : colors.ink }, active && { fontWeight: '700' }]}>{Number(date.slice(8, 10))}</Text>
        </View>
      </Pressable>;
    })}</View>)}
    {caption ? <Text style={[styles.hint, { color: colors.muted }]}>{caption}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  calendar: { gap: 2 }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  action: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  month: { ...typography.label, fontWeight: '600' }, week: { flexDirection: 'row' },
  weekday: { ...typography.caption, flex: 1, textAlign: 'center', paddingVertical: 4 },
  cell: { flex: 1, minWidth: 0, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  day: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  dayText: { ...typography.label }, hint: { ...typography.caption, paddingTop: 6 },
});
