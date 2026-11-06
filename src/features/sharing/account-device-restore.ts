import { assertJsonRecord, assertSharedIdentifier, canonicalJson } from './operations.ts';
import { signSharedDocument, sharedDocumentDigest, validateDevicePublicIdentity, verifySharedDocument, wrapGroupKey, unwrapGroupKey } from './crypto.ts';
import type { DevicePublicIdentity, DeviceSecretIdentity, SharingCryptoGateway, WrappedGroupKey } from './crypto.ts';
import { approveOwnSharedDevice, sameAccountDeviceAddition, sharedRosterDigest, validateSharedRoster, verifySharedRosterTransition } from './roster.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from './roster.ts';

export const ACCOUNT_DEVICE_RESTORE_SLOTS = 4;
export const ACCOUNT_DEVICE_RESTORE_TTL_MS = 15 * 60_000;
export const ACCOUNT_DEVICE_RESTORE_MAX_KEYS = 64;
export interface AccountDeviceRestoreRequest {
  body: { schemaVersion: 1; groupId: string; userId: string; requestId: string; rosterDigest: string; identity: DevicePublicIdentity };
  signature: string;
}
export interface AccountDeviceRestoreGrant {
  body: { schemaVersion: 1; groupId: string; userId: string; requestDigest: string; previousDigest: string;
    sponsorDeviceId: string; minimumKeyVersion: number; roster: SignedSharedRoster; keys: WrappedGroupKey[] };
  signature: string;
}
function exact(value: unknown, fields: string[]) {
  assertJsonRecord(value);
  if (Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('Invalid account device restore fields');
}
function digest(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid account device restore digest');
}
function accountMember(roster: SignedSharedRoster, userId: string) {
  if (roster.body.schemaVersion !== 2 || roster.body.closed) throw new Error('Account restoration requires an active v2 group');
  const member = roster.body.members.find(member => member.userId === userId);
  if (!member) throw new Error('This account is not a current group member');
  return member;
}

/** The request contains only a public device identity. Firebase separately binds its receipt to this UID. */
export function createAccountDeviceRestoreRequest(roster: SignedSharedRoster, userId: string, identity: DeviceSecretIdentity,
  requestId: string): AccountDeviceRestoreRequest {
  validateSharedRoster(roster); accountMember(roster, userId); assertSharedIdentifier(requestId);
  const body: AccountDeviceRestoreRequest['body'] = { schemaVersion: 1, groupId: roster.body.groupId, userId, requestId,
    rosterDigest: sharedRosterDigest(roster), identity: validateDevicePublicIdentity(identity) };
  return verifyAccountDeviceRestoreRequest({ body, signature: signSharedDocument({ domain: 'liflow-account-device-request-v1', body }, identity) }, userId, roster.body.groupId);
}
export function verifyAccountDeviceRestoreRequest(input: AccountDeviceRestoreRequest, userId: string, groupId: string) {
  exact(input, ['body', 'signature']); exact(input.body, ['schemaVersion', 'groupId', 'userId', 'requestId', 'rosterDigest', 'identity']);
  exact(input.body.identity, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  const { body } = input;
  if (body.schemaVersion !== 1 || body.userId !== userId || body.groupId !== groupId) throw new Error('Account device request identity mismatch');
  for (const id of [groupId, userId, body.requestId]) assertSharedIdentifier(id);
  digest(body.rosterDigest); validateDevicePublicIdentity(body.identity);
  verifySharedDocument({ domain: 'liflow-account-device-request-v1', body }, input.signature, body.identity);
  return JSON.parse(canonicalJson(input)) as AccountDeviceRestoreRequest;
}

export async function createAccountDeviceRestoreGrant(input: { crypto: SharingCryptoGateway; previous: VerifiedSharedRoster;
  request: AccountDeviceRestoreRequest; sponsor: DeviceSecretIdentity; userId: string; minimumKeyVersion: number;
  readKey(version: number): Promise<Uint8Array | null>; archive: readonly VerifiedSharedRoster[] }) {
  const { crypto, previous, sponsor, userId } = input;
  const request = verifyAccountDeviceRestoreRequest(input.request, userId, previous.body.groupId);
  if (request.body.rosterDigest !== sharedRosterDigest(previous)) throw new Error('Group changed before automatic device restoration');
  const member = accountMember(previous, userId);
  if (!member.devices.some(device => canonicalJson(device.identity) === canonicalJson(validateDevicePublicIdentity(sponsor)))) throw new Error('A trusted device of the same account is required');
  const existing = member.devices.find(device => device.identity.deviceId === request.body.identity.deviceId);
  if (existing && canonicalJson(existing.identity) !== canonicalJson(request.body.identity)) throw new Error('Existing device keys differ');
  if (!existing && input.archive.some(roster => roster.body.members.some(member => member.devices.some(device => device.identity.deviceId === request.body.identity.deviceId)))) {
    throw new Error('A removed device cannot restore its own former authorization automatically');
  }
  const next = existing ? previous : approveOwnSharedDevice(previous, sponsor, userId, request.body.identity, sharedDocumentDigest(request));
  const minimum = input.minimumKeyVersion;
  if (!Number.isSafeInteger(minimum) || minimum < member.joinedKeyVersion || minimum > previous.body.keyVersion
    || next.body.keyVersion - minimum + 1 > ACCOUNT_DEVICE_RESTORE_MAX_KEYS) throw new Error('A current owner snapshot is needed before device restoration');
  const keys = new Map<number, Uint8Array>();
  try {
    for (let version = minimum; version <= previous.body.keyVersion; version++) {
      const saved = await input.readKey(version);
      if (!saved || saved.length !== 32) throw new Error('Historical group key is not available on this device');
      keys.set(version, saved.slice());
    }
    if (!existing) {
      // A new device of the same principal does not gain membership authority over other people.
      // Retain the existing secret; per-message HKDF still binds the fresh transport epoch.
      // Ordinary admissions, removals, ownership changes and recovery continue to generate a new secret.
      keys.set(next.body.keyVersion, keys.get(previous.body.keyVersion)!.slice());
    }
    const wrapped: WrappedGroupKey[] = [];
    for (const [version, key] of keys) wrapped.push(await wrapGroupKey(crypto, previous.body.groupId, version, key, sponsor, request.body.identity, userId));
    const body: AccountDeviceRestoreGrant['body'] = { schemaVersion: 1, groupId: previous.body.groupId, userId,
      requestDigest: sharedDocumentDigest(request), previousDigest: sharedRosterDigest(previous), sponsorDeviceId: sponsor.deviceId,
      minimumKeyVersion: minimum, roster: next, keys: wrapped };
    const grant: AccountDeviceRestoreGrant = { body, signature: signSharedDocument({ domain: 'liflow-account-device-grant-v1', body }, sponsor) };
    const nextKeys: WrappedGroupKey[] = [];
    if (!existing) nextKeys.push(wrapped.at(-1)!);
    return { grant, next, nextKeys };
  } finally { for (const key of keys.values()) key.fill(0); }
}

/** Public signatures alone are insufficient: callers pin previous from this account's authenticated membership request. */
export function verifyAccountDeviceRestoreGrant(input: AccountDeviceRestoreGrant, requestInput: AccountDeviceRestoreRequest,
  previous: VerifiedSharedRoster, minimumKeyVersion: number): VerifiedSharedRoster {
  exact(input, ['body', 'signature']);
  exact(input.body, ['schemaVersion', 'groupId', 'userId', 'requestDigest', 'previousDigest', 'sponsorDeviceId', 'minimumKeyVersion', 'roster', 'keys']);
  const request = verifyAccountDeviceRestoreRequest(requestInput, requestInput.body.userId, previous.body.groupId), { body } = input;
  const member = accountMember(previous, request.body.userId);
  const sponsor = member.devices.find(device => device.identity.deviceId === body.sponsorDeviceId)?.identity;
  if (!sponsor || body.schemaVersion !== 1 || body.groupId !== previous.body.groupId || body.userId !== request.body.userId
    || body.requestDigest !== sharedDocumentDigest(request) || body.previousDigest !== sharedRosterDigest(previous)
    || request.body.rosterDigest !== body.previousDigest || body.minimumKeyVersion !== minimumKeyVersion
    || minimumKeyVersion < member.joinedKeyVersion || !Number.isSafeInteger(minimumKeyVersion)) throw new Error('Account restoration grant context differs');
  verifySharedDocument({ domain: 'liflow-account-device-grant-v1', body }, input.signature, sponsor);
  const already = member.devices.some(device => canonicalJson(device.identity) === canonicalJson(request.body.identity));
  if (already && canonicalJson(body.roster) !== canonicalJson(previous)) throw new Error('Key redelivery cannot change membership');
  const next = already ? previous : verifySharedRosterTransition(previous, body.roster);
  const addition = !already ? sameAccountDeviceAddition(previous, next) : null;
  if (!already && (addition?.userId !== body.userId || addition.deviceId !== request.body.identity.deviceId
    || next.body.accountDeviceRestore?.requestDigest !== sharedDocumentDigest(request))) throw new Error('Account restoration may add only this same account device');
  if (!already && !next.body.members.find(item => item.userId === request.body.userId)?.devices.some(device => canonicalJson(device.identity) === canonicalJson(request.body.identity))) throw new Error('Device was not approved');
  if (!already && (canonicalJson(next.signer) !== canonicalJson(sponsor) || next.body.ownerDeviceId !== previous.body.ownerDeviceId)) throw new Error('Account restoration changed group authority');
  const expected = next.body.keyVersion - minimumKeyVersion + 1;
  if (!Array.isArray(body.keys) || expected < 1 || expected > ACCOUNT_DEVICE_RESTORE_MAX_KEYS || body.keys.length !== expected) throw new Error('Account restoration key range differs');
  const versions = new Set<number>();
  for (const [index, key] of body.keys.entries()) {
    if (key.groupId !== body.groupId || key.recipientUserId !== body.userId || key.recipientDeviceId !== request.body.identity.deviceId
      || key.senderDeviceId !== sponsor.deviceId || !Number.isSafeInteger(key.keyVersion) || key.keyVersion < minimumKeyVersion
      || key.keyVersion !== minimumKeyVersion + index || key.keyVersion > next.body.keyVersion || versions.has(key.keyVersion)) throw new Error('Account restoration key recipient or epoch differs');
    versions.add(key.keyVersion);
  }
  return next;
}

export interface AccountDeviceRestoreReceipt {
  slot: number; request: AccountDeviceRestoreRequest; receivedAt: number;
  status: 'requested' | 'accepted' | 'acknowledged'; grant?: AccountDeviceRestoreGrant; acceptedAt?: number;
}
export interface AccountDeviceRestorePending { anchor: SignedSharedRoster; previousRevision: number; slot: number; request: AccountDeviceRestoreRequest }
export function validateAccountDeviceRestorePending(input: AccountDeviceRestorePending, userId: string): AccountDeviceRestorePending {
  exact(input, ['anchor', 'previousRevision', 'slot', 'request']);
  const anchor = validateSharedRoster(input.anchor), request = verifyAccountDeviceRestoreRequest(input.request, userId, anchor.body.groupId);
  if (anchor.body.revision !== 1 || anchor.body.accountDeviceRestore || !Number.isSafeInteger(input.previousRevision)
    || input.previousRevision < 1 || input.previousRevision > 4096 || !Number.isInteger(input.slot)
    || input.slot < 0 || input.slot >= ACCOUNT_DEVICE_RESTORE_SLOTS) throw new Error('Invalid saved account restoration');
  return JSON.parse(canonicalJson({ ...input, request })) as AccountDeviceRestorePending;
}
export function parseAccountDeviceRestoreReceipts(input: unknown, userId: string, groupId: string): AccountDeviceRestoreReceipt[] {
  exact(input, ['records']);
  const records = (input as { records: AccountDeviceRestoreReceipt[] }).records;
  if (!Array.isArray(records) || records.length > ACCOUNT_DEVICE_RESTORE_SLOTS) throw new Error('Invalid account restoration receipt page');
  const seen = new Set<number>();
  for (const record of records) {
    exact(record, record.status === 'accepted' ? ['slot', 'request', 'receivedAt', 'status', 'grant', 'acceptedAt'] : ['slot', 'request', 'receivedAt', 'status']);
    if (!['requested', 'accepted', 'acknowledged'].includes(record.status) || !Number.isInteger(record.slot)
      || record.slot < 0 || record.slot >= ACCOUNT_DEVICE_RESTORE_SLOTS || seen.has(record.slot)
      || !Number.isSafeInteger(record.receivedAt) || record.receivedAt < 0
      || record.status === 'accepted' && (!Number.isSafeInteger(record.acceptedAt) || record.acceptedAt! < record.receivedAt)) throw new Error('Invalid account restoration receipt');
    verifyAccountDeviceRestoreRequest(record.request, userId, groupId); seen.add(record.slot);
  }
  return JSON.parse(canonicalJson(records)) as AccountDeviceRestoreReceipt[];
}
export function accountDeviceRestoreAcknowledgment(pending: AccountDeviceRestorePending, grant: AccountDeviceRestoreGrant, identity: DeviceSecretIdentity) {
  const { request, slot } = pending, groupId = request.body.groupId, requestId = request.body.requestId, grantDigest = sharedDocumentDigest(grant);
  if (canonicalJson(validateDevicePublicIdentity(identity)) !== canonicalJson(request.body.identity)) throw new Error('Account restoration recipient differs');
  return { groupId, slot, requestId, grantDigest, signature: signSharedDocument({ domain: 'liflow-account-device-ack-v1', groupId,
    userId: request.body.userId, requestDigest: sharedDocumentDigest(request), grantDigest }, identity) };
}
export async function openAccountDeviceRestoreGrant(input: { crypto: SharingCryptoGateway; grant: AccountDeviceRestoreGrant;
  request: AccountDeviceRestoreRequest; previous: VerifiedSharedRoster; identity: DeviceSecretIdentity; minimumKeyVersion: number }) {
  const { grant, request, previous, identity } = input;
  const next = verifyAccountDeviceRestoreGrant(grant, request, previous, input.minimumKeyVersion);
  if (canonicalJson(validateDevicePublicIdentity(identity)) !== canonicalJson(request.body.identity)) throw new Error('Account restoration recipient differs');
  const sender = previous.body.members.find(member => member.userId === request.body.userId)!.devices.find(device => device.identity.deviceId === grant.body.sponsorDeviceId)!.identity;
  const keys = new Map<number, Uint8Array>();
  try {
    for (const wrapped of grant.body.keys) keys.set(wrapped.keyVersion,
      await unwrapGroupKey(input.crypto, wrapped, identity, request.body.userId, sender, previous.body.groupId, wrapped.keyVersion));
    return { roster: next, keys };
  } catch (error) { for (const key of keys.values()) key.fill(0); throw error; }
}
