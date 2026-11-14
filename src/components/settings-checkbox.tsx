import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { plannerColorsForScheme } from './planner-theme';

/** A quiet check with the same touch area in lists and detailed settings. */
export function SettingsCheckbox({ value, onValueChange, accessibilityLabel, accessibilityHint, disabled = false }: {
  value: boolean; onValueChange(value: boolean): void; accessibilityLabel: string; accessibilityHint?: string; disabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint}
    accessibilityState={{ checked: value, disabled }} disabled={disabled}
    onPress={() => { if (!disabled) onValueChange(!value); }} style={({ pressed }) => [styles.target, pressed && !disabled && { opacity: 0.7 }]}>
    <View pointerEvents="none" style={[styles.check, { borderColor: disabled ? colors.inputBorder : colors.accent,
      backgroundColor: disabled ? value ? colors.elevated : colors.surface : value ? colors.accent : colors.surface }]}>
      {value ? <Text style={[styles.mark, { color: disabled ? colors.disabled : colors.accentInk }]}>✓</Text> : null}
    </View>
  </Pressable>;
}
const styles = StyleSheet.create({
  target: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  check: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  mark: { fontSize: 14, fontWeight: '800', lineHeight: 18 },
});
