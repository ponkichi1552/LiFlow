import type { SharedSyncDependencies, SharingSyncResult } from './synchronizer.ts';
import { verifyCloudMembership } from './synchronizer.ts';
import { upgradeSharedScheduler, approveSharedDevice, removeSharedDevice, removeSharedMembers, transferSharedOwnership, sharedAuthorIdentity, sharedRosterDigest } from './roster.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from './roster.ts';
import { createEncryptedSharedSnapshot } from './snapshots.ts';
import { createSharedInvitation, encodeCompactSharedInvitation, verifySharedJoinRequest } from './invitations.ts';
import type { SharedJoinRequest, SignedSharedInvitation } from './invitations.ts';
import { wrapGroupKey } from './crypto.ts';
import { SharingAccessError, SharingCloudChangedError, SharingKeyVersionError } from './cloud-contract.ts';
import { loadPublishedSharedReplica, loadSharedFacts, readSharingCheckpoint } from '../../platform/storage/sharing-ledger.ts';

/** Membership changes always rotate forward keys and publish a signed snapshot atomically. */
export function createSharedGroupManager(deps: SharedSyncDependencies & {
  sync: (options?: { force?: boolean; budgetMs?: number }) => Promise<SharingSyncResult>;
  makeId: () => string; markLeft: () => Promise<void>;
  verifyMembership?: (current: SignedSharedRoster) => Promise<VerifiedSharedRoster[]>;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> { const next = tail.then(work, work); tail = next.catch(() => undefined); return next; }
  const now = deps.now ?? Date.now;
  const verifyMembership = deps.verifyMembership ?? ((roster: SignedSharedRoster) => verifyCloudMembership(deps, roster));
  async function current() {
    const metadata = await deps.cloud.readGroup(deps.groupId); const archive = await verifyMembership(metadata.roster);
    const roster = archive.at(-1)!;
    if (roster.body.ownerUserId !== deps.userId || roster.body.ownerDeviceId !== deps.identity.deviceId) throw new SharingAccessError('この操作は所有者の端末から行ってください。');
    return { ...metadata, roster, archive };
  }
  async function rotate(change: (roster: VerifiedSharedRoster, revoked: string[]) => VerifiedSharedRoster,
    approval?: { invitation: SignedSharedInvitation; request: SharedJoinRequest }) {
    try { await deps.sync({ force: true, budgetMs: 120_000 }); }
    catch (error) { if (!(error instanceof SharingKeyVersionError)) throw error; }
    const { roster, group, archive } = await current();
    const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
    if (checkpoint.sequence !== group.headSequence) throw new SharingCloudChangedError('最新の共有データを受信してから再試行してください。');
    const next = change(roster, group.revokedUserIds);
    if (next === roster) return;
    const key = await deps.crypto.randomBytes(32);
    try {
      const keys = await Promise.all(next.body.members.flatMap((member) => member.devices.map((device) =>
        wrapGroupKey(deps.crypto, deps.groupId, next.body.keyVersion, key, deps.identity, device.identity, member.userId))));
      let snapshot;
      if (!next.body.closed) {
        const published = await loadPublishedSharedReplica(deps.database, deps.groupId); const facts = await loadSharedFacts(deps.database, deps.groupId);
        const history = [...archive, next];
        snapshot = await createEncryptedSharedSnapshot(deps.crypto, published, facts, next, deps.identity, key, `snapshot.${deps.makeId()}`, group.headSequence,
          (uid, device, version) => {
            const epoch = history.find((item) => item.body.keyVersion === version); if (!epoch) throw new Error('Missing historical membership');
            return sharedAuthorIdentity(epoch, uid, device, version);
          });
        await deps.cloud.prepareSnapshot(snapshot, next);
      }
      await deps.cloud.commitMembership(roster, next, keys, group.headSequence, snapshot?.manifest, approval);
      // Only a successful commit makes this an authoritative key epoch. Failed preparations never overwrite a working key.
      if (!next.body.closed) await deps.saveKey(next.body.keyVersion, key);
      await deps.saveArchive([...archive, next]); deps.changed();
      if (!next.body.closed) await deps.sync({ force: true, budgetMs: 120_000 });
    } finally { key.fill(0); }
  }
  return {
    upgradeScheduler: () => serial(() => rotate((previous, revoked) => {
      if (revoked.length) throw new SharingKeyVersionError('退出したメンバーの鍵を更新してから互換更新してください。');
      return upgradeSharedScheduler(previous, deps.identity);
    })),
    createInvitation: () => serial(async () => {
      await deps.sync({ force: true }); const { roster, group } = await current();
      if (group.rotationRequired) throw new SharingKeyVersionError('共有鍵を更新してから招待してください。');
      const link = await createSharedInvitation(deps.crypto, roster, deps.identity, `invite.${deps.makeId()}`, now());
      await deps.cloud.createInvitation(link.invitation); return { ...link, url: encodeCompactSharedInvitation(link) };
    }),
    approve: (invitation: SignedSharedInvitation, request: SharedJoinRequest) => serial(async () => {
      verifySharedJoinRequest(request, invitation, request.body.userId, now());
      await rotate((previous, revoked) => {
        if (revoked.length) throw new SharingKeyVersionError('退出したメンバーの鍵を更新してから承認してください。');
        const existing = previous.body.members.find((member) => member.userId === request.body.userId)?.devices.find((device) => device.identity.deviceId === request.body.identity.deviceId);
        if (existing) {
          if (existing.identity.signingPublicKey !== request.body.identity.signingPublicKey || existing.identity.agreementPublicKey !== request.body.identity.agreementPublicKey) throw new Error('Device key changed');
          return previous;
        }
        return approveSharedDevice(previous, deps.identity, request.body.userId, request.body.identity);
      }, { invitation, request });
    }),
    removeMembers: (userIds: readonly string[]) => serial(() => rotate((previous, revoked) =>
      removeSharedMembers(previous, deps.identity, [...new Set([...revoked, ...userIds])]))),
    removeDevice: (deviceId: string) => serial(() => rotate((previous, revoked) => {
      if (revoked.length) throw new SharingKeyVersionError('退出したメンバーの鍵を更新してから端末を解除してください。');
      return removeSharedDevice(previous, deps.identity, deviceId);
    })),
    repairDepartures: () => serial(() => rotate((previous, revoked) => revoked.length ? removeSharedMembers(previous, deps.identity, revoked) : previous)),
    transferOwnership: (successor: { userId: string; deviceId: string }) => serial(() => rotate((previous, revoked) => {
      if (revoked.length) throw new SharingKeyVersionError('退出したメンバーの鍵を更新してから引き継いでください。');
      return transferSharedOwnership(previous, deps.identity, successor);
    })),
    leave: () => serial(async () => {
      const { group } = await deps.cloud.readGroup(deps.groupId);
      if (group.ownerUserId === deps.userId) {
        if (group.memberIds.length !== 1) throw new Error('退出する前に所有者を別のメンバーへ引き継いでください。');
        await rotate((previous) => removeSharedMembers(previous, deps.identity, [deps.userId]));
      } else await deps.cloud.leaveGroup(deps.groupId);
      await deps.markLeft(); deps.changed();
    }),
    publishSnapshot: () => serial(async () => {
      await deps.sync({ force: true, budgetMs: 120_000 }); const { roster, group, archive } = await current();
      const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
      if (checkpoint.sequence !== group.headSequence) throw new SharingCloudChangedError('最新の共有データを受信してください。');
      const key = await deps.readKey(roster.body.keyVersion); if (!key) throw new Error('共有鍵が見つかりません。');
      try {
        const snapshot = await createEncryptedSharedSnapshot(deps.crypto, await loadPublishedSharedReplica(deps.database, deps.groupId),
          await loadSharedFacts(deps.database, deps.groupId), roster, deps.identity, key, `snapshot.${deps.makeId()}`, group.headSequence,
          (uid, device, version) => sharedAuthorIdentity(archive.find((item) => item.body.keyVersion === version)!, uid, device, version));
        await deps.cloud.prepareSnapshot(snapshot, roster); await deps.cloud.publishSnapshot(snapshot.manifest, roster);
        await deps.sync({ force: true }); return sharedRosterDigest(roster);
      } finally { key.fill(0); }
    }),
  };
}
