import { addDays, daysBetween, monthDates, parseLocalDate, weekdayOf } from '../scheduling/local-date.ts';
import type { LocalDate } from '../shared/types.ts';

export type CustomRecurrence =
  | { unit: 'day'; interval: number }
  | { unit: 'year'; interval: number }
  | { unit: 'week'; interval: number; weekdays: number[] }
  | { unit: 'month'; interval: number; on: 'date' }
  | { unit: 'month'; interval: number; on: 'weekday'; ordinal: -1 | 1 | 2 | 3 | 4 | 5; weekday: number };
export const RECURRENCE_UNITS = { day: '日', week: '週', month: '月', year: '年' } as const;
export const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'] as const;
/** Calendar rules use Sunday=0; the planner's holiday settings use Sunday=7. */
export const calendarWeekday = (date: LocalDate) => weekdayOf(date) % 7;

export function defaultCustomRecurrence(date: LocalDate, unit: CustomRecurrence['unit'] = 'week', interval = 1): CustomRecurrence {
  return unit === 'week' ? { unit, interval, weekdays: [calendarWeekday(date)] } : unit === 'month' ? { unit, interval, on: 'date' } : { unit, interval };
}
export function validateCustomRecurrence(input: unknown): CustomRecurrence {
  const rule = input as CustomRecurrence;
  if (!rule || typeof rule !== 'object' || !Object.hasOwn(RECURRENCE_UNITS, rule.unit)
    || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 999) throw new Error('繰り返しの間隔を1〜999で設定してください。');
  const weekday = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
  if (rule.unit === 'week') {
    if (!Array.isArray(rule.weekdays) || rule.weekdays.length < 1 || rule.weekdays.length > 7 || !rule.weekdays.every(weekday)) throw new Error('繰り返す曜日を1つ以上選んでください。');
    return { unit: rule.unit, interval: rule.interval, weekdays: [...new Set(rule.weekdays)].sort((a, b) => a - b) };
  }
  if (rule.unit === 'month') {
    if (rule.on === 'date') return { unit: rule.unit, interval: rule.interval, on: rule.on };
    if (rule.on !== 'weekday' || ![-1, 1, 2, 3, 4, 5].includes(rule.ordinal) || !weekday(rule.weekday)) throw new Error('毎月の週と曜日を選んでください。');
    return { unit: rule.unit, interval: rule.interval, on: rule.on, ordinal: rule.ordinal, weekday: rule.weekday };
  }
  return { unit: rule.unit, interval: rule.interval };
}

/** Enumerate only the requested window, including series created many years ago. */
export function customRecurrenceDates(rule: CustomRecurrence, start: LocalDate, from: LocalDate, through: LocalDate): LocalDate[] {
  rule = validateCustomRecurrence(rule); parseLocalDate(start); parseLocalDate(from); parseLocalDate(through);
  if (from > through || daysBetween(from, through) > 736) throw new Error('繰り返しの表示期間を狭めてください。');
  const keep = (day: LocalDate) => day >= start && day >= from && day <= through;
  if (rule.unit === 'day') {
    const first = addDays(start, Math.max(0, Math.ceil(daysBetween(start, from) / rule.interval)) * rule.interval);
    return Array.from({ length: Math.max(0, Math.floor(daysBetween(first, through) / rule.interval) + 1) }, (_, i) => addDays(first, i * rule.interval)).filter(keep);
  }
  if (rule.unit === 'week') {
    const sunday = addDays(start, -calendarWeekday(start)); const step = rule.interval * 7;
    const first = Math.max(0, Math.floor(daysBetween(sunday, from) / step)); const result: LocalDate[] = [];
    for (let n = first; addDays(sunday, n * step) <= through; n++) for (const day of rule.weekdays) {
      const date = addDays(sunday, n * step + day); if (keep(date)) result.push(date);
    }
    return result;
  }
  const base = parseLocalDate(start); const begin = parseLocalDate(from); const end = parseLocalDate(through);
  const baseMonth = base.getUTCFullYear() * 12 + base.getUTCMonth(); const fromMonth = begin.getUTCFullYear() * 12 + begin.getUTCMonth(); const lastMonth = end.getUTCFullYear() * 12 + end.getUTCMonth();
  const step = rule.interval * (rule.unit === 'year' ? 12 : 1); const result: LocalDate[] = [];
  for (let index = baseMonth + Math.max(0, Math.ceil((fromMonth - baseMonth) / step)) * step; index <= lastMonth; index += step) {
    const dates = monthDates(Math.floor(index / 12), index % 12); let date: LocalDate | undefined;
    if (rule.unit === 'month' && rule.on === 'weekday') {
      const position = rule.ordinal === -1 ? dates.length - 1 - (weekdayOf(dates.at(-1)!) - rule.weekday + 7) % 7
        : (rule.weekday - weekdayOf(dates[0]) + 7) % 7 + (rule.ordinal - 1) * 7;
      date = dates[position];
    } else date = dates[base.getUTCDate() - 1];
    if (date && keep(date)) result.push(date);
  }
  return result;
}
export function customRecurrenceLabel(rule: CustomRecurrence, start: LocalDate): string {
  const count = rule.interval; const day = parseLocalDate(start);
  if (rule.unit === 'day') return count === 1 ? '毎日' : `${count}日ごと`;
  if (rule.unit === 'week') return `${count === 1 ? '毎週' : `${count}週間ごと`}（${rule.weekdays.map(n => WEEKDAY_NAMES[n]).join('・')}）`;
  if (rule.unit === 'year') return `${count === 1 ? '毎年' : `${count}年ごと`}（${day.getUTCMonth() + 1}月${day.getUTCDate()}日）`;
  const when = rule.on === 'date' ? `${day.getUTCDate()}日` : `${rule.ordinal === -1 ? '最後の' : `第${rule.ordinal}`}${WEEKDAY_NAMES[rule.weekday]}曜`;
  return `${count === 1 ? '毎月' : `${count}か月ごと`}（${when}）`;
}
