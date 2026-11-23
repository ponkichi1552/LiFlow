import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LocalDate } from '../../domain/shared/types';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { WasteTypeLabel } from '../../components/waste-type-icon';
import type { CalendarOccurrence } from './events';
import { calendarMonthTitleColor, type calendarEventAppearance } from './event-appearance';
import { calendarMonthExpandedTitles, calendarMonthPreviewLayout, calendarMonthTimedPreviews, MONTH_CELL_GAP, MONTH_EVENT_ROW_HEIGHT, MONTH_MORE_HEIGHT, MONTH_SUMMARY_HEIGHT, MONTH_WASTE_HEIGHT } from './month-density';
import { CalendarMonthEventTitle } from './month-event-title';
import { minuteLabel } from './events';
import { monthDetailLayout, type CalendarMonthDetail } from './month-detail-store';
import { CalendarMonthEvent, type CalendarMonthEventDrag } from './month-event';
import { calendarDisplayedTitle } from './title-display';

type Appearance = ReturnType<typeof calendarEventAppearance>;

export function CalendarMonthEvents<Capture>({ events, day, height, summary, wasteLabel, eventError, width, fontScale, appearances, fallbackAppearance, dark, drag, detail = 'standard', framed = false }: {
  events: readonly CalendarOccurrence[]; day: LocalDate; height: number; summary: boolean; wasteLabel?: string; eventError?: boolean;
  width: number; fontScale: number;
  appearances: ReadonlyMap<string, Appearance>; fallbackAppearance: Appearance; dark: boolean;
  drag?: CalendarMonthEventDrag<Capture>; detail?: CalendarMonthDetail; framed?: boolean;
}) {
  const [overflow, setOverflow] = useState<Record<string, { title: string; value: boolean }>>({});
  const [measurement, setMeasurement] = useState<{ key: string; height: number }>();
  const report = useCallback((id: string, title: string, value: boolean) => setOverflow(previous => {
    const current = previous[id];
    if ((!current && !value) || current?.title === title && current.value === value) return previous;
    return { ...previous, [id]: { title, value } };
  }), []);
  const config = monthDetailLayout(detail);
  const colors = plannerColorsForScheme(dark ? 'dark' : 'light');
  const hasMetadata = Boolean(wasteLabel || eventError);
  const key = hasMetadata ? JSON.stringify([wasteLabel, eventError, width, fontScale]) : '';
  // A collection label may need two lines. Start with room for both so the count
  // stays inside the cell even before native text layout reports its height.
  const estimated = Math.ceil(((wasteLabel ? 2 * MONTH_WASTE_HEIGHT : 0) + (eventError ? MONTH_SUMMARY_HEIGHT : 0)) * Math.max(1, fontScale))
    + (wasteLabel && eventError ? MONTH_CELL_GAP : 0);
  const metadataSpace = hasMetadata ? (measurement?.key === key ? measurement.height : estimated) + MONTH_CELL_GAP : 0;
  const layout = calendarMonthPreviewLayout(height - metadataSpace, events.length, summary, false, config.maxEvents);
  const shown = events.slice(0, layout.visible);
  const overflowing = new Set(shown.filter(event => overflow[event.id]?.title === calendarDisplayedTitle(event) && overflow[event.id].value).map(event => event.id));
  const expanded = calendarMonthExpandedTitles(shown, overflowing, config.extra ? layout.extraLines : 0);
  const timed = config.extra ? calendarMonthTimedPreviews(shown, day, layout) : new Set<string>();
  return <>
    {hasMetadata ? <View key={key} pointerEvents="none" style={styles.metadata} onLayout={event => {
      const height = Math.ceil(event.nativeEvent.layout.height);
      if (height > 0) setMeasurement(current => current?.key === key && current.height === height ? current : { key, height });
    }}>
      {wasteLabel ? <WasteTypeLabel label={wasteLabel} size={13} style={styles.wasteLabel} textStyle={styles.wasteText} /> : null}
      {eventError ? <Text numberOfLines={1} style={[styles.warning, { color: colors.warning }]}>予定表示不可</Text> : null}
    </View> : null}
    {shown.map(event => {
      const appearance = appearances.get(event.categoryId) ?? fallbackAppearance;
      const color = calendarMonthTitleColor(appearance.foregroundColor, dark);
      const title = calendarDisplayedTitle(event);
      const content = <>
        <CalendarMonthEventTitle title={title} color={color} backgroundColor={appearance.backgroundColor}
          lines={expanded.has(event.id) ? 2 : 1} centerSingleLine={!timed.has(event.id)} onOverflow={value => report(event.id, title, value)} />
        {timed.has(event.id) ? <Text numberOfLines={1} style={[styles.time, { color }]}>{minuteLabel(event.startMinute)}</Text> : null}
      </>;
      const style = [styles.event, framed && styles.framedEvent, { backgroundColor: appearance.backgroundColor }];
      return drag ? <CalendarMonthEvent key={`${event.id}:${title}`} event={event} day={day} drag={drag} style={style}>{content}</CalendarMonthEvent>
        : <View key={`${event.id}:${title}`} style={style}>{content}</View>;
    })}
    {layout.hidden ? <Text numberOfLines={1} style={[styles.more, { color: colors.muted }]}>+{layout.hidden}</Text> : null}
  </>;
}

const styles = StyleSheet.create({
  metadata: { gap: MONTH_CELL_GAP, flexShrink: 0 },
  wasteLabel: { gap: 2 },
  wasteText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: MONTH_WASTE_HEIGHT },
  warning: { fontSize: 12, lineHeight: MONTH_SUMMARY_HEIGHT },
  event: { borderRadius: 3, minHeight: MONTH_EVENT_ROW_HEIGHT, flexShrink: 0, alignItems: 'stretch' },
  framedEvent: { paddingHorizontal: 2 },
  time: { fontSize: 10.5, lineHeight: MONTH_EVENT_ROW_HEIGHT, fontWeight: '400' },
  more: { height: MONTH_MORE_HEIGHT, lineHeight: MONTH_MORE_HEIGHT, fontSize: 11.5, fontWeight: '600', textAlign: 'center', flexShrink: 0 },
});
