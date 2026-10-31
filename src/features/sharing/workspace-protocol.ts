import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry.ts';
import { SHARED_SCHEDULER_VERSION } from './operations.ts';
import { SharingSchedulerVersionError } from './cloud-contract.ts';
import { sharedRosterDigest, validateSharedRoster, verifyPinnedSharedRoster, verifySharedRosterArchive } from './roster.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from './roster.ts';
import { isSupportedV2Scheduler } from './v2/payload-schema.ts';

export type SharedWorkspaceProtocol = 1 | 2;

/** The protocol is authoritative only after the locally pinned signature chain has been verified. */
export function sharedWorkspaceProtocol(roster: VerifiedSharedRoster): SharedWorkspaceProtocol {
  if (roster.body.schemaVersion === 1 && roster.body.schedulerVersion === SHARED_SCHEDULER_VERSION) return 1;
  if (roster.body.schemaVersion === 2 && isSupportedV2Scheduler(roster.body.schedulerVersion)) return 2;
  throw new SharingSchedulerVersionError();
}

/** A pending invitation without its signed archive has no known database format yet. */
export function verifyWorkspaceArchive(record: SharingWorkspaceRecord, inputs: readonly SignedSharedRoster[] = record.rosterArchive): VerifiedSharedRoster[] | null {
  const { anchor, groupId } = record;
  if ('body' in anchor && anchor.body.groupId !== groupId || !('body' in anchor) && anchor.groupId !== groupId) throw new Error('Workspace pin group mismatch');
  if (!inputs.length && !('body' in anchor)) {
    if (record.status !== 'joining') throw new Error('Missing trusted membership archive');
    return null;
  }
  const pin = 'body' in anchor ? { groupId, digest: sharedRosterDigest(anchor), ownerUserId: anchor.body.ownerUserId,
    ownerIdentity: anchor.signer } : anchor;
  const archive = inputs.length ? inputs : 'body' in anchor ? [anchor] : [];
  const revision = 'body' in anchor ? anchor.body.revision : anchor.revision;
  const pinned = archive[revision - 1]; if (!pinned) throw new Error('Missing trusted membership pin');
  const verified = verifySharedRosterArchive(verifyPinnedSharedRoster(pinned, pin), archive);
  if (record.join) {
    const invitationPin = record.join.invitation.body.pin; const epoch = verified[invitationPin.revision - 1];
    if (!epoch || sharedRosterDigest(epoch) !== invitationPin.digest) throw new Error('Invitation does not reach the previously trusted membership chain');
  }
  sharedWorkspaceProtocol(verified.at(-1)!);
  return verified;
}

/** Fetch only bounded public membership history; no database or group secret is needed to choose a format. */
export async function readCloudWorkspaceArchive(record: SharingWorkspaceRecord, currentInput: SignedSharedRoster,
  readRoster: (groupId: string, revision: number) => Promise<SignedSharedRoster>): Promise<VerifiedSharedRoster[]> {
  const current = validateSharedRoster(currentInput); const last = record.rosterArchive.at(-1);
  if (current.body.groupId !== record.groupId || current.body.revision > 4096 || last && current.body.revision < last.body.revision) throw new Error('Shared membership rollback or history limit');
  const inputs = [...record.rosterArchive];
  for (let revision = inputs.length + 1; revision <= current.body.revision; revision++) inputs.push(
    revision === current.body.revision ? current : await readRoster(record.groupId, revision));
  const archive = verifyWorkspaceArchive(record, inputs);
  if (!archive || sharedRosterDigest(archive.at(-1)!) !== sharedRosterDigest(current)) throw new Error('Shared membership changed at an existing revision');
  return archive;
}
