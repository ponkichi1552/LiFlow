import { canonicalJson, causallyPrecedes } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { commonFrame } from './common-frames.ts';
import { deriveClaims } from './claims.ts';
import type { ClaimFact, ClaimRelease, ClaimResolution } from './claims.ts';
import type { GroupPolicy, SharedChoreConfiguration } from './model.ts';
import type { V2HistoryView } from './history-view.ts';
import { V2HistoryConflictError } from './history-view.ts';
import { v2AssignmentLineage } from './assignment-lineage.ts';
import { maximalConfirmedFacts } from './confirmed-facts.ts';
import type { V2AssignmentFact } from './assignment-state.ts';
import { observedV2AssignmentCancellations } from './assignment-state.ts';
import { v2RotationAssignee } from './rotation.ts';

export function rosterAtOperation(archive: readonly VerifiedSharedRoster[], operation: SharedOperation): VerifiedSharedRoster {
  const epoch = archive[operation.keyVersion - 1];
  if (!epoch || epoch.body.keyVersion !== operation.keyVersion || epoch.body.groupId !== operation.groupId) throw new Error('Missing original membership epoch');
  return epoch;
}
export function groupPolicyAt(view: V2HistoryView, operation: SharedOperation): GroupPolicy {
  const configuration = view.field('groupPolicy', 'policy', 'configuration', operation);
  if (!configuration) throw new Error('Missing group policy at authoring');
  return configuration.value as unknown as GroupPolicy;
}

/** Only signed facts observed by the author can establish the authority of a new operation. */
export function frameAtOperation(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], operation: SharedOperation,
  choreId: string, anchorDate: LocalDate, ruleVersion?: number, options: { allowAssignmentConflict?: boolean } = {}) {
  if (view.field('chore', choreId, '$alive', operation)?.value !== true) throw new Error('Unknown or deleted shared chore');
  const configuration = (ruleVersion === undefined ? view.field('chorePolicy', choreId, 'configuration', operation) : view.configurationVersion(choreId, ruleVersion, operation));
  if (!configuration) throw new Error('Missing common chore configuration');
  const config = configuration.value as unknown as SharedChoreConfiguration;
  const frame = commonFrame(view.groupId, choreId, config, anchorDate);
  const epoch = rosterAtOperation(archive, operation); const activeMemberIds = epoch.body.members.map((member) => member.userId);
  const memberSets = configuration.operations.map((fact) => rosterAtOperation(archive, fact).body.members.map((member) => member.userId).sort());
  if (config.policy.assignment.mode === 'all' && !config.targetMemberIds && new Set(memberSets.map((members) => canonicalJson(members))).size > 1) throw new V2HistoryConflictError('Confirm members for the common configuration');
  const configuredMembers = memberSets[0];
  const base = config.policy.assignment.mode === 'all' ? config.targetMemberIds ?? configuredMembers : config.policy.assignment.memberIds;
  const assignmentVersions = v2AssignmentLineage(view, operation, choreId, config);
  const projection = view.assignmentsAt(operation);
  const cancelledAssignments = projection ? null : observedV2AssignmentCancellations(view, operation);
  const allAssignments: V2AssignmentFact[] = projection?.facts ?? view.observed(view.ofType('assignmentRule'), operation)
    .filter((fact) => !cancelledAssignments!.has(fact.operationId))
    .map((fact) => ({ ...fact, payload: fact.payload as unknown as V2AssignmentFact['payload'] }));
  const applicable = allAssignments.filter((fact) => fact.payload.choreId === choreId && fact.payload.ruleVersion <= config.ruleVersion
    && (fact.payload.scope === 'once' ? fact.payload.fromOccurrenceId === frame.id : fact.payload.fromAnchorDate <= anchorDate));
  const matching = applicable.filter((fact) => assignmentVersions.has(fact.payload.ruleVersion));
  const once = matching.filter((fact) => fact.payload.scope === 'once');
  const assignments = maximalConfirmedFacts(once.length ? once : matching, (fact) => fact.payload.basisRuleIds ?? []);
  const allOnce = applicable.filter((fact) => fact.payload.scope === 'once');
  const unmapped = applicable.some((fact) => !assignmentVersions.has(fact.payload.ruleVersion))
    ? maximalConfirmedFacts(allOnce.length ? allOnce : applicable, (fact) => fact.payload.basisRuleIds ?? []).filter((fact) => !assignmentVersions.has(fact.payload.ruleVersion)) : [];
  const assignmentReviews = (projection?.requests ?? []).filter((request) => !request.cancelled && request.kind === 'conflict' && request.proposal.choreId === choreId
    && assignmentVersions.has(request.proposal.ruleVersion) && (request.proposal.scope === 'once' ? request.proposal.occurrenceId === frame.id : request.proposal.anchorDate <= anchorDate))
    .filter((request) => !assignments.some((fact) => fact.payload.reviewedAssignmentRequestIds?.includes(request.requestId)
      && request.conflictIds.every((id) => { const vote = view.byId(id); return vote && causallyPrecedes(vote, fact); })));
  const valueConflict = new Set(assignments.map((fact) => canonicalJson({ memberIds: [...fact.payload.memberIds].sort(), fixed: fact.payload.fixed }))).size > 1;
  let assignmentConflict = assignmentReviews.length > 0 || valueConflict || unmapped.length > 0;
  const configuredAssignees = valueConflict ? [...new Set(assignments.flatMap((fact) => fact.payload.memberIds as string[]))]
    : assignments.length ? assignments[0].payload.memberIds as string[]
      : config.policy.assignment.rotation ? [v2RotationAssignee(view, operation, choreId, config, anchorDate)] : base;
  const assigneeIds = configuredAssignees.filter((uid) => activeMemberIds.includes(uid)).sort();
  const facts = view.observed(view.forOccurrence(frame.id), operation);
  const ignoredClaims = new Set(facts.filter((fact) => fact.entityType === 'claim' && assignments.some((assignment) => causallyPrecedes(fact, assignment))).map((fact) => fact.operationId));
  const resolutions = facts.filter((fact) => fact.entityType === 'claimResolution' && !assignments.some((assignment) => causallyPrecedes(fact, assignment)));
  const concurrentResolutions = resolutions.filter((fact) => (fact.payload.claimOperationIds as string[]).some((id) => ignoredClaims.has(id)));
  assignmentConflict ||= concurrentResolutions.length > 0;
  if (assignmentConflict && !options.allowAssignmentConflict) throw new V2HistoryConflictError('Concurrent assignee rules');
  const claims = deriveClaims(frame.id, { activeMemberIds,
    ignoredClaimOperationIds: ignoredClaims,
    claims: facts.filter((op) => op.entityType === 'claim').map((op) => ({ ...op, ...op.payload }) as unknown as ClaimFact),
    releases: facts.filter((op) => op.entityType === 'claimRelease').map((op) => ({ ...op, ...op.payload }) as unknown as ClaimRelease),
    resolutions: resolutions.map((op) => ({ ...op, ...op.payload }) as unknown as ClaimResolution) });
  const useClaims = config.policy.completion === 'one' && !assigneeIds.length;
  return { frame, config, configuredAssignees: [...configuredAssignees], activeMemberIds, claims,
    assignmentOperationIds: [...new Set([...assignments, ...unmapped].map((fact) => fact.operationId))].sort(), assignmentReviewRequestIds: assignmentReviews.map((state) => state.requestId).sort(),
    assignmentMappingReviewIds: unmapped.map((fact) => fact.operationId).sort(),
    assignmentConflictIds: assignmentConflict ? [...new Set([...assignments.map((fact) => fact.operationId), ...unmapped.map((fact) => fact.operationId), ...assignmentReviews.flatMap((state) => state.conflictIds), ...concurrentResolutions.map((fact) => fact.operationId)])].sort() : [],
    assigneeIds: useClaims ? claims.assigneeIds : assigneeIds,
    assignmentFixed: assignments.some((fact) => fact.payload.fixed === true)
      || useClaims && maximalCausalFacts(resolutions).some((fact) => fact.payload.fixed === true),
    subjectUserIds: config.policy.completion === 'perMember' ? [...configuredAssignees].sort() : [] };
}
