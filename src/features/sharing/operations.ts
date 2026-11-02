import { isSharedTimeZone } from './group-clock.ts';
import { assertSharedIdentifier } from './identifier.ts';
import { V2_ENTITY_TYPES, validateV2CompletionPayload, validateV2EntityPayload } from './v2/payload-schema.ts';
import type { V2EntityType } from './v2/payload-schema.ts';
import { instantMilliseconds } from './v2/date-target.ts';
export { assertSharedIdentifier } from './identifier.ts';
/** The wire payload is deliberately independent of Expo, Firebase and personal Google state. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type VersionVector = Record<string, number>;
export type LegacySharedEntityType = 'chore' | 'baseline' | 'settings' | 'assignment' | 'dependency'
  | 'waste' | 'wasteVisibility' | 'appliance' | 'member' | 'completion';
export type SharedEntityType = LegacySharedEntityType | V2EntityType;
export type SharedOperationType = 'patch' | 'delete' | 'restore' | 'complete' | 'undo';

export interface SharedOperation {
  schemaVersion: 1 | 2;
  /** Schema2 records the original operation time. Delivery time is an independent server receipt. */
  recordedAt?: string;
  /** Schema2 distinguishes knowing a pending fact from observing its server-confirmed acceptance. */
  receiptContext?: VersionVector;
  operationId: string;
  groupId: string;
  authorUserId: string;
  authorDeviceId: string;
  deviceSequence: number;
  logicalClock: number;
  context: VersionVector;
  keyVersion: number;
  entityType: SharedEntityType;
  entityId: string;
  operationType: SharedOperationType;
  payload: Record<string, JsonValue>;
}

export const SHARED_SCHEMA_VERSION = 1;
export const SHARED_SCHEDULER_VERSION = 'liflow-shared-1';
export const MAX_OPERATION_BYTES = 192 * 1024;
const FORBIDDEN_FIELDS = new Set(['proto', 'constructor', 'prototype', 'accesstoken', 'refreshtoken',
  'idtoken', 'apikey', 'privatekey', 'clientsecret', 'signingsecretkey', 'agreementsecretkey', 'groupkey',
  'recoverysecret', 'authorization', 'googletaskid', 'googletasklistid', 'freebusy', 'pdfbase64']);
const OPERATION_FIELDS = new Set(['schemaVersion', 'operationId', 'groupId', 'authorUserId', 'authorDeviceId',
  'deviceSequence', 'logicalClock', 'context', 'keyVersion', 'entityType', 'entityId', 'operationType', 'payload', 'recordedAt', 'receiptContext']);
const FIELDS: Record<LegacySharedEntityType, Set<string>> = {
  chore: new Set(['name', 'category', 'description', 'enabled', 'recommendedCycleDays', 'userIntervalDays',
    'manufacturerRecommendedIntervalDays', 'manufacturerRecommendedConditions', 'requiresCycleSelection',
    'frequencyDaysByMode', 'schedulingNotes', 'windowRadiusDays', 'maxShiftDays', 'load', 'holidayPriority',
    'everyday', 'locationOrAppliance', 'laundryDryingPreference', 'instructions', 'procedureSections', 'tools',
    'cautions', 'trivia', 'sourceNotes', 'archived', 'estimatedMinutes', 'applianceCareSource', 'applianceId', 'applianceTaskName']),
  baseline: new Set(['lastCompletedDate', 'lastCompletedEstimated', 'initialPending', 'initialScheduledDate', 'unknownReason']),
  settings: new Set(['name', 'frequencyMode', 'restDays', 'heavyDailyLimit', 'normalDailyLimit', 'timeZone', 'anchorDate']),
  assignment: new Set(['choreId', 'memberIds']),
  dependency: new Set(['predecessorChoreId', 'successorChoreId', 'policyData']),
  waste: new Set(['label', 'collectionWeekdays', 'recurrence', 'anchorDate', 'monthlyDay']),
  wasteVisibility: new Set(['scheduleId', 'date', 'hidden']),
  appliance: new Set(['manufacturer', 'productName', 'modelNumber', 'category', 'displayName',
    'officialProductUrl', 'officialManualUrl', 'analysis', 'reviewed', 'createdAt', 'updatedAt']),
  member: new Set(['displayName', 'userId']),
  completion: new Set(['choreId', 'completedAt', 'completedByMemberId', 'scheduledDate', 'scheduledWindowStart',
    'scheduledWindowEnd', 'completedLocalDate', 'completionNote', 'estimatedDate', 'outcome', 'targetOperationId']),
};

export function assertJsonRecord(value: unknown): asserts value is Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected a JSON object');
}

/** Stable byte representation for signatures, equality and operation-ID collision detection. */
const quotedCanonicalKeys = new Map<string, string>();
function canonicalPropertyKey(key: string): string {
  const cached = quotedCanonicalKeys.get(key);
  if (cached !== undefined) return cached;
  if (FORBIDDEN_FIELDS.has(key.replace(/[_\s-]/gu, '').toLowerCase())) throw new Error('Private or unsafe field in shared payload');
  const quoted = JSON.stringify(key);
  // Only immutable property-name validation/escaping is reused. Values, object
  // shape, nesting and size limits are checked again on every serialization.
  if (key.length <= 256) {
    if (quotedCanonicalKeys.size >= 512) quotedCanonicalKeys.delete(quotedCanonicalKeys.keys().next().value!);
    quotedCanonicalKeys.set(key, quoted);
  }
  return quoted;
}
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Shared payload is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error('Shared array is too large');
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  assertJsonRecord(value);
  const keys = Object.keys(value).sort();
  if (keys.length > 512) throw new Error('Shared object is too large');
  return `{${keys.map((key) => {
    return `${canonicalPropertyKey(key)}:${canonicalJson(value[key], depth + 1)}`;
  }).join(',')}}`;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validatePatchValues(entityType: LegacySharedEntityType, patch: Record<string, JsonValue>, schemaVersion: number): void {
  const booleans = new Set(['enabled', 'requiresCycleSelection', 'holidayPriority', 'everyday', 'archived',
    'lastCompletedEstimated', 'initialPending', 'hidden', 'reviewed', 'estimatedDate']);
  const cycles = new Set(['recommendedCycleDays', 'userIntervalDays', 'manufacturerRecommendedIntervalDays']);
  const strings = new Set(['name', 'category', 'description', 'schedulingNotes', 'locationOrAppliance', 'applianceTaskName',
    'manufacturer', 'productName', 'modelNumber', 'displayName', 'label', 'officialProductUrl', 'officialManualUrl']);
  const identifiers = new Set(['applianceId', 'choreId', 'userId', 'scheduleId', 'predecessorChoreId',
    'successorChoreId', 'completedByMemberId', 'targetOperationId']);
  const stringArrays = new Set(['manufacturerRecommendedConditions', 'instructions', 'tools', 'cautions', 'sourceNotes']);
  const dates = new Set(['lastCompletedDate', 'initialScheduledDate', 'anchorDate', 'date', 'scheduledDate',
    'scheduledWindowStart', 'scheduledWindowEnd', 'completedLocalDate']);
  const optionalFields = new Set(['recommendedCycleDays', 'userIntervalDays', 'manufacturerRecommendedIntervalDays',
    'manufacturerRecommendedConditions', 'schedulingNotes', 'locationOrAppliance', 'laundryDryingPreference', 'procedureSections',
    'trivia', 'sourceNotes', 'estimatedMinutes', 'applianceCareSource', 'applianceId', 'applianceTaskName', 'unknownReason',
    'officialProductUrl', 'officialManualUrl', 'monthlyDay', 'policyData']);
  const enums: Record<string, string[]> = { load: ['light', 'normal', 'heavy'],
    frequencyMode: ['frequent', 'balanced', 'relaxed'], laundryDryingPreference: ['indoors', 'outdoors', 'either'],
    recurrence: ['weekly', 'biweekly', 'monthly'], unknownReason: ['unknown', 'skipped'],
    outcome: ['completed', 'incomplete'], completionNote: ['completedNow', 'alreadyDone'] };
  for (const [field, value] of Object.entries(patch)) {
    if (entityType === 'waste' && field === 'anchorDate' && value === null) continue;
    if (value === null && optionalFields.has(field)) continue;
    let valid = true;
    if (booleans.has(field)) valid = typeof value === 'boolean';
    else if (cycles.has(field)) valid = value === null || integer(value, 1, 3650);
    else if (strings.has(field)) valid = typeof value === 'string' && value.length <= 100_000
      && (!['name', 'label', 'displayName'].includes(field) || (value.trim().length > 0 && value.length <= 500));
    else if (identifiers.has(field)) { assertSharedIdentifier(value); }
    else if (stringArrays.has(field)) valid = Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 20_000);
    else if (dates.has(field)) valid = (value === null && ['lastCompletedDate', 'initialScheduledDate'].includes(field))
      || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
        && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
    else if (Object.hasOwn(enums, field)) valid = typeof value === 'string' && enums[field].includes(value);
    else if (field === 'frequencyDaysByMode') {
      assertJsonRecord(value);
      valid = Object.keys(value).sort().join(',') === 'balanced,frequent,relaxed' && Object.values(value).every((item) => integer(item, 1, 3650));
    } else if (field === 'windowRadiusDays') valid = integer(value, 0, 14);
    else if (field === 'maxShiftDays') valid = integer(value, 0, 3650);
    else if (field === 'estimatedMinutes') valid = integer(value, 1, 24 * 60);
    else if (field === 'monthlyDay') valid = integer(value, 1, 31);
    else if (field === 'heavyDailyLimit' || field === 'normalDailyLimit') valid = integer(value, 0, 100);
    else if (field === 'restDays' || field === 'collectionWeekdays') valid = Array.isArray(value)
      && value.length <= 7 && new Set(value).size === value.length && value.every((item) => integer(item, 1, 7));
    else if (field === 'memberIds') {
      valid = Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length;
      if (valid) for (const id of value as JsonValue[]) assertSharedIdentifier(id);
    } else if (field === 'timeZone') {
      valid = isSharedTimeZone(value);
    } else if (['completedAt', 'createdAt', 'updatedAt'].includes(field)) valid = typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
    else if (field === 'procedureSections' || field === 'trivia') valid = Array.isArray(value) && value.every((item) => {
      assertJsonRecord(item);
      return field === 'procedureSections'
        ? Object.keys(item).sort().join(',') === 'steps,title' && typeof item.title === 'string'
          && Array.isArray(item.steps) && item.steps.every((step) => typeof step === 'string')
        : Object.keys(item).sort().join(',') === 'body,id,title' && ['id', 'title', 'body'].every((key) => typeof item[key] === 'string');
    });
    else if (field === 'analysis') {
      assertJsonRecord(value);
      valid = Object.keys(value).every((key) => ['manufacturer', 'model', 'tasks', 'analyzedAt', 'requiresUserReview', ...(schemaVersion === 2 ? ['manualSource'] : [])].includes(key))
        && (value.manualSource === undefined || schemaVersion === 2 && value.manualSource !== null && typeof value.manualSource === 'object' && !Array.isArray(value.manualSource)
          && Object.keys(value.manualSource).sort().join(',') === 'kind,sha256' && value.manualSource.kind === 'user_upload' && typeof value.manualSource.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.manualSource.sha256))
        && typeof value.manufacturer === 'string' && typeof value.model === 'string' && value.requiresUserReview === true
        && typeof value.analyzedAt === 'string' && Number.isFinite(Date.parse(value.analyzedAt)) && Array.isArray(value.tasks)
        && value.tasks.every((item) => {
          assertJsonRecord(item);
          return Object.keys(item).every((key) => ['name', 'recommendedIntervalDays', 'recommendedConditions', 'steps', 'tools',
            'safetyCautions', 'estimatedMinutes', 'evidence'].includes(key)) && typeof item.name === 'string'
            && ['steps', 'tools', 'safetyCautions'].every((key) => Array.isArray(item[key]) && (item[key] as JsonValue[]).every((part) => typeof part === 'string'))
            && Array.isArray(item.evidence) && item.evidence.every((source) => { assertJsonRecord(source);
              return Object.keys(source).every((key) => ['url', 'pageOrSection'].includes(key)) && typeof source.url === 'string'; });
        });
    } else if (field === 'applianceCareSource') {
      assertJsonRecord(value);
      valid = Object.keys(value).every((key) => ['manufacturer', 'productName', 'modelNumber', 'productUrl', 'manualUrl', 'analyzedAt', 'evidence'].includes(key))
        && ['manufacturer', 'productName', 'modelNumber', 'manualUrl', 'analyzedAt'].every((key) => typeof value[key] === 'string')
        && Array.isArray(value.evidence);
    } else if (field === 'policyData') valid = value === null || (typeof value === 'object' && !Array.isArray(value));
    else valid = false;
    if (!valid) throw new Error(`Invalid shared ${entityType} field: ${field}`);
  }
}

export function validateSharedOperation(value: unknown, expectedGroupId?: string): SharedOperation {
  assertJsonRecord(value);
  if (Object.keys(value).some((key) => !OPERATION_FIELDS.has(key)) || value.schemaVersion === 1 && ['recordedAt', 'receiptContext'].some((key) => Object.hasOwn(value, key))) throw new Error('Unknown operation field');
  if (value.schemaVersion !== SHARED_SCHEMA_VERSION && value.schemaVersion !== 2) throw new Error('Unsupported shared schema version');
  if (value.schemaVersion === 2) {
    if (typeof value.recordedAt !== 'string') throw new Error('Schema2 needs its original operation time');
    instantMilliseconds(value.recordedAt);
    assertJsonRecord(value.receiptContext);
  }
  for (const key of ['operationId', 'groupId', 'authorUserId', 'authorDeviceId', 'entityId']) assertSharedIdentifier(value[key]);
  if (expectedGroupId && value.groupId !== expectedGroupId) throw new Error('Shared group mismatch');
  if (!integer(value.deviceSequence, 1) || !integer(value.logicalClock, 1) || !integer(value.keyVersion, 1)) {
    throw new Error('Invalid operation clock or key version');
  }
  assertJsonRecord(value.context);
  if (Object.keys(value.context).length > 256) throw new Error('Too many causal devices');
  for (const [device, count] of Object.entries(value.context)) {
    assertSharedIdentifier(device);
    if (!integer(count) || count >= value.logicalClock) throw new Error('Invalid causal clock');
  }
  if ((value.context[value.authorDeviceId as string] ?? 0) !== value.deviceSequence - 1) {
    throw new Error('Invalid author sequence');
  }
  if (Object.hasOwn(value, 'receiptContext')) {
    assertJsonRecord(value.receiptContext);
    if (Object.keys(value.receiptContext).length > 256) throw new Error('Too many confirmed receipt devices');
    for (const [device, count] of Object.entries(value.receiptContext)) {
      assertSharedIdentifier(device);
      if (!integer(count) || count > (value.context[device] as number ?? 0)) throw new Error('Receipt context must be part of the observed operation context');
    }
  }
  const legacy = typeof value.entityType === 'string' && Object.hasOwn(FIELDS, value.entityType);
  const version2 = value.schemaVersion === 2 && typeof value.entityType === 'string' && (V2_ENTITY_TYPES as readonly string[]).includes(value.entityType);
  if (!legacy && !version2) throw new Error('Unknown shared entity type');
  const entityType = value.entityType as SharedEntityType;
  if (!['patch', 'delete', 'restore', 'complete', 'undo'].includes(value.operationType as string)) throw new Error('Unknown shared operation');
  assertJsonRecord(value.payload);
  const fields = Object.keys(value.payload);
  if (version2) validateV2EntityPayload(entityType as V2EntityType, value.payload, { operationId: value.operationId as string,
    entityId: value.entityId as string, authorUserId: value.authorUserId as string, operationType: value.operationType as string });
  else if (value.schemaVersion === 2 && entityType === 'completion') validateV2CompletionPayload(value.payload, value.operationType as string, value.recordedAt as string);
  else {
    if (fields.some((field) => !FIELDS[entityType as LegacySharedEntityType].has(field))) throw new Error('Field is not shared');
    validatePatchValues(entityType as LegacySharedEntityType, value.payload, value.schemaVersion as number);
  }
  if (entityType === 'completion') {
    if (value.operationType === 'complete') {
      assertSharedIdentifier(value.payload.choreId);
      if (typeof value.payload.completedAt !== 'string' || !Number.isFinite(Date.parse(value.payload.completedAt))) {
        throw new Error('Invalid completion timestamp');
      }
      if ('targetOperationId' in value.payload || !['completed', 'incomplete'].includes(value.payload.outcome as string)) {
        throw new Error('Invalid completion');
      }
    } else if (value.operationType === 'undo') {
      assertSharedIdentifier(value.payload.targetOperationId);
      if (fields.length !== 1) throw new Error('Undo must name exactly one completion');
    } else throw new Error('Completion history is immutable');
  } else {
    if (!['patch', 'delete', 'restore'].includes(value.operationType as string)) throw new Error('Invalid entity operation');
    if (value.operationType === 'delete' && fields.length) throw new Error('Delete cannot contain a patch');
    if (value.operationType !== 'delete' && !fields.length) throw new Error('Empty shared patch');
    if (entityType === 'appliance' && 'analysis' in value.payload && value.payload.reviewed !== true) {
      throw new Error('Appliance analysis needs explicit user review');
    }
  }
  const encoded = canonicalJson(value);
  if (new TextEncoder().encode(encoded).length > MAX_OPERATION_BYTES) throw new Error('Shared operation is too large');
  // Detach caller-owned objects before an async write or signature can observe later mutations.
  return JSON.parse(encoded) as SharedOperation;
}

export function causallyPrecedes(left: Pick<SharedOperation, 'authorDeviceId' | 'deviceSequence'>, right: Pick<SharedOperation, 'context'>): boolean {
  return (right.context[left.authorDeviceId] ?? 0) >= left.deviceSequence;
}

export function compareOperationIds(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
