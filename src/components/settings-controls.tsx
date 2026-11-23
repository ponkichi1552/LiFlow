import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { typography } from './planner-typography';
import { plannerColorsForScheme, plannerPressColorsForScheme } from './planner-theme';
import { AppButton } from './planner-ui';

/** Choose the action's meaning and its surrounding surface; colors stay in the shared theme. */
export function SettingsAction({ intent = 'normal', placement = 'panel', compact = true, ...props }: {
  intent?: 'normal' | 'primary' | 'auxiliary' | 'destructive'; placement?: 'panel' | 'page';
} & Omit<ComponentProps<typeof AppButton>, 'variant'>) {
  const variant = intent === 'destructive' ? 'dangerText' : intent === 'primary' ? 'primary'
    : intent === 'auxiliary' ? 'neutral' : placement === 'panel' ? 'surface' : 'outline';
  return <AppButton {...props} compact={compact} variant={variant} />;
}

/** A background groups one chore's fields without enclosing the following chore. */
export function SettingsPanel({ children }: PropsWithChildren) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={[styles.panel, { backgroundColor: colors.elevated }]}>{children}</View>;
}

/** Connection state is supporting text, with the same emphasis in every settings panel. */
export function SettingsStatus({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <Text testID={testID} accessibilityLiveRegion="polite" style={{ ...typography.caption, color: colors.muted, fontWeight: '500', flexShrink: 1 }}>{children}</Text>;
}
export function SettingsLabel({ children }: PropsWithChildren) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <Text accessibilityRole="header" style={{ ...typography.label, color: colors.ink, fontWeight: '600' }}>{children}</Text>;
}

export function SettingsGroup({ title, children, plain = false, action, compact = false }: PropsWithChildren<{ title: string; plain?: boolean; action?: ReactNode; compact?: boolean }>) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={{ gap: compact ? 6 : 10, marginVertical: compact ? 0 : 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...typography.label, color: colors.ink, fontWeight: '600', flex: 1 }}>{title}</Text>{action}
    </View>
    <View style={{ gap: compact ? 8 : 14, padding: compact ? 10 : 12, ...(!plain ? { backgroundColor: colors.elevated, borderRadius: 12 } : {}) }}>{children}</View>
  </View>;
}

export function SettingsSegments<T extends string>({ options, value, onValueChange, wide = false, compact = false, fullWidth = false, fitContent = false, disabled = false, tone = 'accent' }: {
  options: readonly { id: T; label: string; disabled?: boolean }[]; value: T; onValueChange(value: T): void; wide?: boolean; compact?: boolean; fullWidth?: boolean; fitContent?: boolean; disabled?: boolean; tone?: 'accent' | 'quiet';
}) {
  const scheme = useColorScheme();
  const colors = plannerColorsForScheme(scheme);
  const pressColors = plannerPressColorsForScheme(scheme);
  const borderColor = disabled || tone === 'quiet' ? colors.inputBorder : colors.accent;
  return <View style={[styles.segments, wide && { width: 224, maxWidth: '100%' }, compact && { width: 116, flexShrink: 0 }, fullWidth && { width: '100%', maxWidth: '100%' }, fitContent && { width: 'auto', maxWidth: '100%', flexShrink: 0 }, { borderColor, backgroundColor: colors.surface }]}>
    {options.map((option, index) => {
      const selected = option.id === value;
      const unavailable = disabled || option.disabled === true;
      return <Pressable key={option.id} accessibilityRole="button" accessibilityState={{ selected, disabled: unavailable }} disabled={unavailable}
        onPress={() => { if (!unavailable) onValueChange(option.id); }} style={({ pressed }) => [styles.segment, fitContent && { flex: 0 },
          index > 0 && { borderLeftWidth: 1, borderLeftColor: borderColor },
          selected && { backgroundColor: unavailable ? colors.elevated : colors.accentSoft },
          pressed && !unavailable && { backgroundColor: selected ? pressColors.tinted : colors.accentSoft }]}>
        <Text style={[styles.segmentLabel, { color: unavailable ? colors.disabled : selected || tone === 'accent' ? colors.accent : colors.ink }, selected && { fontWeight: '700' }]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  panel: { paddingHorizontal: 12, borderRadius: 12 },
  segments: { flexDirection: 'row', width: 182, maxWidth: '80%', borderWidth: 1, borderRadius: 10, overflow: 'hidden', flexShrink: 1 },
  segment: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'center', alignItems: 'center', flex: 1 },
  segmentLabel: { ...typography.label, textAlign: 'center' },
});
