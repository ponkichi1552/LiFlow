import type { LocalDate } from '../shared/types';
import type { PersonalChoreSchedule } from './types';
import { daysBetween, parseLocalDate } from '../scheduling/local-date.ts';
import { checkedChoreCalendarTiming } from './calendar-timing.ts';

export function checkedPersonalSchedule(value: PersonalChoreSchedule): PersonalChoreSchedule {
  if (!value || typeof value !== 'object') throw new Error('開始日を確認してください。');
  parseLocalDate(value.startDate);
  if (value.once !== undefined && value.once !== true || value.once && value.monthlyDay !== undefined) throw new Error('繰り返しの設定を確認してください。');
  if (value.monthlyDay !== undefined && (!Number.isSafeInteger(value.monthlyDay) || value.monthlyDay < 1 || value.monthlyDay > 31)) {
    throw new RangeError('毎月の日付は1〜31日で入力してください。');
  }
  return { startDate: value.startDate, ...(value.once ? { once: true } : {}), ...(value.monthlyDay === undefined ? {} : { monthlyDay: value.monthlyDay }),
    ...(value.calendarTiming ? { calendarTiming: checkedChoreCalendarTiming(value.calendarTiming) } : {}) };
}

function monthDate(index: number, day: number): LocalDate {
  const year = Math.floor(index / 12); const month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const value = new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10) as LocalDate;
  parseLocalDate(value); return value;
}
function monthIndex(date: LocalDate) {
  const parsed = parseLocalDate(date); return parsed.getUTCFullYear() * 12 + parsed.getUTCMonth();
}
/** Include the boundary for a new rule; completion callers pass a strictly later boundary. */
export function monthlyDateOnOrAfter(date: LocalDate, day: number): LocalDate {
  checkedPersonalSchedule({ startDate: date, monthlyDay: day });
  const index = monthIndex(date); const candidate = monthDate(index, day);
  return candidate >= date ? candidate : monthDate(index + 1, day);
}
/** One real calendar interval, including February and leap years. */
export function monthlyIntervalAt(date: LocalDate, day: number): number {
  checkedPersonalSchedule({ startDate: date, monthlyDay: day });
  const index = monthIndex(date); return daysBetween(monthDate(index - 1, day), monthDate(index, day));
}
