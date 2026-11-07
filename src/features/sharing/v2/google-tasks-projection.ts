import { compareOperationIds } from '../operations.ts';
import type { GoogleSyncEntry } from '../../google-sync/contracts';
import type { V2CommonPlan } from './common-plan';
import type { V2PersonalPlan } from './personal-plan';
import type { V2RoundReference } from './actions';
import { sharedDocumentDigest } from '../crypto.ts';
import { v2NativeWorkspaceNamespace } from './native-identity.ts';
import { v2OccurrenceId, v2SubjectOccurrenceId } from './occurrence-id.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger';

export interface V2GoogleTaskTarget extends V2RoundReference {
  ownerUserId: string; groupId: string; occurrenceId: string; subjectOccurrenceId: string;
}
export interface V2GoogleTaskItem extends GoogleSyncEntry {
  target: V2GoogleTaskTarget; localRevision: string; undoCompletionIds: string[];
  completionRevisionRecords: { operationId: string; active: boolean; acceptance: string; outcome: string }[];
  retainedCompletion?: { checkpointId: string; recorderUserIds: string[] };
}
const completionRevision = (records: V2GoogleTaskItem['completionRevisionRecords'], retained?: V2GoogleTaskItem['retainedCompletion']) => {
  const ordered = records.map(row => [row.operationId, row.active, row.acceptance, row.outcome]).sort(([a], [b]) => compareOperationIds(String(a), String(b)));
  const pages: string[] = []; for (let offset = 0; offset < ordered.length; offset += 1000) pages.push(sharedDocumentDigest(ordered.slice(offset, offset + 1000)));
  return sharedDocumentDigest(retained?.recorderUserIds.length ? [pages, retained.checkpointId, [...retained.recorderUserIds].sort()] : pages);
};
/** The normal completion authorizer still validates these drafts before this private metadata can commit. */
export function v2GoogleRevisionAfterImport(item: V2GoogleTaskItem, drafts: readonly SharedOperationDraft[]) {
  const undone = new Set(drafts.filter(row => row.operationType === 'undo').map(row => row.payload.targetOperationId));
  const added = drafts.filter(row => row.operationType === 'complete').map(row => row.operationId);
  const records = [...item.completionRevisionRecords.map(row => ({ ...row, active: row.active && !undone.has(row.operationId) })),
    ...added.map(operationId => ({ operationId, active: true, acceptance: 'accepted', outcome: 'completed' }))];
  const removedRecorders = new Set(drafts.filter(row => row.entityType === 'retainedCompletionUndo' && row.payload.checkpointId === item.retainedCompletion?.checkpointId)
    .flatMap(row => row.payload.recorderUserIds as string[]));
  const retained = item.retainedCompletion && { ...item.retainedCompletion, recorderUserIds: item.retainedCompletion.recorderUserIds.filter(id => !removedRecorders.has(id)) };
  return { revision: completionRevision(records, retained), undoCompletionIds: [...item.undoCompletionIds.filter(id => !undone.has(id)), ...added].sort() };
}
export function validateV2GoogleTaskTarget(value: V2GoogleTaskTarget, ownerUserId: string, groupId: string): V2GoogleTaskTarget {
  if (!value || value.ownerUserId !== ownerUserId || value.groupId !== groupId
    || value.subjectUserId !== null && value.subjectUserId !== ownerUserId || !Number.isSafeInteger(value.ruleVersion) || value.ruleVersion < 1) throw new Error('Google家事の本人・グループ・対象を確認してください。');
  parseLocalDate(value.anchorDate);
  const occurrenceId = v2OccurrenceId(groupId, value.choreId, value.anchorDate);
  if (value.occurrenceId !== occurrenceId || value.subjectOccurrenceId !== v2SubjectOccurrenceId(occurrenceId, value.subjectUserId)) throw new Error('Google家事の家事回を確認してください。');
  return { ownerUserId, groupId, choreId: value.choreId, anchorDate: value.anchorDate, ruleVersion: value.ruleVersion,
    subjectUserId: value.subjectUserId, occurrenceId, subjectOccurrenceId: value.subjectOccurrenceId };
}

/** Google's due is a date only. Formal shared times and common round IDs stay in the signed group state. */
export function v2GoogleTaskItems(plan: V2CommonPlan, ownerUserId: string, personal?: V2PersonalPlan): V2GoogleTaskItem[] {
  if (!plan.initialized || !plan.members.some(member => member.userId === ownerUserId && member.active)) throw new Error('Google家事の共有設定と参加状態を確認してください。');
  if (personal && (personal.viewerUserId !== ownerUserId || personal.groupId !== plan.groupId || personal.commonPlanHash !== plan.planHash)) throw new Error('Google家事の本人推奨日を確認してください。');
  const namespace = v2NativeWorkspaceNamespace(ownerUserId, plan.groupId); const chores = new Map(plan.chores.map(chore => [chore.id, chore]));
  const recommendations = new Map(personal?.recommendations.map(row => [row.subjectOccurrenceId, row]) ?? []);
  const history = new Map<string, V2CommonPlan['history']>();
  for (const row of plan.history) { const bucket = history.get(row.subjectOccurrenceId) ?? []; bucket.push(row); history.set(row.subjectOccurrenceId, bucket); }
  const result: V2GoogleTaskItem[] = [];
  for (const round of plan.occurrences) {
    const chore = chores.get(round.choreId); if (!chore?.enabled || chore.archived) continue;
    for (const subject of round.subjects) {
      const owns = subject.subjectUserId === null ? !round.assigneeIds.length || round.assigneeIds.includes(ownerUserId) : subject.subjectUserId === ownerUserId;
      if (!owns || !subject.required || !subject.completed && (subject.cooldownSuppressed || subject.virtuallyConsumed)) continue;
      const records = history.get(subject.id) ?? [];
      const accepted = records.filter(row => row.active && row.acceptance === 'accepted' && row.outcome === 'completed');
      const recommended = recommendations.get(subject.id);
      const blocked = !round.activeInPeriod || round.needsAssignment || round.assignmentConflictIds.length > 0 || round.assignmentMappingReviewIds.length > 0
        || subject.pendingCompletionIds.length > 0 || subject.requestReviewIds.length > 0 || subject.dependencyBlocked || subject.dependencyAwaitingCompletion
        || ['conflict', 'review'].includes(subject.formalDate.kind) || Boolean(recommended && !['completed', 'manual', 'recommended'].includes(recommended.state));
      const target = validateV2GoogleTaskTarget({ ownerUserId, groupId: plan.groupId, choreId: round.choreId, anchorDate: round.anchorDate,
        ruleVersion: round.ruleVersion, subjectUserId: subject.subjectUserId, occurrenceId: round.id, subjectOccurrenceId: subject.id }, ownerUserId, plan.groupId);
      const completionRevisionRecords = records.map(({ operationId, active, acceptance, outcome }) => ({ operationId, active, acceptance, outcome }));
      const retainedCompletion = subject.retainedCompletion && { checkpointId: subject.retainedCompletion.checkpointId, recorderUserIds: [...subject.retainedCompletion.recorderUserIds] };
      const localRevision = completionRevision(completionRevisionRecords, retainedCompletion);
      const completedAt = [...accepted.map(row => row.performedAt), ...(subject.retainedCompletion?.completedAt ? [subject.retainedCompletion.completedAt] : [])]
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      result.push({ target, localRevision, completionRevisionRecords, ...(retainedCompletion ? { retainedCompletion } : {}), undoCompletionIds: accepted.filter(row => row.recorderUserId === ownerUserId).map(row => row.operationId).sort(),
        entry: { id: subject.id, householdId: namespace, choreId: chore.id, cycleBaseDate: round.anchorDate,
          windowStart: subject.executionWindowStart, windowEnd: subject.executionWindowEnd, suggestedDate: recommended?.date ?? subject.suggestedDate,
          status: subject.executionWindowEnd < plan.range.asOfDate ? 'overdue' : 'scheduled', assignedMemberIds: [...subject.assigneeIds] }, choreName: chore.name,
        ...(completedAt ? { completedAt } : {}),
        ...(records.some(row => !row.active) ? { locallyIncomplete: true } : {}), ...(blocked ? { synchronizationBlocked: true } : {}) });
    }
  }
  return result;
}
