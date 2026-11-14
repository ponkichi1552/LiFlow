import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { typography } from './planner-typography';
import { plannerColorsForScheme } from './planner-theme';

/** Reuse the same weekday targets for waste collection and calendar recurrence. */
export function WeekdayChoices({ options, selected, onToggle, disabled = false }: {
  options: readonly { id: number; label: string; accessibilityLabel?: string }[];
  selected: readonly number[]; onToggle(id: number): void; disabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={styles.days}>{options.map(day => {
    const active = selected.includes(day.id);
    return <Pressable key={day.id} accessibilityRole="button" accessibilityLabel={day.accessibilityLabel ?? `${day.label}曜`}
      accessibilityState={{ selected: active, disabled }} disabled={disabled} onPress={() => { if (!disabled) onToggle(day.id); }}
      style={({ pressed }) => [styles.day, { borderColor: disabled ? colors.inputBorder : colors.accent,
        backgroundColor: active ? disabled ? colors.elevated : colors.accentSoft : colors.surface }, pressed && !disabled && { opacity: .7 }]}>
      <Text style={[styles.label, { color: disabled ? colors.disabled : colors.accent }]}>{day.label}</Text>
    </Pressable>;
  })}</View>;
}
const styles = StyleSheet.create({
  days: { flexDirection: 'row', gap: 5 },
  day: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  label: { ...typography.label, fontWeight: '700' },
});
