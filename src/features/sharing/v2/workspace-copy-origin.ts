import { assertSharedIdentifier } from '../identifier.ts';

export interface WorkspaceCopyPosition {
  groupId: string;
  rosterDigest: string;
  sequence: number;
}

export interface WorkspaceCopyDestination {
  groupId: string;
  userIds: readonly string[];
}

export interface WorkspaceCopyOrigin extends WorkspaceCopyPosition {
  revision: number;
  userIds: string[];
}

export const maxCopyOperations = 4096;
export const maxCopyRosterRevisions = 4096;

export function assertWorkspaceCopyScopes(source: WorkspaceCopyPosition, destination: WorkspaceCopyDestination) {
  assertSharedIdentifier(source.groupId);
  assertSharedIdentifier(destination.groupId);
  if (source.groupId === destination.groupId || !/^[a-f0-9]{64}$/u.test(source.rosterDigest)
    || !Number.isSafeInteger(source.sequence) || source.sequence < 1 || source.sequence > maxCopyOperations
    || !Array.isArray(destination.userIds) || destination.userIds.length < 1 || destination.userIds.length > 16
    || new Set(destination.userIds).size !== destination.userIds.length) {
    throw new Error('引き継ぐ元と新しい共有グループを確認してください。');
  }
  destination.userIds.forEach(assertSharedIdentifier);
}

export function validateWorkspaceCopyOrigin(input: WorkspaceCopyOrigin, destinationId: string) {
  assertWorkspaceCopyScopes(input, { groupId: destinationId, userIds: input.userIds });
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > maxCopyRosterRevisions
    || Object.keys(input).sort().join(',') !== 'groupId,revision,rosterDigest,sequence,userIds') throw new Error('引き継ぎ元を確認してください。');
  return input;
}

export function workspaceCopyPin({ groupId, rosterDigest, sequence }: WorkspaceCopyOrigin): WorkspaceCopyPosition {
  return { groupId, rosterDigest, sequence };
}
