export const MONTH_EVENT_ROW_HEIGHT = 18;
export const MONTH_MAX_EVENT_ROWS = 4;
export const MONTH_CELL_GAP = 2;
export const MONTH_CELL_PADDING = 3;
export const MONTH_DATE_HEIGHT = 28;
export const MONTH_SUMMARY_HEIGHT = 16;
export const MONTH_WASTE_HEIGHT = 16;
export const MONTH_MORE_HEIGHT = 16;
const reserved = (summary: boolean, waste: boolean) => MONTH_DATE_HEIGHT + 2 * MONTH_CELL_PADDING + 1
  + (summary ? MONTH_SUMMARY_HEIGHT + MONTH_CELL_GAP : 0) + (waste ? MONTH_WASTE_HEIGHT + MONTH_CELL_GAP : 0);
const eventHeight = MONTH_EVENT_ROW_HEIGHT + MONTH_CELL_GAP;

/** Include every row gap, cell inset and the week rule in the available space. */
export function calendarMonthUsedHeight(events: number, summary: boolean, waste: boolean) {
  return reserved(summary, waste) + Math.max(0, events) * eventHeight;
}

/** One stable height keeps every week aligned, even when event data arrives later. */
export function calendarMonthContentHeight(base: number) {
  return Math.max(base, calendarMonthUsedHeight(MONTH_MAX_EVENT_ROWS, true, false), calendarMonthUsedHeight(3, true, true),
    calendarMonthUsedHeight(MONTH_MAX_EVENT_ROWS + 1, false, false));
}
export function calendarMonthEventSlots(height: number, summary: boolean, waste: boolean) {
  return Math.max(0, Math.min(MONTH_MAX_EVENT_ROWS, Math.floor((height - reserved(summary, waste)) / eventHeight)));
}

/** Extra title lines consume spare space only after appointments, +N and day labels fit. */
export function calendarMonthPreviewLayout(height: number, total: number, summary: boolean, waste: boolean) {
  const available = Math.max(0, height - reserved(summary, waste));
  let visible = Math.min(total, calendarMonthEventSlots(height, summary, waste));
  if (total === visible + 1 && total * eventHeight <= available) visible = total;
  while (visible > 0 && visible * eventHeight + (total > visible ? MONTH_MORE_HEIGHT + MONTH_CELL_GAP : 0) > available) visible--;
  const hidden = Math.max(0, total - visible);
  const remaining = available - visible * eventHeight - (hidden ? MONTH_MORE_HEIGHT + MONTH_CELL_GAP : 0);
  const spareLines = Math.max(0, Math.floor(remaining / MONTH_EVENT_ROW_HEIGHT));
  return { visible, hidden, extraLines: Math.min(visible, spareLines), spareLines };
}

/** Reserve two title lines for every appointment before adding optional start times. */
export function calendarMonthTimedPreviews<T extends { id: string; startDate: string; startMinute: number; allDay: boolean }>(
  events: readonly T[], day: string, layout: ReturnType<typeof calendarMonthPreviewLayout>,
) {
  if (layout.hidden || layout.extraLines < events.length) return new Set<string>();
  const slots = Math.max(0, layout.spareLines - events.length);
  return new Set(events.filter(event => !event.allDay && event.startDate === day)
    .sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id)).slice(0, slots).map(event => event.id));
}

export function calendarMonthExpandedTitles<T extends { id: string; startDate: string; startMinute: number; allDay: boolean }>(
  events: readonly T[], overflowing: ReadonlySet<string>, extraLines: number,
) {
  return new Set(events.filter(event => overflowing.has(event.id)).sort((a, b) => Number(a.allDay) - Number(b.allDay)
    || a.startDate.localeCompare(b.startDate) || a.startMinute - b.startMinute || a.id.localeCompare(b.id)).slice(0, extraLines).map(event => event.id));
}
