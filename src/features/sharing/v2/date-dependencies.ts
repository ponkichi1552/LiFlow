import { causallyPrecedes } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { createV2AuthorityIndex } from './history-view.ts';
import type { V2HistoryView } from './history-view.ts';
import { buildV2CommonPlan } from './common-plan.ts';
import { fixedInterval, targetCivilDate, targetReferenceTime, targetReferenceCivilDate } from './date-target.ts';
import type { DateTarget, DesignationMode, ManualRuleFact, SharedOccurrence } from './model.ts';
import type { V2DateRequestState } from './request-state.ts';
import type { V2ServerReceipt } from './server-receipts.ts';

/** Authoring and receiving use the same date-based prerequisite plan, including earlier cycles outside the current view. */
export function violatesV2RequiredOrder(input: { view: V2HistoryView; archive: readonly VerifiedSharedRoster[]; operation: SharedOperation;
  frame: SharedOccurrence; subjectUserId: string | null; target: DateTarget; mode: DesignationMode; timeZone: string; formalRules: readonly ManualRuleFact[];
  requests: readonly V2DateRequestState[]; receiptEpochs: ReadonlyMap<string, VerifiedSharedRoster>; receipts?: ReadonlyMap<string, V2ServerReceipt> }): boolean {
  if (!input.view.ofType('dependency').length) return false;
  const cut = createV2AuthorityIndex(input.view.groupId, undefined, undefined, undefined, input.view.retentionAt(input.operation));
  for (const op of input.view.ready) if (causallyPrecedes(op, input.operation)) cut.accept(op);
  const plan = buildV2CommonPlan({ assessment: { view: cut.view, approvedRules: [...input.formalRules], requestStates: [...input.requests], receiptEpochs: input.receiptEpochs },
    archive: input.archive.slice(0, input.operation.keyVersion), receipts: input.receipts ?? new Map() },
  { from: input.frame.anchorDate, through: input.frame.anchorDate, asOfDate: input.frame.anchorDate });
  const slot = plan.occurrences.find((entry) => entry.id === input.frame.id)?.subjects.find((entry) => entry.subjectUserId === input.subjectUserId);
  if (plan.issues.some((issue) => issue.kind === 'dependencyPolicyNeedsReview' && issue.choreId === input.frame.choreId)) return true;
  if (!slot) return plan.dependencies.some((edge) => edge.required && edge.successorChoreId === input.frame.choreId);
  if (slot.completed) return false;
  if (slot.dependencyBlocked && !slot.dependencyNotBefore) return true;
  const proposedDay = input.mode === 'deadline' ? targetReferenceCivilDate(input.target, input.timeZone, plan.timeZone) : targetCivilDate(input.target, plan.timeZone);
  if (slot.dependencyNotBefore && proposedDay < slot.dependencyNotBefore) return true;
  const interval = fixedInterval(input.target);
  const exact = interval?.start ?? (input.mode === 'deadline' ? targetReferenceTime(input.target, input.timeZone) : null);
  return exact !== null && slot.dependencyNotBeforeInstant !== null && exact < slot.dependencyNotBeforeInstant;
}
