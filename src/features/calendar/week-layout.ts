import { addDays } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { weekStart } from './layout.ts';

export function calendarWeekDays(date: LocalDate): LocalDate[] {
  const start = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
export function calendarWeekLabel(date: LocalDate) {
  const days = calendarWeekDays(date), from = days[0], through = days[6];
  const label = (day: LocalDate, year = false) => `${year ? `${Number(day.slice(0, 4))}年` : ''}${Number(day.slice(5, 7))}月${Number(day.slice(-2))}日`;
  return `${label(from, from.slice(0, 4) !== through.slice(0, 4))}〜${from.slice(0, 7) === through.slice(0, 7) ? `${Number(through.slice(-2))}日` : label(through, from.slice(0, 4) !== through.slice(0, 4))}`;
}
