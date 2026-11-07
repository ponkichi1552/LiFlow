import type { LocalDate } from '../../domain/shared/types';
import type { ChoreDefinition } from '../../domain/chores/types';
import type { AdaptivePlacementLoad } from '../../domain/scheduling/adaptive/placement';
import type { V2CommonPlan } from '../sharing/v2/common-plan';
import { sharedLocalDate } from '../sharing/group-clock.ts';
import { fixedInterval } from '../sharing/v2/date-target.ts';
import { commonChoreLinks } from './common-chore-links.ts';
import type { V2PersonalPlan } from '../sharing/v2/personal-plan';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import { sharedCompletionTimeReviewIds } from './shared-completion-evidence.ts';

export interface CapturedSharedPlanning {
  ownerUserId: string; groupId: string; sourceHash: string; plan: V2PersonalPlan;
}
/** Reuse a stable full-horizon, shared-first recommendation in each visible range. */
export function capturedSharedRecommendations(common: V2CommonPlan, fallback: V2PersonalPlan, captured?: CapturedSharedPlanning): V2PersonalPlan {
  if (!captured || captured.sourceHash !== common.sourceHash || captured.groupId !== common.groupId || captured.ownerUserId !== fallback.viewerUserId) return fallback;
  const byId = new Map(captured.plan.recommendations.map(row => [row.subjectOccurrenceId, row]));
  const recommendations = fallback.recommendations.map(row => byId.get(row.subjectOccurrenceId) ?? row);
  const pages = []; for (let offset = 0; offset < recommendations.length; offset += 1000) pages.push(sharedDocumentDigest(recommendations.slice(offset, offset + 1000)));
  return { ...fallback, recommendations, localHash: sharedDocumentDigest([common.planHash, fallback.viewerUserId, pages]) };
}

/** Read-only owner projection. Neither a shared occurrence nor its assigned date is changed. */
export function sharedAdaptiveLoad(plan: V2CommonPlan, ownerUserId: string, today: LocalDate, timeZone: string,
  personal: readonly ChoreDefinition[], recommendations?: V2PersonalPlan) {
  if (!plan.initialized || !plan.members.some(member => member.active && member.userId === ownerUserId)) throw new Error('共有家事を参照する本人の参加状態を確認してください。');
  const chores = new Map(plan.chores.map(chore => [chore.id, chore]));
  const loads = new Map<string, AdaptivePlacementLoad>();
  if (recommendations && (recommendations.groupId !== plan.groupId || recommendations.viewerUserId !== ownerUserId || recommendations.commonPlanHash !== plan.planHash)) throw new Error('本人向け共有予定の計算版を確認してください。');
  const dates = new Map(recommendations?.recommendations.map(row => [row.subjectOccurrenceId, row.date]));
  const spent = new Set<string>();
  // Canonicalize concurrent completions by the subject occurrence first. Another
  // member's completion releases the reservation but never becomes the owner's work.
  const completed = new Map<string, V2CommonPlan['history'][number]>();
  const review = sharedCompletionTimeReviewIds(plan);
  for (const record of plan.history) {
    if (!record.active || record.acceptance !== 'accepted' || record.outcome !== 'completed' || record.approvalConflictIds.length || review.has(record.operationId)) continue;
    const previous = completed.get(record.subjectOccurrenceId);
    if (!previous || Date.parse(record.performedAt) < Date.parse(previous.performedAt)
      || Date.parse(record.performedAt) === Date.parse(previous.performedAt) && record.operationId < previous.operationId) completed.set(record.subjectOccurrenceId, record);
  }
  for (const record of completed.values()) {
    const chore = chores.get(record.choreId);
    if (!chore || record.performerUserId !== ownerUserId || sharedLocalDate(new Date(record.performedAt), timeZone) !== today) continue;
    const roundId = `shared:${plan.groupId}:${record.subjectOccurrenceId}`; spent.add(record.subjectOccurrenceId);
    loads.set(roundId, { roundId, date: today, load: chore.load, minutes: chore.estimatedMinutes ?? null, slot: null });
  }
  for (const occurrence of plan.occurrences) {
    const chore = chores.get(occurrence.choreId);
    if (!chore || !chore.enabled || chore.archived || occurrence.historical || !occurrence.activeInPeriod) continue;
    for (const subject of occurrence.subjects) {
      if (!subject.required || subject.completed || subject.virtuallyConsumed || subject.cooldownSuppressed || spent.has(subject.id)) continue;
      const owns = subject.subjectUserId !== null ? subject.subjectUserId === ownerUserId
        : occurrence.assigneeIds.length === 0 || occurrence.assigneeIds.includes(ownerUserId);
      if (!owns) continue;
      const target = subject.formalDate.kind === 'manual' && subject.formalDate.mode === 'fixed' ? subject.formalDate.target : null;
      const slot = target ? fixedInterval(target) : null;
      // Date-only tasks retain their agreed civil date across different regions.
      // An actual interval has an instant and belongs to its owner's starting day.
      const date = slot ? sharedLocalDate(new Date(slot.start), timeZone) : dates.get(subject.id) ?? subject.suggestedDate;
      const roundId = `shared:${plan.groupId}:${subject.id}`;
      loads.set(roundId, { roundId, date, load: chore.load, minutes: chore.estimatedMinutes ?? null,
        slot: chore.estimatedMinutes === undefined ? null : slot });
    }
  }
  return { loads: [...loads.values()].sort((a, b) => a.roundId.localeCompare(b.roundId)),
    suppressedPersonalChoreIds: new Set(commonChoreLinks(personal, plan.chores).map(link => link.personalChoreId)) };
}
