import moment from 'moment-timezone';
import type { LocalDate } from '../shared/types.ts';

/** Use the bundled tzdb for both directions of a calendar clock conversion. */
export function pinnedClockAt(value: Date | number, timeZone: string): { date: LocalDate; minute: number } {
  const at = typeof value === 'number' ? value : value.getTime();
  const zone = moment.tz.zone(timeZone);
  if (!zone || !Number.isFinite(at)) throw new Error('予定の日時・タイムゾーンを確認してください。');
  const clock = new Date(at - zone.utcOffset(at) * 60_000);
  return { date: clock.toISOString().slice(0, 10) as LocalDate, minute: clock.getUTCHours() * 60 + clock.getUTCMinutes() };
}
