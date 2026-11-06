import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { GoogleTaskCreateIdentity, GoogleTaskCreateIntent } from './task-create-intent';

export interface SharedTaskClaim {
  schemaVersion: 1; scopeHash: string; occurrenceHash: string; revision: number;
  phase: 'reserved' | 'linked' | 'released'; attemptId: string; taskHash: string | null;
}
export interface SharedTaskClaimCloud {
  reserveBatch(intents: readonly GoogleTaskCreateIntent[]): Promise<readonly boolean[]>;
  reject(intent: GoogleTaskCreateIntent): Promise<void>;
  rejectBatch(intents: readonly GoogleTaskCreateIntent[]): Promise<void>;
  linked(identity: GoogleTaskCreateIdentity, taskId: string): Promise<void>;
  deleted(identity: GoogleTaskCreateIdentity, taskId: string): Promise<void>;
}
export interface SharedTaskClaimReader {
  /** A server read, never an offline cached grant. */
  read(identity: GoogleTaskCreateIdentity): Promise<SharedTaskClaim | null>;
}
const hash = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0');
export const sharedTaskIdHash = (taskId: string): string => {
  if (!text(taskId)) throw new Error('Google家事の作成結果を確認してください。');
  return hash(['tasks-id-v1', taskId]);
};

/** Private metadata only. No Google ID, account ID, marker, name, or date is uploaded. */
export function sharedTaskClaimKey(namespace: string, identity: GoogleTaskCreateIdentity) {
  if (![namespace, identity.accountSubject, identity.taskListId, identity.occurrenceMarker].every(text)
    || !/^LiFlow occurrence: [a-f0-9]{64}$/u.test(identity.occurrenceMarker)) throw new Error('共有Google家事の作成先を確認してください。');
  const scopeHash = hash(['tasks-create-scope-v1', namespace, identity.accountSubject, identity.taskListId]);
  return { scopeHash, occurrenceHash: hash(['tasks-create-occurrence-v1', scopeHash, identity.occurrenceMarker]) };
}
export function checkedSharedTaskClaim(value: unknown, key: ReturnType<typeof sharedTaskClaimKey>): SharedTaskClaim {
  const row = value as SharedTaskClaim;
  // Timestamp metadata is checked and removed by the transport.
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 7
    || Object.keys(row).some(name => !['schemaVersion', 'scopeHash', 'occurrenceHash', 'revision', 'phase', 'attemptId', 'taskHash'].includes(name))) throw new Error('共有Google家事の作成記録を確認してください。');
  if (row.schemaVersion !== 1 || row.scopeHash !== key.scopeHash || row.occurrenceHash !== key.occurrenceHash
    || !digest(row.scopeHash) || !digest(row.occurrenceHash) || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !text(row.attemptId) || row.attemptId.length > 512 || !['reserved', 'linked', 'released'].includes(row.phase)
    || (row.phase === 'linked' ? !digest(row.taskHash) : row.taskHash !== null)) throw new Error('共有Google家事の作成記録を確認してください。');
  return { ...row };
}
const nextRevision = (row: SharedTaskClaim | null) => {
  const next = (row?.revision ?? 0) + 1; if (!Number.isSafeInteger(next)) throw new Error('Google家事の作成記録を確認してください。'); return next;
};
export function reserveSharedTaskClaim(row: SharedTaskClaim | null, key: ReturnType<typeof sharedTaskClaimKey>, intent: GoogleTaskCreateIntent): SharedTaskClaim | null {
  if (!text(intent.attemptId) || intent.attemptId.length > 512 || !Number.isFinite(Date.parse(intent.startedAt))) throw new Error('Google家事の作成試行を確認してください。');
  if (row && row.phase !== 'released') return null;
  if (row?.attemptId === intent.attemptId) throw new Error('Google家事の作成試行を使い直すことはできません。');
  return { schemaVersion: 1, ...key, revision: nextRevision(row), phase: 'reserved', attemptId: intent.attemptId, taskHash: null };
}
export function linkSharedTaskClaim(row: SharedTaskClaim | null, key: ReturnType<typeof sharedTaskClaimKey>, taskId: string): SharedTaskClaim | null {
  const taskHash = sharedTaskIdHash(taskId);
  if (row?.phase === 'linked') {
    if (row.taskHash !== taskHash) throw Object.assign(new Error('同じ共有家事のGoogle対応記録が異なります。保存内容は保持しています。'), { code: 'ambiguous_task_occurrence' });
    return null;
  }
  return { schemaVersion: 1, ...key, revision: nextRevision(row), phase: 'linked',
    attemptId: row?.phase === 'reserved' ? row.attemptId : `observed.${taskHash}`, taskHash };
}
/** Expiry or a device stopping is never evidence that a non-idempotent POST did not succeed. */
export function releaseSharedTaskClaim(row: SharedTaskClaim | null, expected: { attemptId: string } | { taskId: string }): SharedTaskClaim | null {
  if (!text('attemptId' in expected ? expected.attemptId : expected.taskId)) throw new Error('Google家事の作成記録を確認してください。');
  if (!row || row.phase === 'released') return null;
  const matches = 'attemptId' in expected ? row.phase === 'reserved' && row.attemptId === expected.attemptId
    : row.phase === 'linked' && row.taskHash === sharedTaskIdHash(expected.taskId);
  return matches ? { ...row, phase: 'released', taskHash: null, revision: nextRevision(row) } : null;
}
