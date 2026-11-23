import { useMemo } from 'react';
import { CalendarDayPicker } from '../../components/calendar-day-picker';
import { weekdayOf } from '../../domain/scheduling/local-date';
import type { LocalDate, Weekday } from '../../domain/shared/types';

export function HolidayCalendar({ today, restDays, days, selectedDate, onSelect }: {
  today: LocalDate; restDays: readonly Weekday[]; days: readonly { date: LocalDate; holiday?: boolean }[];
  selectedDate: LocalDate | null; onSelect(date: LocalDate): void;
}) {
  const overrides = useMemo(() => new Map(days.map(day => [day.date, day.holiday])), [days]);
  const isHoliday = (date: LocalDate) => overrides.get(date) ?? restDays.includes(weekdayOf(date));
  return <CalendarDayPicker today={today} label="日別設定のカレンダー" selected={date => date === selectedDate} marked={isHoliday}
    describe={date => `${date.replaceAll('-', '/')} ${isHoliday(date) ? '休日' : '休日以外'}`} onSelect={onSelect} />;
}
