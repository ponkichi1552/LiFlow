import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { typography } from '../../components/planner-typography';
import { plannerColorsForScheme } from '../../components/planner-theme';

/** Settings rows share one quiet divider instead of enclosing every saved rule in a card. */
export function WasteSettingsItem({ children }: PropsWithChildren) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={[styles.item, { borderBottomColor: colors.border }]}>{children}</View>;
}
export function WasteSettingsHeading({ title, count }: { title: string; count: string }) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={styles.heading}><Text accessibilityRole="header" style={[typography.label, { color: colors.ink, fontWeight: '600' }]}>{title}</Text>
    <Text style={[typography.label, { color: colors.ink, fontWeight: '600' }]}>{count}</Text></View>;
}
export function WasteRegistrationHeading({ count }: { count: number }) {
  const colors = plannerColorsForScheme(useColorScheme());
  return count ? <WasteSettingsHeading title="登録済み" count={`${count}種類`} />
    : <Text style={[typography.caption, { color: colors.muted }]}>未登録</Text>;
}
export function WasteSettingsAction({ title, onPress, disabled = false, danger = false, quiet = false, surface = false, accessibilityLabel }: {
  title: string; onPress(): void; disabled?: boolean; danger?: boolean; quiet?: boolean; surface?: boolean; accessibilityLabel?: string;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, surface && { borderWidth: 0 }, pressed && { backgroundColor: colors.accentSoft }, disabled && { opacity: 0.5 }]}>
    <Text style={[styles.actionText, quiet && styles.quietText, { color: danger ? colors.warning : quiet ? colors.muted : colors.ink }]}>{title}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({
  heading: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  item: { paddingVertical: 12, borderBottomWidth: 1, gap: 8 },
  action: { minHeight: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10 },
  actionText: { ...typography.label, fontWeight: '500' },
  quietText: { ...typography.caption, fontWeight: '400' },
});
