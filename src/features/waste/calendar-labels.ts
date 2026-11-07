import type { LocalDate } from '@/domain/shared/types';
import type { WeeklyWasteSchedule } from './contracts';
import { generateWasteCollectionDates } from './weekly-scheduler.ts';
import { weekdayOf } from '../../domain/scheduling/local-date.ts';

/** Weekly labels belong to weekday headers; less frequent labels belong to individual dates. */
export function wasteCalendarLabels(
  schedules: readonly WeeklyWasteSchedule[], from: LocalDate, through: LocalDate,
  hiddenOccurrenceKeys: readonly string[] = [],
) {
  const weeklyByColumn: string[][] = Array.from({ length: 7 }, () => []);
  const byDate = new Map<LocalDate, string[]>();
  const hiddenWeeklyByDate = new Map<LocalDate, string[]>();
  const hidden = new Set(hiddenOccurrenceKeys);
  const weeklyCounts = new Map<number, Map<string, number>>();
  const hiddenCounts = new Map<LocalDate, Map<string, number>>();
  for (const schedule of schedules) {
    const label = schedule.label;
    if ((schedule.recurrence ?? 'weekly') === 'weekly') {
      for (const day of new Set(schedule.collectionWeekdays)) {
        const labels = weeklyByColumn[day % 7];
        if (labels && !labels.includes(label)) labels.push(label);
        const counts = weeklyCounts.get(day % 7) ?? new Map<string, number>();
        counts.set(label, (counts.get(label) ?? 0) + 1); weeklyCounts.set(day % 7, counts);
      }
      for (const occurrence of hidden.size ? generateWasteCollectionDates(schedule, from, through) : []) {
        if (!hidden.has(`${schedule.id}:${occurrence.date}`)) continue;
        const labels = hiddenWeeklyByDate.get(occurrence.date) ?? [];
        if (!labels.includes(label)) labels.push(label);
        hiddenWeeklyByDate.set(occurrence.date, labels);
        const counts = hiddenCounts.get(occurrence.date) ?? new Map<string, number>();
        counts.set(label, (counts.get(label) ?? 0) + 1); hiddenCounts.set(occurrence.date, counts);
      }
    } else {
      for (const occurrence of generateWasteCollectionDates(schedule, from, through)) {
        if (hidden.has(`${schedule.id}:${occurrence.date}`)) continue;
        const labels = byDate.get(occurrence.date) ?? [];
        if (!labels.includes(label)) labels.push(label);
        byDate.set(occurrence.date, labels);
      }
    }
  }
  for (const [date, labels] of hiddenWeeklyByDate) {
    const all = weeklyCounts.get(weekdayOf(date) % 7); const counts = hiddenCounts.get(date)!;
    const hiddenLabels = labels.filter(label => counts.get(label) === all?.get(label));
    if (hiddenLabels.length) hiddenWeeklyByDate.set(date, hiddenLabels); else hiddenWeeklyByDate.delete(date);
  }
  return { weeklyByColumn, byDate, hiddenWeeklyByDate };
}
