import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '@/domain/shared/types';
import type { WasteCollectionOccurrence, WeeklyWasteSchedule } from '@/features/waste/contracts';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function generateWasteCollectionDates(
  schedule: WeeklyWasteSchedule,
  from: LocalDate,
  through: LocalDate,
): WasteCollectionOccurrence[] {
  const start = parseLocalDate(from);
  const end = parseLocalDate(through);

  if (start.getTime() > end.getTime()) {
    throw new RangeError('from must be on or before through');
  }

  const recurrence = schedule.recurrence ?? 'weekly';
  const anchor = schedule.anchorDate ? parseLocalDate(schedule.anchorDate).getTime() : null;
  const occurrences: WasteCollectionOccurrence[] = [];
  const add = (timestamp: number) => {
    if (timestamp >= start.getTime() && timestamp <= end.getTime()) occurrences.push({
        scheduleId: schedule.id,
        householdId: schedule.householdId,
        label: schedule.label,
        date: new Date(timestamp).toISOString().slice(0, 10) as LocalDate,
      });
  };
  if (recurrence === 'weekly') {
    const firstWeekday = start.getUTCDay() || 7;
    for (const weekday of new Set(schedule.collectionWeekdays)) {
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
      const first = start.getTime() + ((weekday - firstWeekday + 7) % 7) * DAY_IN_MILLISECONDS;
      for (let timestamp = first; timestamp <= end.getTime(); timestamp += 7 * DAY_IN_MILLISECONDS) add(timestamp);
    }
    occurrences.sort((a, b) => a.date.localeCompare(b.date));
  } else if (recurrence === 'biweekly' && anchor !== null) {
    const step = 14 * DAY_IN_MILLISECONDS;
    const first = anchor + Math.max(0, Math.ceil((start.getTime() - anchor) / step)) * step;
    for (let timestamp = first; timestamp <= end.getTime(); timestamp += step) add(timestamp);
  } else if (recurrence === 'monthly' && Number.isInteger(schedule.monthlyDay) && schedule.monthlyDay! >= 1 && schedule.monthlyDay! <= 31) {
    let year = start.getUTCFullYear(); let month = start.getUTCMonth();
    while (Date.UTC(year, month, 1) <= end.getTime()) {
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const timestamp = Date.UTC(year, month, Math.min(schedule.monthlyDay!, lastDay));
      if (anchor === null || timestamp >= anchor) add(timestamp);
      month++; if (month === 12) { year++; month = 0; }
    }
  }

  return occurrences;
}

/** Compatibility for older callers; all modes use the same calculation. */
export const generateWeeklyCollectionDates = generateWasteCollectionDates;
