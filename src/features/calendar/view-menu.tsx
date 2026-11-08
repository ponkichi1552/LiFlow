import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';
import type { CalendarDetailView } from './display-store';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
export const CALENDAR_DETAIL_LABELS = { day: '1日', two: '2日', list: 'リスト' } as const;

export function CalendarViewMenu({ value, onSelect, onClose }: { value: CalendarDetailView; onSelect: (value: CalendarDetailView) => void; onClose: () => void }) {
  const styles = usePlannerBorderStyles(baseStyles);
  const insets = useSafeAreaInsets();
  return <Modal transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel="表示の選択を閉じる" style={StyleSheet.absoluteFill} onPress={onClose} />
    <View accessibilityViewIsModal style={[styles.menu, { top: insets.top + 54 }]}>
      {(Object.keys(CALENDAR_DETAIL_LABELS) as CalendarDetailView[]).map(mode => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={`${CALENDAR_DETAIL_LABELS[mode]}表示`} accessibilityState={{ selected: value === mode }}
        onPress={() => { onSelect(mode); onClose(); }} style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
        <Text style={styles.label}>{CALENDAR_DETAIL_LABELS[mode]}</Text>{value === mode ? <Text aria-hidden style={styles.check}>✓</Text> : null}
      </Pressable>)}
    </View>
  </View></Modal>;
}
const baseStyles = StyleSheet.create({
  overlay: { flex: 1 }, menu: { position: 'absolute', right: 18, minWidth: 156, paddingVertical: 4, backgroundColor: palette.elevated, borderWidth: 1, borderColor: palette.border, borderRadius: 14, boxShadow: '0 4px 18px #00000040' },
  option: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 14 }, label: { ...typography.control, color: palette.ink, flex: 1 }, check: { ...typography.control, color: palette.accent }, pressed: { backgroundColor: palette.accentSoft },
});
