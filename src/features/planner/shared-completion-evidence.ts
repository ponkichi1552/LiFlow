import type { V2CommonPlan } from '../sharing/v2/common-plan';

/** A missing receipt may still be a local optimistic report. A receipt that
 * contradicts the reported time is explicitly excluded by the common planner. */
export function sharedCompletionTimeReviewIds(plan: Pick<V2CommonPlan, 'issues'>): ReadonlySet<string> {
  return new Set((plan.issues ?? []).filter(issue => issue.kind === 'reportedTimeNeedsReview').flatMap(issue => issue.operationIds));
}
