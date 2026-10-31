import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';
import type { LocalDate } from '../../domain/shared/types';

const years = Array.from({ length: 300 }, (_, index) => 1900 + index);
/** A bounded year list and all twelve months; choosing a destination does not change the display mode. */
export function CalendarMonthPicker({ month, onSelect, onClose }: { month: LocalDate; onSelect(month: LocalDate): void; onClose(): void }) {
  const [year, setYear] = useState(Number(month.slice(0, 4)));
  const [selectedMonth, setMonth] = useState(Number(month.slice(5, 7)));
  const [initialIndex] = useState(() => Math.max(0, Math.min(299, year - 1900 - 2)));
  const insets = useSafeAreaInsets();
  return <Modal transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="年月の選択を閉じる" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View accessibilityViewIsModal style={[styles.panel, { paddingBottom: Math.max(12, insets.bottom) }]}>
        <View style={styles.header}><Pressable accessibilityRole="button" onPress={onClose} style={styles.action}><Text style={styles.actionText}>閉じる</Text></Pressable>
          <Text accessibilityRole="header" style={styles.title}>年月を選択</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`${year}年${selectedMonth}月へ移動`} onPress={() => { onSelect(`${year}-${String(selectedMonth).padStart(2, '0')}-01` as LocalDate); onClose(); }} style={styles.action}><Text style={styles.actionText}>移動</Text></Pressable>
        </View>
        <View style={styles.choices}>
          <FlatList accessibilityLabel="年" style={styles.years} data={years} keyExtractor={String} initialScrollIndex={initialIndex}
            getItemLayout={(_, index) => ({ length: 44, offset: index * 44, index })}
            renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item}年`} accessibilityState={{ selected: year === item }}
              onPress={() => setYear(item)} style={[styles.year, item === year && styles.selected]}><Text style={[styles.label, item === year && styles.selectedText]}>{item}年</Text></Pressable>} />
          <View style={styles.months}>{Array.from({ length: 12 }, (_, index) => index + 1).map(item => <Pressable key={item} accessibilityRole="button" accessibilityLabel={`${item}月`} accessibilityState={{ selected: selectedMonth === item }}
            onPress={() => setMonth(item)} style={[styles.month, item === selectedMonth && styles.selected]}><Text style={[styles.label, item === selectedMonth && styles.selectedText]}>{item}月</Text></Pressable>)}</View>
        </View>
      </View>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay }, panel: { backgroundColor: palette.elevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  title: { ...typography.subheading, color: palette.ink, flex: 1, textAlign: 'center', fontWeight: '600' }, action: { minWidth: 56, minHeight: 44, justifyContent: 'center', alignItems: 'center' }, actionText: { ...typography.control, color: palette.accent },
  choices: { flexDirection: 'row', height: 220, padding: 12, gap: 12 }, years: { width: 104, flexGrow: 0 }, year: { height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  months: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignContent: 'space-between', justifyContent: 'space-between' }, month: { width: '31%', minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  label: { ...typography.control, color: palette.ink }, selected: { backgroundColor: palette.accentSoft }, selectedText: { color: palette.accent, fontWeight: '700' },
});
