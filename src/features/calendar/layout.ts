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
export const timelineDayMinutes = 24 * 60;
const overnightPreviewMinutes = 30;

export function timelineGroups(events: readonly CalendarOccurrence[], date: LocalDate, minimumVisibleMinutes = 0, showOvernight = false) {
  const tomorrow = showOvernight ? addDays(date, 1) : null;
  const rows = events.filter(row => !row.allDay && row.startDate <= date && row.endDate >= date).map(row => ({ row,
    start: row.startDate < date ? 0 : row.startMinute,
    end: row.endDate > date
      ? timelineDayMinutes + (tomorrow ? Math.min(overnightPreviewMinutes, row.endDate === tomorrow ? row.endMinute : overnightPreviewMinutes) : 0)
      : row.endMinute,
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
  }).filter(row => row.end > row.start).map(row => {
    // At the end of the day, keep the minimum size inside the visible interval.
    // Only an actual continuation can extend below midnight.
    const bottom = Math.max(row.end, Math.min(timelineDayMinutes, row.start + minimumVisibleMinutes));
    return { ...row, top: Math.max(0, Math.min(row.start, bottom - minimumVisibleMinutes)), bottom };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.start - b.start || b.end - a.end || a.row.id.localeCompare(b.row.id));
  return assignTimelineLanes(rows);
}

function assignTimelineLanes<T extends { top: number; bottom: number }>(rows: readonly T[]) {
  type Lane = T & { lane: number; lanes: number };
  const groups: Lane[][] = [];
  let group: Lane[] = []; let groupEnd = -1; let laneCount = 0;
  const active = minimumHeap<{ end: number; lane: number }>((a, b) => a.end - b.end || a.lane - b.lane);
  const free = minimumHeap<number>((a, b) => a - b);
  const finish = () => {
    if (group.length) {
      for (const row of group) row.lanes = laneCount;
      groups.push(group);
    }
    group = []; laneCount = 0; groupEnd = -1; active.clear(); free.clear();
  };
  for (const row of rows) {
    if (row.top >= groupEnd) finish();
    while (active.peek()?.end <= row.top) free.push(active.pop()!.lane);
    const lane = free.pop() ?? laneCount++;
    active.push({ end: row.bottom, lane });
    group.push({ ...row, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, row.bottom);
  }
  finish();
  return groups;
}

export function timelineEvents(events: readonly CalendarOccurrence[], date: LocalDate, minimumVisibleMinutes = 0) {
  return timelineGroups(events, date, minimumVisibleMinutes).flat();
}
export type TimelineEntry = ReturnType<typeof timelineEvents>[number];
type TimelineHead = { top: number; entries: TimelineEntry[] };
export type TimelineLabel = { minutes: number; lines: 1 | 2; clock: boolean };
type CompactTimelineOptions = {
  minimumLabel: number; gap: number;
  railBottom(item: TimelineEntry): number;
  label(item: TimelineEntry, available: number): TimelineLabel;
};
type CompactTimelineBlock =
  | { kind: 'columns'; cards: (TimelineHead & { bottom: number; lane: number; lanes: number })[] }
  | { kind: 'stacked'; cards: (TimelineHead & { size: TimelineLabel })[] };

/** Keep nearby titles beside their own rails. A long rail may span several independent title groups. */
export function compactTimelineLayout(group: readonly TimelineEntry[], before: number, options: CompactTimelineOptions): CompactTimelineBlock[] {
  const ordered = [...group].sort((a, b) => a.start - b.start || a.end - b.end || a.row.id.localeCompare(b.row.id));
  let coveredThrough = -1;
  const separated = ordered.some((item, index) => {
    if (index > 0 && item.start >= coveredThrough) return true;
    coveredThrough = Math.max(coveredThrough, item.end);
    return false;
  });
  if (group.length === 1 || separated) return [{ kind: 'columns', cards: group.map(item => ({ ...item, entries: [item] })) }];

  const { minimumLabel, gap } = options;
  const runs: TimelineHead[][] = [];
  for (const entry of ordered) {
    let heads = runs.at(-1);
    const previous = heads?.at(-1);
    if (!heads || !previous || entry.top >= previous.top + minimumLabel + gap) {
      heads = [];
      runs.push(heads);
    }
    const last = heads.at(-1), thirdBack = heads.at(-3);
    if (last && thirdBack && thirdBack.top + minimumLabel + gap > entry.top) last.entries.push(entry);
    else heads.push({ top: last ? Math.max(entry.top, last.top + minimumLabel + gap) : entry.top, entries: [entry] });
  }

  const blocks: CompactTimelineBlock[] = [];
  for (let index = 0; index < runs.length; index++) {
    const heads = runs[index];
    const boundary = runs[index + 1]?.[0].top ?? before;
    const [item] = heads[0].entries;
    // A rail from an earlier appointment can pass alongside a full card.
    if (heads.length === 1 && item.bottom <= boundary) {
      blocks.push({ kind: 'columns', cards: [{ entries: [item], top: item.top, bottom: item.bottom, lane: 0, lanes: 1 }] });
      continue;
    }
    const stacked = stackTimelineHeads(heads, boundary, options);
    if (stacked) {
      blocks.push({ kind: 'stacked', cards: stacked });
      continue;
    }

    // Full-height side-by-side cards also occupy any following titles under them.
    const columns = [];
    let bottom = -1;
    let nextHeads: TimelineHead[] | undefined = heads;
    while (nextHeads) {
      for (const { entries } of nextHeads) {
        const [item] = entries;
        columns.push({ entries, top: item.top, bottom: item.bottom });
        bottom = Math.max(bottom, item.bottom);
      }
      const following = runs[index + 1];
      nextHeads = following && following[0].top < bottom ? following : undefined;
      if (nextHeads) index++;
    }
    columns.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    blocks.push({ kind: 'columns', cards: assignTimelineLanes(columns).flat() });
  }
  return blocks;
}

function stackTimelineHeads(heads: readonly TimelineHead[], before: number, { minimumLabel, gap, railBottom, label }: CompactTimelineOptions) {
  // Set the latest start that still leaves the next title on its own rail.
  // Add the optional clock line only with space left after reserving those starts.
  const latestStarts: number[] = [];
  let limit = before;
  for (let index = heads.length - 1; index >= 0; index--) {
    const item = heads[index].entries[0];
    const latest = Math.min(railBottom(item), limit) - minimumLabel;
    if (latest + 1e-6 < item.top) return null;
    latestStarts[index] = latest;
    limit = latest - gap;
  }
  let nextTop = 0;
  return heads.map(({ entries }, index) => {
    const item = entries[0];
    const top = Math.max(item.top, nextTop);
    const end = Math.min(railBottom(item), index + 1 < heads.length ? latestStarts[index + 1] - gap : before);
    const size = label(item, end - top);
    nextTop = top + size.minutes + gap;
    return { entries, top, size };
  });
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
