import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';

export const CALENDAR_EDIT_SCOPES = [
  { value: 'one', label: 'この予定だけ' },
  { value: 'future', label: '今後の予定すべて' },
  { value: 'series', label: '繰り返し全体' },
] as const;
export type CalendarEditScope = typeof CALENDAR_EDIT_SCOPES[number]['value'];
/** All three choices remain visible on both platforms; closing never commits a move. */
export function CalendarRecurrenceScopePicker({ value, onSelect, onClose }: { value?: CalendarEditScope; onSelect(scope: CalendarEditScope): void; onClose(): void }) {
  const styles = usePlannerBorderStyles(baseStyles), insets = useSafeAreaInsets();
  return <Modal transparent animationType="slide" onRequestClose={onClose}><View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel="変更範囲の選択を閉じる" style={StyleSheet.absoluteFill} onPress={onClose} />
    <View accessibilityViewIsModal style={[styles.panel, { paddingBottom: Math.max(12, insets.bottom) }]}>
      <Text accessibilityRole="header" style={styles.title}>変更する範囲</Text>
      {CALENDAR_EDIT_SCOPES.map(row => <Pressable key={row.value} accessibilityRole="button" accessibilityLabel={row.label} accessibilityState={{ selected: value === row.value }} onPress={() => onSelect(row.value)} style={styles.option}>
        <Text style={styles.label}>{row.label}</Text>{value === row.value ? <Text aria-hidden style={styles.check}>✓</Text> : null}
      </Pressable>)}
      <Pressable accessibilityRole="button" accessibilityLabel="変更範囲の選択をキャンセル" onPress={onClose} style={styles.option}><Text style={[styles.label, { color: palette.accent }]}>キャンセル</Text></Pressable>
    </View>
  </View></Modal>;
}
const baseStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay }, panel: { backgroundColor: palette.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  title: { ...typography.body, fontWeight: '600', textAlign: 'center', color: palette.ink, padding: 16 },
  option: { minHeight: 52, paddingVertical: 12, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: palette.border },
  label: { ...typography.body, color: palette.ink, flex: 1 }, check: { ...typography.body, color: palette.accent },
});
