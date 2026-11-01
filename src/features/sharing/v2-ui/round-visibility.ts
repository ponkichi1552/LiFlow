import type { V2GroupScreenModel } from '../v2/controller.ts';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan.ts';
import type { V2CompletionRecord } from '../v2/completion-history';

const historyIndexes = new WeakMap<readonly V2CompletionRecord[], Map<string, { record: V2CompletionRecord; index: number }>>();
function historyIndex(history: readonly V2CompletionRecord[]) {
  let work = historyIndexes.get(history);
  if (!work) { work = new Map(history.map((record, index) => [record.operationId, { record, index }])); historyIndexes.set(history, work); }
  return work;
}

/** This is a display preference. Keep one's own work and the administrator's audit view available. */
export function v2CanShowCompletion(model: V2GroupScreenModel, record: V2CompletionRecord) {
  const viewer = model.viewerUserId;
  return viewer === model.adminUserId || model.plan.policy?.showCompletionStatus === true
    || record.recorderUserId === viewer || record.performerUserId === viewer || record.subjectUserId === viewer
    || record.subjectUserId === null && (record.originalAssigneeIds.length === 0 || record.originalAssigneeIds.includes(viewer));
}

/** Local presentation only; signed command permissions are still checked by the receiver. */
export function createV2RoundVisibility(model: V2GroupScreenModel) {
  const work = historyIndex(model.plan.history);
  const viewer = model.viewerUserId; const admin = viewer === model.adminUserId;
  return (round: V2PlannedOccurrence, subject: V2SubjectPlan) => {
    const owns = subject.subjectUserId === null ? round.assigneeIds.length === 0 || round.assigneeIds.includes(viewer) : subject.subjectUserId === viewer;
    const ids = new Set([...subject.completionOperationIds, ...subject.pendingCompletionIds]);
    const relatedWork = [...ids].flatMap((id) => { const record = work.get(id); return record ? [record] : []; }).sort((a, b) => a.index - b.index).map((entry) => entry.record);
    return { admin, owns, relatedWork, showStatus: owns || admin || model.plan.policy?.showCompletionStatus === true
      || relatedWork.some((record) => v2CanShowCompletion(model, record)) };
  };
}
