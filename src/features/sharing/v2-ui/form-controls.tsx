import { FormTextInput as TextInput } from '../../../components/form-text-input';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SettingsSwitch as Switch } from '../../../components/settings-switch';
import type { StyleProp, TextInputProps, ViewStyle } from 'react-native';
import { NavigationHeader, palette, typography } from '../../../components/planner-ui';
import { v2LocalTimeChoices } from './target-form';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { SafeAreaView } from '../../../components/screen-safe-area';

/** Android already uses adjustResize. Avoid applying an additional keyboard-height correction there. */
export function V2FormScrollView({ children, contentContainerStyle, header, footer }: { children: ReactNode; contentContainerStyle?: StyleProp<ViewStyle>; header?: ReactNode; footer?: ReactNode }) {
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    {header ? <NavigationHeader>{header}</NavigationHeader> : null}
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={contentContainerStyle}>{children}</ScrollView>
    {footer ? <SafeAreaView edges={['bottom']} style={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 8 }}>{footer}</SafeAreaView> : null}
  </KeyboardAvoidingView>;
}

export function V2Choices<T extends string>({ label, value, choices, onChange, disabled = false, compact = false }: {
  label: string; value: T; choices: readonly { value: T; label: string; shortLabel?: string; weight?: number }[]; onChange: (value: T) => void; disabled?: boolean; compact?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={compact ? v2FormStyles.compactChoiceRow : v2FormStyles.group}><Text style={v2FormStyles.label}>{label}</Text><View style={compact ? [v2FormStyles.compactChoices, { borderColor: colors.inputBorder, backgroundColor: colors.surface }] : v2FormStyles.choices}>
    {choices.map(({ value: choiceValue, label: choiceLabel, shortLabel, weight }, index) => <Pressable key={choiceValue} accessibilityRole="radio" accessibilityLabel={choiceLabel}
      accessibilityState={{ checked: value === choiceValue, disabled }} disabled={disabled} onPress={() => onChange(choiceValue)}
      style={[compact ? [v2FormStyles.compactChoice, weight !== undefined && { flex: weight, minWidth: 44 * weight }, index > 0 && { borderLeftWidth: 1, borderLeftColor: colors.inputBorder }] : v2FormStyles.choice,
        value === choiceValue && (compact ? { backgroundColor: colors.accentSoft } : v2FormStyles.selectedChoice), disabled && v2FormStyles.disabled]}>
      <Text numberOfLines={compact ? 1 : undefined} style={[v2FormStyles.choiceText, compact && { color: value === choiceValue ? colors.accent : colors.muted, fontWeight: value === choiceValue ? '700' : '400' }]}>{compact ? shortLabel ?? choiceLabel : choiceLabel}</Text>
    </Pressable>)}
  </View></View>;
}

export function V2TextField({ label, displayLabel = label, filled = false, ...props }: Omit<TextInputProps, 'style' | 'accessibilityLabel'> & { label: string; displayLabel?: string | false; filled?: boolean }) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={v2FormStyles.group}>{displayLabel !== false ? <Text style={v2FormStyles.label}>{displayLabel}</Text> : null}
    <TextInput {...props} accessibilityLabel={label} autoCapitalize="none" style={[v2FormStyles.input, props.multiline && v2FormStyles.multilineInput,
      filled && { borderWidth: 0, backgroundColor: colors.elevated, color: colors.ink }]} />
  </View>;
}

export function V2Flag({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
    <Text style={[v2FormStyles.label, { flex: 1 }]}>{label}</Text><Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} />
  </View>;
}

export function V2TimeDisambiguation({ day, clock, timeZone, value, onChange, disabled, label = '時刻の区別' }: {
  day: string; clock: string; timeZone: string; value: string; onChange: (value: string) => void; disabled?: boolean; label?: string;
}) {
  let choices: ReturnType<typeof v2LocalTimeChoices> = [];
  try { choices = v2LocalTimeChoices(day, clock, timeZone); } catch { /* Partial text is validated only when the user submits. */ }
  if (choices.length < 2) return null;
  return <View style={v2FormStyles.group}><Text style={v2FormStyles.caption}>この地域では同じ時刻が複数回あります。どの時刻か選んでください。</Text>
    <V2Choices label={label} value={value} choices={choices} onChange={onChange} disabled={disabled} />
  </View>;
}

export const v2FormStyles = StyleSheet.create({
  compactChoiceRow: { flex: 1, minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  compactChoices: { flexDirection: 'row', flex: 1, maxWidth: 224, borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  compactChoice: { flex: 1, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 8 },
  group: { gap: 6 }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: palette.border, justifyContent: 'center' },
  selectedChoice: { backgroundColor: palette.accentSoft, borderColor: palette.accent }, disabled: { opacity: 0.5 },
  choiceText: { ...typography.label, color: palette.ink }, label: { ...typography.label, color: palette.ink },
  input: { ...typography.body, color: palette.ink, minHeight: 46, borderWidth: 1, borderColor: palette.border, borderRadius: 11, paddingHorizontal: 12 },
  multilineInput: { minHeight: 100, maxHeight: 240, paddingVertical: 10, textAlignVertical: 'top' },
  body: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning },
});
