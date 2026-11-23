import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types';
import type { LoadOrder, TaskPriority } from '../../../domain/scheduling/task-priority';
import type { V2GroupScreenModel } from '../v2/controller';
import type { V2PersonalPlan } from '../v2/personal-plan';
import { homeUpcomingRange, isHomeTaskExpired, type HomeWeekScope } from '../../planner/home-presentation.ts';
import { homeSummary } from '../../planner/home-summary.ts';
import { v2CalendarProjection } from './calendar-projection.ts';
import { v2HomeUpcomingRows, type V2HomeUpcomingRow } from './home-upcoming.ts';
import type { V2PrivateOverlayState } from './private-overlay';
import { createV2RoundVisibility } from './round-visibility.ts';
import { orderTaskRows } from './task-order.ts';

export function buildHomeRows(
  model: V2GroupScreenModel, personal: V2PersonalPlan, privateOverlay: V2PrivateOverlayState | undefined,
  weekScope: HomeWeekScope, order: LoadOrder, completionValues: ReadonlyMap<string, boolean>, expiredExpanded: boolean,
) {
  const recommendations = new Map(personal.recommendations.map(entry => [entry.subjectOccurrenceId, entry]));
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => subject.required && (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId)).map((subject) => ({ round, subject })));
  const range = homeUpcomingRange(model.plan.range.asOfDate, weekScope);
  const allUpcomingDates = { from: addDays(model.plan.range.asOfDate, 1), through: homeUpcomingRange(model.plan.range.asOfDate, 'next').through };
  const projection = v2CalendarProjection(model, personal, completionValues, false, { from: model.plan.range.asOfDate, through: allUpcomingDates.through });
  const today = projection.byDate.get(model.plan.range.asOfDate) ?? [];
  const visibility = createV2RoundVisibility(model);
  const choreById = new Map(model.plan.chores.map(chore => [chore.id, chore]));
  const sharedExpired = entries.filter(({ round, subject }) => {
    if (subject.showExpiredOnHome) return true;
    if (!subject.completed || completionValues.get(`shared:${subject.id}`) !== false) return false;
    const completion = visibility(round, subject).relatedWork.find(record => record.active && record.outcome === 'completed' && record.acceptance === 'accepted');
    return (completion?.schedule?.windowEnd ?? subject.executionWindowEnd) < model.plan.range.asOfDate;
  }).map(item => ({ ...item, source: 'shared' as const, key: `shared:${item.subject.id}` }));
  const candidates = [...(model.waste?.occurrences ?? []).filter(entry => entry.occurrence.date === model.plan.range.asOfDate && entry.hidden !== true)
    .map(entry => ({ source: 'waste' as const, key: `waste:${entry.key}`, entry })),
    ...today.filter(entry => entry.subject.automaticBacklog !== 'later').map((entry) => ({ source: 'shared' as const, key: `shared:${entry.subject.id}`, ...entry })),
    ...(privateOverlay?.status === 'ready' ? privateOverlay.home : []).map((row) => ({ source: 'personal' as const, key: row.key, row }))];
  type HomeTask = (typeof candidates | typeof sharedExpired)[number];
  const priority = (item: HomeTask): TaskPriority & { asOfDate?: LocalDate; estimatedMinutes?: number } => item.source === 'personal'
      ? { completed: completionValues.get(item.key) ?? item.row.completed, load: item.row.chore.load, estimatedMinutes: item.row.chore.estimatedMinutes, recommendedDate: item.row.suggestedDate, windowStart: item.row.windowStart, windowEnd: item.row.windowEnd, asOfDate: privateOverlay?.status === 'ready' ? privateOverlay.today : undefined }
      : item.source === 'shared' ? { completed: visibility(item.round, item.subject).showStatus && (completionValues.get(item.key) ?? item.subject.completed),
        load: choreById.get(item.round.choreId)?.load ?? 'light', estimatedMinutes: choreById.get(item.round.choreId)?.estimatedMinutes, recommendedDate: recommendations.get(item.subject.id)?.date ?? item.subject.suggestedDate, windowStart: item.subject.executionWindowStart, windowEnd: item.subject.executionWindowEnd }
        : { completed: false, load: 'light', recommendedDate: model.plan.range.asOfDate };
  const allHomeRows = orderTaskRows(candidates, model.plan.range.asOfDate, priority, order);
  const privateExpired = allHomeRows.filter(item => item.source === 'personal' && isHomeTaskExpired(completionValues.get(item.key) ?? item.row.completed,
    item.row.windowEnd, privateOverlay?.status === 'ready' ? privateOverlay.today : model.plan.range.asOfDate));
  const expiredKeys = new Set(privateExpired.map(item => item.key));
  const homeRows = allHomeRows.filter(item => !expiredKeys.has(item.key));
  const sharedNames = new Set(homeRows.flatMap(row => row.source === 'shared' ? [choreById.get(row.round.choreId)?.name] : []));
  const duplicateSourceNames = new Set(homeRows.flatMap(row => row.source === 'personal' && sharedNames.has(row.row.chore.name) ? [row.row.chore.name] : []));
  const allUpcoming = v2HomeUpcomingRows(model, projection, privateOverlay, allUpcomingDates, order, completionValues);
  const upcoming = allUpcoming.filter(group => range.from <= group.date && group.date <= range.through);
  const upcomingKnown = model.plan.range.through >= allUpcomingDates.through && privateOverlay?.status !== 'unavailable'
    && (privateOverlay?.status !== 'ready' || privateOverlay.range.through >= allUpcomingDates.through);
  const total = homeRows.filter(item => item.source !== 'waste').length;
  const expired = [...sharedExpired, ...privateExpired];
  const onlyExpired = total === 0 && expired.length > 0;
  const expiredRows = expiredExpanded || onlyExpired ? orderTaskRows(expired, model.plan.range.asOfDate, priority, order) : [];
  type HomeListItem = { kind: 'today' | 'expired'; key: string; item: HomeTask; showSource?: boolean } | { kind: 'upcoming'; key: string; item: V2HomeUpcomingRow }
    | { kind: 'weeks' | 'emptyToday' | 'emptyWeek' | 'expiredHeading'; key: string } | { kind: 'upcomingDate'; key: string; date: LocalDate };
  const listRows: HomeListItem[] = [
    ...homeRows.map(item => {
      const name = item.source === 'personal' ? item.row.chore.name : item.source === 'shared' ? choreById.get(item.round.choreId)?.name : undefined;
      return { kind: 'today' as const, key: `today:${item.key}`, item, showSource: name !== undefined && duplicateSourceNames.has(name) };
    }),
    ...(!homeRows.length && !expired.length ? [{ kind: 'emptyToday' as const, key: 'emptyToday' }] : []),
    ...(expired.length ? [{ kind: 'expiredHeading' as const, key: 'expiredHeading' }] : []),
    ...expiredRows.map(item => ({ item, kind: 'expired' as const, key: `expired:${item.key}` })),
    ...(allUpcoming.length || !upcomingKnown ? [{ kind: 'weeks' as const, key: 'weeks' }] : []),
    ...upcoming.flatMap(({ date, rows }): HomeListItem[] => [{ kind: 'upcomingDate', key: `date:${date}`, date }, ...rows.map(item => ({ kind: 'upcoming' as const, key: `upcoming:${item.key}`, item }))]),
    ...(allUpcoming.length && !upcoming.length && upcomingKnown ? [{ kind: 'emptyWeek' as const, key: 'emptyWeek' }] : []),
  ];
  const done = homeRows.filter(item => item.source === 'personal' ? completionValues.get(item.key) ?? item.row.completed
    : item.source === 'shared' && visibility(item.round, item.subject).showStatus && (completionValues.get(item.key) ?? item.subject.completed)).length;
  const summary = homeSummary(total, done);
  const mixedSources = listRows.some(row => 'item' in row && row.item.source === 'personal')
    && listRows.some(row => 'item' in row && row.item.source === 'shared');
  return { listRows, expiredCount: expired.length, onlyExpired, recommendations, total, done, summary, mixedSources };
}
