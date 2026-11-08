import { assertJsonRecord, assertSharedIdentifier, canonicalJson } from '../operations.ts';
import { signSharedDocument, verifySharedDocument } from '../crypto.ts';
import type { DeviceSecretIdentity } from '../crypto.ts';
import { sharedAuthorIdentity, sharedRosterDigest } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';

export interface V2RecoveryLockBody {
  schemaVersion: 1; groupId: string; id: string; ownerUserId: string; ownerDeviceId: string;
  keyVersion: number; rosterDigest: string; throughSequence: number; reviewDigest: string;
}
export interface SignedV2RecoveryLock { body: V2RecoveryLockBody; signature: string }
const domain = 'liflow-v2-owner-recovery-lock-v1';
export function validateV2RecoveryLock(input: SignedV2RecoveryLock): SignedV2RecoveryLock {
  assertJsonRecord(input); assertJsonRecord(input.body); const { body } = input;
  if (Object.keys(input).sort().join(',') !== 'body,signature'
    || Object.keys(body).sort().join(',') !== 'groupId,id,keyVersion,ownerDeviceId,ownerUserId,reviewDigest,rosterDigest,schemaVersion,throughSequence'
    || body.schemaVersion !== 1 || !Number.isSafeInteger(body.keyVersion) || body.keyVersion < 1
    || !Number.isSafeInteger(body.throughSequence) || body.throughSequence < 0
    || !/^[a-f0-9]{64}$/u.test(body.rosterDigest) || !/^[a-f0-9]{64}$/u.test(body.reviewDigest)
    || typeof input.signature !== 'string' || !/^[a-f0-9]{128}$/u.test(input.signature)) throw new Error('Invalid recovery lock');
  [body.groupId, body.id, body.ownerUserId, body.ownerDeviceId].forEach(assertSharedIdentifier);
  return JSON.parse(canonicalJson(input));
}
export function signV2RecoveryLock(roster: VerifiedSharedRoster, owner: DeviceSecretIdentity,
  value: { id: string; throughSequence: number; reviewDigest: string }): SignedV2RecoveryLock {
  if (roster.body.schemaVersion !== 2 || owner.deviceId !== roster.body.ownerDeviceId) throw new Error('Only the current v2 owner device can confirm recovery');
  const body: V2RecoveryLockBody = { schemaVersion: 1, groupId: roster.body.groupId, id: value.id, ownerUserId: roster.body.ownerUserId,
    ownerDeviceId: roster.body.ownerDeviceId, keyVersion: roster.body.keyVersion, rosterDigest: sharedRosterDigest(roster),
    throughSequence: value.throughSequence, reviewDigest: value.reviewDigest };
  return validateV2RecoveryLock({ body, signature: signSharedDocument({ domain, body }, owner) });
}
export function verifyV2RecoveryLock(raw: SignedV2RecoveryLock, roster: VerifiedSharedRoster): SignedV2RecoveryLock {
  const input = validateV2RecoveryLock(raw); const { body } = input;
  if (roster.body.schemaVersion !== 2 || roster.body.closed || body.groupId !== roster.body.groupId || body.ownerUserId !== roster.body.ownerUserId
    || body.ownerDeviceId !== roster.body.ownerDeviceId || body.keyVersion !== roster.body.keyVersion || body.rosterDigest !== sharedRosterDigest(roster)) {
    throw new Error('Recovery lock belongs to another owner or epoch');
  }
  verifySharedDocument({ domain, body }, input.signature, sharedAuthorIdentity(roster, body.ownerUserId, body.ownerDeviceId, body.keyVersion));
  return input;
}
export class V2RecoveryInProgressError extends Error {
  readonly code = 'sharing/recovery-in-progress';
  constructor() { super('管理者が共有の復旧を進めています。変更はこの端末に保存され、復旧後に送信されます。'); }
}
