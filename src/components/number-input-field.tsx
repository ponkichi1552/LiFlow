import { useRef, type ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native';
import type { TextInputProps } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { palette, typography } from './planner-ui';
import { plannerColorsForScheme } from './planner-theme';

/** Single-line numeric controls use native font metrics, not paragraph line spacing. */
export function NumberInputField({ prefix, suffix = '日', borderless = false, inputWidth, editIndicator = false, ...props }: Omit<TextInputProps, 'style'> & { prefix?: string; suffix?: string; borderless?: boolean; inputWidth?: number; editIndicator?: boolean }) {
  const colors = plannerColorsForScheme(useColorScheme());
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const editable = props.editable !== false && props.readOnly !== true;
  const unitColor = editable ? colors.muted : colors.disabled;
  return <Pressable accessible={false} disabled={!editable} onPress={() => input.current?.focus()}
    style={[styles.field, { borderColor: editable ? colors.inputBorder : colors.border, backgroundColor: colors.surface }, borderless && styles.borderless]}>
    <View style={styles.unitSlot} aria-hidden>{editIndicator && !prefix && editable
      ? <Svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><Path d="m16 3 5 5M3 21l5-1L21 7a2.8 2.8 0 0 0-4-4L4 16l-1 5Z" /></Svg>
      : <Text style={[styles.unit, { color: unitColor }]}>{prefix ?? ''}</Text>}</View>
    <TextInput ref={input} placeholderTextColor={editable ? editIndicator ? colors.ink : colors.muted : colors.disabled} {...props} editable={editable}
      accessibilityState={{ ...props.accessibilityState, disabled: !editable }} keyboardType="number-pad" underlineColorAndroid="transparent"
      style={[styles.input, { color: editable ? colors.ink : colors.disabled }, inputWidth !== undefined && { width: inputWidth }, !props.value && props.placeholder ? styles.placeholder : null]} />
    <View style={styles.unitSlot} aria-hidden><Text style={[styles.unit, { color: unitColor }]}>{suffix}</Text></View>
  </Pressable>;
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
