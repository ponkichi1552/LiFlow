import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { plannerColorsForScheme } from './planner-theme';
import { typography } from './planner-typography';
import { SettingsLabel } from './settings-controls';

/** A quiet check with the same touch area in lists and detailed settings. */
export function SettingsCheckbox({ value, onValueChange, label, description, accessibilityLabel, accessibilityHint, disabled = false, pending = false }: {
  value: boolean; onValueChange(value: boolean): void; accessibilityHint?: string; disabled?: boolean; pending?: boolean;
} & ({ label: string; description?: string; accessibilityLabel?: string } | { label?: undefined; description?: undefined; accessibilityLabel: string })) {
  const colors = plannerColorsForScheme(useColorScheme());
  const locked = disabled || pending;
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={accessibilityLabel ?? label} accessibilityHint={accessibilityHint ?? description}
    accessibilityState={{ checked: value, disabled: locked }} disabled={locked}
    onPress={() => { if (!locked) onValueChange(!value); }} style={({ pressed }) => [label ? styles.row : styles.target, pressed && !locked && { backgroundColor: colors.accentSoft }]}>
    {description ? <View style={styles.copy}>
      <SettingsLabel>{label}</SettingsLabel>
      <Text style={[styles.description, { color: colors.muted }]}>{description}</Text>
    </View> : label ? <Text style={[styles.label, { color: colors.ink }]}>{label}</Text> : null}
    <View pointerEvents="none" style={[styles.check, { borderColor: disabled ? colors.inputBorder : colors.accent,
      backgroundColor: disabled ? value ? colors.elevated : colors.surface : value ? colors.accent : colors.surface }]}>
      {value ? <Text style={[styles.mark, { color: disabled ? colors.disabled : colors.accentInk }]}>✓</Text> : null}
    </View>
  </Pressable>;
}
const styles = StyleSheet.create({
  target: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 10, borderRadius: 10 },
  label: { ...typography.body, flex: 1 },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  description: { ...typography.caption },
  check: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  mark: { fontSize: 14, fontWeight: '800', lineHeight: 18 },
});
