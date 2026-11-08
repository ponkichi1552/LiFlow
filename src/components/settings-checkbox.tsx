import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { palette } from './planner-colors';
import { plannerColorsForScheme } from './planner-theme';

/** A quiet check with the same touch area in lists and detailed settings. */
export function SettingsCheckbox({ value, onValueChange, accessibilityLabel, disabled = false }: {
  value: boolean; onValueChange(value: boolean): void; accessibilityLabel: string; disabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={accessibilityLabel}
    accessibilityState={{ checked: value, disabled }} disabled={disabled}
    onPress={() => { if (!disabled) onValueChange(!value); }} style={styles.target}>
    <View pointerEvents="none" style={[styles.check, { borderColor: value ? colors.accent : colors.inputBorder,
      backgroundColor: value ? colors.accent : colors.surface }]}>
      {value ? <Text style={styles.mark}>✓</Text> : null}
    </View>
  </Pressable>;
}
const styles = StyleSheet.create({
  target: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  check: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  mark: { color: palette.accentInk, fontSize: 14, fontWeight: '800', lineHeight: 18 },
});
