import type { LocalDate } from '../shared/types';
import { addDays, daysBetween, parseLocalDate } from '../scheduling/local-date.ts';
import { pinnedClockAt } from '../scheduling/zoned-clock.ts';
import { v2WallTimeCandidates } from '../../features/sharing/v2/local-time.ts';

/** Explicit calendar input, distinct from an automatically allocated work slot. */
export interface ChoreCalendarTiming {
  allDay: boolean; endDayOffset: number; startMinute: number; endMinute: number; timeZone: string;
}
export function checkedChoreCalendarTiming(value: ChoreCalendarTiming): ChoreCalendarTiming {
  if (!value || typeof value.allDay !== 'boolean' || !Number.isSafeInteger(value.endDayOffset) || value.endDayOffset < 0 || value.endDayOffset > 14
    || ![value.startMinute, value.endMinute].every(n => Number.isInteger(n) && n >= 0 && n < 1440)
    || typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 100) throw new Error('開始・終了を確認してください。期間は14日以内で指定できます。');
  pinnedClockAt(0, value.timeZone);
  if (!value.allDay && value.endDayOffset * 1440 + value.endMinute <= value.startMinute) throw new Error('終了は開始より後にしてください。');
  return { allDay: value.allDay, endDayOffset: value.endDayOffset, startMinute: value.startMinute, endMinute: value.endMinute, timeZone: value.timeZone };
}
export function choreCalendarTiming(value: { startDate: LocalDate; endDate: LocalDate; allDay: boolean; startMinute: number; endMinute: number; timeZone: string }): ChoreCalendarTiming {
  parseLocalDate(value.startDate); parseLocalDate(value.endDate);
  return checkedChoreCalendarTiming({ allDay: value.allDay, endDayOffset: daysBetween(value.startDate, value.endDate), startMinute: value.startMinute, endMinute: value.endMinute, timeZone: value.timeZone });
}
export function choreCalendarSpan(date: LocalDate, source: ChoreCalendarTiming) {
  parseLocalDate(date); const timing = checkedChoreCalendarTiming(source);
  const at = (day: LocalDate, minute: number) => {
    const candidates = v2WallTimeCandidates({ date: day, hour: Math.floor(minute / 60), minute: minute % 60, timeZone: timing.timeZone });
    if (candidates.length !== 1) throw new Error('夏時間で存在しない、または重複する時刻です。別の時刻を選んでください。');
    return candidates[0];
  };
  return { start: at(date, timing.allDay ? 0 : timing.startMinute), end: at(addDays(date, timing.endDayOffset + Number(timing.allDay)), timing.allDay ? 0 : timing.endMinute) };
}
export function calendarChorePlacement(id: string, date: LocalDate, source: ChoreCalendarTiming, allowMissingTime = false) {
  const timing = checkedChoreCalendarTiming(source); const through = addDays(date, timing.endDayOffset);
  let slot: { start: number; end: number } | null = null; let calendarTimeIssue: true | undefined;
  if (!timing.allDay) {
    try { slot = choreCalendarSpan(date, timing); }
    catch (cause) { if (!allowMissingTime) throw cause; calendarTimeIssue = true; }
  }
  return { id, originalBaseDate: date, placedBaseDate: date, recommendedDate: date,
    basicWindow: { from: date, through }, displayedWindow: { from: date, through },
    slot, fallback: Boolean(calendarTimeIssue), manualDate: date,
    ...(!timing.allDay ? { manualTime: true as const } : {}), ...(calendarTimeIssue ? { calendarTimeIssue } : {}) };
}
