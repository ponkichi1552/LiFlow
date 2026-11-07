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
export function v2CalendarProjection(model: V2GroupScreenModel, personal?: V2PersonalPlan, completionValues?: ReadonlyMap<string, boolean>, recommendedOnly = false,
  displayRange: { from: LocalDate; through: LocalDate } = model.plan.range) {
  if (personal && (personal.viewerUserId !== model.viewerUserId || personal.groupId !== model.plan.groupId || personal.commonPlanHash !== model.plan.planHash)) {
    throw new Error('本人と現在の共有予定に対応する推奨を取得してください。');
  }
  parseLocalDate(displayRange.from); parseLocalDate(displayRange.through);
  if (displayRange.from > displayRange.through) throw new Error('表示する日付の範囲を確認してください。');
  const fromDate = displayRange.from > model.plan.range.from ? displayRange.from : model.plan.range.from;
  const throughDate = displayRange.through < model.plan.range.through ? displayRange.through : model.plan.range.through;
  const recommendations = new Map(personal?.recommendations.map((entry) => [entry.subjectOccurrenceId, entry]) ?? []);
  const visibility = createV2RoundVisibility(model);
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId) && (subject.required || subject.completed || subject.pendingCompletionIds.length > 0)).map((subject) => {
    const visible = visibility(round, subject);
    const candidate = recommendations.get(subject.id); const recommendation = candidate && visible.owns ? candidate : undefined;
    const override = completionValues?.get(`shared:${subject.id}`);
    const completed = visible.showStatus && (override ?? subject.completed);
    const pendingUndo = visible.showStatus && subject.completed && override === false && recommendation?.state === 'completed';
    const completion = completed || pendingUndo ? visible.relatedWork.find(record => record.active && record.outcome === 'completed' && record.acceptance === 'accepted') : undefined;
    const observedCompletionDate = completion ? sharedLocalDate(new Date(completion.performedAt), model.plan.timeZone) : subject.retainedCompletion?.completedDate;
    return { id: subject.id, round, subject, recommendation, completed, date: recommendation?.date ?? subject.suggestedDate,
      completedDate: completed ? observedCompletionDate : undefined,
      // Completed subjects temporarily carry their common suggestion instead of
      // a personal recommendation. Keep the clicked day until the undo and its
      // recommendation are read together, without treating the row as completed.
      pendingUndoDate: pendingUndo ? observedCompletionDate : undefined,
      windowStart: completion?.schedule?.windowStart ?? subject.executionWindowStart, windowEnd: completion?.schedule?.windowEnd ?? subject.executionWindowEnd,
      counted: visible.showStatus && subject.required && !completed };
  }));
  const byDate = new Map<LocalDate, typeof entries>(); const counts = new Map<LocalDate, number>();
  for (const entry of entries) {
    const dates: LocalDate[] = [];
    if (recommendedOnly) dates.push(entry.pendingUndoDate ?? entry.completedDate ?? entry.date);
    else {
      const from = entry.windowStart > fromDate ? entry.windowStart : fromDate;
      const through = entry.windowEnd < throughDate ? entry.windowEnd : throughDate;
      for (let date = from; date <= through; date = addDays(date, 1)) dates.push(date);
      if (entry.completedDate && !dates.includes(entry.completedDate)) dates.push(entry.completedDate);
      if (entry.pendingUndoDate && !dates.includes(entry.pendingUndoDate)) dates.push(entry.pendingUndoDate);
    }
    for (const date of dates) if (date >= fromDate && date <= throughDate) {
      const list = byDate.get(date) ?? []; list.push(entry); byDate.set(date, list);
    }
  }
  // Hermes constructs a native collator for localeCompare. Reuse one only for
  // this synchronous projection, so the next invocation still uses its locale.
  let compareIds: Intl.Collator['compare'] | undefined;
  for (const [date, list] of byDate) {
    const selected = new Map<string, typeof entries[number]>();
    const choice = (entry: typeof entries[number]) => ({ id: entry.id, suggestedDate: entry.date,
      completed: entry.completed,
      completedOnDate: entry.completedDate === date || entry.pendingUndoDate === date,
      inWindow: entry.windowStart <= date && date <= entry.windowEnd });
    for (const entry of list) {
      const key = JSON.stringify([entry.round.choreId, entry.subject.subjectUserId]); const previous = selected.get(key);
      if (!previous || compareDateOccurrence(choice(entry), choice(previous), date) < 0) selected.set(key, entry);
    }
    const rows = [...selected.values()].sort((a, b) => (compareIds ??= new Intl.Collator().compare)(a.id, b.id)); byDate.set(date, rows);
    counts.set(date, rows.filter(entry => entry.counted).length);
  }
  return { byDate, counts };
}
