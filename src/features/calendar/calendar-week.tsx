import { useLayoutEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useAnimatedRef, useScrollOffset } from 'react-native-reanimated';
import { palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { addDays } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import type { CalendarDragColumn } from './direct-actions';
import { timelineDayMinutes } from './layout';
import { calendarWeekDays, calendarWeekLabel } from './week-layout';
import { CalendarDayPanels, CalendarTimelineShift, type layoutCalendarDayPanels } from './calendar-day-panels';
import { calendarDragColumn, calendarTimelineOffset } from './timeline-origin';

export type WeekRecenter = (minute?: number | null) => void;
const timePadding = 9;
const weekHours = Array.from({ length: 25 }, (_, hour) => hour);

/** The month calendar's seven columns, extended vertically by appointment time. */
export function CalendarWeek({ date, height, currentMinute, defaultMinute, endMinute = timelineDayMinutes, dragging, activeDay, hourHeight,
  renderHeading, layoutPanels, renderChores, renderSummary, renderDay, onSelect, onReady, onScroll }: {
  date: LocalDate; height: number; currentMinute: number | null; defaultMinute: number; dragging: boolean; activeDay: LocalDate | null; hourHeight: number;
  endMinute?: number;
  renderHeading(day: LocalDate): ReactNode;
  layoutPanels?(days: readonly LocalDate[], height: number): ReturnType<typeof layoutCalendarDayPanels>;
  renderChores?(day: LocalDate, height: number): ReactNode;
  renderSummary?(day: LocalDate): ReactNode;
  renderDay(day: LocalDate, days: readonly LocalDate[], columnWidth: number, dragColumns: () => readonly CalendarDragColumn[]): ReactNode;
  onSelect(date: LocalDate): void; onReady(recenter: WeekRecenter | null): void; onScroll(): void;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const days = calendarWeekDays(date), start = days[0];
  const [width, setWidth] = useState(0), [viewportHeight, setViewportHeight] = useState(0);
  const [headingHeight, setHeadingHeight] = useState(0), [navigationHeight, setNavigationHeight] = useState(44);
  const bodyHeight = viewportHeight || Math.max(0, height - navigationHeight - headingHeight);
  const panels = layoutPanels?.(days, bodyHeight);
  const columns = panels?.columns ?? days.map(day => ({ day, height: 0 }));
  const vertical = useAnimatedRef<ComponentRef<typeof ScrollView>>();
  const scrollOffset = useScrollOffset(vertical);
  const positioned = useRef('');
  const dragColumns = () => {
    const scrollY = scrollOffset.get();
    return columns.map(({ height }) => calendarDragColumn(height, scrollY, timePadding, hourHeight));
  };
  const pendingPosition = useRef<{ minute?: number | null } | null>(null);
  const position = (force = false, minute?: number | null) => {
    if (force) pendingPosition.current = { minute };
    if (viewportHeight <= 0) return;
    const requested = pendingPosition.current;
    if (requested || positioned.current !== start) {
      const pane = columns.find(column => column.day === date);
      const y = calendarTimelineOffset(requested?.minute ?? currentMinute ?? defaultMinute, viewportHeight, pane?.height ?? 0, timePadding, hourHeight);
      vertical.current?.scrollTo({ y, animated: false });
      positioned.current = start; pendingPosition.current = null; onScroll();
    }
  };
  useLayoutEffect(() => { onReady(minute => position(true, minute)); position(); });
  useLayoutEffect(() => () => onReady(null), [onReady]);
  return <View testID="calendar-week" style={styles.root} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <View style={styles.navigation} onLayout={event => setNavigationHeight(event.nativeEvent.layout.height)}>
      <Pressable accessibilityRole="button" accessibilityLabel="前の7日間" disabled={dragging} onPress={() => onSelect(addDays(date, -7))} style={styles.arrow}><Chevron direction="left" /></Pressable>
      <Text accessibilityRole="header" style={styles.range}>{calendarWeekLabel(date)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="次の7日間" disabled={dragging} onPress={() => onSelect(addDays(date, 7))} style={styles.arrow}><Chevron direction="right" /></Pressable>
    </View>
    <View testID="calendar-week-heading" style={styles.headerRow} onLayout={event => setHeadingHeight(event.nativeEvent.layout.height)}>
      {days.map(day => <View key={day} style={styles.column}>{renderHeading(day)}</View>)}
    </View>
    <View style={styles.vertical}>
      {panels && renderChores ? <CalendarDayPanels layout={panels} dragging={dragging} renderChores={renderChores} renderSummary={renderSummary} /> : null}
      <ScrollView ref={vertical} testID="calendar-week-time-scroll" style={styles.vertical} nestedScrollEnabled enabled={!dragging} scrollEnabled={!dragging}
        onLayout={event => setViewportHeight(event.nativeEvent.layout.height)} onContentSizeChange={() => position()} onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={styles.timeContent}>
        <View testID="calendar-week-grid" style={[styles.columns, { height: hourHeight * endMinute / 60 + 16 }]}>
          {columns.map(({ day, height }) => <View key={day} style={[styles.column, activeDay === day && { zIndex: 1 }]}>
            <CalendarTimelineShift testID={`calendar-week-time:${day}`} panelHeight={height} hourHeight={hourHeight} scrollOffset={scrollOffset} style={styles.vertical}>
              {weekHours.map(hour => <View key={hour} pointerEvents="none" style={[styles.rule, { top: hour * hourHeight }]} />)}
              {renderDay(day, days, width / days.length, dragColumns)}
            </CalendarTimelineShift>
          </View>)}
        </View>
      </ScrollView>
    </View>
  </View>;
}

const baseStyles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 }, navigation: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderColor: palette.border },
  arrow: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, range: { ...typography.label, color: palette.ink, textAlign: 'center', flexShrink: 1 },
  headerRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: palette.border }, columns: { flexDirection: 'row' }, column: { flex: 1, minWidth: 0, borderRightWidth: 1, borderColor: palette.border },
  vertical: { flex: 1, minHeight: 0 }, timeContent: { paddingTop: timePadding, paddingBottom: 76 },
  rule: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: palette.border },
});
