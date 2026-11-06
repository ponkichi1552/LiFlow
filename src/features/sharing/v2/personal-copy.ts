import type { ChoreDefinition, FrequencyMode } from '../../../domain/chores/types';
import type { LocalDate } from '../../../domain/shared/types';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { JsonValue, SharedOperation } from '../operations';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger';
import { validateSharedOperation } from '../operations.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { chorePolicyFromPreset } from './model.ts';
import type { SharedChoreConfiguration } from './model';

export interface V2PersonalCopySource {
  scope: 'personal'; ownerUserId: string; householdId: string; frequencyMode: FrequencyMode; chores: readonly ChoreDefinition[];
}
export interface V2PersonalCopyContext {
  userId: string; groupId: string; administratorUserId: string; rosterDigest: string; groupName: string; timeZone: string;
}
export interface V2PersonalCopyRecord {
  personalChoreId: string; sharedChoreId: string; choreOperationId: string; configurationOperationId: string;
  fields: Record<string, JsonValue>; configuration: SharedChoreConfiguration | null;
}
export interface V2PersonalCopyReview {
  schemaVersion: 1; id: string; ownerUserId: string; groupId: string; contextDigest: string;
  anchorDate: LocalDate; preset: 'common' | 'eachMember'; sourceFingerprint: string;
  createdAt: string; records: V2PersonalCopyRecord[]; digest: string;
}
// Parent appliance IDs are local references. Public maker evidence remains visible in the review.
const copyFields = ['name', 'category', 'description',
  'manufacturerRecommendedIntervalDays', 'manufacturerRecommendedConditions', 'requiresCycleSelection', 'schedulingNotes', 'load',
  'locationOrAppliance', 'laundryDryingPreference', 'instructions', 'procedureSections', 'tools', 'cautions', 'trivia',
  'sourceNotes', 'estimatedMinutes', 'applianceCareSource', 'applianceTaskName'] as const;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function v2PersonalCopyContextDigest(context: V2PersonalCopyContext) {
  return sharedDocumentDigest(context);
}
function selected(source: V2PersonalCopySource, context: V2PersonalCopyContext, ids: readonly string[]) {
  if (source.scope !== 'personal' || source.ownerUserId !== context.userId || source.householdId !== 'local-household'
    || context.administratorUserId !== context.userId) throw new Error('本人の個人設定と、共有グループの管理者を確認してください。');
  if (!['frequent', 'balanced', 'relaxed'].includes(source.frequencyMode) || !Array.isArray(ids) || !ids.length || ids.length > 20
    || ids.some(id => typeof id !== 'string' || !id.length || id.length > 512 || id.includes('\0'))
    || new Set(ids).size !== ids.length || new Set(source.chores.map(chore => chore.id)).size !== source.chores.length) throw new Error('コピーする家事を1〜20件選び直してください。');
  return [...ids].sort().map(id => {
    const chore = source.chores.find(chore => chore.id === id);
    if (!chore || chore.householdId !== source.householdId || chore.archived) throw new Error('選択した個人家事が変更されています。');
    const fields: Record<string, JsonValue> = {};
    for (const name of copyFields) if (chore[name] !== undefined) fields[name] = clone(chore[name]) as JsonValue;
    fields.enabled = chore.requiresCycleSelection === true ? false : chore.enabled;
    fields.archived = false;
    const interval = chore.requiresCycleSelection ? null : chore.userIntervalDays ?? chore.recommendedCycleDays
      ?? chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[source.frequencyMode] ?? null;
    if (interval !== null && (!Number.isSafeInteger(interval) || interval < 1 || interval > 3650)) throw new Error('コピーする周期を確認してください。');
    const radius = chore.everyday === true && interval === 1 ? 0 : chore.windowRadiusDays;
    if (typeof chore.enabled !== 'boolean' || typeof chore.everyday !== 'boolean' || !Number.isSafeInteger(radius) || radius < 0 || radius > 14) throw new Error('コピーする実施期間を確認してください。');
    return { personalChoreId: id, fields, interval, radius };
  });
}
export function v2PersonalCopySourceFingerprint(source: V2PersonalCopySource, context: V2PersonalCopyContext, ids: readonly string[]) {
  return sharedDocumentDigest(selected(source, context, ids).map(row => sharedDocumentDigest(row)));
}
function reviewDigest(review: Omit<V2PersonalCopyReview, 'digest'>) {
  const { records, ...header } = review;
  return sharedDocumentDigest({ ...header, records: records.map(record => sharedDocumentDigest(record)) });
}
export function v2PersonalCopyDrafts(review: V2PersonalCopyReview): SharedOperationDraft[] {
  return review.records.flatMap(record => [
    { operationId: record.choreOperationId, entityType: 'chore' as const, entityId: record.sharedChoreId,
      operationType: 'patch' as const, payload: clone(record.fields) },
    ...(record.configuration ? [{ operationId: record.configurationOperationId, entityType: 'chorePolicy' as const,
      entityId: record.sharedChoreId, operationType: 'patch' as const,
      payload: { configuration: clone(record.configuration) as unknown as JsonValue } }] : []),
  ]);
}
export function prepareV2PersonalCopy(source: V2PersonalCopySource, context: V2PersonalCopyContext,
  ids: readonly string[], preset: 'common' | 'eachMember', makeId: () => string, now: Date): V2PersonalCopyReview {
  for (const id of [context.userId, context.groupId, context.administratorUserId]) assertSharedIdentifier(id);
  if (!['common', 'eachMember'].includes(preset) || !/^[a-f0-9]{64}$/u.test(context.rosterDigest)
    || typeof context.groupName !== 'string' || !context.groupName.trim()) throw new Error('コピー先の共有設定を確認してください。');
  const anchorDate = sharedLocalDate(now, context.timeZone);
  const records = selected(source, context, ids).map(({ personalChoreId, fields, interval, radius }): V2PersonalCopyRecord => ({
    personalChoreId, fields, sharedChoreId: makeId(), choreOperationId: makeId(), configurationOperationId: makeId(),
    configuration: interval === null ? null : { policy: chorePolicyFromPreset(preset), anchorDate, intervalDays: interval,
      windowBeforeDays: radius, windowAfterDays: radius,
      ruleVersion: 1, effectiveFrom: anchorDate, active: fields.enabled as boolean },
  }));
  const body: Omit<V2PersonalCopyReview, 'digest'> = { schemaVersion: 1, id: makeId(), ownerUserId: context.userId, groupId: context.groupId,
    contextDigest: v2PersonalCopyContextDigest(context), anchorDate, preset,
    sourceFingerprint: v2PersonalCopySourceFingerprint(source, context, ids), createdAt: now.toISOString(), records };
  const review = { ...body, digest: reviewDigest(body) };
  validateV2PersonalCopyReview(review, context); return review;
}
/** No source completion, Google mapping, private parent ID or baseline is emitted as a shared fact. */
export function validateV2PersonalCopyReview(value: V2PersonalCopyReview, context: Pick<V2PersonalCopyContext, 'userId' | 'groupId'>): V2PersonalCopyReview {
  const review = clone(value); const { digest, ...body } = review;
  const names = ['schemaVersion', 'id', 'ownerUserId', 'groupId', 'contextDigest', 'anchorDate', 'preset', 'sourceFingerprint', 'createdAt', 'records', 'digest'];
  if (Object.keys(review).length !== names.length || Object.keys(review).some(name => !names.includes(name))) throw new Error('コピーの保存形式を確認してください。');
  if (review.schemaVersion !== 1 || review.ownerUserId !== context.userId || review.groupId !== context.groupId
    || !Array.isArray(review.records) || !review.records.length || review.records.length > 20 || digest !== reviewDigest(body)
    || !['common', 'eachMember'].includes(review.preset) || !/^[a-f0-9]{64}$/u.test(review.sourceFingerprint)
    || !/^[a-f0-9]{64}$/u.test(review.contextDigest)) throw new Error('確認したコピー内容を読み直してください。');
  assertSharedIdentifier(review.id); parseLocalDate(review.anchorDate);
  const draftIds = new Set<string>(); const choreIds = new Set<string>();
  for (const record of review.records) {
    if (Object.keys(record).sort().join(',') !== 'choreOperationId,configuration,configurationOperationId,fields,personalChoreId,sharedChoreId') throw new Error('コピーの保存形式を確認してください。');
    if (choreIds.has(record.sharedChoreId) || Object.keys(record.fields).some(name => ![...copyFields, 'enabled', 'archived'].includes(name as typeof copyFields[number]))) throw new Error('コピーの保存形式を確認してください。');
    choreIds.add(record.sharedChoreId);
  }
  for (const draft of v2PersonalCopyDrafts(review)) {
    if (draftIds.has(draft.operationId)) throw new Error('コピーの操作番号を確認してください。'); draftIds.add(draft.operationId);
    validateSharedOperation({ ...draft, schemaVersion: 2, groupId: context.groupId, authorUserId: context.userId,
      authorDeviceId: 'copy-preview-validation', deviceSequence: 1, logicalClock: 1, context: {}, receiptContext: {},
      keyVersion: 1, recordedAt: review.createdAt } as SharedOperation, context.groupId);
  }
  return review;
}

/** Confirmation rechecks the original private fields and audience; completion-only edits are irrelevant. */
export function validateV2PersonalCopyAgainstSource(value: V2PersonalCopyReview, context: V2PersonalCopyContext,
  source: V2PersonalCopySource, now: Date): V2PersonalCopyReview {
  const review = validateV2PersonalCopyReview(value, context);
  if (review.contextDigest !== v2PersonalCopyContextDigest(context) || review.anchorDate !== sharedLocalDate(now, context.timeZone)) throw new Error('コピー先の参加者・地域・日付が変わりました。内容をもう一度確認してください。');
  const ids = review.records.flatMap(row => [row.sharedChoreId, row.choreOperationId, row.configurationOperationId]); ids.push(review.id);
  const rebuilt = prepareV2PersonalCopy(source, context, review.records.map(row => row.personalChoreId), review.preset,
    () => ids.shift()!, new Date(review.createdAt));
  if (ids.length || rebuilt.digest !== review.digest) throw new Error('確認後に個人設定が変わりました。コピーする内容を読み直してください。');
  return review;
}
