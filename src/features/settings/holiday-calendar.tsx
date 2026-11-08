import { useMemo } from 'react';
import { CalendarDayPicker } from '../../components/calendar-day-picker';
import { weekdayOf } from '../../domain/scheduling/local-date';
import type { LocalDate, Weekday } from '../../domain/shared/types';

/** Date exceptions change the effective holiday without changing the weekly rhythm. */
export function HolidayCalendar({ today, restDays, days, onToggle }: {
  today: LocalDate; restDays: readonly Weekday[]; days: readonly { date: LocalDate; holiday?: boolean }[]; onToggle(date: LocalDate): void;
}) {
  const overrides = useMemo(() => new Map(days.map(day => [day.date, day.holiday])), [days]);
  return <CalendarDayPicker today={today} label="休日カレンダー" selected={date => overrides.get(date) ?? restDays.includes(weekdayOf(date))}
    describe={(date, holiday) => `${date.replaceAll('-', '/')} ${holiday ? '休日' : '平日'}`}
    selectionHint={holiday => holiday ? 'タップで平日に変更' : 'タップで休日に変更'} onSelect={onToggle} caption="日付をタップして休日を切り替え" />;
}
