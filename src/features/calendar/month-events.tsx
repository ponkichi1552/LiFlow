import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LocalDate } from '../../domain/shared/types';
import { plannerColorsForScheme } from '../../components/planner-theme';
import type { CalendarOccurrence } from './events';
import { calendarMonthTitleColor, type calendarEventAppearance } from './event-appearance';
import { calendarMonthExpandedTitles, calendarMonthPreviewLayout, calendarMonthTimedPreviews, MONTH_EVENT_ROW_HEIGHT, MONTH_MORE_HEIGHT } from './month-density';
import { CalendarMonthEventTitle } from './month-event-title';
import { minuteLabel } from './events';
import { monthDetailLayout, type CalendarMonthDetail } from './month-detail-store';
import { CalendarMonthEvent, type CalendarMonthEventDrag } from './month-event';
import { calendarDisplayedTitle } from './title-display';

type Appearance = ReturnType<typeof calendarEventAppearance>;

export function CalendarMonthEvents<Capture>({ events, day, height, summary, waste, appearances, fallbackAppearance, dark, drag, detail = 'standard' }: {
  events: readonly CalendarOccurrence[]; day: LocalDate; height: number; summary: boolean; waste: boolean;
  appearances: ReadonlyMap<string, Appearance>; fallbackAppearance: Appearance; dark: boolean;
  drag?: CalendarMonthEventDrag<Capture>; detail?: CalendarMonthDetail;
}) {
  const [overflow, setOverflow] = useState<Record<string, { title: string; value: boolean }>>({});
  const report = useCallback((id: string, title: string, value: boolean) => setOverflow(previous => {
    const current = previous[id];
    if ((!current && !value) || current?.title === title && current.value === value) return previous;
    return { ...previous, [id]: { title, value } };
  }), []);
  const config = monthDetailLayout(detail);
  const layout = calendarMonthPreviewLayout(height, events.length, summary, waste, config.maxEvents);
  const shown = events.slice(0, layout.visible);
  const overflowing = new Set(shown.filter(event => overflow[event.id]?.title === calendarDisplayedTitle(event) && overflow[event.id].value).map(event => event.id));
  const expanded = calendarMonthExpandedTitles(shown, overflowing, config.extra ? layout.extraLines : 0);
  const timed = config.extra ? calendarMonthTimedPreviews(shown, day, layout) : new Set<string>();
  return <>
    {shown.map(event => {
      const appearance = appearances.get(event.categoryId) ?? fallbackAppearance;
      const color = calendarMonthTitleColor(appearance.foregroundColor, dark);
      const title = calendarDisplayedTitle(event);
      const content = <>
        <CalendarMonthEventTitle title={title} color={color} backgroundColor={appearance.backgroundColor}
          lines={expanded.has(event.id) ? 2 : 1} centerSingleLine={!timed.has(event.id)} onOverflow={value => report(event.id, title, value)} />
        {timed.has(event.id) ? <Text numberOfLines={1} style={[styles.time, { color }]}>{minuteLabel(event.startMinute)}</Text> : null}
      </>;
      const style = [styles.event, { backgroundColor: appearance.backgroundColor }];
      return drag ? <CalendarMonthEvent key={`${event.id}:${title}`} event={event} day={day} drag={drag} style={style}>{content}</CalendarMonthEvent>
        : <View key={`${event.id}:${title}`} style={style}>{content}</View>;
    })}
    {layout.hidden ? <Text numberOfLines={1} style={[styles.more, { color: plannerColorsForScheme(dark ? 'dark' : 'light').muted }]}>+{layout.hidden}</Text> : null}
  </>;
}

const styles = StyleSheet.create({
  event: { borderRadius: 3, minHeight: MONTH_EVENT_ROW_HEIGHT, flexShrink: 0, alignItems: 'stretch' },
  time: { fontSize: 10.5, lineHeight: MONTH_EVENT_ROW_HEIGHT, fontWeight: '400' },
  more: { height: MONTH_MORE_HEIGHT, lineHeight: MONTH_MORE_HEIGHT, fontSize: 11.5, fontWeight: '600', textAlign: 'center', flexShrink: 0 },
});
