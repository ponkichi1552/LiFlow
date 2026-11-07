import { addDays, daysBetween, weekdayOf } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import type { CalendarOccurrence } from './events.ts';

export const weekStart = (date: LocalDate) => addDays(date, -(weekdayOf(date) % 7));
export function weekIndex(anchor: LocalDate, date: LocalDate) { return Math.floor(daysBetween(anchor, weekStart(date)) / 7); }
function minimumHeap<T>(compare: (left: T, right: T) => number) {
  const values: T[] = [];
  return {
    peek: () => values[0], clear: () => { values.length = 0; },
    push(value: T) {
      let i = values.length; values.push(value);
      while (i > 0) { const parent = (i - 1) >> 1; if (compare(values[parent], value) <= 0) break; values[i] = values[parent]; i = parent; }
      values[i] = value;
    },
    pop(): T | undefined {
      if (!values.length) return undefined;
      const first = values[0]; const last = values.pop()!;
      if (values.length) {
        let i = 0;
        while (i * 2 + 1 < values.length) {
          let child = i * 2 + 1;
          if (child + 1 < values.length && compare(values[child + 1], values[child]) < 0) child++;
          if (compare(last, values[child]) <= 0) break; values[i] = values[child]; i = child;
        }
        values[i] = last;
      }
      return first;
    },
  };
}
export function timelineEvents(events: readonly CalendarOccurrence[], date: LocalDate, minimumVisibleMinutes = 0) {
  const rows = events.filter(row => !row.allDay && row.startDate <= date && row.endDate >= date).map(row => ({ row,
    start: row.startDate < date ? 0 : row.startMinute, end: row.endDate > date ? 1440 : row.endMinute, lane: 0, lanes: 1,
  })).filter(row => row.end > row.start).sort((a, b) => a.start - b.start || b.end - a.end || a.row.id.localeCompare(b.row.id));
  let group: typeof rows = []; let groupEnd = -1; let laneCount = 0;
  const active = minimumHeap<{ end: number; lane: number }>((a, b) => a.end - b.end || a.lane - b.lane);
  const free = minimumHeap<number>((a, b) => a - b);
  const finish = () => { for (const row of group) row.lanes = laneCount; group = []; laneCount = 0; groupEnd = -1; active.clear(); free.clear(); };
  for (const row of rows) {
    if (row.start >= groupEnd) finish();
    while (active.peek()?.end <= row.start) free.push(active.pop()!.lane);
    const lane = free.pop() ?? laneCount++;
    // A short event still needs a readable card. Reserve its visible extent for
    // collisions, keeping the real start/end unchanged for editing and labels.
    const visibleEnd = Math.max(row.end, row.start + minimumVisibleMinutes);
    active.push({ end: visibleEnd, lane }); row.lane = lane; group.push(row); groupEnd = Math.max(groupEnd, visibleEnd);
  }
  finish(); return rows;
}
export function calendarSwipe(startX: number, dx: number, dy: number, width: number, minimum = 45): 'home' | 'chores' | 'previous' | 'next' | null {
  if (Math.abs(dx) < minimum || Math.abs(dx) < Math.abs(dy) * 1.4) return null;
  if (startX <= 24 && dx > 0) return 'home';
  if (startX >= width - 24 && dx < 0) return 'chores';
  if (startX <= 24 || startX >= width - 24) return null;
  return dx > 0 ? 'previous' : 'next';
}
