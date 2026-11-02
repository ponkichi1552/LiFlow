import { addDays, daysBetween, weekdayOf } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import type { CalendarOccurrence } from './events.ts';

export const weekStart = (date: LocalDate) => addDays(date, -(weekdayOf(date) % 7));
export function weekIndex(anchor: LocalDate, date: LocalDate) { return Math.floor(daysBetween(anchor, weekStart(date)) / 7); }
export function timelineEvents(events: readonly CalendarOccurrence[], date: LocalDate) {
  const rows = events.filter(row => !row.allDay && row.startDate <= date && row.endDate >= date).map(row => ({ row,
    start: row.startDate < date ? 0 : row.startMinute, end: row.endDate > date ? 1440 : row.endMinute, lane: 0, lanes: 1,
  })).filter(row => row.end > row.start).sort((a, b) => a.start - b.start || b.end - a.end || a.row.id.localeCompare(b.row.id));
  let group: typeof rows = []; let groupEnd = -1; let ends: number[] = [];
  const finish = () => { for (const row of group) row.lanes = ends.length; group = []; ends = []; };
  for (const row of rows) {
    if (row.start >= groupEnd) finish();
    let lane = ends.findIndex(end => end <= row.start); if (lane < 0) lane = ends.length;
    ends[lane] = row.end; row.lane = lane; group.push(row); groupEnd = Math.max(groupEnd, row.end);
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
