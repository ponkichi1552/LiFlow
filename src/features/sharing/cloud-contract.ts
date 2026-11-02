import { assertJsonRecord, assertSharedIdentifier, canonicalJson } from './operations.ts';
import { sharedRosterDigest, validateSharedRoster } from './roster.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from './roster.ts';
import type { EncryptedSharedOperation } from './crypto.ts';
import type { V2ServerReceipt } from './v2/server-receipts.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';

export interface SharedCloudGroup {
  schemaVersion: 1 | 2;
  ownerUserId: string;
  ownerDeviceId: string;
  memberIds: string[];
  deviceOwners: Record<string, string>;
  keyVersion: number;
  rosterRevision: number;
  rosterJson: string;
  revokedUserIds: string[];
  rotationRequired: boolean;
  closed: boolean;
  headSequence: number;
  lastOperationId: string | null;
  snapshotId: string | null;
  snapshotThroughSequence: number;
  retentionCutoff?: LocalDate;
  retentionThroughSequence?: number;
  retentionKeyVersion?: number;
}
export interface SharedCloudEvent {
  operationId: string;
  uploadSequence: number;
  envelope: EncryptedSharedOperation;
  envelopeJson: string;
  authorProofDigest?: string;
  serverReceipt?: V2ServerReceipt;
}
export class SharingAccessError extends Error { readonly code = 'sharing/access-denied'; }
export class SharingKeyVersionError extends Error { readonly code = 'sharing/key-version-changed'; }
export class SharingSnapshotRequiredError extends Error { readonly code = 'sharing/snapshot-required'; }
export class SharingCloudChangedError extends Error { readonly code = 'sharing/cloud-changed'; }
export class SharingSchedulerVersionError extends Error { readonly code = 'sharing/scheduler-version-mismatch';
  constructor() { super('この共有グループの計算ルールに対応するLiFlowへ更新してください。'); } }
export const MAX_SHARED_CLOUD_BATCH_BYTES = 8 * 1024 * 1024;

/** Firestore also caps request bytes: 100 large snapshot chunks cannot share one write batch. */
export function boundedSharingCloudBatches<T>(items: readonly T[], encodedSize: (item: T) => number): T[][] {
  const result: T[][] = []; let page: T[] = []; let bytes = 0;
  for (const item of items) {
    const size = encodedSize(item);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SHARED_CLOUD_BATCH_BYTES) throw new Error('Shared cloud record exceeds request size');
    if (page.length >= 100 || bytes + size > MAX_SHARED_CLOUD_BATCH_BYTES) { result.push(page); page = []; bytes = 0; }
    page.push(item); bytes += size;
  }
  if (page.length) result.push(page);
  return result;
}

export function rosterCloudFields(input: VerifiedSharedRoster) {
  const roster = validateSharedRoster(input);
  return { schemaVersion: roster.body.schemaVersion, ownerUserId: roster.body.ownerUserId, ownerDeviceId: roster.body.ownerDeviceId,
    memberIds: roster.body.members.map((member) => member.userId),
    deviceOwners: Object.fromEntries(roster.body.members.flatMap((member) => member.devices.map((device) => [device.identity.deviceId, member.userId]))),
    keyVersion: roster.body.keyVersion, rosterRevision: roster.body.revision, rosterJson: canonicalJson(roster),
    revokedUserIds: [] as string[], rotationRequired: false, closed: roster.body.closed };
}

/** The cloud ACL is useful only when it agrees with the pinned, signed membership. */
export function parseSharedCloudGroup(raw: unknown, groupId: string): { group: SharedCloudGroup; roster: SignedSharedRoster } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing shared group');
  const { createdAt: _created, updatedAt: _updated, ...value } = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== ['schemaVersion', 'ownerUserId', 'ownerDeviceId', 'memberIds', 'deviceOwners',
    'keyVersion', 'rosterRevision', 'rosterJson', 'revokedUserIds', 'rotationRequired', 'closed', 'headSequence',
    'lastOperationId', 'snapshotId', 'snapshotThroughSequence', ...('retentionCutoff' in value ? ['retentionCutoff', 'retentionThroughSequence', 'retentionKeyVersion'] : [])].sort().join(',')) throw new Error('Unknown shared cloud metadata');
  if (typeof value.rosterJson !== 'string' || value.rosterJson.length > 60_000) throw new Error('Invalid public roster');
  const roster = validateSharedRoster(JSON.parse(value.rosterJson));
  if (roster.body.groupId !== groupId) throw new Error('Shared group mismatch');
  const expected = rosterCloudFields(roster as VerifiedSharedRoster);
  for (const key of ['schemaVersion', 'ownerUserId', 'ownerDeviceId', 'memberIds', 'deviceOwners', 'keyVersion',
    'rosterRevision', 'closed'] as const) {
    if (canonicalJson(value[key]) !== canonicalJson(expected[key])) throw new Error('Cloud access metadata differs from the signed roster');
  }
  if (!Array.isArray(value.revokedUserIds) || value.revokedUserIds.some((uid) => typeof uid !== 'string' || !expected.memberIds.includes(uid))
    || new Set(value.revokedUserIds).size !== value.revokedUserIds.length
    || typeof value.rotationRequired !== 'boolean' || (value.revokedUserIds.length > 0 && !value.rotationRequired)) {
    throw new Error('Invalid revocation metadata');
  }
  for (const key of ['headSequence', 'snapshotThroughSequence'] as const) {
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('Invalid shared delivery position');
  }
  if ((value.snapshotThroughSequence as number) > (value.headSequence as number)) throw new Error('Snapshot is ahead of the log');
  if ('retentionCutoff' in value) {
    parseLocalDate(value.retentionCutoff as LocalDate);
    if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.retentionThroughSequence) || Number(value.retentionThroughSequence) < 0
      || Number(value.retentionThroughSequence) > Number(value.snapshotThroughSequence) || !Number.isSafeInteger(value.retentionKeyVersion)
      || Number(value.retentionKeyVersion) < 1 || Number(value.retentionKeyVersion) >= Number(value.keyVersion)) throw new Error('Invalid shared retention boundary');
  }
  for (const key of ['lastOperationId', 'snapshotId'] as const) if (value[key] !== null) assertSharedIdentifier(value[key]);
  return { group: value as unknown as SharedCloudGroup, roster };
}

export function assertSharedCloudAccess(group: SharedCloudGroup, userId: string, deviceId?: string): void {
  if (group.closed || !group.memberIds.includes(userId) || group.revokedUserIds.includes(userId)
    || (deviceId && group.deviceOwners[deviceId] !== userId)) throw new SharingAccessError('この共有グループへのアクセス権がありません。');
}

export function parseSharedCloudEvent(operationId: string, value: unknown, groupId: string): SharedCloudEvent {
  assertSharedIdentifier(operationId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cloud event');
  const { createdAt: _created, ...fields } = value as Record<string, unknown>;
  assertJsonRecord(fields);
  const expectedFields = fields.schemaVersion === 2 ? 'authorDeviceId,authorProofDigest,authorUserId,envelopeJson,keyVersion,schemaVersion,uploadSequence'
    : 'authorDeviceId,authorUserId,envelopeJson,keyVersion,schemaVersion,uploadSequence';
  if (Object.keys(fields).sort().join(',') !== expectedFields
    || ![1, 2].includes(fields.schemaVersion as number) || !Number.isSafeInteger(fields.uploadSequence) || (fields.uploadSequence as number) < 1
    || typeof fields.envelopeJson !== 'string' || fields.envelopeJson.length > 800_000) throw new Error('Invalid cloud event metadata');
  if (fields.schemaVersion === 2 && (typeof fields.authorProofDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(fields.authorProofDigest))) throw new Error('Missing authenticated v2 receipt commitment');
  const envelope = JSON.parse(fields.envelopeJson) as EncryptedSharedOperation;
  if (envelope.schemaVersion !== fields.schemaVersion || envelope.operationId !== operationId || envelope.groupId !== groupId || envelope.authorUserId !== fields.authorUserId
    || envelope.authorDeviceId !== fields.authorDeviceId || envelope.keyVersion !== fields.keyVersion) throw new Error('Cloud event header mismatch');
  return { operationId, uploadSequence: fields.uploadSequence as number, envelope, envelopeJson: fields.envelopeJson,
    ...(fields.schemaVersion === 2 ? { authorProofDigest: fields.authorProofDigest as string } : {}) };
}

export function sameSharedRoster(left: SignedSharedRoster, right: SignedSharedRoster): boolean {
  return sharedRosterDigest(left) === sharedRosterDigest(right);
}
