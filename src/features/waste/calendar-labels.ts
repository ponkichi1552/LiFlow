import type { LocalDate } from '@/domain/shared/types';
import type { WeeklyWasteSchedule } from './contracts';
import { generateWasteCollectionDates } from './weekly-scheduler.ts';

/** Weekly labels belong to weekday headers; less frequent labels belong to individual dates. */
export function wasteCalendarLabels(
  schedules: readonly WeeklyWasteSchedule[], from: LocalDate, through: LocalDate,
  hiddenOccurrenceKeys: readonly string[] = [],
) {
  const weeklyByColumn: string[][] = Array.from({ length: 7 }, () => []);
  const byDate = new Map<LocalDate, string[]>();
  const hiddenWeeklyByDate = new Map<LocalDate, string[]>();
  const hidden = new Set(hiddenOccurrenceKeys);
  for (const schedule of schedules) {
    if ((schedule.recurrence ?? 'weekly') === 'weekly') {
      for (const day of schedule.collectionWeekdays) {
        const labels = weeklyByColumn[day % 7];
        if (labels && !labels.includes(schedule.label)) labels.push(schedule.label);
      }
      for (const occurrence of hidden.size ? generateWasteCollectionDates(schedule, from, through) : []) {
        if (!hidden.has(`${schedule.id}:${occurrence.date}`)) continue;
        const labels = hiddenWeeklyByDate.get(occurrence.date) ?? [];
        if (!labels.includes(schedule.label)) labels.push(schedule.label);
        hiddenWeeklyByDate.set(occurrence.date, labels);
      }
    } else {
      for (const occurrence of generateWasteCollectionDates(schedule, from, through)) {
        if (hidden.has(`${schedule.id}:${occurrence.date}`)) continue;
        const labels = byDate.get(occurrence.date) ?? [];
        if (!labels.includes(schedule.label)) labels.push(schedule.label);
        byDate.set(occurrence.date, labels);
      }
    }
  }
  return { weeklyByColumn, byDate, hiddenWeeklyByDate };
}
