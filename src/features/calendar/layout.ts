import { addDays, daysBetween, weekdayOf } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import type { CalendarOccurrence } from './events.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';

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
  })).map(row => {
    // The wall clock moves backwards during a fall transition. A short real
    // interval can therefore end at an earlier displayed minute (01:50 to
    // 01:10, for example); preserve its elapsed length on the single daily
    // timeline instead of filtering it as an empty interval.
    if (row.row.timeIssue === 'fold' && row.row.startDate === date && row.row.endDate === date && row.end < row.start) {
      const start = v2WallTimeCandidates({ date, hour: Math.floor(row.row.startMinute / 60), minute: row.row.startMinute % 60, timeZone: row.row.timeZone });
      const end = v2WallTimeCandidates({ date, hour: Math.floor(row.row.endMinute / 60), minute: row.row.endMinute % 60, timeZone: row.row.timeZone });
      let elapsed = Infinity;
      for (const first of start) for (const last of end) if (last > first) elapsed = Math.min(elapsed, (last - first) / 60_000);
      if (Number.isFinite(elapsed)) row.end = row.start + elapsed;
    }
    return row;
  }).filter(row => row.end > row.start).sort((a, b) => a.start - b.start || b.end - a.end || a.row.id.localeCompare(b.row.id));
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

export type TimelineEntry = ReturnType<typeof timelineEvents>[number];
type TimelineHead = { top: number; minutes: number; entries: TimelineEntry[] };

/** Align duration rails to time, allowing readable labels to stack independently. */
export function compactTimelineHeads(entries: readonly TimelineEntry[], labelMinutes: (entry: TimelineEntry) => number, gap: number): TimelineHead[] {
  const ordered = [...entries].sort((a, b) => a.start - b.start || a.end - b.end || a.row.id.localeCompare(b.row.id));
  const result: TimelineHead[] = [];
  let used = 0;
  for (const entry of ordered) {
    const last = result.at(-1);
    const minutes = Math.min(1440, labelMinutes(entry));
    const top = last ? Math.max(entry.start, last.top + last.minutes + gap) : entry.start;
    const thirdBack = result.at(-3);
    // The first three simultaneous appointments each have a title. If the
    // queue gets longer, keep the remainder accessible alongside the last one.
    if (last && (used + gap + minutes > 1440 || thirdBack && thirdBack.top + thirdBack.minutes + gap > entry.start)) last.entries.push(entry);
    else {
      used += (last ? gap : 0) + minutes;
      result.push({ top, minutes, entries: [entry] });
    }
  }
  // Near midnight there may be room above, even when no room remains below.
  let boundary = 1440;
  for (let i = result.length - 1; i >= 0; i--) {
    const head = result[i];
    head.top = Math.max(0, Math.min(head.top, boundary - head.minutes));
    boundary = head.top - gap;
  }
  return result;
}

export function compactAllDayLanes(days: readonly LocalDate[], eventsOn: (day: LocalDate) => readonly CalendarOccurrence[]) {
  type Span = { event: CalendarOccurrence; start: number; end: number };
  const events = new Map<string, Span>();
  for (const [index, day] of days.entries()) {
    for (const event of eventsOn(day)) {
      if (!event.allDay || event.birthday || event.holiday) continue;
      const span = events.get(event.id);
      if (span) span.end = index;
      else events.set(event.id, { event, start: index, end: index });
    }
  }
  const active = minimumHeap<{ end: number; lane: number }>((a, b) => a.end - b.end || a.lane - b.lane);
  const free = minimumHeap<number>((a, b) => a - b);
  const lanes: Span[][] = [];
  for (const span of events.values()) {
    while (active.peek()?.end < span.start) free.push(active.pop()!.lane);
    const lane = free.pop() ?? lanes.length;
    (lanes[lane] ??= []).push(span);
    active.push({ end: span.end, lane });
  }
  return lanes;
}
export function calendarSwipe(startX: number, dx: number, dy: number, width: number, minimum = 45): 'home' | 'chores' | 'previous' | 'next' | null {
  if (Math.abs(dx) < minimum || Math.abs(dx) < Math.abs(dy) * 1.4) return null;
  if (startX <= 24 && dx > 0) return 'home';
  if (startX >= width - 24 && dx < 0) return 'chores';
  if (startX <= 24 || startX >= width - 24) return null;
  return dx > 0 ? 'previous' : 'next';
}
