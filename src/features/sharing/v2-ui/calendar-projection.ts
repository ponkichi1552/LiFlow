import { addDays, monthDates, parseLocalDate, weekdayOf } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { V2GroupScreenModel } from '../v2/controller.ts';
import type { V2PersonalPlan } from '../v2/personal-plan.ts';
import { compareDateOccurrence } from '../../../domain/scheduling/date-tasks.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { createV2RoundVisibility } from './round-visibility.ts';

export function v2CalendarMonth(day: LocalDate, offset = 0) {
  if (!Number.isSafeInteger(offset)) throw new RangeError('表示する月の移動量を確認してください。');
  const first = parseLocalDate(day); first.setUTCDate(1); first.setUTCMonth(first.getUTCMonth() + offset);
  const month = first.toISOString().slice(0, 10) as LocalDate; parseLocalDate(month);
  const dates = monthDates(first.getUTCFullYear(), first.getUTCMonth()); const start = addDays(month, -(weekdayOf(month) % 7));
  const cells = Array.from({ length: Math.ceil(((weekdayOf(month) % 7) + dates.length) / 7) * 7 }, (_, index) => addDays(start, index));
  cells.forEach(parseLocalDate);
  return { month, cells, from: cells[0], through: cells.at(-1)!, year: first.getUTCFullYear(), monthNumber: first.getUTCMonth() + 1 };
}

/** Local display only. Personal recommendations never change the common plan or another member's date. */
export function v2CalendarProjection(model: V2GroupScreenModel, personal?: V2PersonalPlan, completionValues?: ReadonlyMap<string, boolean>) {
  if (personal && (personal.viewerUserId !== model.viewerUserId || personal.groupId !== model.plan.groupId || personal.commonPlanHash !== model.plan.planHash)) {
    throw new Error('本人と現在の共有予定に対応する推奨を取得してください。');
  }
  const recommendations = new Map(personal?.recommendations.map((entry) => [entry.subjectOccurrenceId, entry]) ?? []);
  const visibility = createV2RoundVisibility(model);
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId) && (subject.required || subject.completed || subject.pendingCompletionIds.length > 0)).map((subject) => {
    const visible = visibility(round, subject);
    const candidate = recommendations.get(subject.id); const recommendation = candidate && visible.owns ? candidate : undefined;
    const completion = visible.relatedWork.find(record => record.active && record.outcome === 'completed' && record.acceptance === 'accepted');
    return { id: subject.id, round, subject, recommendation, date: recommendation?.date ?? subject.suggestedDate,
      completedDate: completion ? sharedLocalDate(new Date(completion.performedAt), model.plan.timeZone) : undefined,
      windowStart: completion?.schedule?.windowStart ?? subject.executionWindowStart, windowEnd: completion?.schedule?.windowEnd ?? subject.executionWindowEnd,
      counted: visible.showStatus && subject.required && !(completionValues?.get(`shared:${subject.id}`) ?? subject.completed) };
  }));
  const byDate = new Map<LocalDate, typeof entries>(); const counts = new Map<LocalDate, number>();
  for (const entry of entries) {
    const from = entry.windowStart > model.plan.range.from ? entry.windowStart : model.plan.range.from;
    const through = entry.windowEnd < model.plan.range.through ? entry.windowEnd : model.plan.range.through;
    for (let date = from; date <= through; date = addDays(date, 1)) {
      const list = byDate.get(date) ?? []; list.push(entry); byDate.set(date, list);
    }
    if (entry.completedDate && entry.completedDate >= model.plan.range.from && entry.completedDate <= model.plan.range.through
      && (entry.completedDate < from || entry.completedDate > through)) {
      const list = byDate.get(entry.completedDate) ?? []; list.push(entry); byDate.set(entry.completedDate, list);
    }
  }
  for (const [date, list] of byDate) {
    const selected = new Map<string, typeof entries[number]>();
    const choice = (entry: typeof entries[number]) => ({ id: entry.id, suggestedDate: entry.date,
      completed: completionValues?.get(`shared:${entry.id}`) ?? entry.subject.completed,
      completedOnDate: entry.completedDate === date, inWindow: entry.windowStart <= date && date <= entry.windowEnd });
    for (const entry of list) {
      const key = JSON.stringify([entry.round.choreId, entry.subject.subjectUserId]); const previous = selected.get(key);
      if (!previous || compareDateOccurrence(choice(entry), choice(previous), date) < 0) selected.set(key, entry);
    }
    const rows = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id)); byDate.set(date, rows);
    counts.set(date, rows.filter(entry => entry.counted).length);
  }
  return { byDate, counts };
}
