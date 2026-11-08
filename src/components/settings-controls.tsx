import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { typography } from './planner-typography';
import { plannerColorsForScheme } from './planner-theme';
import { AppButton } from './planner-ui';

/** Choose the action's meaning and its surrounding surface; colors stay in the shared theme. */
export function SettingsAction({ intent = 'normal', placement = 'panel', compact = true, ...props }: {
  intent?: 'normal' | 'primary' | 'destructive'; placement?: 'panel' | 'page';
} & Omit<ComponentProps<typeof AppButton>, 'variant'>) {
  const variant = intent === 'destructive' ? 'dangerText' : intent === 'primary' ? 'primary'
    : placement === 'panel' ? 'surface' : 'outline';
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

export function SettingsGroup({ title, children, plain = false, action }: PropsWithChildren<{ title: string; plain?: boolean; action?: ReactNode }>) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={{ gap: 10, marginVertical: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...typography.label, color: colors.ink, fontWeight: '600', flex: 1 }}>{title}</Text>{action}
    </View>
    <View style={{ gap: 14, padding: 12, ...(!plain ? { backgroundColor: colors.elevated, borderRadius: 12 } : {}) }}>{children}</View>
  </View>;
}

export function SettingsSegments<T extends string>({ options, value, onValueChange, wide = false, compact = false, fullWidth = false, disabled = false }: {
  options: readonly { id: T; label: string }[]; value: T; onValueChange(value: T): void; wide?: boolean; compact?: boolean; fullWidth?: boolean; disabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={[styles.segments, wide && { width: 224, maxWidth: '100%' }, compact && { width: 116, flexShrink: 0 }, fullWidth && { width: '100%', maxWidth: '100%' }, { borderColor: colors.inputBorder, backgroundColor: colors.surface }]}>
    {options.map((option, index) => {
      const selected = option.id === value;
      return <Pressable key={option.id} accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled}
        onPress={() => onValueChange(option.id)} style={({ pressed }) => [styles.segment,
          index > 0 && { borderLeftWidth: 1, borderLeftColor: colors.inputBorder },
          selected && { backgroundColor: colors.accentSoft }, pressed && { opacity: 0.7 }]}>
        <Text style={[styles.segmentLabel, { color: selected ? colors.accent : colors.muted }, selected && { fontWeight: '700' }]}>{option.label}</Text>
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
