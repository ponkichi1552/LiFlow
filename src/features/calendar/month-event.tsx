import { useRef, type ComponentRef, type ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LocalDate } from '../../domain/shared/types';
import type { CalendarOccurrence } from './events';
import { addDays } from '../../domain/scheduling/local-date';
import { CALENDAR_DRAG_HOLD_MS, type CalendarDropTarget } from './direct-actions';
import type { MonthDragStart } from './month-drag-driver';

export interface CalendarMonthEventDrag<Capture> {
  activeId?: string; canMove(event: CalendarOccurrence): boolean; onBegin(event: CalendarOccurrence): Capture | null;
  onCommit(capture: Capture, target: CalendarDropTarget): Promise<void>;
  prepare(input: MonthDragStart<Capture, ReactNode>): void; onOpen(): void;
}
export function CalendarMonthEvent<Capture>({ event, day, drag, style, children }: {
  event: CalendarOccurrence; day: LocalDate; drag: CalendarMonthEventDrag<Capture>; style: StyleProp<ViewStyle>; children: ReactNode;
}) {
  const held = useRef(false); const pressed = useRef(false);
  const host = useRef<ComponentRef<typeof View>>(null);
  const draggable = drag.canMove(event);
  return <Pressable ref={host} accessibilityRole="button" accessibilityLabel={`${event.title}、${day}の予定`} accessibilityHint={draggable ? '長押しして日付を移動できます' : undefined}
    accessibilityActions={draggable ? [{ name: 'moveNextDay', label: '翌日へ移動' }, { name: 'movePreviousDay', label: '前日へ移動' }] : undefined}
    onAccessibilityAction={action => {
      const direction = action.nativeEvent.actionName === 'moveNextDay' ? 1 : action.nativeEvent.actionName === 'movePreviousDay' ? -1 : 0;
      if (!direction || !draggable) return; const capture = drag.onBegin(event);
      if (capture) void drag.onCommit(capture, { day: addDays(event.startDate, direction), minute: event.startMinute }).catch(() => {});
    }}
    style={[style, drag.activeId === event.id && { opacity: 0 }]} delayLongPress={CALENDAR_DRAG_HOLD_MS}
    onPressIn={input => {
      pressed.current = true; held.current = false;
      if (!draggable) return;
      const capture = drag.onBegin(event); const target = host.current ?? input.currentTarget; const point = { x: input.nativeEvent.pageX, y: input.nativeEvent.pageY };
      if (!capture || !target || typeof target === 'number') return;
      target.measureInWindow((x, y, width, height) => {
        if (pressed.current && width > 0 && height > 0) drag.prepare({ capture, event, day, point, frame: { x, y, width, height }, preview: <View style={style}>{children}</View> });
      });
    }} onPressOut={() => { pressed.current = false; }}
    onPress={() => { if (!held.current) drag.onOpen(); }}
    onLongPress={draggable ? () => { held.current = true; } : undefined}>{children}</Pressable>;
}
