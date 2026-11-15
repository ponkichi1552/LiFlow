import { useLayoutEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { addDays, formatJapaneseDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { calendarWeekDays, calendarWeekLabel } from './week-layout';

export type WeekRecenter = (minute?: number | null) => void;
/** The month calendar's seven columns, extended vertically by appointment time. */
export function CalendarWeek({ date, currentMinute, defaultMinute, dragging, activeDay, hourHeight, renderHeading, renderSummary, renderDay, onSelect, onReady, onScroll }: {
  date: LocalDate; currentMinute: number | null; defaultMinute: number; dragging: boolean; activeDay: LocalDate | null; hourHeight: number;
  renderHeading(day: LocalDate): ReactNode; renderSummary(day: LocalDate): ReactNode;
  renderDay(day: LocalDate, days: readonly LocalDate[], columnWidth: number): ReactNode;
  onSelect(date: LocalDate): void; onReady(recenter: WeekRecenter | null): void; onScroll(): void;
}) {
  const styles = usePlannerBorderStyles(baseStyles), { height } = useWindowDimensions();
  const days = calendarWeekDays(date), start = days[0];
  const [width, setWidth] = useState(0), [viewportHeight, setViewportHeight] = useState(0);
  const [headingHeights, setHeadingHeights] = useState<Record<string, number>>({}), [summaryHeights, setSummaryHeights] = useState<Record<string, number>>({});
  const headingHeight = Math.max(44, ...days.map(day => headingHeights[day] ?? 44));
  const summaryLimit = Math.max(0, Math.min(170, height * .23, height * .4 - headingHeight));
  const summaryHeight = Math.min(summaryLimit, Math.max(0, ...days.map(day => summaryHeights[day] ?? 0)));
  const vertical = useRef<ComponentRef<typeof ScrollView>>(null), positioned = useRef('');
  const pendingPosition = useRef<{ minute?: number | null } | null>(null);
  const position = (force = false, minute?: number | null) => {
    if (force) pendingPosition.current = { minute };
    if (viewportHeight <= 0) return;
    const requested = pendingPosition.current;
    if (requested || positioned.current !== start) {
      vertical.current?.scrollTo({ y: Math.max(0, (requested?.minute ?? currentMinute ?? defaultMinute) / 60 * hourHeight - viewportHeight / 2), animated: false });
      positioned.current = start; pendingPosition.current = null; onScroll();
    }
  };
  useLayoutEffect(() => { onReady(minute => position(true, minute)); position(); });
  useLayoutEffect(() => () => onReady(null), [onReady]);
  return <View testID="calendar-week" style={styles.root} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <View style={styles.navigation}>
      <Pressable accessibilityRole="button" accessibilityLabel="前の7日間" disabled={dragging} onPress={() => onSelect(addDays(date, -7))} style={styles.arrow}><Chevron direction="left" /></Pressable>
      <Text accessibilityRole="header" style={styles.range}>{calendarWeekLabel(date)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="次の7日間" disabled={dragging} onPress={() => onSelect(addDays(date, 7))} style={styles.arrow}><Chevron direction="right" /></Pressable>
    </View>
    <View testID="calendar-week-heading" style={[styles.headerRow, { height: headingHeight + summaryHeight + 1 }]}>
      {days.map(day => <View key={day} style={styles.column}>
        <View style={{ height: headingHeight }}><View onLayout={event => { const value = event.nativeEvent.layout.height; setHeadingHeights(before => before[day] === value ? before : { ...before, [day]: value }); }}>{renderHeading(day)}</View></View>
        <ScrollView nestedScrollEnabled enabled={!dragging} scrollEnabled={!dragging} style={{ height: summaryHeight }} onContentSizeChange={(_width, value) => setSummaryHeights(before => before[day] === value ? before : { ...before, [day]: value })} accessibilityLabel={`${formatJapaneseDate(day, { year: true })}の終日予定と家事`}>
          {renderSummary(day)}
        </ScrollView>
      </View>)}
    </View>
    <ScrollView ref={vertical} testID="calendar-week-time-scroll" style={styles.vertical} nestedScrollEnabled enabled={!dragging} scrollEnabled={!dragging}
      onLayout={event => setViewportHeight(event.nativeEvent.layout.height)} onContentSizeChange={() => position()} onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={styles.timeContent}>
      <View testID="calendar-week-grid" style={[styles.columns, { height: hourHeight * 24 + 16 }]}>
        {days.map(day => <View key={day} style={[styles.column, activeDay === day && { zIndex: 1 }]}>
          {Array.from({ length: 25 }, (_, hour) => <View key={hour} pointerEvents="none" style={[styles.rule, { top: hour * hourHeight }]} />)}
          {renderDay(day, days, width / 7)}
        </View>)}
      </View>
    </ScrollView>
  </View>;
}
const baseStyles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 }, navigation: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderColor: palette.border },
  arrow: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, range: { ...typography.label, color: palette.ink, textAlign: 'center', flexShrink: 1 },
  headerRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, columns: { flexDirection: 'row' }, column: { flex: 1, minWidth: 0, borderRightWidth: 1, borderColor: palette.border },
  vertical: { flex: 1, minHeight: 0 }, timeContent: { paddingTop: 9, paddingBottom: 76 },
  rule: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: palette.border },
});
