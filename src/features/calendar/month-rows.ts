import { addDays } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';

export interface CalendarMonthRow {
  id: string; month: LocalDate; days: readonly (LocalDate | null)[];
  monthStartColumn: number | null; height: number; offset: number;
}
export const MONTH_HEADING_HEIGHT = 38;

type RowGeometry = Omit<CalendarMonthRow, 'height' | 'offset'>;
const geometry = new WeakMap<readonly LocalDate[], readonly RowGeometry[]>();

/** A boundary week becomes two partial rows, with the new month at its actual weekday column. */
export function calendarMonthRows(weeks: readonly LocalDate[], rowHeight: number): CalendarMonthRow[] {
  let shape = geometry.get(weeks);
  if (!shape) {
    const rows: RowGeometry[] = [];
    for (const start of weeks) {
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      const months = [...new Set(days.map(day => `${day.slice(0, 7)}-01` as LocalDate))];
      for (const month of months) {
        const cells = days.map(day => day.slice(0, 7) === month.slice(0, 7) ? day : null);
        const first = cells.indexOf(month); const monthStartColumn = first >= 0 ? first : null;
        rows.push({ id: `${start}:${month}`, month, days: cells, monthStartColumn });
      }
    }
    shape = rows; geometry.set(weeks, rows);
  }
  let offset = 0;
  return shape.map(row => {
    const height = rowHeight + (row.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT);
    const result = { ...row, days: [...row.days], height, offset }; offset += height; return result;
  });
}
export function calendarRowForDate(rows: readonly CalendarMonthRow[], date: LocalDate) {
  return rows.findIndex(row => row.days.includes(date));
}
