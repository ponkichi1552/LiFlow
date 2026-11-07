import type { V2GroupScreenModel } from '../v2/controller';
import type { V2CompletionRecord } from '../v2/completion-history';
import type { CommonCompletionSource } from '../../planner/common-chore-links';
import { sharedCompletionTimeReviewIds } from '../../planner/shared-completion-evidence.ts';

/** Normalize only this viewer's subject or a common household occurrence, including explicit undo. */
export function v2CommonCompletionSource(model: V2GroupScreenModel): CommonCompletionSource {
  const bySubject = new Map<string, V2CompletionRecord[]>();
  const review = sharedCompletionTimeReviewIds(model.plan);
  for (const record of model.plan.history) {
    if (record.subjectUserId !== null && record.subjectUserId !== model.viewerUserId) continue;
    const rows = bySubject.get(record.subjectOccurrenceId) ?? []; rows.push(record); bySubject.set(record.subjectOccurrenceId, rows);
  }
  return { groupId: model.plan.groupId, chores: model.plan.chores,
    completions: [...bySubject.values()].map(rows => {
      const active = rows.filter(record => record.active && record.outcome === 'completed' && record.acceptance === 'accepted' && !record.approvalConflictIds.length && !review.has(record.operationId));
      const record = [...(active.length ? active : rows)].sort((a, b) => Date.parse(a.performedAt) - Date.parse(b.performedAt) || a.operationId.localeCompare(b.operationId))[0];
      return { id: record.operationId, householdId: 'shared-v2', choreId: record.choreId, scheduleEntryId: record.subjectOccurrenceId,
        completedAt: record.performedAt, outcome: active.length ? 'completed' : 'incomplete', source: 'inApp',
        scheduledDate: record.schedule?.date ?? record.anchorDate, scheduledWindowStart: record.schedule?.windowStart ?? record.anchorDate,
        scheduledWindowEnd: record.schedule?.windowEnd ?? record.anchorDate };
    }) };
}
