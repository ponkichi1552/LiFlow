export interface CalendarHelpRect { x: number; y: number; width: number; height: number }
export type CalendarHelpTargets = Partial<Record<'add' | 'mode' | 'search' | 'calendar' | 'event', CalendarHelpRect>>;
export interface CalendarHelpHost { measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void }
export type RegisterCalendarHelpTarget = (key: string, host: CalendarHelpHost | null) => void;

/** Native measurement is local, bounded, and cannot delay opening the calendar. */
export function measureCalendarHelpTargets(hosts: Partial<Record<'add' | 'mode' | 'search' | 'calendar', CalendarHelpHost | null>>, events: ReadonlyMap<string, CalendarHelpHost>, done: (targets: CalendarHelpTargets) => void) {
  const nodes = [...Object.entries(hosts).filter((row): row is [string, CalendarHelpHost] => Boolean(row[1])), ...[...events].map(([key, host]) => [`event:${key}`, host] as const)];
  const rects = new Map<string, CalendarHelpRect>(); let remaining = nodes.length, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (stopped) return; stopped = true; clearTimeout(timer);
    const targets: CalendarHelpTargets = Object.fromEntries([...rects].filter(([key]) => !key.startsWith('event:')));
    const viewport = targets.calendar;
    if (viewport) targets.event = [...rects].filter(([key, frame]) => key.startsWith('event:') && frame.y >= viewport.y && frame.y + frame.height <= viewport.y + viewport.height - 65 && frame.x >= viewport.x && frame.x + frame.width <= viewport.x + viewport.width + 1)
      .sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x)[0]?.[1];
    done(targets);
  };
  if (!remaining) { finish(); return () => {}; }
  timer = setTimeout(finish, 100);
  for (const [key, host] of nodes) {
    try { host.measureInWindow((x, y, width, height) => {
      if (stopped) return; if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) rects.set(key, { x, y, width, height });
      if (--remaining === 0) finish();
    }); } catch { if (--remaining === 0) finish(); }
  }
  return () => { stopped = true; clearTimeout(timer); };
}

export function calendarHelpPlacement(screen: { width: number; height: number; top: number; bottom: number }, rect: CalendarHelpRect | undefined, cardHeight: number) {
  const { width, height } = screen, margin = 16, gap = 30;
  const cardWidth = Math.max(0, Math.min(420, width - margin * 2)); const left = (width - cardWidth) / 2;
  const safeTop = screen.top + margin, safeBottom = height - screen.bottom - margin;
  const h = Math.min(cardHeight, Math.max(0, safeBottom - safeTop));
  const target = rect && rect.width > 0 && rect.height > 0 && rect.x < width && rect.y < height && rect.x + rect.width > 0 && rect.y + rect.height > 0 ? {
    x: Math.max(0, rect.x - 5), y: Math.max(0, rect.y - 5),
    width: Math.min(width, rect.x + rect.width + 5) - Math.max(0, rect.x - 5),
    height: Math.min(height, rect.y + rect.height + 5) - Math.max(0, rect.y - 5),
  } : undefined;
  if (!target) return { left, top: Math.max(safeTop, (safeTop + safeBottom - h) / 2), width: cardWidth, height: h, target };
  const below = safeBottom - target.y - target.height >= h + gap || target.y - safeTop < h + gap;
  const top = Math.max(safeTop, Math.min(safeBottom - h, below ? target.y + target.height + gap : target.y - gap - h));
  const tipX = target.x + target.width / 2, arrowX = Math.max(left + 20, Math.min(left + cardWidth - 20, tipX));
  const startY = below ? top - 3 : top + h + 3, endY = below ? target.y + target.height + 3 : target.y - 3;
  const clear = below ? startY > endY : startY < endY;
  const arrow = clear ? { fromX: arrowX, fromY: startY, toX: tipX, toY: endY, direction: below ? -1 : 1 } : undefined;
  return { left, top, width: cardWidth, height: h, target, arrow };
}
