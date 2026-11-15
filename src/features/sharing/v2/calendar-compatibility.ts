import type { EventDraft } from '../../../domain/calendar/events';
import { supportsCalendarMonthDates } from './payload-schema.ts';

export const CALENDAR_MONTH_DATES_UPGRADE_MESSAGE = '毎月の複数日付には互換更新が必要です。管理者が「グループ管理」で「共有グループを互換更新」を行ってください。';
export const calendarUsesMonthDates = (value: EventDraft | null | undefined): boolean => value?.recurrence === 'custom'
  && value.customRecurrence?.unit === 'month' && value.customRecurrence.on === 'dates';
export class SharedCalendarMonthDatesCompatibilityError extends Error {
  readonly code = 'sharing/calendar-month-dates-upgrade-required';
  constructor() { super(CALENDAR_MONTH_DATES_UPGRADE_MESSAGE); }
}
/** Authoring cannot silently upgrade a signed group or send an old client an unknown rule. */
export function assertCalendarMonthDatesCompatibility(value: EventDraft | null | undefined, version: string): void {
  if (calendarUsesMonthDates(value) && !supportsCalendarMonthDates(version)) throw new SharedCalendarMonthDatesCompatibilityError();
}
