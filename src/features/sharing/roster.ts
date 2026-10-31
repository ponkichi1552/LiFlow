import { SharingSchedulerVersionError } from './cloud-contract.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertJsonRecord, assertSharedIdentifier, canonicalJson, compareOperationIds, SHARED_SCHEDULER_VERSION } from './operations.ts';
import { signSharedDocument, validateDevicePublicIdentity, verifySharedDocument } from './crypto.ts';
import type { DevicePublicIdentity, DeviceSecretIdentity } from './crypto.ts';
import { V2_SCHEDULER_VERSION, isSupportedV2Scheduler } from './v2/payload-schema.ts';

export interface SharedDeviceMembership { identity: DevicePublicIdentity; joinedKeyVersion: number }
export interface SharedGroupMember { userId: string; joinedKeyVersion: number; devices: SharedDeviceMembership[] }
export interface SharedRosterBody {
  schemaVersion: 1 | 2;
  groupId: string;
  revision: number;
  keyVersion: number;
  ownerUserId: string;
  ownerDeviceId: string;
  schedulerVersion: string;
  previousDigest: string | null;
  closed: boolean;
  members: SharedGroupMember[];
}
export interface SignedSharedRoster { body: SharedRosterBody; signer: DevicePublicIdentity; signature: string }
declare const verifiedRoster: unique symbol;
export type VerifiedSharedRoster = SignedSharedRoster & { readonly [verifiedRoster]: true };
export const MAX_SHARED_MEMBERS = 16;
export const MAX_DEVICES_PER_MEMBER = 4;

function exactKeys(value: unknown, fields: string[]): void {
  assertJsonRecord(value);
  if (Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('Unknown or missing roster field');
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid roster version');
}
function publicOnly(value: DevicePublicIdentity): DevicePublicIdentity {
  exactKeys(value, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  return validateDevicePublicIdentity(value);
}

/** Shape/self-signature validation alone does not establish membership authority; verify a pin or transition. */
export function validateSharedRoster(input: SignedSharedRoster): SignedSharedRoster {
  exactKeys(input, ['body', 'signer', 'signature']);
  const { body } = input;
  exactKeys(body, ['schemaVersion', 'groupId', 'revision', 'keyVersion', 'ownerUserId', 'ownerDeviceId',
    'schedulerVersion', 'previousDigest', 'closed', 'members']);
  if (![1, 2].includes(body.schemaVersion) || typeof body.closed !== 'boolean') throw new Error('Unsupported roster schema');
  for (const id of [body.groupId, body.ownerUserId, body.ownerDeviceId]) assertSharedIdentifier(id);
  positive(body.revision); positive(body.keyVersion);
  if (body.keyVersion !== body.revision) throw new Error('Membership revisions must rotate the group key');
  if (typeof body.schedulerVersion !== 'string' || body.schedulerVersion.length > 80 || !body.schedulerVersion) throw new Error('Invalid scheduler version');
  if (body.previousDigest !== null && !/^[a-f0-9]{64}$/u.test(body.previousDigest)) throw new Error('Invalid prior roster digest');
  if ((body.revision === 1) !== (body.previousDigest === null)) throw new Error('Invalid roster chain anchor');
  if (!Array.isArray(body.members) || body.members.length > MAX_SHARED_MEMBERS
    || (body.closed ? body.members.length !== 0 : body.members.length === 0)) throw new Error('Invalid roster members');
  const users = new Set<string>(); const devices = new Set<string>();
  for (const member of body.members) {
    exactKeys(member, ['userId', 'joinedKeyVersion', 'devices']); assertSharedIdentifier(member.userId); positive(member.joinedKeyVersion);
    if (member.joinedKeyVersion > body.keyVersion || users.has(member.userId)) throw new Error('Invalid or duplicate group member');
    users.add(member.userId);
    if (!Array.isArray(member.devices) || !member.devices.length || member.devices.length > MAX_DEVICES_PER_MEMBER) throw new Error('Invalid member devices');
    for (const device of member.devices) {
      exactKeys(device, ['identity', 'joinedKeyVersion']); const identity = publicOnly(device.identity); positive(device.joinedKeyVersion);
      if (devices.has(identity.deviceId) || device.joinedKeyVersion < member.joinedKeyVersion || device.joinedKeyVersion > body.keyVersion) {
        throw new Error('Device belongs to another member or epoch');
      }
      devices.add(identity.deviceId);
    }
  }
  const owner = body.members.find((member) => member.userId === body.ownerUserId);
  if (!body.closed && !owner?.devices.some((device) => device.identity.deviceId === body.ownerDeviceId)) throw new Error('Owner signing device is missing');
  const signer = publicOnly(input.signer);
  if (body.revision === 1 && signer.deviceId !== body.ownerDeviceId) throw new Error('Initial roster needs its owner signature');
  verifySharedDocument({ domain: 'liflow-shared-roster-v1', body }, input.signature, signer);
  return JSON.parse(canonicalJson(input)) as SignedSharedRoster;
}

export function sharedRosterDigest(roster: SignedSharedRoster): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(roster))));
}

function signRoster(body: SharedRosterBody, identity: DeviceSecretIdentity): SignedSharedRoster {
  const normalized = { ...body, members: body.members.map((member) => ({ ...member,
    devices: [...member.devices].sort((a, b) => compareOperationIds(a.identity.deviceId, b.identity.deviceId)),
  })).sort((a, b) => compareOperationIds(a.userId, b.userId)) };
  return validateSharedRoster({ body: normalized, signer: validateDevicePublicIdentity(identity),
    signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body: normalized }, identity) });
}

export function createSharedRoster(groupId: string, ownerUserId: string, identity: DeviceSecretIdentity,
  options: { schemaVersion: 1 | 2 } = { schemaVersion: 1 }): VerifiedSharedRoster {
  return signRoster({ schemaVersion: options.schemaVersion, groupId, revision: 1, keyVersion: 1, ownerUserId,
    ownerDeviceId: identity.deviceId, schedulerVersion: options.schemaVersion === 2 ? V2_SCHEDULER_VERSION : SHARED_SCHEDULER_VERSION, previousDigest: null, closed: false,
    members: [{ userId: ownerUserId, joinedKeyVersion: 1, devices: [{ identity: validateDevicePublicIdentity(identity), joinedKeyVersion: 1 }] }] }, identity) as VerifiedSharedRoster;
}

/** The digest/owner pin must come from the user's authenticated invitation or a previous local checkpoint. */
export function verifyPinnedSharedRoster(input: SignedSharedRoster, pin: {
  groupId: string; digest: string; ownerUserId: string; ownerIdentity: DevicePublicIdentity;
}): VerifiedSharedRoster {
  const roster = validateSharedRoster(input); const owner = validateDevicePublicIdentity(pin.ownerIdentity);
  if (roster.body.groupId !== pin.groupId || sharedRosterDigest(roster) !== pin.digest || roster.body.ownerUserId !== pin.ownerUserId
    || roster.body.ownerDeviceId !== owner.deviceId || !roster.body.members.find((member) => member.userId === pin.ownerUserId)?.devices
      .some((device) => canonicalJson(device.identity) === canonicalJson(owner))) throw new Error('Roster does not match the trusted invitation');
  return roster as VerifiedSharedRoster;
}

export function verifySharedRosterTransition(previousInput: VerifiedSharedRoster, nextInput: SignedSharedRoster): VerifiedSharedRoster {
  const previous = validateSharedRoster(previousInput); const next = validateSharedRoster(nextInput);
  const priorOwner = previous.body.members.find((member) => member.userId === previous.body.ownerUserId)?.devices
    .find((device) => device.identity.deviceId === previous.body.ownerDeviceId)?.identity;
  if (previous.body.closed || !priorOwner || canonicalJson(priorOwner) !== canonicalJson(next.signer)
    || next.body.groupId !== previous.body.groupId || next.body.previousDigest !== sharedRosterDigest(previous)
    || next.body.revision !== previous.body.revision + 1 || next.body.keyVersion !== previous.body.keyVersion + 1) {
    throw new Error('Untrusted roster transition or rollback');
  }
  if (next.body.schemaVersion < previous.body.schemaVersion) throw new Error('Shared protocol cannot be downgraded');
  if (next.body.schemaVersion !== previous.body.schemaVersion && (next.body.schemaVersion !== 2
    || !isSupportedV2Scheduler(next.body.schedulerVersion) || next.body.closed
    || next.body.ownerUserId !== previous.body.ownerUserId || next.body.ownerDeviceId !== previous.body.ownerDeviceId
    || canonicalJson(next.body.members) !== canonicalJson(previous.body.members))) {
    throw new Error('A protocol upgrade must preserve the owner and every approved member device');
  }
  if (!next.body.closed && (next.body.ownerUserId !== previous.body.ownerUserId || next.body.ownerDeviceId !== previous.body.ownerDeviceId)
    && !next.body.members.some((member) => member.userId === previous.body.ownerUserId
      && member.devices.some((device) => device.identity.deviceId === previous.body.ownerDeviceId))) {
    throw new Error('Transfer ownership before removing the old owner; the successor must generate the future key');
  }
  if (previous.body.schemaVersion === 2 && next.body.schemaVersion === 2 && previous.body.schedulerVersion !== next.body.schedulerVersion) {
    const draft = (version: string) => Number(version.match(/^liflow-shared-2-draft-(\d+)$/u)?.[1] ?? NaN);
    if (!isSupportedV2Scheduler(next.body.schedulerVersion)) throw new SharingSchedulerVersionError();
    if (!(draft(next.body.schedulerVersion) > draft(previous.body.schedulerVersion))
      || next.body.ownerUserId !== previous.body.ownerUserId || next.body.ownerDeviceId !== previous.body.ownerDeviceId
      || canonicalJson(next.body.members) !== canonicalJson(previous.body.members) || next.body.closed) throw new Error('A scheduler upgrade must preserve membership and move forward');
  }
  // Surviving devices keep their original approval epoch, and cannot silently change accounts.
  for (const oldMember of previous.body.members) {
    for (const oldDevice of oldMember.devices) {
      const nextMember = next.body.members.find((member) => member.devices.some((device) => device.identity.deviceId === oldDevice.identity.deviceId));
      if (nextMember && (nextMember.userId !== oldMember.userId || nextMember.joinedKeyVersion !== oldMember.joinedKeyVersion
        || nextMember.devices.find((device) => device.identity.deviceId === oldDevice.identity.deviceId)!.joinedKeyVersion !== oldDevice.joinedKeyVersion)) {
        throw new Error('An approved device cannot change its account or approval epoch');
      }
    }
  }
  for (const member of next.body.members) {
    const oldMember = previous.body.members.find((candidate) => candidate.userId === member.userId);
    if (member.joinedKeyVersion !== (oldMember?.joinedKeyVersion ?? next.body.keyVersion)) throw new Error('Invalid member approval epoch');
    for (const device of member.devices) {
      if (!oldMember?.devices.some((candidate) => candidate.identity.deviceId === device.identity.deviceId)
        && device.joinedKeyVersion !== next.body.keyVersion) throw new Error('New devices need the current approval epoch');
    }
  }
  return next as VerifiedSharedRoster;
}

function updateRoster(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity, change: (body: SharedRosterBody) => void): VerifiedSharedRoster {
  validateSharedRoster(previous);
  if (previous.body.closed || previous.body.ownerDeviceId !== owner.deviceId) throw new Error('Only the current owner device can change membership');
  const body = JSON.parse(canonicalJson(previous.body)) as SharedRosterBody;
  body.revision++; body.keyVersion++; body.previousDigest = sharedRosterDigest(previous);
  change(body);
  return verifySharedRosterTransition(previous, signRoster(body, owner));
}

/** Prepare a signed local upgrade. Activation, new keys and migration data are a separate transaction. */
export function upgradeSharedRoster(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity): VerifiedSharedRoster {
  if (previous.body.schemaVersion !== 1) throw new Error('Only a v1 group can prepare a v2 upgrade');
  return updateRoster(previous, owner, (body) => { body.schemaVersion = 2; body.schedulerVersion = V2_SCHEDULER_VERSION; });
}

/** Only the owner can change this signed contract. Existing facts and keys stay in the archive. */
export function upgradeSharedScheduler(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity): VerifiedSharedRoster {
  if (previous.body.schemaVersion !== 2 || !isSupportedV2Scheduler(previous.body.schedulerVersion)) throw new Error('Unsupported scheduler upgrade');
  if (previous.body.schedulerVersion === V2_SCHEDULER_VERSION) return previous;
  return updateRoster(previous, owner, body => { body.schedulerVersion = V2_SCHEDULER_VERSION; });
}

export function approveSharedDevice(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity, userId: string, publicIdentity: DevicePublicIdentity): VerifiedSharedRoster {
  assertSharedIdentifier(userId); const identity = validateDevicePublicIdentity(publicIdentity);
  return updateRoster(previous, owner, (body) => {
    if (body.members.some((member) => member.devices.some((device) => device.identity.deviceId === identity.deviceId))) throw new Error('Device is already approved');
    let member = body.members.find((candidate) => candidate.userId === userId);
    if (!member) { member = { userId, joinedKeyVersion: body.keyVersion, devices: [] }; body.members.push(member); }
    member.devices.push({ identity, joinedKeyVersion: body.keyVersion });
  });
}

/** The last member may close the group; other owners transfer first, then the successor rekeys on departure. */
export function removeSharedMember(
  previous: VerifiedSharedRoster, owner: DeviceSecretIdentity, userId: string,
): VerifiedSharedRoster {
  return removeSharedMembers(previous, owner, [userId]);
}
export function removeSharedMembers(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity, userIds: readonly string[]): VerifiedSharedRoster {
  if (!userIds.length || new Set(userIds).size !== userIds.length) throw new Error('Choose members to remove');
  return updateRoster(previous, owner, (body) => {
    if (userIds.some((uid) => !body.members.some((member) => member.userId === uid))) throw new Error('Unknown group member');
    body.members = body.members.filter((member) => !userIds.includes(member.userId));
    if (userIds.includes(body.ownerUserId)) {
      if (!body.members.length) body.closed = true;
      else throw new Error('Choose the next owner before leaving; they must create the post-departure key');
    }
  });
}

/** Recovery removes reviewed devices in one forward epoch, preserving their owner's healthy devices. */
export function recoverSharedRoster(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity,
  removeDeviceIds: readonly string[], removeUserIds: readonly string[] = []): VerifiedSharedRoster {
  const devices = new Set(removeDeviceIds); const users = new Set(removeUserIds);
  if (devices.size !== removeDeviceIds.length || users.size !== removeUserIds.length
    || devices.has(previous.body.ownerDeviceId) || users.has(previous.body.ownerUserId)) throw new Error('Recovery must retain its current owner device');
  const known = new Set(previous.body.members.flatMap(member => member.devices.map(device => device.identity.deviceId)));
  if ([...devices].some(id => !known.has(id)) || [...users].some(id => !previous.body.members.some(member => member.userId === id))) throw new Error('Unknown recovery removal');
  return updateRoster(previous, owner, body => {
    body.members = body.members.filter(member => !users.has(member.userId)).map(member => ({ ...member,
      devices: member.devices.filter(device => !devices.has(device.identity.deviceId)) })).filter(member => member.devices.length);
  });
}

export function transferSharedOwnership(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity,
  successor: { userId: string; deviceId: string }): VerifiedSharedRoster {
  return updateRoster(previous, owner, (body) => {
    const member = body.members.find((candidate) => candidate.userId === successor.userId);
    if (!member?.devices.some((device) => device.identity.deviceId === successor.deviceId)
      || body.ownerDeviceId === successor.deviceId) throw new Error('Choose another approved owner device');
    body.ownerUserId = successor.userId; body.ownerDeviceId = successor.deviceId;
  });
}

export function removeSharedDevice(previous: VerifiedSharedRoster, owner: DeviceSecretIdentity, deviceId: string): VerifiedSharedRoster {
  return updateRoster(previous, owner, (body) => {
    if (deviceId === body.ownerDeviceId) throw new Error('Transfer ownership before removing the owner device');
    const member = body.members.find((candidate) => candidate.devices.some((device) => device.identity.deviceId === deviceId));
    if (!member) throw new Error('Unknown group device');
    member.devices = member.devices.filter((device) => device.identity.deviceId !== deviceId);
    if (!member.devices.length) body.members = body.members.filter((candidate) => candidate !== member);
  });
}

/** Verify history backwards to the pin and then forwards, retaining past authors without trusting a new cloud key. */
export function verifySharedRosterArchive(anchor: VerifiedSharedRoster, inputs: readonly SignedSharedRoster[]): VerifiedSharedRoster[] {
  if (!inputs.length || inputs.length > 4096 || inputs.length < anchor.body.revision) throw new Error('Missing membership archive');
  const first = validateSharedRoster(inputs[0]);
  if (first.body.revision !== 1) throw new Error('Membership archive is missing its creation anchor');
  let previous = verifyPinnedSharedRoster(first, { groupId: first.body.groupId, digest: sharedRosterDigest(first),
    ownerUserId: first.body.ownerUserId, ownerIdentity: first.signer });
  const result = [previous];
  for (const input of inputs.slice(1)) { previous = verifySharedRosterTransition(previous, input); result.push(previous); }
  if (sharedRosterDigest(result[anchor.body.revision - 1]) !== sharedRosterDigest(anchor)) throw new Error('Membership archive does not reach the trusted pin');
  return result;
}

export function sharedAuthorIdentity(roster: VerifiedSharedRoster, userId: string, deviceId: string, authoringKeyVersion: number): DevicePublicIdentity {
  const member = roster.body.members.find((candidate) => candidate.userId === userId);
  const device = member?.devices.find((candidate) => candidate.identity.deviceId === deviceId);
  if (roster.body.closed || !device || authoringKeyVersion < device.joinedKeyVersion || authoringKeyVersion > roster.body.keyVersion) {
    throw new Error('Author is not an approved device for this group epoch');
  }
  return device.identity;
}
