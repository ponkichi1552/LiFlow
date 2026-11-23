import { useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';
import type { LocalDate } from '../../domain/shared/types';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { CalendarTextAction } from './calendar-sheet-header';

const firstYear = 1900;
const lastYear = 2199;
const years = [null, ...Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index), null];
const months = [null, ...Array.from({ length: 12 }, (_, index) => index + 1), null];

/** Year and month share the same scroll and tap behavior on both platforms. */
export function CalendarMonthPicker({ month, onSelect, onClose }: { month: LocalDate; onSelect(month: LocalDate): void; onClose(): void }) {
  const styles = usePlannerBorderStyles(baseStyles);
  const [year, setYear] = useState(Math.max(firstYear, Math.min(lastYear, Number(month.slice(0, 4)))));
  const [selectedMonth, setMonth] = useState(Number(month.slice(5, 7)));
  const latest = useRef({ year, month: selectedMonth }); const moved = useRef(false);
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const rowHeight = Math.max(44, Math.ceil(typography.control.lineHeight * fontScale + 12));
  return <Modal transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="年月の選択を閉じる" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View accessibilityViewIsModal style={[styles.panel, { paddingBottom: Math.max(12, insets.bottom) }]}>
        <View style={styles.header}><CalendarTextAction title="閉じる" onPress={onClose} />
          <Text accessibilityRole="header" style={styles.title}>年月を選択</Text>
          <CalendarTextAction title="移動" label={`${year}年${selectedMonth}月へ移動`} onPress={() => { if (moved.current) return; moved.current = true; onSelect(`${latest.current.year}-${String(latest.current.month).padStart(2, '0')}-01` as LocalDate); onClose(); }} />
        </View>
        <View style={styles.choices}>
          <View pointerEvents="none" style={[styles.selection, { top: rowHeight + 8, height: rowHeight }]} />
          <CalendarMonthWheel unit="年" rows={years} value={year} rowHeight={rowHeight}
            onChange={next => { if (next !== latest.current.year) { latest.current.year = next; setYear(next); } }} />
          <CalendarMonthWheel unit="月" rows={months} value={selectedMonth} rowHeight={rowHeight}
            onChange={next => { if (next !== latest.current.month) { latest.current.month = next; setMonth(next); } }} />
        </View>
      </View>
    </View>
  </Modal>;
}

function CalendarMonthWheel({ unit, rows, value, rowHeight, onChange }: {
  unit: '年' | '月'; rows: readonly (number | null)[]; value: number; rowHeight: number; onChange(value: number): void;
}) {
  const list = useRef<FlatList<number | null>>(null);
  const userScroll = useRef(false);
  const [initialIndex] = useState(() => rows.indexOf(value) - 1);
  const selectOffset = (offset: number) => {
    const index = Math.max(1, Math.min(rows.length - 2, Math.round(offset / rowHeight) + 1));
    const selected = rows[index];
    if (selected !== null) onChange(selected);
  };
  return <FlatList ref={list} testID={unit === '年' ? 'calendar-year-wheel' : 'calendar-month-wheel'} accessibilityLabel={unit}
    style={[baseStyles.wheel, { height: rowHeight * 3 }]} data={rows}
    keyExtractor={(item, index) => item === null ? `edge-${index}` : String(item)} initialScrollIndex={initialIndex}
    getItemLayout={(_, index) => ({ length: rowHeight, offset: index * rowHeight, index })}
    initialNumToRender={6} windowSize={5} scrollEventThrottle={32} showsVerticalScrollIndicator={false}
    bounces={false} overScrollMode="never" contentInsetAdjustmentBehavior="never" decelerationRate="fast" snapToInterval={rowHeight}
    onScrollBeginDrag={() => { userScroll.current = true; }}
    onScroll={event => { if (userScroll.current) selectOffset(event.nativeEvent.contentOffset.y); }}
    onScrollEndDrag={event => { if (userScroll.current) selectOffset(event.nativeEvent.contentOffset.y); }}
    onMomentumScrollEnd={event => {
      if (userScroll.current) selectOffset(event.nativeEvent.contentOffset.y);
      userScroll.current = false;
    }}
    renderItem={({ item, index }) => item === null ? <View style={{ height: rowHeight }} aria-hidden />
      : <Pressable accessibilityRole="button" accessibilityLabel={`${item}${unit}`} accessibilityState={{ selected: value === item }}
        onPress={() => {
          userScroll.current = false;
          onChange(item);
          list.current?.scrollToOffset({ offset: (index - 1) * rowHeight, animated: false });
        }} style={[baseStyles.row, { height: rowHeight }]}>
        <Text numberOfLines={1} style={[baseStyles.label, value === item && baseStyles.selectedText]}>{item}{unit}</Text>
      </Pressable>} />;
}

const baseStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay }, panel: { backgroundColor: palette.elevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  title: { ...typography.body, color: palette.ink, flex: 1, textAlign: 'center', fontWeight: '700' },
  choices: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8 }, wheel: { flex: 1, minWidth: 0 },
  selection: { position: 'absolute', left: 12, right: 12, borderRadius: 8, backgroundColor: palette.accentSoft },
  row: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  label: { ...typography.control, color: palette.muted }, selectedText: { color: palette.accent, fontWeight: '700' },
});
