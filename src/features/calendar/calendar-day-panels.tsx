import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { palette } from '../../components/planner-ui';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import type { LocalDate } from '../../domain/shared/types';
import type { compactAllDayLanes } from './layout';
import { calendarTimelineInset } from './timeline-origin';

type AllDayBand = { height: number; content: ReactNode };
type DayPanel = { day: LocalDate; summary: number; chores: number; height: number };

export function compactAllDayBand(lanes: ReturnType<typeof compactAllDayLanes>, bodyHeight: number, rowHeight: number,
  render: (height: number, scrollable: boolean) => ReactNode): AllDayBand | null {
  if (lanes.length === 0 || bodyHeight <= 0) return null;
  const rowSpace = (count: number) => count * rowHeight + 5;
  const height = Math.min(bodyHeight * .24, rowSpace(Math.min(3, lanes.length)));
  return { height, content: render(height, height < rowSpace(lanes.length)) };
}

export function layoutCalendarDayPanels(days: readonly LocalDate[], bodyHeight: number, allDay: AllDayBand | null, choreHeight: (day: LocalDate) => number,
  summaryHeight: (day: LocalDate) => number = () => 0) {
  const allDayHeight = allDay?.height ?? 0;
  // The bottom controls occupy part of the viewport. Use the rest of the
  // date's available space instead of capping the list at a percentage.
  const available = bodyHeight - Math.min(44, bodyHeight / 4);
  const columns = days.map((day): DayPanel => {
    const summary = summaryHeight(day);
    const top = allDayHeight + summary;
    const chores = Math.min(Math.max(0, available - top), choreHeight(day));
    return { day, summary, chores, height: top + chores };
  });
  const firstVisibleClock = columns.length ? Math.min(...columns.map(column => column.height)) : 0;
  return { allDay, allDayHeight, columns, firstVisibleClock };
}

export function CalendarTimelineShift({ panelHeight, hourHeight, scrollOffset, testID, style, children, decorative }: {
  panelHeight: number; hourHeight: number; scrollOffset: SharedValue<number>; testID?: string; style?: StyleProp<ViewStyle>;
  children: ReactNode; decorative?: boolean;
}) {
  const inset = useAnimatedStyle(() => ({ transform: [{ translateY: calendarTimelineInset(panelHeight, scrollOffset.get(), hourHeight) }] }));
  return <Animated.View testID={testID} pointerEvents={decorative ? 'none' : undefined} style={[style, inset]}>{children}</Animated.View>;
}

export function CalendarDayPanels({ layout, dragging, gutter = 0, renderChores, renderSummary }: {
  layout: ReturnType<typeof layoutCalendarDayPanels>; dragging: boolean; gutter?: number;
  renderChores(day: LocalDate, height: number): ReactNode;
  renderSummary?(day: LocalDate): ReactNode;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const { allDay, allDayHeight, columns } = layout;
  const position = (index: number) => ({
    left: `${index * 100 / columns.length}%` as const, width: `${100 / columns.length}%` as const,
  });
  return <View testID="calendar-day-panels" pointerEvents={dragging ? 'none' : 'box-none'} style={styles.overlay}>
    {gutter > 0 && layout.firstVisibleClock > 0 ? <View pointerEvents="none" style={[
      styles.panel, styles.gutter, { width: gutter - 1, height: Math.max(0, layout.firstVisibleClock - 2) },
    ]} /> : null}
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { left: gutter }]}>
    {allDay ? <View testID="calendar-fixed-all-day" pointerEvents="box-none" style={[styles.allDay, { height: allDayHeight }]}>
      <View pointerEvents="none" style={styles.allDayGrid}>
        {columns.map(({ day }) => <View key={day} style={styles.allDayCell} />)}
      </View>
      {allDay.content}
    </View> : null}
    {renderSummary ? columns.map(({ day, summary }, index) => summary > 0 ? <View key={day}
      style={[styles.panel, styles.summary, position(index), { top: allDayHeight, height: summary }]}>{renderSummary(day)}</View> : null) : null}
    {columns.some(panel => panel.chores > 0) ? <View testID="calendar-fixed-chores" pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {columns.map(({ day, summary, chores }, index) => chores > 0 ? <View key={day} testID={`calendar-chore-column:${day}`}
        style={[styles.panel, styles.surface, position(index), { top: allDayHeight + summary, height: chores }]}>{renderChores(day, chores)}</View> : null)}
    </View> : null}
    </View>
  </View>;
}

const baseStyles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 1 },
  panel: { position: 'absolute' },
  gutter: { top: 0, left: 0, backgroundColor: palette.background },
  allDay: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: palette.background, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  allDayGrid: { ...StyleSheet.absoluteFill, flexDirection: 'row' },
  allDayCell: { flex: 1, borderRightWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  surface: { backgroundColor: palette.background, borderRightWidth: 1, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  summary: { backgroundColor: palette.background, borderRightWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
});
