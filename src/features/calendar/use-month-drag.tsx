import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, AppState, StyleSheet, Text, View } from 'react-native';
import { GestureStateManager, usePanGesture } from 'react-native-gesture-handler';
import type { LocalDate } from '../../domain/shared/types';
import { palette, typography } from '../../components/planner-ui';
import type { CalendarDropTarget, CalendarMonthViewport } from './direct-actions';
import { createMonthDragDriver, type MonthDragPoint, type MonthDragStart } from './month-drag-driver';
import { CALENDAR_DRAG_HOLD_MS } from './direct-actions';

export function useMonthDrag<Capture>(options: {
  enabled: boolean; viewport(): CalendarMonthViewport | null; offset(): number; limit(): number;
  resolve(start: MonthDragStart<Capture, ReactNode>, point: MonthDragPoint): CalendarDropTarget | null;
  scroll(offset: number): void; begin(day: LocalDate): void; end(): void;
  commit(capture: Capture, target: CalendarDropTarget): Promise<void>;
}) {
  const driver = useMemo(() => createMonthDragDriver<Capture, ReactNode>(), []);
  const pending = useRef<MonthDragStart<Capture, ReactNode> | null>(null);
  const [position] = useState(() => { const value = new Animated.ValueXY(); return { value, transform: value.getTranslateTransform() }; });
  const [preview, setPreview] = useState<{ start: MonthDragStart<Capture, ReactNode>; viewport: CalendarMonthViewport; target: CalendarDropTarget | null } | null>(null);
  // The native recognizer survives the source week's virtualization.
  const gesture = usePanGesture({ enabled: options.enabled, activateAfterLongPress: CALENDAR_DRAG_HOLD_MS,
    maxPointers: 1, minDistance: 0, runOnJS: true, cancelsJSResponder: true,
    onActivate: event => { const start = pending.current;
      if (!start || !driver.start(start)) { GestureStateManager.deactivate(event.handlerTag); return; }
      driver.claim();
    },
    onUpdate: event => driver.move({ x: event.absoluteX, y: event.absoluteY }, event.numberOfPointers),
    onDeactivate: event => { if (event.canceled) driver.cancel(); else driver.finish({ x: event.absoluteX, y: event.absoluteY }); },
    onFinalize: () => { pending.current = null; driver.cancel(); },
  });
  useLayoutEffect(() => {
    driver.update({ ...options,
      begin: start => { const viewport = options.viewport(); if (!viewport) return;
        position.value.setValue({ x: 0, y: 0 }); setPreview({ start, viewport, target: { day: start.event.startDate, minute: start.event.startMinute } }); options.begin(start.day); },
      end: () => { setPreview(null); options.end(); },
      preview: (start, point, target) => {
        const viewport = options.viewport();
        const left = start.frame.x - (viewport?.x ?? 0); const top = start.frame.y - (viewport?.y ?? 0);
        position.value.setValue(viewport ? {
          x: Math.max(2, Math.min(viewport.width - start.frame.width - 2, left + point.x - start.point.x)) - left,
          y: Math.max(24, Math.min(viewport.height - start.frame.height - 2, top + point.y - start.point.y)) - top,
        } : { x: point.x - start.point.x, y: point.y - start.point.y });
        setPreview(previous => previous && (previous.target?.day !== target?.day || previous.target?.minute !== target?.minute) ? { ...previous, target } : previous);
      },
    });
  });
  useLayoutEffect(() => () => driver.cancel(), [driver]);
  useEffect(() => { const listener = AppState.addEventListener('change', state => { if (state !== 'active') { pending.current = null; driver.cancel(); } });
    return () => listener.remove(); }, [driver]);
  const overlay = preview ? <View testID="calendar-month-drag-preview" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
    <Animated.View style={{ position: 'absolute', zIndex: 30,
      left: preview.start.frame.x - preview.viewport.x, top: preview.start.frame.y - preview.viewport.y,
      width: preview.start.frame.width, height: preview.start.frame.height, transform: position.transform }}>
      {preview.target ? <Text style={styles.target}>{preview.target.day.slice(5).replace('-', '/')}</Text> : null}
      {preview.start.preview}
      <View style={[StyleSheet.absoluteFill, styles.outline]} />
    </Animated.View>
  </View> : null;
  return { prepare: (start: MonthDragStart<Capture, ReactNode>) => { pending.current = start; }, activeId: preview?.start.event.id, overlay,
    gesture, observedScroll: driver.observedScroll };
}

const styles = StyleSheet.create({
  outline: { borderWidth: 2, borderColor: palette.accent, borderRadius: 5 },
  target: { ...typography.small, position: 'absolute', bottom: '100%', left: 0, color: palette.ink, backgroundColor: palette.surface, paddingHorizontal: 4, borderRadius: 3 },
});
