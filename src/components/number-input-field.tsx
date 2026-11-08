import { StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native';
import type { TextInputProps } from 'react-native';

import { palette, typography } from './planner-ui';
import { plannerColorsForScheme } from './planner-theme';

/** Single-line numeric controls use native font metrics, not paragraph line spacing. */
export function NumberInputField({ prefix, suffix = '日', borderless = false, inputWidth, ...props }: Omit<TextInputProps, 'style'> & { prefix?: string; suffix?: string; borderless?: boolean; inputWidth?: number }) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={[styles.field, { borderColor: colors.border, backgroundColor: colors.background }, borderless && styles.borderless]}>
    <View style={styles.unitSlot} aria-hidden><Text style={styles.unit}>{prefix ?? ''}</Text></View>
    <TextInput placeholderTextColor={colors.muted} {...props} keyboardType="number-pad" underlineColorAndroid="transparent" style={[styles.input, { color: colors.ink }, inputWidth !== undefined && { width: inputWidth }, !props.value && props.placeholder ? styles.placeholder : null]} />
    <View style={styles.unitSlot} aria-hidden><Text style={styles.unit}>{suffix}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  field: { minHeight: 46, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: palette.border,
    borderRadius: 11, paddingHorizontal: 6, backgroundColor: palette.background },
  borderless: { borderWidth: 0 },
  // Equal unit slots keep the number horizontally centered, including fields without ±.
  unitSlot: { width: 16, alignItems: 'center', justifyContent: 'center' },
  unit: { fontSize: typography.caption.fontSize, color: palette.muted },
  input: { fontSize: typography.control.fontSize, color: palette.ink, fontWeight: '700', width: 48,
    minHeight: 44, padding: 0, textAlign: 'center', textAlignVertical: 'center', includeFontPadding: false },
  placeholder: { fontSize: typography.caption.fontSize, fontWeight: '400' },
});
