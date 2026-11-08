import type { LocalDate } from '../../../domain/shared/types';
import type { V2PlannedOccurrence, V2SubjectPlan } from './common-plan';

export interface V2CompletionFrontier { date: LocalDate; anchorDate: LocalDate; instant: number }
export const v2BacklogKey = (choreId: string, version: number, subjectUserId: string | null) => JSON.stringify([choreId, version, subjectUserId]);

/** Explicit dates, assignments, reviews and pending reports remain separate obligations. */
export function v2AutomaticBacklogEligible(round: V2PlannedOccurrence, subject: V2SubjectPlan) {
  return subject.formalDate.kind === 'automatic' && !round.assignmentOperationIds.length && !round.assignmentConflictIds.length
    && !round.assignmentMappingReviewIds.length && !round.extensionRequestIds.length && !subject.requestReviewIds.length
    && !subject.pendingCompletionIds.length;
}

/** One physical completion covers automatic slots, without inventing completed history for those slots. */
export function applyV2AutomaticBacklog(rounds: V2PlannedOccurrence[], frontiers: ReadonlyMap<string, V2CompletionFrontier>, today: LocalDate) {
  const first = new Map<string, { round: V2PlannedOccurrence; subject: V2SubjectPlan }>();
  for (const round of rounds) for (const subject of round.subjects) {
    if (!subject.required || subject.completed || !v2AutomaticBacklogEligible(round, subject)) continue;
    const key = v2BacklogKey(round.choreId, round.ruleVersion, subject.subjectUserId); const done = frontiers.get(key);
    if (done && round.anchorDate <= (done.anchorDate > done.date ? done.anchorDate : done.date) && subject.executionWindowStart <= done.date) {
      subject.automaticBacklog = 'covered'; subject.virtuallyConsumed = true; subject.showExpiredOnHome = false;
      continue;
    }
    subject.automaticBacklog = 'later'; subject.showExpiredOnHome = false;
    if (subject.executionWindowStart > today || subject.minimumNextExecutionDay && subject.minimumNextExecutionDay > today) continue;
    const previous = first.get(key);
    if (!previous || round.anchorDate < previous.round.anchorDate || round.anchorDate === previous.round.anchorDate && subject.id < previous.subject.id) first.set(key, { round, subject });
  }
  for (const { subject } of first.values()) {
    subject.automaticBacklog = 'pending'; subject.virtuallyConsumed = false;
    subject.showExpiredOnHome = subject.executionWindowEnd < today;
  }
}
