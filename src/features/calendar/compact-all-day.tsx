import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { palette, typography } from '../../components/planner-ui';
import { formatJapaneseDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import type { CalendarOccurrence } from './events';
import type { calendarEventAppearance } from './event-appearance';
import type { compactAllDayLanes } from './layout';
import { calendarDisplayedTitle } from './title-display';

export function CompactAllDay({ days, lanes, openChoreDays, rowHeight, heightLimit, dragging, simultaneousWith, appearanceFor, isSelected, onOpen }:
  { days: readonly LocalDate[]; lanes: ReturnType<typeof compactAllDayLanes>; rowHeight: number; heightLimit: number; dragging: boolean;
    openChoreDays: readonly LocalDate[];
    simultaneousWith?: ComponentProps<typeof ScrollView>['simultaneousWith'];
    appearanceFor(event: CalendarOccurrence): ReturnType<typeof calendarEventAppearance>;
    isSelected(event: CalendarOccurrence): boolean; onOpen(event: CalendarOccurrence): void }) {
  return <ScrollView testID="calendar-compact-all-day" accessibilityLabel="終日予定" nestedScrollEnabled enabled={!dragging} scrollEnabled={!dragging}
    simultaneousWith={simultaneousWith} disallowInterruption={false}
    contentInsetAdjustmentBehavior="never" style={[styles.panel, { height: heightLimit }]} contentContainerStyle={styles.content}>
    {lanes.map((lane, index) => <View key={index} style={{ height: rowHeight }}>{lane.map(({ event, start, end }) => {
      const appearance = appearanceFor(event);
      const title = calendarDisplayedTitle(event);
      const selected = isSelected(event);
      const dates = start === end ? formatJapaneseDate(days[start]) : `${formatJapaneseDate(days[start])}〜${formatJapaneseDate(days[end])}`;
      const span = days.slice(start, end + 1);
      const freeColumn = Math.max(0, span.findIndex(day => !openChoreDays.includes(day)));
      return <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${title}を編集`} accessibilityHint={`終日、${dates}`}
        accessibilityState={{ selected }} onPress={() => onOpen(event)}
        style={[styles.bar, { left: `${start * 100 / days.length}%`, width: `${span.length * 100 / days.length}%` }]}>
        <View style={[styles.surface, { backgroundColor: appearance.backgroundColor, borderLeftColor: appearance.accent }, selected && styles.selected]} />
        <View pointerEvents="none" style={[styles.titleSlot, { left: `${freeColumn * 100 / span.length}%` }]}>
          <Text numberOfLines={1} style={[styles.title, { color: appearance.foregroundColor }]}>{title}</Text>
        </View>
      </Pressable>;
    })}</View>)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  panel: { flexGrow: 0, flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, backgroundColor: palette.background },
  content: { paddingVertical: 2 },
  bar: { position: 'absolute', top: 0, bottom: 0, paddingHorizontal: 2, paddingVertical: 2 },
  surface: { flex: 1, minWidth: 0, borderRadius: 4, borderLeftWidth: 2 },
  titleSlot: { position: 'absolute', top: 2, bottom: 2, right: 2, paddingLeft: 8, paddingRight: 4, justifyContent: 'center' },
  selected: { borderWidth: 1, borderColor: palette.accent },
  title: { ...typography.caption, fontWeight: '600' },
});
