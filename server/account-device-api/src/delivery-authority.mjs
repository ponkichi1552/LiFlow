import { parseSharedCloudGroup } from '../../../src/features/sharing/cloud-contract.ts';
import { parsePrivateCalendarCloudHead } from '../../../src/features/sharing/private-calendar/cloud-contract.ts';
import { verifyPrivateCalendarAuthorityUpdate, verifyPrivateCalendarRoot } from '../../../src/features/sharing/private-calendar/authority.ts';
import { sharedRosterDigest, verifyPinnedSharedRoster, verifySharedRosterTransition } from '../../../src/features/sharing/roster.ts';

const histories = new WeakMap();
const MAX_REVISIONS = 4096;

function verifyGroupRoot(record, id) {
  const roster = JSON.parse(record.rosterJson);
  const body = roster.body;
  if (body.revision !== 1 || body.members.length !== 1 || body.members[0].devices.length !== 1) throw new Error('Invalid delivery roster anchor');
  return verifyPinnedSharedRoster(roster, { groupId: id, digest: sharedRosterDigest(roster), ownerUserId: body.ownerUserId, ownerIdentity: roster.signer });
}

/** The current root is read in the erasure transaction. History documents are append-only under Rules. */
export async function verifiedDeliveryAuthority(firestore, root, raw, kind) {
  if (!raw) return null;
  const shared = kind === 'shared';
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...privateHead } = raw;
  const metadata = shared ? parseSharedCloudGroup(raw, root.id).group : parsePrivateCalendarCloudHead(privateHead, root.id);
  const revision = shared ? metadata.rosterRevision : metadata.authorityRevision;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISIONS) throw new Error('Delivery authority revision outside verified range');
  const currentJson = shared ? raw.rosterJson : raw.authorityJson;
  const anchor = shared ? `${root.id}:${raw.createdAt?.seconds}:${raw.createdAt?.nanoseconds}` : metadata.rootDigest;
  let cache = histories.get(firestore);
  if (!cache) { cache = new Map(); histories.set(firestore, cache); }
  const cached = cache.get(root.path);
  let verified = cached?.anchor === anchor && (cached.revision < revision || cached.revision === revision && cached.tip === currentJson)
    ? cached.verified : undefined;
  const first = verified ? cached.revision + 1 : 1;
  let tip = verified ? cached.tip : null;
  const history = root.collection(shared ? 'rosters' : 'authorities');
  for (let start = first; start <= revision; start += 64) {
    const refs = Array.from({ length: Math.min(64, revision - start + 1) }, (_, index) => history.doc(String(start + index)));
    const rows = await firestore.getAll(...refs);
    for (const snapshot of rows) {
      const data = snapshot.data();
      const rawJson = shared ? data?.rosterJson : data?.authorityJson;
      if (typeof rawJson !== 'string' || rawJson.length > (shared ? 60_000 : 16_000)) throw new Error('Missing delivery authority revision');
      verified = shared
        ? verified ? verifySharedRosterTransition(verified, JSON.parse(rawJson)) : verifyGroupRoot(data, root.id)
        : verified ? verifyPrivateCalendarAuthorityUpdate(verified, JSON.parse(rawJson))
          : verifyPrivateCalendarRoot(JSON.parse(rawJson), { ownerUserId: root.id, accountGeneration: metadata.accountGeneration, rootDigest: metadata.rootDigest });
      if (!shared && verified.digest !== data.authorityDigest) throw new Error('Delivery authority digest differs');
      tip = rawJson;
    }
  }
  if (!verified || tip !== currentJson || (shared ? verified.body.revision : verified.signed.body.revision) !== revision
    || !shared && verified.digest !== metadata.authorityDigest) throw new Error('Delivery authority tip differs');
  cache.delete(root.path);
  cache.set(root.path, { anchor, revision, verified, tip });
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  const devices = shared ? verified.body.members.filter(member => !metadata.revokedUserIds.includes(member.userId))
    .flatMap(member => member.devices.map(({ identity }) => ({ userId: member.userId, identity })))
    : verified.signed.body.devices.map(identity => ({ userId: root.id, identity }));
  return { metadata, devices, digest: shared ? sharedRosterDigest(verified) : verified.digest };
}
