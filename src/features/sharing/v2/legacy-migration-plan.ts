import { assertSharedIdentifier, canonicalJson, compareOperationIds, validateSharedOperation } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { sharedLocalDate } from '../group-clock.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';
import type { GroupPolicy, SharedChoreConfiguration } from './model.ts';
import { readVerifiedLegacyMigrationSnapshot, readVerifiedLegacyMigrationSource, verifiedLegacyMigrationPin } from './legacy-migration-source.ts';
import type { VerifiedLegacyMigration } from './legacy-migration-source.ts';
import { V2_SCHEDULER_VERSION, isSupportedV2Scheduler } from './payload-schema.ts';

type ConfigurationChoice = Pick<SharedChoreConfiguration, 'policy' | 'anchorDate' | 'intervalDays' | 'windowBeforeDays' | 'windowAfterDays'> & { active: boolean };
export type LegacyMigrationChoreChoice = { choreId: string; kind: 'keepDisabled' }
  | { choreId: string; kind: 'configure'; configuration: ConfigurationChoice };
export interface LegacyMigrationPlan {
  schemaVersion: 1; schedulerVersion: string; id: string; userId: string; groupId: string; createdAt: string; effectiveFrom: LocalDate;
  sourcePin: { sourceSnapshotDigest: string; witnessDigest: string }; targetRosterDigest: string; groupPolicy: GroupPolicy;
  records: { choreId: string; configuration: SharedChoreConfiguration | null; disableExisting: boolean }[];
  digest: string;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('移行の確認内容を読み直してください。');
}
function digest(plan: Omit<LegacyMigrationPlan, 'digest'>) {
  const { records, ...header } = plan;
  return sharedDocumentDigest({ ...header, records: records.map(record => sharedDocumentDigest(record)) });
}

/** Every living chore gets an explicit decision. No cadence, assignee or original completion is inferred. */
export function prepareLegacyMigrationPlan(checkpoint: VerifiedLegacyMigration, input: {
  id: string; userId: string; groupPolicy: GroupPolicy; choices: readonly LegacyMigrationChoreChoice[]; now: Date;
}): LegacyMigrationPlan {
  return prepareAtVersion(checkpoint, input, V2_SCHEDULER_VERSION);
}
function prepareAtVersion(checkpoint: VerifiedLegacyMigration, input: Parameters<typeof prepareLegacyMigrationPlan>[1], schedulerVersion: string): LegacyMigrationPlan {
  assertSharedIdentifier(input.id); assertSharedIdentifier(input.userId);
  const source = readVerifiedLegacyMigrationSource(checkpoint); const original = readVerifiedLegacyMigrationSnapshot(checkpoint);
  const witness = original.base.legacyMigrationWitness;
  if (!witness || source.roster.body.ownerUserId !== input.userId || input.groupPolicy.kind !== witness.body.groupKind) throw new Error('管理者と、確認するグループの種類を確認してください。');
  if (source.replica.entities.some(entity => Object.keys(entity.conflicts).length)) throw new Error('移行前のグループで同時編集を解決してください。');
  const settings = source.replica.entities.find(entity => entity.entityType === 'settings' && entity.entityId === 'settings' && !entity.deleted);
  if (!settings || typeof settings.fields.timeZone !== 'string') throw new Error('移行前の地域設定を確認してください。');
  const effectiveFrom = sharedLocalDate(input.now, settings.fields.timeZone);
  const chores = source.replica.entities.filter(entity => entity.entityType === 'chore' && !entity.deleted && entity.fields.archived !== true).sort((a, b) => compareOperationIds(a.entityId, b.entityId));
  if (!Array.isArray(input.choices) || input.choices.length !== chores.length || input.choices.length > 4096
    || new Set(input.choices.map(choice => choice.choreId)).size !== input.choices.length) throw new Error('全ての家事について移行内容を確認してください。');
  const choices = new Map(input.choices.map(choice => [choice.choreId, choice]));
  const memberIds = source.roster.body.members.map(member => member.userId).sort(compareOperationIds);
  const records = chores.map(chore => {
    const choice = choices.get(chore.entityId);
    if (!choice) throw new Error('全ての家事について移行内容を確認してください。');
    if (choice.kind === 'keepDisabled') {
      exact(choice, ['choreId', 'kind']);
      return { choreId: chore.entityId, configuration: null, disableExisting: chore.fields.enabled === true };
    }
    if (choice.kind !== 'configure') throw new Error('移行する家事の種類を確認してください。');
    exact(choice, ['choreId', 'kind', 'configuration']);
    exact(choice.configuration, ['policy', 'anchorDate', 'intervalDays', 'windowBeforeDays', 'windowAfterDays', 'active']);
    if (typeof choice.configuration.active !== 'boolean') throw new Error('移行後の有効・無効を確認してください。');
    const configuration: SharedChoreConfiguration = { ...clone(choice.configuration), ruleVersion: 1,
      effectiveFrom: choice.configuration.anchorDate > effectiveFrom ? choice.configuration.anchorDate : effectiveFrom,
      ...(choice.configuration.policy.completion === 'perMember' && choice.configuration.policy.assignment.mode === 'all' ? { targetMemberIds: [...memberIds] } : {}) };
    for (const id of configuration.policy.assignment.memberIds) if (!memberIds.includes(id)) throw new Error('現在のメンバーから担当者を選んでください。');
    configuration.policy.assignment.memberIds.sort(compareOperationIds);
    return { choreId: chore.entityId, configuration, disableExisting: false };
  });
  const body: Omit<LegacyMigrationPlan, 'digest'> = { schemaVersion: 1, schedulerVersion, id: input.id,
    userId: input.userId, groupId: source.replica.groupId, createdAt: input.now.toISOString(), effectiveFrom,
    sourcePin: verifiedLegacyMigrationPin(checkpoint), targetRosterDigest: witness.body.targetRosterDigest, groupPolicy: clone(input.groupPolicy), records };
  const plan = { ...body, digest: digest(body) };
  const oldIds = new Set(source.replica.operationIndex.map(item => item.operationId));
  for (const draft of legacyMigrationDrafts(plan, checkpoint)) {
    if (oldIds.has(draft.operationId)) throw new Error('移行の操作番号が既存の記録と重なっています。確認をやり直してください。');
    validateSharedOperation({ ...draft, schemaVersion: 2, groupId: plan.groupId,
      authorUserId: plan.userId, authorDeviceId: source.roster.body.ownerDeviceId, deviceSequence: 1, logicalClock: 1, context: {}, receiptContext: {},
      keyVersion: witness.body.targetKeyVersion, recordedAt: plan.createdAt } as SharedOperation, plan.groupId);
  }
  return plan;
}

/** Only new configuration is authored; original definitions, history, profiles, waste and appliances stay in the source snapshot. */
export function legacyMigrationDrafts(plan: LegacyMigrationPlan, checkpoint: VerifiedLegacyMigration): SharedOperationDraft[] {
  const operations: SharedOperationDraft[] = [{ operationId: `${plan.id}.policy`, entityType: 'groupPolicy', entityId: 'policy', operationType: 'patch',
    payload: { configuration: clone(plan.groupPolicy) as unknown as JsonValue } }];
  plan.records.forEach((record, index) => {
    if (record.configuration) operations.push({ operationId: `${plan.id}.cfg.${index}`, entityType: 'chorePolicy', entityId: record.choreId, operationType: 'patch',
      payload: { configuration: clone(record.configuration) as unknown as JsonValue } },
    { operationId: `${plan.id}.active.${index}`, entityType: 'chore', entityId: record.choreId, operationType: 'patch', payload: { enabled: record.configuration.active === true, requiresCycleSelection: false } });
    else if (record.disableExisting) operations.push({ operationId: `${plan.id}.disable.${index}`, entityType: 'chore', entityId: record.choreId, operationType: 'patch', payload: { enabled: false } });
  });
  operations.push({ operationId: `${plan.id}.finish`, entityType: 'migration', entityId: `${plan.id}.finish`, operationType: 'patch', payload: {
    legacyFrontier: clone(checkpoint.frontier) as JsonValue, sourceSnapshotDigest: checkpoint.sourceSnapshotDigest,
    groupKind: plan.groupPolicy.kind, schedulerVersion: plan.schedulerVersion } });
  return operations;
}

export function validateLegacyMigrationPlan(value: LegacyMigrationPlan, checkpoint: VerifiedLegacyMigration, now?: Date): LegacyMigrationPlan {
  const plan = clone(value);
  exact(plan, ['schemaVersion', 'schedulerVersion', 'id', 'userId', 'groupId', 'createdAt', 'effectiveFrom', 'sourcePin', 'targetRosterDigest', 'groupPolicy', 'records', 'digest']);
  if (plan.schemaVersion !== 1 || !isSupportedV2Scheduler(plan.schedulerVersion) || !Array.isArray(plan.records) || plan.records.length > 4096) throw new Error('移行の確認をやり直してください。');
  const choices: LegacyMigrationChoreChoice[] = plan.records.map(record => {
    exact(record, ['choreId', 'configuration', 'disableExisting']);
    if (!record.configuration) return { choreId: record.choreId, kind: 'keepDisabled' };
    const { policy, anchorDate, intervalDays, windowBeforeDays, windowAfterDays, active } = record.configuration;
    if (typeof active !== 'boolean') throw new Error('移行後の有効・無効を確認してください。');
    return { choreId: record.choreId, kind: 'configure', configuration: { policy, anchorDate, intervalDays, windowBeforeDays, windowAfterDays, active } };
  });
  const rebuilt = prepareAtVersion(checkpoint, { id: plan.id, userId: plan.userId, groupPolicy: plan.groupPolicy, choices, now: new Date(plan.createdAt) }, plan.schedulerVersion);
  if (canonicalJson(plan) !== canonicalJson(rebuilt)) throw new Error('確認した移行内容が変更されています。');
  if (now) {
    const source = readVerifiedLegacyMigrationSource(checkpoint); const settings = source.replica.entities.find(entity => entity.entityType === 'settings' && entity.entityId === 'settings');
    if (plan.effectiveFrom !== sharedLocalDate(now, settings?.fields.timeZone as string)) throw new Error('日付が変わりました。移行内容をもう一度確認してください。');
  }
  return rebuilt;
}
