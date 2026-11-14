import type { LocalDate } from '../../domain/shared/types';

/** Retain the requested monthly day even when the starting month is shorter. */
export function anchorForMonthlyDay(anchor: LocalDate, day: number): LocalDate {
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new RangeError('毎月の日付は1〜31日です。');
  let year = Number(anchor.slice(0, 4)), month = Number(anchor.slice(5, 7));
  while (new Date(Date.UTC(year, month, 0)).getUTCDate() < day) {
    month++; if (month > 12) { month = 1; year++; }
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as LocalDate;
}
