import { authorizeSharedCalendarOperation } from './calendar-state.ts';
import { supportsRetainedManuals, supportsUploadedManuals, supportsSharedCalendar } from './payload-schema.ts';
import { readV2ManualDocument } from './manual-documents.ts';
import { restoreManualDocument } from '../../appliance-care/manual-document.ts';
import type { ManualDocument, ManualChunk } from '../../appliance-care/manual-document';
import { canonicalJson, causallyPrecedes, compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { SharedReplica } from '../replica.ts';
import { sharedAuthorIdentity } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { v2DatePermissionId, v2SubjectOccurrenceId } from './occurrence-id.ts';
import { createV2AuthorityIndex, V2HistoryConflictError } from './history-view.ts';
import type { V2HistoryView } from './history-view.ts';
import { frameAtOperation, groupPolicyAt, rosterAtOperation } from './authority-context.ts';
import { deriveClaims } from './claims.ts';
import type { ClaimFact, ClaimRelease, ClaimResolution } from './claims.ts';
import { evaluateDateChangePermission, mayUndoCompletion, v2DateDecisionAudience } from './permissions.ts';
import type { DatePermissionFact, DateChangePermission } from './permissions.ts';
import { v2MembershipStart } from './membership-period.ts';
import { normalizeDateTarget, targetCivilDate, targetReferenceTime, validateDesignationTarget } from './date-target.ts';
import type { DateRuleCancellation, DateTarget, DesignationMode, DesignationOptions, ManualRule, ManualRuleFact, RuleSelector, SharedChoreConfiguration } from './model.ts';
import { cancellationScopeMatches } from './date-cancellations.ts';
import { v2CancellationProposal, v2CancellationSelector } from './cancellation-proposal.ts';
import { selectManualRule } from './period-rules.ts';
import { v2DateChangeOriginal } from './date-change-original.ts';
import { fixedConflictAtOperation } from './fixed-conflict.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { deriveV2DateRequest } from './request-state.ts';
import type { V2DateRequestState } from './request-state.ts';
import { approvedRequestRule } from './formal-rules.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { recordedInstructionAt } from './recorded-instruction.ts';
import { violatesV2RequiredOrder } from './date-dependencies.ts';
import { normalizeV2Configuration } from './configuration-normalization.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { expandedCommonWindow } from './window-extension.ts';
import { createV2AssignmentHistory, v2AssignmentRequestReference } from './assignment-state.ts';
import { v2ReadPoint } from './view-point.ts';
import { v2ConfirmedReceiptContext, v2ObservedReceipts } from './receipt-context.ts';
import { v2AssignmentLineage } from './assignment-lineage.ts';
import { assertVerifiedLegacyMigration, verifiedLegacyMigrationKind } from './legacy-migration-source.ts';
import type { VerifiedLegacyMigration } from './legacy-migration-source.ts';
import { verifyV2RecoveryWitnesses } from './recovery-witness.ts';
export type { VerifiedLegacyMigration } from './legacy-migration-source.ts';
type DependencyEvidence = { receipts: ReadonlyMap<string, V2ServerReceipt>; epochs: ReadonlyMap<string, VerifiedSharedRoster> };

export class V2AuthorityError extends Error { readonly code = 'sharing/v2-authority-denied'; }
const CHORE_COMMON_FIELDS = new Set(['enabled', 'archived', 'recommendedCycleDays', 'userIntervalDays', 'manufacturerRecommendedIntervalDays',
  'requiresCycleSelection', 'frequencyDaysByMode', 'windowRadiusDays', 'maxShiftDays', 'load', 'holidayPriority', 'everyday', 'estimatedMinutes', 'laundryDryingPreference']);

function requireAuthority(value: unknown, message: string): asserts value {
  if (!value) throw new V2AuthorityError(message);
}
function observedTarget(view: V2HistoryView, op: SharedOperation, id: string, entityType: SharedOperation['entityType']): SharedOperation {
  const target = view.byId(id);
  requireAuthority(target && target.entityType === entityType && causallyPrecedes(target, op), 'Referenced fact was not observed');
  return target;
}

/** Signatures and the complete roster chain are verified before this business-authority pass. */
export function validateV2BusinessHistory(replica: SharedReplica, archive: readonly VerifiedSharedRoster[], migration?: VerifiedLegacyMigration): void {
  const result = assessV2BusinessHistory(replica, archive, migration);
  if (result.rejected.length) throw result.rejected[0].error;
}

export class V2AwaitingReceiptError extends Error { readonly code = 'sharing/v2-awaiting-receipt'; }
export class V2ReceiptCausalityError extends Error { readonly code = 'sharing/v2-receipt-causality'; }
export interface V2RejectedOperation { operationId: string; kind: 'unauthorized' | 'conflict' | 'unconfirmed'; error: Error }
export interface V2ReceiptEvidence {
  receipts: ReadonlyMap<string, V2ServerReceipt>;
  facts: ReadonlyMap<string, AuthenticatedSharedOperation>;
  pendingLocalIds: ReadonlySet<string>;
}
export function assessV2BusinessHistory(replica: SharedReplica, archive: readonly VerifiedSharedRoster[], migration?: VerifiedLegacyMigration,
  evidence?: V2ReceiptEvidence) {
  if (migration !== undefined) assertVerifiedLegacyMigration(migration, replica, archive);
  const recoveries = verifyV2RecoveryWitnesses(replica.recoveryWitnesses ?? [], archive, replica.groupId);
  const indexed = new Map(replica.operationIndex.map(item => [item.operationId, item]));
  for (const recovery of recoveries) {
    for (const entry of recovery.body.entries) {
      const current = indexed.get(entry.operationId);
      if (entry.classification === 'restoredOriginal' ? !current : Boolean(current)) throw new Error('Recovery evidence conflicts with the active operation history');
    }
    for (const value of recovery.preservedFacts) {
      const current = indexed.get(value.fact.operation.operationId);
      if (current && current.digest !== sharedDocumentDigest(value.fact.operation)) throw new Error('Recovered original differs from the active fact');
      const actual = evidence?.receipts.get(value.fact.operation.operationId);
      if (!actual || canonicalJson(actual) !== canonicalJson(value.receipt)) throw new V2AwaitingReceiptError('Fetch the independently committed receipt for the preserved recovery fact');
    }
  }
  const pending = new Set(replica.pendingOperationIds); const rejected: V2RejectedOperation[] = [];
  const provisionalOperationIds: string[] = [];
  const receiptEpochs = new Map<string, VerifiedSharedRoster>();
  const requestStates = new Map<string, V2DateRequestState>();
  const approvedRules = new Map<string, ManualRuleFact>();
  const requestContexts = new Map<string, ReturnType<typeof dateContext>>();
  const requestDecisions = new Map<string, SharedOperation[]>();
  const dirtyRequests = new Set<string>();
  const causalRequestStates = new Map<string, Map<string, V2DateRequestState>>();
  const cancellationRequestIds = new Set<string>();
  const causalCancellations = new Map<string, DateRuleCancellation[]>(); let cancellationGeneration = -1;
  let confirmedServerTime = 0;
  for (const receipt of evidence?.receipts.values() ?? []) confirmedServerTime = Math.max(confirmedServerTime, receipt.receivedAtMs);
  const unconfirmedFrontier = new Map<string, number>();
  const dots = new Map(replica.operations.map((op) => [`${op.authorDeviceId}:${op.deviceSequence}`, op]));
  let assignmentsAt!: ReturnType<typeof createV2AssignmentHistory>;
  const { view, accept } = createV2AuthorityIndex(replica.groupId, (at) => assignmentsAt(at), () => v2ConfirmedReceiptContext(view.ready, evidence?.receipts ?? new Map()), cancellationsAt);
  assignmentsAt = createV2AssignmentHistory(view, archive, evidence);
  const ready = replica.operations.filter((op) => !pending.has(op.operationId))
    .sort((a, b) => a.logicalClock - b.logicalClock || compareOperationIds(a.operationId, b.operationId));
  for (const op of ready) {
    try {
      const formal = ['designation', 'designationCancel', 'changeRequest', 'requestDecision', 'completion', 'assignmentRequest'].includes(op.entityType)
        ? formalRulesAt(op, op.entityType === 'requestDecision' ? op.payload.requestId as string : undefined) : [];
      const reviewIds = (op.entityType === 'designation' ? (op.payload.configuration as unknown as ManualRule).reviewedRequestIds
        : op.entityType === 'changeRequest' ? op.payload.reviewedRequestIds as string[] | undefined : undefined) ?? [];
      const reviews = new Map<string, V2DateRequestState>();
      if (evidence) for (const id of reviewIds) {
        const state = requestAt(id, op); if (state) reviews.set(id, state);
      }
      if (evidence && (op.entityType === 'completion' && 'recordedCommonWindow' in op.payload
        || view.ofType('dependency').length && (op.entityType === 'designation' || op.entityType === 'changeRequest' || op.entityType === 'requestDecision' && op.payload.decision === 'counteroffer'))) {
        for (const request of view.ofType('changeRequest')) { const state = requestAt(request.operationId, op); if (state) reviews.set(request.operationId, state); }
      }
      if (evidence && op.schemaVersion === 2) {
        const receipt = evidence.receipts.get(op.operationId);
        if (receipt) {
          const fact = evidence.facts.get(op.operationId); if (!fact) throw new Error('Missing receipt author proof');
          const receivedEpoch = bindV2ServerReceipt(receipt, fact, archive);
          receiptEpochs.set(op.operationId, receivedEpoch);
          for (const [device, count] of Object.entries(op.context)) {
            if (count <= (migration?.frontier[device] ?? 0)) continue;
            const ancestor = dots.get(`${device}:${count}`); const prior = ancestor && evidence.receipts.get(ancestor.operationId);
            if (!prior) throw new V2AwaitingReceiptError('Fetch the observed fact receipt before applying its descendant');
            if (prior.uploadSequence >= receipt.uploadSequence) throw new V2ReceiptCausalityError('A future server event cannot retroactively establish observed authority');
          }
          authorizeV2Operation(view, archive, op, migration, undefined, receiptEpochs, formal, requestContexts, reviews, evidence.receipts); authorizeV2Operation(view, archive, op, migration, receivedEpoch, receiptEpochs, formal, requestContexts, reviews, evidence.receipts);
        } else if (evidence.pendingLocalIds.has(op.operationId)) {
          authorizeV2Operation(view, archive, op, migration, undefined, receiptEpochs, formal, requestContexts, reviews, evidence.receipts);
          authorizeV2Operation(view, archive, op, migration, archive.at(-1), receiptEpochs, formal, requestContexts, reviews, evidence.receipts);
        } else throw new V2AwaitingReceiptError('Fetch the immutable receipt before applying this received fact');
      } else authorizeV2Operation(view, archive, op, migration);
      const originalContext = evidence && op.entityType === 'changeRequest'
        ? dateContext(view, archive, op, undefined, undefined, receiptEpochs.get(op.operationId), formal, reviews, { receipts: evidence.receipts, epochs: receiptEpochs }) : undefined;
      accept(op);
      if (evidence?.pendingLocalIds.has(op.operationId) && !evidence.receipts.has(op.operationId)) provisionalOperationIds.push(op.operationId);
      if (originalContext) {
        requestContexts.set(op.operationId, originalContext); dirtyRequests.add(op.operationId);
        if (op.payload.cancellation) cancellationRequestIds.add(op.operationId);
      }
      if (evidence && op.entityType === 'requestDecision') {
        const id = op.payload.requestId as string; const decisions = requestDecisions.get(id) ?? [];
        decisions.push(op); requestDecisions.set(id, decisions); dirtyRequests.add(id);
      }
    } catch (error) {
      const awaitingAncestor = [...unconfirmedFrontier].some(([device, sequence]) => (op.context[device] ?? 0) >= sequence);
      const kind = error instanceof V2AwaitingReceiptError || awaitingAncestor ? 'unconfirmed' : error instanceof V2HistoryConflictError ? 'conflict' : 'unauthorized';
      if (kind === 'unconfirmed') unconfirmedFrontier.set(op.authorDeviceId, Math.min(unconfirmedFrontier.get(op.authorDeviceId) ?? op.deviceSequence, op.deviceSequence));
      rejected.push({ operationId: op.operationId, kind, error: awaitingAncestor ? new V2AwaitingReceiptError('Fetch the prior immutable receipts before applying this fact')
        : error instanceof Error ? error : new Error('Invalid business authority') });
    }
  }
  flushRequests();
  return { view, rejected, provisionalOperationIds, receiptEpochs: receiptEpochs as ReadonlyMap<string, VerifiedSharedRoster>,
    requestStates: [...requestStates.values()], approvedRules: [...approvedRules.values()], formalRulesAt,
    assignmentRequests: assignmentsAt(v2ReadPoint(view, archive.at(-1)!)).requests };

  function requestAt(id: string, at: SharedOperation): V2DateRequestState | undefined {
    if (!evidence) return;
    const request = view.byId(id); const context = requestContexts.get(id);
    if (!request || !context || !causallyPrecedes(request, at)) return;
    const key = canonicalJson([at.context, at.receiptContext ?? null]); const cut = causalRequestStates.get(key) ?? new Map<string, V2DateRequestState>();
    causalRequestStates.set(key, cut);
    const decisions = (requestDecisions.get(id) ?? []).filter((fact) => causallyPrecedes(fact, at));
    if (!cut.has(id)) cut.set(id, deriveV2DateRequest({ request: evidence.facts.get(id)!,
      decisions: decisions.map((fact) => evidence.facts.get(fact.operationId)!),
      receipts: v2ObservedReceipts([request, ...decisions], at, evidence.receipts), archive, confirmedServerTime,
      context: { permission: context.permission, assigneeIds: context.assigneeIds, timeZone: context.zone,
        originalWasConflicted: context.originalWasConflicted, originalMissingTime: context.originalMissingTime, originalReferenceAt: context.originalReferenceAt,
        originalTimeZone: context.originalTimeZone, proposedReferenceAt: context.proposedReferenceAt, proposedTimeZone: context.proposedTimeZone, basisRuleIds: context.basisRuleIds } }));
    while (causalRequestStates.size > 256) causalRequestStates.delete(causalRequestStates.keys().next().value!);
    return cut.get(id);
  }
  function formalRulesAt(at: SharedOperation, except?: string): ManualRuleFact[] {
    const rules: ManualRuleFact[] = [];
    for (const [id, context] of requestContexts) {
      if (id === except) continue;
      const state = requestAt(id, at); if (!state) continue;
      const rule = approvedRequestRule(view.byId(id)!, state, { timeZone: context.zone, ruleVersion: context.config.ruleVersion });
      if (rule) rules.push(rule);
    }
    return rules;
  }
  function cancellationsAt(point?: SharedOperation): DateRuleCancellation[] {
    if (!cancellationRequestIds.size) return [];
    if (cancellationGeneration !== view.ready.length) { causalCancellations.clear(); cancellationGeneration = view.ready.length; }
    const at = point ?? v2ReadPoint(view, archive.at(-1)!); const result: DateRuleCancellation[] = [];
    const key = canonicalJson([at.keyVersion, at.context, at.receiptContext ?? null]); const known = causalCancellations.get(key); if (known) return known;
    for (const id of cancellationRequestIds) {
      const state = requestAt(id, at);
      if (state?.kind === 'approved' && state.formalAction === 'cancel' && state.proposal.cancellation) result.push(state.proposal.cancellation);
    }
    causalCancellations.set(key, result);
    while (causalCancellations.size > 256) causalCancellations.delete(causalCancellations.keys().next().value!);
    return result;
  }

  function flushRequests(except?: string): void {
    if (!evidence) return;
    for (const id of dirtyRequests) {
      if (id === except) continue;
      const context = requestContexts.get(id)!; const request = view.byId(id)!;
      const state = deriveV2DateRequest({ request: evidence.facts.get(id)!,
        decisions: (requestDecisions.get(id) ?? []).map((fact) => evidence.facts.get(fact.operationId)!), receipts: evidence.receipts, archive, confirmedServerTime,
        context: { permission: context.permission, assigneeIds: context.assigneeIds, timeZone: context.zone,
          originalWasConflicted: context.originalWasConflicted, originalMissingTime: context.originalMissingTime, originalReferenceAt: context.originalReferenceAt,
          originalTimeZone: context.originalTimeZone, proposedReferenceAt: context.proposedReferenceAt, proposedTimeZone: context.proposedTimeZone, basisRuleIds: context.basisRuleIds } });
      const rule = approvedRequestRule(request, state, { timeZone: context.zone, ruleVersion: context.config.ruleVersion });
      requestStates.set(id, state); if (rule) approvedRules.set(id, rule); else approvedRules.delete(id);
      dirtyRequests.delete(id);
    }
  }
}

export function validateV2DeliveredAuthority(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], fact: AuthenticatedSharedOperation,
  receipt: V2ServerReceipt, migration?: VerifiedLegacyMigration, requestEpochs?: ReadonlyMap<string, VerifiedSharedRoster>): void {
  const receivedEpoch = bindV2ServerReceipt(receipt, fact, archive);
  if (fact.operation.entityType === 'requestDecision' && !requestEpochs?.has(fact.operation.payload.requestId as string)) {
    throw new V2AwaitingReceiptError('The request delivery epoch is required before validating its decision');
  }
  authorizeV2Operation(view, archive, fact.operation, migration, undefined, requestEpochs);
  authorizeV2Operation(view, archive, fact.operation, migration, receivedEpoch, requestEpochs);
}

function authorizeV2Operation(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], op: SharedOperation, migration?: VerifiedLegacyMigration,
  receivedEpoch?: VerifiedSharedRoster, requestEpochs?: ReadonlyMap<string, VerifiedSharedRoster>, formalRules: readonly ManualRuleFact[] = [],
  requestContexts?: ReadonlyMap<string, ReturnType<typeof dateContext>>, reviewedRequests?: ReadonlyMap<string, V2DateRequestState>, receipts?: ReadonlyMap<string, V2ServerReceipt>): void {
  const originalEpoch = rosterAtOperation(archive, op); const epoch = receivedEpoch ?? originalEpoch; const admin = epoch.body.ownerUserId === op.authorUserId;
  sharedAuthorIdentity(originalEpoch, op.authorUserId, op.authorDeviceId, op.keyVersion);
  if (receivedEpoch) sharedAuthorIdentity(receivedEpoch, op.authorUserId, op.authorDeviceId, op.keyVersion);
  requireAuthority(originalEpoch.body.schemaVersion === op.schemaVersion, 'Operation does not match its original protocol epoch');
  if (op.schemaVersion === 1) {
    requireAuthority(migration && op.deviceSequence <= (migration.frontier[op.authorDeviceId] ?? 0), 'Legacy operation is outside the verified migration checkpoint');
    return;
  }
  if (op.entityType === 'appliance' && op.payload.analysis && typeof op.payload.analysis === 'object'
    && !Array.isArray(op.payload.analysis) && op.payload.analysis.manualSource != null) {
    requireAuthority(supportsUploadedManuals(originalEpoch.body.schedulerVersion), 'Uploaded manuals require an owner-approved scheduler upgrade');
    if (supportsRetainedManuals(originalEpoch.body.schedulerVersion)) {
      const digest = (op.payload.analysis.manualSource as { sha256?: string }).sha256;
      const historical = view.observed(view.topic('appliance', op.entityId), op).some(previous => {
        const analysis = previous.payload.analysis;
        return !supportsRetainedManuals(rosterAtOperation(archive, previous).body.schedulerVersion) && analysis && typeof analysis === 'object' && !Array.isArray(analysis)
          && analysis.manualSource && typeof analysis.manualSource === 'object' && !Array.isArray(analysis.manualSource) && analysis.manualSource.sha256 === digest;
      });
      requireAuthority(typeof digest === 'string' && (historical || readV2ManualDocument(view, op, digest) !== null), 'The analyzed PDF must be retained before its appliance is shared');
    }
  }
  if (op.entityType === 'manualChunk' || op.entityType === 'manualDocument') {
    requireAuthority(supportsRetainedManuals(originalEpoch.body.schedulerVersion), 'PDF retention requires a compatible group');
    if (op.entityType === 'manualDocument') requireAuthority(restoreManualDocument(op.payload as unknown as ManualDocument, digest =>
      view.observed(view.topic('manualChunk', `manual-chunk.${digest}`), op)[0]?.payload as unknown as ManualChunk | undefined) !== null, 'A PDF cannot reference missing or unrelated chunks');
    return;
  }
  if (op.entityType === 'calendarEvent') {
    requireAuthority(supportsSharedCalendar(originalEpoch.body.schedulerVersion), 'Shared calendar requires an owner-approved compatibility update');
    authorizeSharedCalendarOperation(view, op, admin); return;
  }
  const memberIds = epoch.body.members.map((member) => member.userId);
  const member = (id: string) => requireAuthority(memberIds.includes(id), 'Target is not an approved member');
  const adminOnly = () => requireAuthority(admin, 'This common setting requires the administrator');
  if (['groupPolicy', 'settings', 'baseline', 'dependency'].includes(op.entityType)) {
    adminOnly(); if (op.entityType === 'settings') requireAuthority(op.entityId === 'settings', 'Shared settings must use their singleton ID'); return;
  }
  if (op.entityType === 'chore') {
    if (op.operationType === 'patch' && view.topic('chore', op.entityId).length) {
      try { if (view.field('chore', op.entityId, '$alive', op)?.value === false) adminOnly(); }
      catch (error) { if (error instanceof V2HistoryConflictError) adminOnly(); else throw error; }
    }
    if (op.operationType !== 'patch' || Object.keys(op.payload).some((field) => CHORE_COMMON_FIELDS.has(field)
      && !(field === 'enabled' && op.payload.enabled === false && !view.field('chore', op.entityId, '$alive', op)))) adminOnly();
    return;
  }
  if (op.entityType === 'member') {
    requireAuthority(op.entityId === op.authorUserId && (!('userId' in op.payload) || op.payload.userId === op.authorUserId), 'A profile cannot impersonate another member'); return;
  }
  if (op.entityType === 'assignment') throw new V2AuthorityError('V2 assignments require an explicit occurrence scope');
  if (['waste', 'wasteVisibility', 'appliance'].includes(op.entityType)) return;
  if (op.entityType === 'migration') {
    adminOnly(); requireAuthority(migration && canonicalJson(op.payload.legacyFrontier) === canonicalJson(migration.frontier)
      && op.payload.sourceSnapshotDigest === migration.sourceSnapshotDigest
      && (verifiedLegacyMigrationKind(migration) === undefined || verifiedLegacyMigrationKind(migration) === op.payload.groupKind), 'Migration must bind the verified source checkpoint'); return;
  }
  if (op.entityType === 'chorePolicy') {
    adminOnly(); requireAuthority(view.field('chore', op.entityId, '$alive', op)?.value === true, 'Configure an existing shared chore');
    const configuration = op.payload.configuration as unknown as SharedChoreConfiguration;
    configuration.policy.assignment.memberIds.forEach(member);
    const previous = view.observed(view.topic('chorePolicy', op.entityId), op);
    const maximum = previous.reduce((value, fact) => Math.max(value, (fact.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion), 0);
    const historicalSubjects = new Set(maximalCausalFacts(previous).flatMap((fact) => {
      const cfg = fact.payload.configuration as unknown as SharedChoreConfiguration;
      return cfg.policy.completion === 'perMember' && cfg.policy.assignment.mode === 'all'
        ? cfg.targetMemberIds ?? rosterAtOperation(archive, fact).body.members.map((entry) => entry.userId) : [];
    }));
    for (const uid of configuration.targetMemberIds ?? []) requireAuthority(memberIds.includes(uid) || historicalSubjects.has(uid), 'Cannot add an unapproved completion subject');
    if (configuration.assignmentSourceVersion) {
      const source = view.field('chorePolicy', op.entityId, 'configuration', op,
        (fact) => (fact.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion === configuration.assignmentSourceVersion)?.value as unknown as SharedChoreConfiguration | undefined;
      requireAuthority(source && canonicalJson(source.policy) === canonicalJson(normalizeV2Configuration(configuration).policy), 'Assignment inheritance must preserve its original completion and assignment policy');
    }
    requireAuthority(configuration.ruleVersion === maximum + 1, 'Common rule revisions must advance explicitly'); return;
  }
  if (op.entityType === 'datePermission') {
    adminOnly(); member(op.payload.userId as string);
    requireAuthority(op.entityId === v2DatePermissionId(op.groupId, op.payload.choreId as string, op.payload.userId as string), 'Grant ID must bind its chore and member');
    requireAuthority(view.field('chore', op.payload.choreId as string, '$alive', op)?.value === true, 'Cannot grant rights for an unknown chore'); return;
  }
  if (op.entityType === 'completion' && op.operationType === 'undo') {
    const target = observedTarget(view, op, op.payload.targetOperationId as string, 'completion');
    requireAuthority(target.operationType === 'complete' && target.entityId === op.entityId
      && mayUndoCompletion(op.authorUserId, target.authorUserId, epoch.body.ownerUserId, memberIds), 'Only the recorder or administrator may undo this completion'); return;
  }
  if (op.entityType === 'completionApproval') {
    adminOnly(); const target = observedTarget(view, op, op.payload.completionOperationId as string, 'completion');
    requireAuthority(target.operationType === 'complete', 'Approval must reference an actual completion fact'); return;
  }
  if (op.entityType === 'assignmentCancel') {
    adminOnly(); for (const id of op.payload.targetOperationIds as string[]) {
      const source = view.byId(id); requireAuthority(source && ['assignmentRule', 'assignmentRequest'].includes(source.entityType) && causallyPrecedes(source, op), 'Cancel an observed signed assignment source only');
    } return;
  }
  if (op.entityType === 'assignmentDecision') {
    adminOnly(); const request = observedTarget(view, op, op.payload.requestId as string, 'assignmentRequest');
    if (op.payload.decision === 'reject') return;
    requireAuthority(!view.assignmentsAt(op)?.requests.find((state) => state.requestId === request.operationId)?.cancelled, 'This assignment request has been cancelled');
    const current = view.field('chorePolicy', request.payload.choreId as string, 'configuration', op)?.value as unknown as SharedChoreConfiguration | undefined;
    requireAuthority(current && ((current.effectiveFrom ?? current.anchorDate) > (request.payload.anchorDate as string)
      || v2AssignmentLineage(view, op, request.payload.choreId as string, current).has(request.payload.ruleVersion as number)), 'Review the changed common cadence before approving this assignment');
    const context = frameAtOperation(view, archive, op, request.payload.choreId as string, request.payload.anchorDate as LocalDate, request.payload.ruleVersion as number);
    const sameIds = (left: unknown, right: readonly string[]) => canonicalJson([...(left as string[])].sort()) === canonicalJson([...right].sort());
    requireAuthority(sameIds(request.payload.originalMemberIds, context.assigneeIds) && sameIds(request.payload.originalAssignmentIds, context.assignmentOperationIds)
      && sameIds(request.payload.originalClaimOperationIds, context.claims.activeClaimOperationIds), 'Assignment changed since this request; review its current assignees first');
    (request.payload.memberIds as string[]).forEach(member); return;
  }
  if (op.entityType === 'requestDecision') {
    const request = observedTarget(view, op, op.payload.requestId as string, 'changeRequest');
    const context = requestContexts?.get(request.operationId)
      ?? dateContext(view, archive, request, undefined, undefined, requestEpochs?.get(request.operationId), formalRules, reviewedRequests, receipts ? { receipts, epochs: requestEpochs ?? new Map() } : undefined);
    const audience = v2DateDecisionAudience(context.permission, context.assigneeIds, request.authorUserId);
    let automaticCancellation = false;
    if (request.payload.cancellation && op.payload.decision !== 'reject') {
      const current = frameAtOperation(view, archive, op, request.payload.choreId as string, request.payload.anchorDate as LocalDate, context.config.ruleVersion);
      const subject = request.payload.subjectUserId as string | null;
      const currentAssignees = subject === null ? current.assigneeIds : current.subjectUserIds.includes(subject) ? [subject] : [];
      requireAuthority(canonicalJson(currentAssignees) === canonicalJson(context.assigneeIds), 'Review the changed assignees before accepting this removal');
      const removal = v2CancellationProposal(observedDateRules(view, op, formalRules), current.frame, request.payload.subjectUserId as string | null,
        context.zone, request.payload.cancellation as unknown as DateRuleCancellation);
      requireAuthority(removal.referenceAt === context.proposedReferenceAt && canonicalJson(removal.target) === canonicalJson(context.proposed) && removal.mode === context.mode
        && canonicalJson(removal.options) === canonicalJson(context.proposedOptions), 'Review the changed date remaining after this removal');
      automaticCancellation = op.payload.decision === 'approve' && removal.automatic;
    }
    let answerTarget: DateTarget | null = op.payload.decision === 'approve' ? context.proposed
      : op.payload.decision === 'counteroffer' ? op.payload.target as unknown as DateTarget : null;
    if (op.payload.decision === 'acceptCounteroffer') {
      const proposed = observedTarget(view, op, op.payload.referenceDecisionId as string, 'requestDecision');
      requireAuthority(audience.counterofferRecipientIds.includes(op.authorUserId) && proposed.payload.requestId === request.operationId
        && proposed.payload.decision === 'counteroffer', 'Only the affected consenting member may accept that administrator counteroffer');
      answerTarget = proposed.payload.target as unknown as DateTarget;
    } else if (op.payload.decision === 'counteroffer') adminOnly();
    else {
      requireAuthority(admin && audience.administratorVote || audience.approvingMemberIds.includes(op.authorUserId), 'Decision requires the designated approver');
    }
    if (answerTarget !== null) {
      const target = validateDesignationTarget(context.mode, answerTarget);
      const current = frameAtOperation(view, archive, op, request.payload.choreId as string, request.payload.anchorDate as LocalDate, context.config.ruleVersion);
      const subject = request.payload.subjectUserId as string | null;
      const assignees = subject === null ? current.assigneeIds : current.subjectUserIds.includes(subject) ? [subject] : [];
      const answerLabel = op.payload.decision === 'counteroffer' ? 'Counteroffer' : 'Date answer';
      requireAuthority(!fixedConflictAtOperation(view, archive, op, target, assignees,
        { occurrenceId: current.frame.id, subjectUserId: subject }, formalRules), `${answerLabel} conflicts with a fixed shared assignment`);
      requireAuthority(automaticCancellation || !violatesV2RequiredOrder({ view, archive, operation: op, frame: current.frame, subjectUserId: subject,
        target, mode: context.mode, timeZone: context.zone, formalRules, requests: [...(reviewedRequests?.values() ?? [])], receiptEpochs: requestEpochs ?? new Map(), receipts }), `${answerLabel} violates a required chore order`);
    }
    return;
  }
  if (op.entityType === 'designationCancel') {
    for (const id of op.payload.targetOperationIds as string[]) {
      const target = observedDateRules(view, op, formalRules, true).find((fact) => fact.operationId === id);
      requireAuthority(target, 'Referenced designation was not confirmed and observed'); const rule = target.rule;
      const selector = op.payload.selector as unknown as RuleSelector | undefined;
      let cancelRule = rule;
      if (selector) {
        adminOnly();
        const from = selector.scope === 'once' ? selector.anchorDate : selector.scope === 'period' ? selector.range.from : selector.from;
        const frame = frameAtOperation(view, archive, op, rule.choreId, from, rule.ruleVersion).frame;
        requireAuthority(cancellationScopeMatches(rule, selector, frame), 'Cancellation scope must start on an actual matching source occurrence');
        cancelRule = { ...rule, referenceAnchorDate: from };
      }
      requireAuthority(admin || rule.issuerUserId === op.authorUserId && !rule.adminLocked && !rule.strict, 'A locked designation must be changed through a request');
      const context = dateContext(view, archive, op, cancelRule, { precision: 'date', date: cancelRule.referenceAnchorDate }, receivedEpoch, formalRules);
      requireAuthority(context.permission.kind === 'allowed' && !context.permission.needsRequest, 'Cancelling this designation requires consent');
    }
    return;
  }
  const payload = op.payload;
  const rule = op.entityType === 'designation' ? payload.configuration as unknown as ManualRule : null;
  const choreId = rule?.choreId ?? payload.choreId as string;
  const anchorDate = rule?.referenceAnchorDate ?? (payload.anchorDate ?? payload.fromAnchorDate) as LocalDate;
  const ruleVersion = rule?.ruleVersion ?? (['completion', 'assignmentRule', 'assignmentRequest'].includes(op.entityType) ? payload.ruleVersion as number : undefined);
  const frame = frameAtOperation(view, archive, op, choreId, anchorDate, ruleVersion, { allowAssignmentConflict: op.entityType === 'assignmentRule' });
  const occurrenceId = op.entityType === 'completion' ? v2SubjectOccurrenceId(frame.frame.id, payload.subjectUserId as string | null) : frame.frame.id;
  if (!rule) requireAuthority((payload.occurrenceId ?? payload.fromOccurrenceId ?? op.entityId) === occurrenceId, 'Operation belongs to another common occurrence');
  if (op.entityType === 'assignmentRule') {
    adminOnly(); (payload.memberIds as string[]).forEach(member);
    const assignmentFacts = view.assignmentsAt(op)?.facts.filter((fact) => fact.payload.choreId === choreId) ?? [];
    requireAuthority(payload.scope === 'once' || !assignmentFacts.some((fact) => frame.assignmentConflictIds.includes(fact.operationId) && fact.payload.scope === 'once'), 'Resolve a one-off assignment conflict on its actual occurrence');
    const known = new Set(assignmentFacts.map((fact) => fact.operationId));
    for (const id of payload.basisRuleIds as string[] ?? []) requireAuthority(known.has(id), 'Assignment basis was not observed with its confirmation');
    for (const id of payload.reviewedAssignmentRequestIds as string[] ?? []) requireAuthority(frame.assignmentReviewRequestIds.includes(id), 'A conflicting assignment request must be reviewed on its actual occurrence');
    return;
  }
  if (op.entityType === 'assignmentRequest') {
    requireAuthority(admin || frame.assigneeIds.includes(op.authorUserId), 'Only an affected assignee may request this assignment change');
    (payload.memberIds as string[]).forEach(member);
    const sameIds = (left: unknown, right: readonly string[]) => canonicalJson([...(left as string[])].sort()) === canonicalJson([...right].sort());
    requireAuthority(sameIds(payload.originalMemberIds, frame.assigneeIds) && sameIds(payload.originalAssignmentIds, frame.assignmentOperationIds)
      && sameIds(payload.originalClaimOperationIds, frame.claims.activeClaimOperationIds), 'Request must preserve its actual original assignment');
    const reference = v2AssignmentRequestReference(view, op, frame.frame, frame.config.policy.completion === 'perMember' ? frame.subjectUserIds : [], formalRules);
    requireAuthority(canonicalJson(payload.reference) === canonicalJson(reference.reference) && payload.timeZone === reference.timeZone, 'Assignment request must bind its real schedule and timezone');
    return;
  }
  if (op.entityType === 'completion') {
    member(payload.completedByMemberId as string);
    requireAuthority(frame.config.policy.completion === 'one' ? payload.subjectUserId === null : frame.subjectUserIds.includes(payload.subjectUserId as string), 'Completion subject does not belong to this chore');
    const expected = frame.config.policy.completion === 'perMember' ? [payload.subjectUserId as string] : frame.assigneeIds;
    requireAuthority(canonicalJson([...(payload.originalAssigneeIds as string[])].sort()) === canonicalJson([...expected].sort()), 'Original assignees must match the observed common state');
    requireAuthority(admin || payload.completedByMemberId === op.authorUserId || expected.includes(op.authorUserId), 'A member cannot record work as another person');
    if ('recordedInstruction' in payload) {
      const instruction = recordedInstructionAt(view, op, frame.frame, payload.subjectUserId as string | null, formalRules);
      requireAuthority(canonicalJson(payload.recordedInstruction) === canonicalJson(instruction), 'Recorded instruction must match the formal date observed when reporting work');
      if ('scheduledDate' in payload && instruction.kind !== 'unconfirmed') {
        const expectedDate = instruction.kind === 'designated' ? targetCivilDate(instruction.target, instruction.timeZone) : frame.frame.anchorDate;
        requireAuthority(payload.scheduledDate === expectedDate, 'A private recommendation cannot replace the recorded common date');
      }
      if ('recordedCommonWindow' in payload) {
        const common = expandedCommonWindow({ frame: frame.frame, timeZone: instruction.timeZone, view, at: op, requests: [...(reviewedRequests?.values() ?? [])],
          approvedRules: formalRules, receiptEpochs: requestEpochs ?? new Map() });
        const date = instruction.kind === 'designated' ? targetCivilDate(instruction.target, instruction.timeZone) : frame.frame.anchorDate;
        const start = instruction.kind === 'designated' && date < common.windowStart ? date : common.windowStart;
        const end = instruction.kind === 'designated' && date > common.windowEnd ? date : common.windowEnd;
        requireAuthority(canonicalJson(payload.recordedCommonWindow) === canonicalJson({ start: common.windowStart, end: common.windowEnd })
          && payload.scheduledWindowStart === start && payload.scheduledWindowEnd === end, 'Recorded common and subject windows must match the schedule observed when reporting work');
      }
    }
    // Disallowed substitutions remain real reports awaiting approval; they are not accepted completions.
    groupPolicyAt(view, op); return;
  }
  if (op.entityType === 'claim' || op.entityType === 'claimRelease' || op.entityType === 'claimResolution') {
    requireAuthority(frame.config.policy.completion === 'one' && frame.configuredAssignees.filter((uid) => memberIds.includes(uid)).length === 0, 'Only an unassigned common chore can be claimed');
    if (op.entityType === 'claim') requireAuthority(!frame.assigneeIds.length || frame.assigneeIds.every((uid) => uid === op.authorUserId), 'Another assignee was already observed');
    if (op.entityType === 'claimRelease') {
      for (const id of payload.targetOperationIds as string[]) {
        const target = observedTarget(view, op, id, 'claim'); requireAuthority(target.authorUserId === op.authorUserId && target.payload.occurrenceId === occurrenceId, 'Cannot release another claim');
      }
      requireAuthority(!frame.assignmentFixed || !frame.assigneeIds.includes(op.authorUserId), 'A fixed assignment needs a change request');
    }
    if (op.entityType === 'claimResolution') {
      adminOnly(); (payload.assigneeIds as string[]).forEach(member);
      requireAuthority((payload.claimOperationIds as string[]).every((id) => frame.claims.activeClaimOperationIds.includes(id)), 'Resolve active claims only');
      const facts = [...view.observed(view.forOccurrence(occurrenceId), op), op];
      deriveClaims(occurrenceId, { activeMemberIds: memberIds,
        claims: facts.filter((fact) => fact.entityType === 'claim').map((fact) => ({ ...fact, ...fact.payload }) as unknown as ClaimFact),
        releases: facts.filter((fact) => fact.entityType === 'claimRelease').map((fact) => ({ ...fact, ...fact.payload }) as unknown as ClaimRelease),
        resolutions: facts.filter((fact) => fact.entityType === 'claimResolution').map((fact) => ({ ...fact, ...fact.payload }) as unknown as ClaimResolution) });
    }
    return;
  }
  if (op.entityType === 'designation' || op.entityType === 'changeRequest') {
    if (rule?.adminLocked) adminOnly();
    if (rule?.allowDuringCooldown) adminOnly();
    const selector = rule?.selector ?? op.payload.selector as unknown as ManualRule['selector'];
    requireAuthority(selector.scope === 'once' ? selector.occurrenceId === frame.frame.id && selector.anchorDate === frame.frame.anchorDate
      : selector.scope === 'period' ? selector.range.from <= anchorDate && (selector.range.through === null || anchorDate <= selector.range.through) : selector.from <= anchorDate,
    'Date rule must include its reference occurrence');
    const context = dateContext(view, archive, op, rule ?? undefined, undefined, receivedEpoch, formalRules, reviewedRequests, receipts ? { receipts, epochs: requestEpochs ?? new Map() } : undefined);
    if (rule) requireAuthority(rule.timeZoneAtCreation === context.zone, 'Designation must bind the group timezone observed by its author');
    if (!rule && context.proposedOptions.adminLocked && !context.originalOptions.adminLocked) adminOnly();
    requireAuthority(context.permission.kind !== 'denied', 'This date change is forbidden');
    if (rule) requireAuthority(context.permission.kind === 'allowed' && !context.permission.needsRequest, 'This date change requires a signed request and consent');
    return;
  }
  throw new V2AuthorityError('Unsupported v2 business operation');
}

export function dateChangeContextAtOperation(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], op: SharedOperation, receivedEpoch?: VerifiedSharedRoster,
  formalRules: readonly ManualRuleFact[] = [], reviewedRequests?: ReadonlyMap<string, V2DateRequestState>, dependencyEvidence?: DependencyEvidence) {
  return dateContext(view, archive, op, undefined, undefined, receivedEpoch, formalRules, reviewedRequests, dependencyEvidence);
}
function dateContext(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], op: SharedOperation, rule?: ManualRule, proposedOverride?: DateTarget,
  receivedEpoch?: VerifiedSharedRoster, formalRules: readonly ManualRuleFact[] = [], reviewedRequests?: ReadonlyMap<string, V2DateRequestState>, dependencyEvidence?: DependencyEvidence) {
  const choreId = rule?.choreId ?? op.payload.choreId as string; const anchorDate = rule?.referenceAnchorDate ?? op.payload.anchorDate as LocalDate;
  const context = frameAtOperation(view, archive, op, choreId, anchorDate, rule?.ruleVersion);
  const subject = rule ? rule.subjectUserId : op.payload.subjectUserId as string | null;
  requireAuthority(context.config.policy.completion === 'one' ? subject === null : context.subjectUserIds.includes(subject as string), 'Date subject does not belong to the chore');
  const epoch = receivedEpoch ?? rosterAtOperation(archive, op); const policy = groupPolicyAt(view, op);
  const zone = view.field('settings', 'settings', 'timeZone', op)?.value;
  requireAuthority(typeof zone === 'string', 'Missing shared timezone');
  const rules = observedDateRules(view, op, formalRules);
  const current = selectManualRule(rules, context.frame, subject, zone);
  const cancelling = op.entityType === 'designationCancel';
  const basis = cancelling ? [] : rule?.basisRuleIds ?? op.payload.basisRuleIds as string[] | undefined ?? [];
  const reviewIds = cancelling ? [] : rule?.reviewedRequestIds ?? op.payload.reviewedRequestIds as string[] | undefined ?? [];
  for (const id of reviewIds) {
    const request = observedTarget(view, op, id, 'changeRequest'); const state = reviewedRequests?.get(id);
    requireAuthority(request.payload.choreId === choreId && request.payload.subjectUserId === subject
      && state && state.conflictIds.length > 0 && state.conflictIds.every((decisionId) => {
        const decision = view.byId(decisionId); return decision && causallyPrecedes(decision, op);
      }), 'A request conflict review must observe its actual conflicting answers for this chore and subject');
  }
  if (current.kind === 'conflict') {
    if (!(cancelling && op.authorUserId === epoch.body.ownerUserId) && !current.candidates.every((fact) => basis.includes(fact.operationId))) {
      throw new V2HistoryConflictError('Resolve concurrent dates with every observed candidate before another change');
    }
    if (!cancelling) {
      const rank = (scope: ManualRule['selector']['scope']) => scope === 'once' ? 3 : scope === 'period' ? 2 : 1;
      const selector = rule?.selector ?? op.payload.selector as unknown as ManualRule['selector'];
      requireAuthority(rank(selector.scope) >= Math.max(...current.candidates.map((fact) => rank(fact.rule.selector.scope))), 'A lower-priority recurrence cannot resolve a more specific date conflict');
    }
  }
  const known = new Set(observedDateRules(view, op, formalRules, true).filter((fact) => fact.rule.choreId === choreId && fact.rule.subjectUserId === subject).map((fact) => fact.operationId));
  for (const id of basis) requireAuthority(known.has(id), 'Date basis must reference an observed rule for this chore and subject');
  const originalRule = current.kind === 'selected' ? current.fact.rule : null;
  const originals = current.kind === 'conflict' ? current.candidates.map((fact) => fact.rule) : originalRule ? [originalRule] : [];
  const source = cancelling ? { original: originals[0]?.target ?? { precision: 'date' as const, date: anchorDate },
    unresolved: false, originalMissingTime: false, originalReferenceAt: null, originalTimeZone: originals[0]?.timeZoneAtCreation ?? zone,
    latestOriginalReferenceAt: originals.length ? Math.max(...originals.map((previous) => targetReferenceTime(previous.target, previous.timeZoneAtCreation))) : null }
    : v2DateChangeOriginal(originals, context.frame, zone);
  const { original } = source;
  if (source.unresolved) requireAuthority(basis.length > 0 && (current.kind === 'selected' ? current.equivalentOperationIds : current.kind === 'conflict' ? current.candidates.map((fact) => fact.operationId) : [])
    .every((id) => basis.includes(id)), 'Resolving an uncertain clock must explicitly observe its source rules');
  const originalOptions: DesignationOptions = { adminLocked: originals.some((previous) => previous.adminLocked),
    strict: originals.some((previous) => previous.strict), forbidEarlier: originals.some((previous) => previous.forbidEarlier) };
  const fixedTime = originals.some((previous) => previous.mode === 'fixed');
  const proposed = proposedOverride ?? rule?.target ?? op.payload.proposed as unknown as DateTarget;
  const mode: DesignationMode = proposedOverride ? 'day' : rule?.mode ?? op.payload.proposedMode as DesignationMode;
  const proposedOptions: DesignationOptions = op.entityType === 'designationCancel' ? { strict: false, adminLocked: false, forbidEarlier: false }
    : rule ? { strict: rule.strict, adminLocked: rule.adminLocked, forbidEarlier: rule.forbidEarlier,
      ...(rule.allowDuringCooldown === undefined ? {} : { allowDuringCooldown: rule.allowDuringCooldown }) } : op.payload.proposedOptions as unknown as DesignationOptions;
  if (!proposedOverride) validateDesignationTarget(mode, proposed);
  let automaticCancellation = false; let proposedReferenceAt: number | null = null; let proposedTimeZone = zone;
  if (op.entityType === 'changeRequest' && op.payload.cancellation) {
    const cancellation = op.payload.cancellation as unknown as DateRuleCancellation;
    const selector = op.payload.selector as unknown as RuleSelector;
    requireAuthority(canonicalJson(v2CancellationSelector(rules, cancellation)) === canonicalJson(selector),
    'Removal scope must match the requested common occurrence and period');
    const removal = v2CancellationProposal(rules, context.frame, subject, zone, cancellation);
    requireAuthority(canonicalJson(removal.target) === canonicalJson(proposed) && removal.mode === mode && canonicalJson(removal.options) === canonicalJson(proposedOptions),
      'Removal reference must come from the remaining observed common rules');
    automaticCancellation = removal.automatic; proposedReferenceAt = removal.referenceAt; proposedTimeZone = removal.timeZone;
  }
  if (op.entityType === 'changeRequest') {
    requireAuthority(canonicalJson(op.payload.original === null ? null : normalizeDateTarget(op.payload.original as unknown as DateTarget)) === canonicalJson(original)
      && op.payload.originalDesignationId === (current.kind === 'selected' ? current.fact.operationId : null), 'Request must reference the formal date observed by its author');
  }
  const assigneeIds = subject === null ? context.assigneeIds : [subject]; const date = targetCivilDate(proposed, zone);
  const memberSince = v2MembershipStart(archive, op.authorUserId, epoch.body.keyVersion);
  const grants = view.observed(view.ofType('datePermission'), op).filter(fact => memberSince !== null && fact.payload.userId === op.authorUserId
    && fact.payload.choreId === choreId && fact.keyVersion >= memberSince && fact.keyVersion <= epoch.body.keyVersion)
    .map((fact) => ({ ...fact, ...fact.payload }) as unknown as DatePermissionFact);
  let permission: DateChangePermission = evaluateDateChangePermission({ actorUserId: op.authorUserId, adminUserId: epoch.body.ownerUserId,
      activeMemberIds: epoch.body.members.map((member) => member.userId), choreId, assigneeIds, policy, grants,
      movingEarlier: !source.unresolved && source.latestOriginalReferenceAt !== null && targetReferenceTime(proposed, zone) < source.latestOriginalReferenceAt, beforeWindow: date < context.frame.windowStart,
      afterWindow: date > context.frame.windowEnd, ...originalOptions, adminLocked: originalOptions.adminLocked || fixedTime,
      fixedConflict: fixedConflictAtOperation(view, archive, op, proposed, assigneeIds, { occurrenceId: context.frame.id, subjectUserId: subject }, formalRules), operation: op });
  const weakensInstruction = originals.some((previous) => previous.adminLocked && !proposedOptions.adminLocked
    || previous.strict && !proposedOptions.strict || previous.forbidEarlier && !proposedOptions.forbidEarlier
    || previous.adminLocked && mode !== previous.mode || previous.mode === 'fixed' && mode !== 'fixed');
  const extendsFutureWindow = op.entityType === 'changeRequest' && op.payload.extensionScope === 'future'
    && (date < context.frame.windowStart || date > context.frame.windowEnd);
  const removesLockedInstruction = op.entityType === 'changeRequest' && op.payload.cancellation && originals.some((previous) => previous.adminLocked || previous.strict || previous.mode === 'fixed');
  if (permission.kind !== 'denied' && op.authorUserId !== epoch.body.ownerUserId && (weakensInstruction || removesLockedInstruction || current.kind === 'conflict' || source.unresolved || reviewIds.length > 0 || proposedOptions.allowDuringCooldown || extendsFutureWindow)) {
    permission = { kind: 'approvalRequired', approver: permission.kind === 'approvalRequired' && permission.approver !== 'admin' ? 'adminAndAssignee' : 'admin',
      reason: extendsFutureWindow ? 'outsideWindow' : originalOptions.adminLocked || fixedTime ? 'fixed' : 'strict' };
  }
  if (source.unresolved && permission.kind === 'allowed') permission = { ...permission, needsRequest: true };
  if (!cancelling && !automaticCancellation && permission.kind !== 'denied' && violatesV2RequiredOrder({ view, archive, operation: op, frame: context.frame,
    subjectUserId: subject, target: proposed, mode, timeZone: zone, formalRules, requests: [...(reviewedRequests?.values() ?? [])],
    receiptEpochs: dependencyEvidence?.epochs ?? new Map(), receipts: dependencyEvidence?.receipts })) permission = { kind: 'denied', reason: 'dependency' };
  return { ...context, assigneeIds, mode, original, proposed, proposedOptions, originalRule, originalOptions, zone, permission,
    originalWasConflicted: current.kind === 'conflict' || source.unresolved, originalMissingTime: source.originalMissingTime, originalReferenceAt: source.originalReferenceAt,
    originalTimeZone: source.originalTimeZone, proposedReferenceAt, proposedTimeZone,
    basisRuleIds: current.kind === 'selected' ? current.equivalentOperationIds : current.kind === 'conflict' ? current.candidates.map((fact) => fact.operationId) : [] };
}
