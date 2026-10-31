import { validateSharedCalendarPayload } from './calendar-state.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { instantMilliseconds, normalizeDateTarget, validateDesignationTarget } from './date-target.ts';
import { createGroupPolicy } from './model.ts';
import type { DateTarget } from './model.ts';
import type { JsonValue } from '../operations.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { isSharedTimeZone } from '../group-clock.ts';
import { validateManualChunk, validateManualDocument } from '../../appliance-care/manual-document.ts';

export const V2_ENTITY_TYPES = ['groupPolicy', 'chorePolicy', 'datePermission', 'assignmentRule', 'claim', 'claimRelease',
  'claimResolution', 'assignmentRequest', 'assignmentDecision', 'assignmentCancel', 'designation', 'designationCancel', 'changeRequest', 'requestDecision', 'completionApproval', 'migration', 'calendarEvent', 'manualChunk', 'manualDocument'] as const;
export type V2EntityType = typeof V2_ENTITY_TYPES[number];
export const V2_SCHEMA_VERSION = 2;
export const V2_SCHEDULER_VERSION = 'liflow-shared-2-draft-42';
/** Signed 38/39 histories keep their original epochs until the owner approves an upgrade. */
export const isSupportedV2Scheduler = (version: string): boolean => version === V2_SCHEDULER_VERSION || version === 'liflow-shared-2-draft-41' || version === 'liflow-shared-2-draft-40' || version === 'liflow-shared-2-draft-39' || version === 'liflow-shared-2-draft-38';
export const supportsSharedCalendar = (version: string): boolean => version === V2_SCHEDULER_VERSION || version === 'liflow-shared-2-draft-41';
type RecordValue = Record<string, JsonValue>;

function record(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected a v2 object');
  const data = value as RecordValue;
  if (Object.keys(data).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(data, key))) throw new Error('Unknown or missing v2 field');
  return data;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('Invalid v2 integer');
}
function flag(value: unknown): void { if (typeof value !== 'boolean') throw new Error('Invalid v2 boolean'); }
function idOrNull(value: unknown): void { if (value !== null) assertSharedIdentifier(value); }
function ids(value: unknown, allowEmpty = true, limit = 64): string[] {
  if (!Array.isArray(value) || !allowEmpty && !value.length || value.length > limit || new Set(value).size !== value.length) throw new Error('Invalid v2 identifiers');
  value.forEach(assertSharedIdentifier); return value as string[];
}
function day(value: unknown): void { if (typeof value !== 'string') throw new Error('Invalid v2 date'); parseLocalDate(value as LocalDate); }
function timestamp(value: unknown): void { if (typeof value !== 'string') throw new Error('Invalid v2 timestamp'); instantMilliseconds(value); }
function choice(value: unknown, values: readonly string[]): void { if (typeof value !== 'string' || !values.includes(value)) throw new Error('Invalid v2 choice'); }
function target(value: unknown): void { normalizeDateTarget(value as DateTarget); }
function selector(value: unknown): void {
  const data = record(value, ['scope', 'occurrenceId', 'anchorDate', 'range', 'from'], ['scope']);
  if (data.scope === 'once') { record(data, ['scope', 'occurrenceId', 'anchorDate']); assertSharedIdentifier(data.occurrenceId); day(data.anchorDate); }
  else if (data.scope === 'ongoing') { record(data, ['scope', 'from']); day(data.from); }
  else if (data.scope === 'period') {
    record(data, ['scope', 'range']); const range = record(data.range, ['from', 'through']); day(range.from);
    if (range.through !== null) { day(range.through); if ((range.from as string) > (range.through as string)) throw new Error('Invalid v2 period'); }
  } else throw new Error('Invalid v2 selector');
}
function groupPolicy(value: unknown): void {
  const names = Object.keys(createGroupPolicy('family')); const data = record(value, names);
  choice(data.kind, ['family', 'roommates']);
  for (const name of names.filter((key) => key !== 'kind')) flag(data[name]);
}
function chorePolicy(value: unknown): void {
  const required = ['policy', 'anchorDate', 'intervalDays', 'windowBeforeDays', 'windowAfterDays', 'ruleVersion'];
  const data = record(value, [...required, 'effectiveFrom', 'active', 'targetMemberIds', 'assignmentSourceVersion'], required);
  day(data.anchorDate); integer(data.intervalDays, 1, 3650); integer(data.windowBeforeDays, 0, 14); integer(data.windowAfterDays, 0, 14); integer(data.ruleVersion, 1);
  if ('effectiveFrom' in data) { day(data.effectiveFrom); if ((data.effectiveFrom as string) < (data.anchorDate as string)) throw new Error('Effective date cannot precede its common anchor'); }
  if ('active' in data) flag(data.active);
  if ('assignmentSourceVersion' in data) integer(data.assignmentSourceVersion, 1, Number(data.ruleVersion) - 1);
  const policy = record(data.policy, ['completion', 'assignment']); choice(policy.completion, ['one', 'perMember']);
  const assignment = record(policy.assignment, ['mode', 'memberIds']); choice(assignment.mode, ['open', 'all', 'selected']);
  const members = ids(assignment.memberIds, assignment.mode !== 'selected', 16);
  if (assignment.mode !== 'selected' && members.length) throw new Error('Non-selected assignment cannot hide member IDs');
  if (policy.completion === 'perMember' && assignment.mode === 'open') throw new Error('Per-member chores require defined subjects');
  if ('targetMemberIds' in data) {
    if (policy.completion !== 'perMember' || assignment.mode !== 'all') throw new Error('Pinned subjects require an each-member policy');
    ids(data.targetMemberIds, true, 16);
  }
}

/** Explicit schema2 records; private Calendar, credentials and arbitrary extension fields are never accepted. */
export function validateV2EntityPayload(entityType: V2EntityType, payload: RecordValue, binding: {
  operationId: string; entityId: string; authorUserId: string; operationType: string;
}): void {
  if (binding.operationType !== 'patch') throw new Error('V2 facts and policy history cannot be deleted or restored');
  if (entityType === 'manualChunk') { validateManualChunk(payload, binding.entityId); return; }
  if (entityType === 'manualDocument') { validateManualDocument(payload, binding.entityId); return; }
  if (entityType === 'groupPolicy' || entityType === 'chorePolicy') {
    record(payload, ['configuration']);
    if (entityType === 'groupPolicy') { if (binding.entityId !== 'policy') throw new Error('Invalid group policy ID'); groupPolicy(payload.configuration); }
    else chorePolicy(payload.configuration);
    return;
  }
  if (entityType === 'datePermission') {
    record(payload, ['choreId', 'userId', 'enabled', 'rights']); assertSharedIdentifier(payload.choreId); assertSharedIdentifier(payload.userId); flag(payload.enabled);
    const rights = record(payload.rights, ['changeDate', 'changeOthers', 'changeBeforeWindow']); Object.values(rights).forEach(flag);
    if (!rights.changeDate && (rights.changeOthers || rights.changeBeforeWindow)) throw new Error('Date permission rights require changeDate');
    return;
  }
  // Each append-only business fact has its own identity. A patch cannot rewrite an older fact entity.
  if (binding.entityId !== binding.operationId) throw new Error('V2 fact identity must equal its operation ID');
  if (entityType === 'calendarEvent') { validateSharedCalendarPayload(payload, binding.operationId); return; }
  if (entityType === 'assignmentRule') {
    const required = ['choreId', 'memberIds', 'fromOccurrenceId', 'fromAnchorDate', 'scope', 'fixed', 'ruleVersion'];
    record(payload, [...required, 'basisRuleIds', 'reviewedAssignmentRequestIds'], required);
    if ('basisRuleIds' in payload) ids(payload.basisRuleIds);
    if ('reviewedAssignmentRequestIds' in payload) ids(payload.reviewedAssignmentRequestIds, false);
    assertSharedIdentifier(payload.choreId); ids(payload.memberIds, true, 16); assertSharedIdentifier(payload.fromOccurrenceId); day(payload.fromAnchorDate);
    choice(payload.scope, ['once', 'from']); flag(payload.fixed); integer(payload.ruleVersion, 1); return;
  }
  if (entityType === 'assignmentRequest') {
    record(payload, ['requesterUserId', 'choreId', 'anchorDate', 'occurrenceId', 'ruleVersion', 'originalMemberIds', 'originalAssignmentIds', 'originalClaimOperationIds', 'memberIds', 'scope', 'fixed', 'reference', 'timeZone']);
    if (payload.requesterUserId !== binding.authorUserId) throw new Error('Assignment requester mismatch');
    assertSharedIdentifier(payload.choreId); assertSharedIdentifier(payload.occurrenceId); day(payload.anchorDate); integer(payload.ruleVersion, 1);
    ids(payload.originalMemberIds, true, 16); ids(payload.originalAssignmentIds); ids(payload.originalClaimOperationIds); ids(payload.memberIds, true, 16);
    choice(payload.scope, ['once', 'from']); flag(payload.fixed); target(payload.reference);
    if (!isSharedTimeZone(payload.timeZone)) throw new Error('Invalid assignment request timezone'); return;
  }
  if (entityType === 'assignmentDecision') {
    record(payload, ['requestId', 'decision']); assertSharedIdentifier(payload.requestId); choice(payload.decision, ['approve', 'reject']); return;
  }
  if (entityType === 'assignmentCancel') { record(payload, ['targetOperationIds']); ids(payload.targetOperationIds, false); return; }
  if (entityType === 'claim' || entityType === 'claimRelease') {
    record(payload, entityType === 'claim' ? ['choreId', 'anchorDate', 'occurrenceId', 'userId'] : ['choreId', 'anchorDate', 'occurrenceId', 'userId', 'targetOperationIds']);
    assertSharedIdentifier(payload.choreId); day(payload.anchorDate); assertSharedIdentifier(payload.occurrenceId);
    if (payload.userId !== binding.authorUserId) throw new Error('A claim cannot impersonate another member');
    if (entityType === 'claimRelease') ids(payload.targetOperationIds, false); return;
  }
  if (entityType === 'claimResolution') {
    record(payload, ['choreId', 'anchorDate', 'occurrenceId', 'claimOperationIds', 'assigneeIds', 'fixed']);
    assertSharedIdentifier(payload.choreId); day(payload.anchorDate); assertSharedIdentifier(payload.occurrenceId);
    ids(payload.claimOperationIds, false); ids(payload.assigneeIds, false, 16); flag(payload.fixed); return;
  }
  if (entityType === 'designation') {
    record(payload, ['configuration']);
    const required = ['id', 'choreId', 'subjectUserId', 'selector', 'referenceAnchorDate', 'timeZoneAtCreation', 'mode', 'target', 'strict', 'adminLocked', 'forbidEarlier', 'issuerUserId', 'ruleVersion'];
    const data = record(payload.configuration, [...required, 'basisRuleIds', 'reviewedRequestIds', 'allowDuringCooldown'], required);
    if ('basisRuleIds' in data) ids(data.basisRuleIds);
    if ('reviewedRequestIds' in data) ids(data.reviewedRequestIds, false);
    if ('allowDuringCooldown' in data) flag(data.allowDuringCooldown);
    if (data.id !== binding.operationId || data.issuerUserId !== binding.authorUserId) throw new Error('A designation cannot impersonate another issuer');
    assertSharedIdentifier(data.choreId); idOrNull(data.subjectUserId); selector(data.selector); day(data.referenceAnchorDate); choice(data.mode, ['deadline', 'day', 'fixed']);
    if ((data.selector as RecordValue).scope === 'once' && (data.selector as RecordValue).anchorDate !== data.referenceAnchorDate) throw new Error('One-off designation anchor mismatch');
    if (!isSharedTimeZone(data.timeZoneAtCreation)) throw new Error('Invalid designation timezone');
    validateDesignationTarget(data.mode as 'deadline' | 'day' | 'fixed', data.target as DateTarget);
    flag(data.strict); flag(data.adminLocked); flag(data.forbidEarlier); integer(data.ruleVersion, 1); return;
  }
  if (entityType === 'designationCancel') {
    record(payload, ['targetOperationIds', 'selector'], ['targetOperationIds']); ids(payload.targetOperationIds, false);
    if ('selector' in payload) selector(payload.selector); return;
  }
  if (entityType === 'changeRequest') {
    const required = ['requesterUserId', 'choreId', 'anchorDate', 'occurrenceId', 'subjectUserId', 'originalDesignationId', 'original', 'proposed', 'proposedMode', 'proposedOptions', 'selector', 'extensionScope'];
    record(payload, [...required, 'basisRuleIds', 'reviewedRequestIds', 'cancellation'], required);
    if ('basisRuleIds' in payload) ids(payload.basisRuleIds);
    if ('reviewedRequestIds' in payload) ids(payload.reviewedRequestIds, false);
    if (payload.requesterUserId !== binding.authorUserId) throw new Error('Request author mismatch');
    assertSharedIdentifier(payload.choreId); day(payload.anchorDate); assertSharedIdentifier(payload.occurrenceId); idOrNull(payload.subjectUserId); idOrNull(payload.originalDesignationId);
    if (payload.original !== null) target(payload.original); choice(payload.proposedMode, ['deadline', 'day', 'fixed']);
    validateDesignationTarget(payload.proposedMode as 'deadline' | 'day' | 'fixed', payload.proposed as unknown as DateTarget);
    Object.values(record(payload.proposedOptions, ['strict', 'adminLocked', 'forbidEarlier', 'allowDuringCooldown'], ['strict', 'adminLocked', 'forbidEarlier'])).forEach(flag);
    selector(payload.selector); choice(payload.extensionScope, ['once', 'future']);
    if ('cancellation' in payload) {
      const cancellation = record(payload.cancellation, ['targetOperationIds', 'selector']); ids(cancellation.targetOperationIds, false);
      if (cancellation.selector !== null) selector(cancellation.selector);
      if (payload.extensionScope !== 'once') throw new Error('A cancellation cannot extend a common execution window');
    }
    return;
  }
  if (entityType === 'requestDecision') {
    const required = ['requestId', 'decision', 'target', 'referenceDecisionId'];
    record(payload, [...required, 'allowDuringCooldown'], required); assertSharedIdentifier(payload.requestId);
    choice(payload.decision, ['approve', 'reject', 'counteroffer', 'acceptCounteroffer']); idOrNull(payload.referenceDecisionId);
    if (payload.decision === 'counteroffer') target(payload.target); else if (payload.target !== null) throw new Error('Only a counteroffer supplies a target');
    if ('allowDuringCooldown' in payload && (payload.decision !== 'counteroffer' || payload.allowDuringCooldown !== true)) throw new Error('Only a counteroffer may add an explicit recent-work exception');
    if ((payload.decision === 'acceptCounteroffer') !== (payload.referenceDecisionId !== null)) throw new Error('Counteroffer acceptance needs exactly its proposal reference'); return;
  }
  if (entityType === 'completionApproval') { record(payload, ['completionOperationId', 'decision']); assertSharedIdentifier(payload.completionOperationId); choice(payload.decision, ['approve', 'reject']); return; }
  if (entityType === 'migration') {
    record(payload, ['legacyFrontier', 'sourceSnapshotDigest', 'groupKind', 'schedulerVersion']);
    const frontier = record(payload.legacyFrontier, Object.keys(payload.legacyFrontier as object));
    if (Object.keys(frontier).length > 256) throw new Error('Invalid migration frontier');
    for (const [device, count] of Object.entries(frontier)) { assertSharedIdentifier(device); integer(count); }
    if (typeof payload.sourceSnapshotDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.sourceSnapshotDigest) || (typeof payload.schedulerVersion !== 'string' || !isSupportedV2Scheduler(payload.schedulerVersion))) throw new Error('Invalid migration proof');
    choice(payload.groupKind, ['family', 'roommates']); return;
  }
  throw new Error('Unknown v2 entity');
}

export function validateV2CompletionPayload(payload: RecordValue, operationType: string, recordedAt: string): void {
  if (operationType === 'undo') { record(payload, ['targetOperationId']); assertSharedIdentifier(payload.targetOperationId); return; }
  if (operationType !== 'complete') throw new Error('V2 completion facts are immutable');
  const required = ['choreId', 'anchorDate', 'completedAt', 'completedByMemberId', 'subjectUserId', 'originalAssigneeIds', 'ruleVersion', 'outcome'];
  record(payload, [...required, 'scheduledDate', 'scheduledWindowStart', 'scheduledWindowEnd', 'completedLocalDate', 'completionNote', 'recordedInstruction', 'recordedCommonWindow'], required);
  assertSharedIdentifier(payload.choreId); day(payload.anchorDate); assertSharedIdentifier(payload.completedByMemberId); idOrNull(payload.subjectUserId);
  ids(payload.originalAssigneeIds, true, 16); integer(payload.ruleVersion, 1); choice(payload.outcome, ['completed', 'incomplete']); timestamp(payload.completedAt);
  if (instantMilliseconds(payload.completedAt as string) > instantMilliseconds(recordedAt)) throw new Error('Actual work cannot be recorded before it took place');
  for (const field of ['scheduledDate', 'scheduledWindowStart', 'scheduledWindowEnd', 'completedLocalDate']) if (field in payload) day(payload[field]);
  if ('completionNote' in payload) choice(payload.completionNote, ['completedNow', 'alreadyDone']);
  if (payload.scheduledWindowStart && payload.scheduledWindowEnd && payload.scheduledWindowStart > payload.scheduledWindowEnd) throw new Error('Invalid completion window');
  if ('recordedCommonWindow' in payload) {
    const window = record(payload.recordedCommonWindow, ['start', 'end']); day(window.start); day(window.end);
    if ((window.start as string) > (window.end as string) || !['scheduledDate', 'scheduledWindowStart', 'scheduledWindowEnd', 'recordedInstruction'].every((key) => Object.hasOwn(payload, key))) throw new Error('Incomplete recorded common schedule');
  }
  if ('recordedInstruction' in payload) {
    const info = record(payload.recordedInstruction, ['kind', 'timeZone', 'ruleId', 'mode', 'target', 'strict', 'reason'], ['kind', 'timeZone']);
    if (!isSharedTimeZone(info.timeZone)) throw new Error('Invalid recorded instruction timezone');
    if (info.kind === 'automatic') record(info, ['kind', 'timeZone']);
    else if (info.kind === 'designated') {
      record(info, ['kind', 'timeZone', 'ruleId', 'mode', 'target', 'strict']); assertSharedIdentifier(info.ruleId);
      choice(info.mode, ['deadline', 'day', 'fixed']); flag(info.strict); validateDesignationTarget(info.mode as 'deadline' | 'day' | 'fixed', info.target as unknown as DateTarget);
    } else if (info.kind === 'unconfirmed') { record(info, ['kind', 'timeZone', 'reason']); choice(info.reason, ['dateConflict', 'cycleChanged', 'timeZoneChanged', 'invalidInterval', 'ambiguousTime']); }
    else throw new Error('Invalid recorded instruction');
  }
}
