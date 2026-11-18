import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { FlatListProps } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { monthDates, parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { japanesePublicHoliday } from './holiday-label';

type YearRow = { key: string; year: number; quarter: number | null };
export type YearScroller = (month: string) => void;

/** Only visible month rows are drawn; vertical scrolling crosses year boundaries. */
export function CalendarYear({ initialYear, today, editorOpen = false, onMonth, onYear, onReady }: {
  initialYear: number; today: LocalDate; editorOpen?: boolean; onMonth(date: LocalDate): void; onYear(year: number): void; onReady(scroll: YearScroller | null): void;
}) {
  const styles = usePlannerBorderStyles(baseStyles); const { fontScale } = useWindowDimensions();
  const list = useRef<FlatList<YearRow>>(null); const [initial] = useState(() => Math.max(1900, Math.min(2199, initialYear)));
  const tracking = useRef(false); const reportedYear = useRef(initial);
  const headingHeight = Math.ceil(40 * fontScale); const monthHeight = Math.ceil(Math.max(132, 34 * fontScale + 6 * Math.max(14, 12 * fontScale) + 12));
  const rowHeight = monthHeight + 16; const yearHeight = headingHeight + rowHeight * 4;
  const rows = useMemo(() => Array.from({ length: 300 }, (_, index) => {
    const year = 1900 + index;
    return [{ key: `${year}`, year, quarter: null }, ...Array.from({ length: 4 }, (_, quarter) => ({ key: `${year}:${quarter}`, year, quarter }))];
  }).flat(), []);
  const layout = useCallback((_data: ArrayLike<YearRow> | null | undefined, index: number) => {
    const within = index % 5;
    return { index, length: within === 0 ? headingHeight : rowHeight, offset: Math.floor(index / 5) * yearHeight + (within === 0 ? 0 : headingHeight + (within - 1) * rowHeight) };
  }, [headingHeight, rowHeight, yearHeight]);
  const initialIndex = (initial - 1900) * 5 + 1;
  const visibleOffset = useRef(layout(undefined, initialIndex).offset);
  const editorOffset = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (editorOpen) editorOffset.current = visibleOffset.current;
    else if (editorOffset.current !== null) list.current?.scrollToOffset({ offset: editorOffset.current, animated: false });
  }, [editorOpen]);
  const scrollToMonth = useCallback((month: string) => {
    const year = Number(month.slice(0, 4)); const ordinal = Number(month.slice(5, 7));
    if (!Number.isInteger(year) || year < 1900 || year > 2199 || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 12) return;
    editorOffset.current = null;
    tracking.current = true;
    list.current?.scrollToIndex({ index: (year - 1900) * 5 + 1 + Math.floor((ordinal - 1) / 3), viewPosition: .5, animated: false });
  }, []);
  useLayoutEffect(() => { onReady(scrollToMonth); return () => onReady(null); }, [onReady, scrollToMonth]);
  const scrolled = useCallback<NonNullable<FlatListProps<YearRow>['onScroll']>>(event => {
    const offset = event.nativeEvent.contentOffset.y;
    if (editorOpen || !Number.isFinite(offset)) return;
    const beforeEditor = editorOffset.current;
    // UIKit can send a zero offset while restoring the year list after the sheet closes.
    if (beforeEditor !== null && beforeEditor > 0 && offset <= 0) {
      list.current?.scrollToOffset({ offset: beforeEditor, animated: false });
      return;
    }
    if (beforeEditor !== null && Math.abs(offset - beforeEditor) > 1) editorOffset.current = null;
    // Each year starts with its heading. Change the fixed header only when
    // that heading reaches the top of the list, in either scroll direction.
    const next = Math.max(1900, Math.min(2199, 1900 + Math.floor(Math.max(0, offset) / yearHeight)));
    // Ignore the mount-time zero offset before initialScrollIndex is applied.
    if (!tracking.current && next !== initial) return;
    tracking.current = true;
    visibleOffset.current = Math.max(0, offset);
    if (reportedYear.current === next) return;
    reportedYear.current = next; onYear(next);
  }, [editorOpen, initial, onYear, yearHeight]);
  return <FlatList ref={list} testID="calendar-year" data={rows} keyExtractor={row => row.key} initialScrollIndex={initialIndex} scrollEnabled={!editorOpen}
    getItemLayout={layout} initialNumToRender={6} maxToRenderPerBatch={5} windowSize={5} contentContainerStyle={{ paddingBottom: 76 }}
    onScrollBeginDrag={() => { editorOffset.current = null; tracking.current = true; }} onScroll={scrolled} scrollEventThrottle={16}
    renderItem={({ item }) => item.quarter === null
      ? <View style={[styles.yearHeading, { height: headingHeight }]}><Text accessibilityRole="header" style={styles.yearTitle}>{item.year}年</Text></View>
      : <View style={[styles.monthRow, { height: rowHeight }]}>{Array.from({ length: 3 }, (_, column) => {
        const month = item.quarter! * 3 + column; const dates = monthDates(item.year, month); const start = parseLocalDate(dates[0]).getUTCDay();
        const current = dates[0].slice(0, 7) === today.slice(0, 7);
        return <Pressable key={month} accessibilityRole="button" accessibilityLabel={`${item.year}年${month + 1}月を表示`} accessibilityHint={current ? '今月' : undefined}
          onPress={() => onMonth(dates[0])} style={[styles.month, { height: monthHeight }, current && styles.current]}>
          <Text style={[styles.monthTitle, current && { color: palette.accent }]}>{month + 1}月</Text>
          <View style={styles.days}>{['日', '月', '火', '水', '木', '金', '土'].map(day => <Text key={day} style={styles.weekday}>{day}</Text>)}
            {Array.from({ length: start }, (_, index) => <View key={`empty:${index}`} style={styles.dateSlot} />)}
            {dates.map(day => <Text key={day} style={[styles.dateSlot, styles.date, japanesePublicHoliday(day) && { color: palette.warning }]}>{Number(day.slice(-2))}</Text>)}
          </View>
        </Pressable>;
      })}</View>} />;
}
const baseStyles = StyleSheet.create({
  yearHeading: { paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center' }, yearTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  monthRow: { flexDirection: 'row', gap: '3%', paddingHorizontal: 12, paddingBottom: 16 },
  month: { width: '31.3%', gap: 4, borderWidth: 1, borderColor: 'transparent', borderRadius: 8, padding: 4 },
  monthTitle: { ...typography.label, color: palette.ink, fontWeight: '700' }, current: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  days: { flexDirection: 'row', flexWrap: 'wrap' }, weekday: { fontSize: 9, lineHeight: 12, color: palette.muted, textAlign: 'center', width: `${100 / 7}%` },
  dateSlot: { width: `${100 / 7}%`, minHeight: 14 }, date: { fontSize: 9, lineHeight: 12, color: palette.ink, textAlign: 'center' },
});
