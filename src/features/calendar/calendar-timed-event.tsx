import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ComponentRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View, type GestureResponderEvent, type PanResponderGestureState, type StyleProp, type ViewStyle } from 'react-native';
import type { LocalDate } from '../../domain/shared/types';
import { palette, typography } from '../../components/planner-ui';
import type { CalendarOccurrence } from './events';
import { minuteLabel } from './events';
import { CALENDAR_DRAG_HOLD_MS, calendarDragTarget, type CalendarDragColumn } from './direct-actions';
import type { RegisterCalendarHelpTarget } from './help-targets';
import { addDays } from '../../domain/scheduling/local-date';
import { calendarDisplayedTitle } from './title-display';

type Target = { day: LocalDate; minute: number };
type PagePoint = Pick<GestureResponderEvent['nativeEvent'], 'pageX' | 'pageY'>;
function pagePoint(event?: GestureResponderEvent): PagePoint | undefined {
  const touch = event?.nativeEvent;
  return touch && { pageX: touch.pageX, pageY: touch.pageY };
}
function createTimedDragControl() {
  let actions = { active: () => false, grant: () => {}, cancel: () => {},
    move: (_gesture: PanResponderGestureState, _point?: PagePoint) => {}, finish: (_gesture: PanResponderGestureState, _point?: PagePoint) => {} };
  const control = PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => actions.active() && gesture.numberActiveTouches === 1,
    onMoveShouldSetPanResponder: (_event, gesture) => actions.active() && gesture.numberActiveTouches === 1,
    onPanResponderGrant: () => actions.grant(), onPanResponderMove: (event, gesture) => actions.move(gesture, event?.nativeEvent),
    onPanResponderRelease: (event, gesture) => actions.finish(gesture, event?.nativeEvent), onPanResponderTerminate: () => actions.cancel(),
    onPanResponderTerminationRequest: () => !actions.active(), onShouldBlockNativeResponder: () => actions.active(),
  });
  return { panHandlers: control.panHandlers, update: (next: typeof actions) => { actions = next; } };
}
export function CalendarTimedEvent<Capture>({ event, day, days, columnWidth, hourHeight, draggable, style, selected, children, background,
  onOpen, onBegin, onCommit, onActive, onResolveTarget, dragColumns, dateOnly = false, helpTarget, accessibleTime }: {
  event: CalendarOccurrence; day: LocalDate; days: readonly LocalDate[]; columnWidth: number; hourHeight: number;
  draggable: boolean; style: StyleProp<ViewStyle>; selected: boolean; children: ReactNode; background?: ReactNode;
  onOpen(): void; onBegin(): Capture | null; onCommit(capture: Capture, target: Target): Promise<void>; onActive(day: LocalDate | null): void;
  helpTarget?: RegisterCalendarHelpTarget; onResolveTarget?(gesture: PanResponderGestureState): Target | null; dateOnly?: boolean;
  dragColumns?(): readonly CalendarDragColumn[];
  accessibleTime?: string;
}) {
  const setHost = useCallback((node: ComponentRef<typeof View> | null) => { helpTarget?.(`timed:${event.id}:${day}`, draggable ? node : null); }, [helpTarget, event.id, day, draggable]);
  const [animation] = useState(() => { const pan = new Animated.ValueXY(); return { pan, transform: pan.getTranslateTransform() }; });
  const pan = animation.pan;
  const control = useMemo(() => createTimedDragControl(), []);
  const [target, setTarget] = useState<Target | null>(null);
  const session = useRef<{ capture: Capture; origin: Target; touch?: PagePoint; days: readonly LocalDate[]; columnWidth: number; hourHeight: number;
    columns?: readonly CalendarDragColumn[]; resolve?: (gesture: PanResponderGestureState) => Target | null } | null>(null);
  const touchBeforeHold = useRef<PagePoint | undefined>(undefined);
  const claimed = useRef(false); const held = useRef(false); const saving = useRef(false); const alive = useRef(true);
  const reset = () => {
    session.current = null; claimed.current = false; pan.setValue({ x: 0, y: 0 });
    onActive(null); if (alive.current) setTarget(null);
  };
  const destination = (gesture: PanResponderGestureState, pointer?: PagePoint) => {
    const value = session.current;
    if (!value) return null;
    // PanResponder resets dx/dy when it takes over from the long-press button.
    const translation = value.touch && pointer
      ? { x: pointer.pageX - value.touch.pageX, y: pointer.pageY - value.touch.pageY }
      : { x: gesture.dx, y: gesture.dy };
    const next = value.resolve ? value.resolve(gesture)
      : calendarDragTarget(value.origin, value.days, value.columnWidth, value.hourHeight, translation.x, translation.y, value.columns);
    return { next, translation };
  };
  useLayoutEffect(() => {
    control.update({ active: () => Boolean(session.current), grant: () => { claimed.current = true; }, cancel: reset,
      move: (gesture, pointer) => {
        if (!session.current) return;
        if (gesture.numberActiveTouches !== 1) { reset(); return; }
        const drop = destination(gesture, pointer); if (!drop) return;
        const { next, translation } = drop;
        pan.setValue(translation);
        setTarget(previous => previous?.day === next?.day && previous?.minute === next?.minute ? previous : next);
      }, finish: (gesture, pointer) => {
      const value = session.current; const next = destination(gesture, pointer)?.next;
      if (!value || !next || saving.current || next.day === value.origin.day && next.minute === value.origin.minute) { reset(); return; }
      session.current = null; saving.current = true;
      // The parent installs its pending position synchronously before the save awaits storage.
      const work = onCommit(value.capture, next); pan.setValue({ x: 0, y: 0 });
      onActive(null); if (alive.current) setTarget(null);
      void work.catch(() => { /* The calendar owns save-error feedback. */ }).finally(() => { saving.current = false; reset(); });
    } });
  });
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; if (session.current) onActive(null); }; }, [onActive]);
  return <Animated.View ref={setHost} {...control.panHandlers} testID={`calendar-movable-${event.id}`} onTouchEnd={() => { if (session.current && !claimed.current) reset(); }}
    onTouchCancel={() => { if (session.current && !claimed.current) reset(); }} style={[style, { transform: animation.transform }, target && styles.active]}>
    {background}
    {target ? <Text pointerEvents="none" style={styles.target}>{target.day.slice(5).replace('-', '/')}{dateOnly ? '' : ` ${minuteLabel(target.minute)}`}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel={dateOnly ? `${calendarDisplayedTitle(event)}、${day}の予定` : `${calendarDisplayedTitle(event)}を編集`} accessibilityHint={draggable ? `長押しして${dateOnly ? '日付' : '日時'}を移動できます` : undefined}
      accessibilityValue={accessibleTime ? { text: accessibleTime } : undefined}
      accessibilityActions={draggable ? dateOnly ? [{ name: 'moveNextDay', label: '翌日へ移動' }, { name: 'movePreviousDay', label: '前日へ移動' }] : [{ name: 'moveLater', label: '5分後へ移動' }, { name: 'moveEarlier', label: '5分前へ移動' }] : undefined}
      onAccessibilityAction={action => {
        const direction = action.nativeEvent.actionName === (dateOnly ? 'moveNextDay' : 'moveLater') ? 1 : action.nativeEvent.actionName === (dateOnly ? 'movePreviousDay' : 'moveEarlier') ? -1 : 0;
        if (!direction || !draggable || saving.current || session.current) return;
        const next = dateOnly ? { day: addDays(event.startDate, direction), minute: event.startMinute } : calendarDragTarget({ day, minute: event.startMinute }, [day], columnWidth, hourHeight, 0, direction * hourHeight / 12);
        if (!next || next.day === event.startDate && next.minute === event.startMinute) return;
        const capture = onBegin(); if (!capture) return;
        saving.current = true;
        void onCommit(capture, next).catch(() => { /* The calendar owns save-error feedback. */ }).finally(() => { saving.current = false; });
      }}
      accessibilityState={{ selected }} hitSlop={dateOnly ? undefined : 4}
      style={({ pressed }) => [!dateOnly && styles.hit, pressed && !held.current && styles.pressed]} onPressIn={touchEvent => {
        if (saving.current) return;
        held.current = false;
        touchBeforeHold.current = pagePoint(touchEvent);
      }} onPressMove={draggable ? touchEvent => {
        if (!held.current && !saving.current) touchBeforeHold.current = pagePoint(touchEvent);
      } : undefined}
      onPress={() => { if (!held.current && !saving.current) onOpen(); }} delayLongPress={CALENDAR_DRAG_HOLD_MS} onLongPress={draggable ? touchEvent => {
        if (saving.current || session.current) return;
        const capture = onBegin(); if (!capture) return;
        held.current = true; claimed.current = false;
        const origin = { day: event.startDate, minute: event.startMinute };
        const touch = touchBeforeHold.current ?? pagePoint(touchEvent);
        session.current = { capture, origin, touch, days: [...days], columnWidth, hourHeight, columns: dragColumns?.(), resolve: onResolveTarget };
        setTarget(origin); onActive(day);
      } : undefined}>{dateOnly ? children : <View pointerEvents="none" style={styles.hit}>{children}</View>}</Pressable>
    {target ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.outline]} /> : null}
  </Animated.View>;
}

const styles = StyleSheet.create({
  // The outline must not reduce the text area, or clip the date tag above the card.
  hit: { flex: 1 }, active: { zIndex: 20, overflow: 'visible' }, pressed: { opacity: .78 },
  outline: { borderWidth: 2, borderColor: palette.accent, borderRadius: 5 },
  target: { ...typography.small, position: 'absolute', bottom: '100%', left: 0, color: palette.ink, backgroundColor: palette.surface, paddingHorizontal: 4, borderRadius: 3 },
});
