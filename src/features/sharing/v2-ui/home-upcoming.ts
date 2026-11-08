import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types';
import type { LoadOrder } from '../../../domain/scheduling/task-priority';
import { orderTaskRows } from '../../../domain/scheduling/task-row-order.ts';
import type { V2GroupScreenModel } from '../v2/controller';
import type { v2CalendarProjection } from './calendar-projection';
import { privateOverlayForViewer, type V2PrivateOverlayState, type V2PrivateTaskRow } from './private-overlay.ts';
import { createV2RoundVisibility } from './round-visibility.ts';
import { dateTaskOccurrenceReference } from '../../../domain/scheduling/date-task-reference.ts';

type Projection = ReturnType<typeof v2CalendarProjection>;
type SharedRow = NonNullable<ReturnType<Projection['byDate']['get']>>[number];
export type V2HomeUpcomingRow = ({ source: 'shared'; key: string } & SharedRow) | { source: 'personal'; key: string; row: V2PrivateTaskRow };

/** Reuse the calendar projection but show each occurrence only on its recommendation. */
export function v2HomeUpcomingRows(model: V2GroupScreenModel, projection: Projection, privateValue: V2PrivateOverlayState | undefined,
  range: { from: LocalDate; through: LocalDate }, order: LoadOrder, values?: ReadonlyMap<string, boolean>) {
  const overlay = privateOverlayForViewer(privateValue, model.viewerUserId);
  const chores = new Map(model.plan.chores.map(chore => [chore.id, chore])); const visible = createV2RoundVisibility(model);
  const homeSharedIds = new Set((projection.byDate.get(model.plan.range.asOfDate) ?? [])
    .filter(row => row.subject.automaticBacklog !== 'later').map(row => row.subject.id));
  const homePrivateIds = new Set(overlay?.status === 'ready' ? overlay.home.flatMap(row => {
    const id = dateTaskOccurrenceReference(row.revision); return id === null ? [] : [id];
  }) : []);
  const groups: { date: LocalDate; rows: V2HomeUpcomingRow[] }[] = [];
  for (let date = range.from; date <= range.through; date = addDays(date, 1)) {
    const rows: V2HomeUpcomingRow[] = [
      ...(projection.byDate.get(date) ?? []).filter(entry => entry.date === date && date > model.plan.range.asOfDate && !homeSharedIds.has(entry.subject.id))
        .map(entry => ({ ...entry, source: 'shared' as const, key: `shared:${entry.subject.id}` })),
      ...(overlay?.status === 'ready' ? overlay.byDate.get(date) ?? [] : []).filter(row => row.suggestedDate === date && overlay?.status === 'ready' && date > overlay.today
        && !homePrivateIds.has(dateTaskOccurrenceReference(row.revision) ?? ''))
        .map(row => ({ source: 'personal' as const, key: row.key, row })),
    ];
    if (rows.length) groups.push({ date, rows: orderTaskRows(rows, model.plan.range.asOfDate, item => item.source === 'personal'
      ? { completed: values?.get(item.key) ?? item.row.completed, load: item.row.chore.load, estimatedMinutes: item.row.chore.estimatedMinutes,
        recommendedDate: item.row.suggestedDate, windowStart: item.row.windowStart, windowEnd: item.row.windowEnd, asOfDate: overlay?.status === 'ready' ? overlay.today : undefined }
      : { completed: visible(item.round, item.subject).showStatus && (values?.get(item.key) ?? item.subject.completed),
        load: chores.get(item.round.choreId)?.load ?? 'light', estimatedMinutes: chores.get(item.round.choreId)?.estimatedMinutes,
        recommendedDate: item.date, windowStart: item.subject.executionWindowStart, windowEnd: item.subject.executionWindowEnd }, order) });
  }
  return groups;
}
