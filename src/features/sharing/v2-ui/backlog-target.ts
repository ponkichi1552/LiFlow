import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import { v2BacklogKey } from '../v2/automatic-backlog.ts';

const indexes = new WeakMap<readonly V2PlannedOccurrence[], Map<string, { round: V2PlannedOccurrence; subject: V2SubjectPlan }>>();
/** The same immutable plan supplies the quick-checkbox target and its immediate feedback. */
export function v2BacklogTarget(rounds: readonly V2PlannedOccurrence[], round: V2PlannedOccurrence, subject: V2SubjectPlan, today: string) {
  if (subject.completed || subject.automaticBacklog !== 'later' || round.anchorDate > today || subject.executionWindowStart > today) return { round, subject };
  let index = indexes.get(rounds);
  if (!index) {
    index = new Map(); indexes.set(rounds, index);
    for (const candidate of rounds) for (const slot of candidate.subjects) if (slot.automaticBacklog === 'pending') index.set(v2BacklogKey(candidate.choreId, candidate.ruleVersion, slot.subjectUserId), { round: candidate, subject: slot });
  }
  return index.get(v2BacklogKey(round.choreId, round.ruleVersion, subject.subjectUserId)) ?? { round, subject };
}
