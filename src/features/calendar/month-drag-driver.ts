import type { LocalDate } from '../../domain/shared/types';
import type { CalendarOccurrence } from './events';
import type { CalendarDropTarget, CalendarMonthViewport } from './direct-actions';

export interface MonthDragPoint { x: number; y: number }
export interface MonthDragStart<Capture, Preview> {
  capture: Capture; event: CalendarOccurrence; day: LocalDate; point: MonthDragPoint;
  frame: CalendarMonthViewport; preview: Preview;
}

/** Edge pressure changes speed continuously; leaving the grid stops scrolling. */
export function monthDragEdgeSpeed(viewport: CalendarMonthViewport | null, point: MonthDragPoint) {
  if (!viewport || ![viewport.x, viewport.y, viewport.width, viewport.height, point.x, point.y].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0 || point.x < viewport.x || point.x >= viewport.x + viewport.width
    || point.y < viewport.y || point.y >= viewport.y + viewport.height) return 0;
  const band = Math.min(64, viewport.height / 4);
  const top = (viewport.y + band - point.y) / band;
  const bottom = (point.y - (viewport.y + viewport.height - band)) / band;
  return top > 0 ? -540 * top * top : bottom > 0 ? 540 * bottom * bottom : 0;
}

interface MonthDragEnvironment<Capture, Preview> {
  enabled: boolean;
  viewport(): CalendarMonthViewport | null; offset(): number; limit(): number;
  resolve(start: MonthDragStart<Capture, Preview>, point: MonthDragPoint): CalendarDropTarget | null;
  scroll(offset: number): void;
  begin(start: MonthDragStart<Capture, Preview>): void; end(): void;
  preview(start: MonthDragStart<Capture, Preview>, point: MonthDragPoint, target: CalendarDropTarget | null): void;
  commit(capture: Capture, target: CalendarDropTarget): Promise<void>;
}

/** Own the gesture above the virtualized list so its source week can unmount safely. */
export function createMonthDragDriver<Capture, Preview>(clock = {
  request: (callback: (at: number) => void) => requestAnimationFrame(callback),
  cancel: (id: number) => cancelAnimationFrame(id),
}) {
  let environment: MonthDragEnvironment<Capture, Preview> | null = null;
  let session: { start: MonthDragStart<Capture, Preview>; point: MonthDragPoint; claimed: boolean } | null = null;
  let frame: number | null = null; let last: number | null = null;
  const stop = () => { if (frame !== null) clock.cancel(frame); frame = null; last = null; };
  const cancel = () => { stop(); if (session) { session = null; environment?.end(); } };
  const refresh = () => { if (session && environment) environment.preview(session.start, session.point, environment.resolve(session.start, session.point)); };
  const canScroll = () => {
    if (!session?.claimed || !environment) return 0;
    const speed = monthDragEdgeSpeed(environment.viewport(), session.point); const offset = environment.offset();
    return speed < 0 && offset > 0 || speed > 0 && offset < environment.limit() ? speed : 0;
  };
  const tick = (at: number) => {
    frame = null;
    if (!session || !environment) { stop(); return; }
    const speed = canScroll(); if (!speed) { stop(); return; }
    const elapsed = last === null ? 16 : Math.max(0, Math.min(50, at - last)); last = at;
    const next = Math.max(0, Math.min(environment.limit(), environment.offset() + speed * elapsed / 1000));
    environment.scroll(next); refresh();
    if (canScroll()) frame = clock.request(tick); else stop();
  };
  const schedule = () => { if (canScroll()) { if (frame === null) frame = clock.request(tick); } else stop(); };
  const finish = (point: MonthDragPoint) => {
    const current = session; const owner = environment; if (!current || !owner) return;
    stop(); session = null; owner.end();
    const target = owner.resolve(current.start, point);
    if (target && (target.day !== current.start.event.startDate || target.minute !== current.start.event.startMinute)) {
      void owner.commit(current.start.capture, target).catch(() => { /* Calendar save feedback belongs to the parent. */ });
    }
  };
  return {
    update(next: MonthDragEnvironment<Capture, Preview>) { environment = next; if (!next.enabled) cancel(); },
    start(input: MonthDragStart<Capture, Preview>) {
      if (session || !environment?.enabled || !environment.viewport()) return false;
      session = { start: input, point: input.point, claimed: false }; environment.begin(input); refresh(); return true;
    },
    active: () => Boolean(session),
    claim() { if (session) session.claimed = true; },
    move(point: MonthDragPoint, touches: number) {
      if (!session) return;
      if (touches !== 1 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { cancel(); return; }
      session.point = point; refresh(); schedule();
    },
    observedScroll() { refresh(); },
    finish,
    touchEnd(point: MonthDragPoint) { if (session?.claimed) finish(point); else cancel(); },
    unclaimedEnd() { if (session && !session.claimed) cancel(); },
    cancel,
  };
}
