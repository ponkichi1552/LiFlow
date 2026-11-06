import { canonicalJson } from './operations.ts';
import { sameAccountDeviceAddition, sharedRosterDigest } from './roster.ts';
import type { VerifiedSharedRoster } from './roster.ts';
import { unwrapGroupKey } from './crypto.ts';
import type { DeviceSecretIdentity, SharingCryptoGateway, WrappedGroupKey } from './crypto.ts';

/** Only verified, consecutive additions within an existing account preserve this secret. Removal never does. */
export function continuousAccountDeviceEpochs(archive: readonly VerifiedSharedRoster[], from: number, through: number): boolean {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from < 1 || through < from) return false;
  for (let version = from + 1; version <= through; version++) {
    const previous = archive.find(roster => roster.body.keyVersion === version - 1), next = archive.find(roster => roster.body.keyVersion === version);
    if (!previous || !next || !sameAccountDeviceAddition(previous, next)) return false;
  }
  return archive.some(roster => roster.body.keyVersion === from);
}

/** Resolve old owner snapshots without re-authorizing the new device to author old operations. */
export async function resolveSharedGroupKey(input: { crypto: SharingCryptoGateway; userId: string; identity: DeviceSecretIdentity;
  archive: readonly VerifiedSharedRoster[]; epoch: VerifiedSharedRoster;
  readKey(version: number): Promise<Uint8Array | null>; saveKey(version: number, key: Uint8Array): Promise<void>;
  readEnvelope(version: number): Promise<WrappedGroupKey> }) {
  const { archive, identity, userId } = input;
  const current = archive.at(-1);
  const known = archive.find(roster => roster.body.keyVersion === input.epoch.body.keyVersion);
  if (!current || !known || input.epoch.body.groupId !== current.body.groupId
    || sharedRosterDigest(known) !== sharedRosterDigest(input.epoch)
    || archive.some(roster => roster.body.groupId !== current.body.groupId)) throw new Error('Unknown group key epoch');
  const membership = current?.body.members.find(member => member.userId === userId)?.devices.find(device => device.identity.deviceId === identity.deviceId);
  if (!membership || canonicalJson(membership.identity) !== canonicalJson({ deviceId: identity.deviceId,
    signingPublicKey: identity.signingPublicKey, agreementPublicKey: identity.agreementPublicKey })) throw new Error('Device is not a current group member');
  const resolving = new Set<number>();
  const resolve = async (epoch: VerifiedSharedRoster): Promise<Uint8Array> => {
    const version = epoch.body.keyVersion, saved = await input.readKey(version);
    if (saved) { if (saved.length !== 32) throw new Error('Invalid saved group key'); return saved.slice(); }
    if (resolving.has(version) || resolving.size > 64) throw new Error('Invalid account device key continuity');
    resolving.add(version);
    try {
      let source: VerifiedSharedRoster | undefined;
      if (version < membership.joinedKeyVersion && continuousAccountDeviceEpochs(archive, version, membership.joinedKeyVersion)) {
        source = archive.find(roster => roster.body.keyVersion === membership.joinedKeyVersion);
      } else {
        const previous = archive.find(roster => roster.body.keyVersion === version - 1);
        const addition = previous ? sameAccountDeviceAddition(previous, epoch) : null;
        if (addition && addition.deviceId !== identity.deviceId) source = previous;
      }
      let key: Uint8Array;
      if (source) key = await resolve(source);
      else {
        const wrapped = await input.readEnvelope(version);
        const owner = epoch.body.members.flatMap(member => member.devices).find(device => device.identity.deviceId === epoch.body.ownerDeviceId)?.identity;
        const sender = wrapped.senderDeviceId === epoch.signer.deviceId ? epoch.signer : owner;
        if (!sender || sender.deviceId !== wrapped.senderDeviceId) throw new Error('共有鍵の配布元を確認できません。');
        key = await unwrapGroupKey(input.crypto, wrapped, identity, userId, sender, epoch.body.groupId, version);
      }
      try { await input.saveKey(version, key); return key.slice(); } finally { key.fill(0); }
    } finally { resolving.delete(version); }
  };
  return resolve(input.epoch);
}
