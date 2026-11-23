import type { CalendarDragColumn } from './direct-actions';

export function calendarTimelineInset(panelHeight: number, scrollOffset: number, hourHeight: number) {
  'worklet';
  // Leave space above midnight only for this day's panels. After the first
  // part of the scroll, the clock lines of every day align again.
  return panelHeight * Math.max(0, 1 - Math.max(0, scrollOffset) / (2 * hourHeight));
}

export function calendarTimelineOffset(minute: number, viewport: number, panelHeight: number, top: number, hourHeight: number) {
  const distance = minute / 60 * hourHeight + top - (viewport + panelHeight) / 2;
  const alignedDistance = 2 * hourHeight;
  return Math.max(0, distance < alignedDistance
    ? (distance + panelHeight) / (1 + panelHeight / alignedDistance) : distance);
}

export function calendarDragColumn(panelHeight: number, scrollOffset: number, top: number, hourHeight: number): CalendarDragColumn {
  const inset = calendarTimelineInset(panelHeight, scrollOffset, hourHeight);
  return { inset, minimum: panelHeight > 0 ? panelHeight + Math.max(0, scrollOffset) - top - inset : -Infinity };
}
