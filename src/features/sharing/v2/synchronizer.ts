import type { SharedSyncDependencies } from '../synchronizer.ts';
import { createSharedSynchronizer, verifyCloudMembership } from '../synchronizer.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';
import type { SharedCloudEvent } from '../cloud-contract.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from '../roster.ts';
import type { VerifiedSharedSnapshot } from '../snapshots.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { withIsolatedSqliteTransaction } from '../../../platform/storage/isolated-transaction.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import { V2AwaitingReceiptError } from './receiver-authority.ts';
import { V2_SCHEDULER_VERSION } from './payload-schema.ts';
import { verifyV2RecoveryWitnesses } from './recovery-witness.ts';
import { canonicalJson } from '../operations.ts';
import { recoveryArrayDigest } from './recovery-content.ts';
import { sharedRosterDigest } from '../roster.ts';
import { readV2RecoveryEvidence } from './recovery-evidence.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { createV2RecoveryEvidenceProgress } from '../../../platform/storage/sharing-v2-recovery-evidence.ts';
import { preserveV2RecoveryOriginalsInside } from '../../../platform/storage/sharing-v2-recovery.ts';
import { V2RecoveryInProgressError, verifyV2RecoveryLock } from './recovery-lock.ts';

export class V2ReceiptRecoveryPendingError extends Error { readonly code = 'sharing/receipt-recovery-pending'; }
const unrelatedToRecoveryLock = new Set(['unavailable', 'deadline-exceeded', 'cancelled', 'aborted', 'resource-exhausted',
  'permission-denied', 'unauthenticated', 'sharing/access-denied', 'sharing/scheduler-version-mismatch',
  'sharing/receipt-recovery-pending', 'sharing/v2-awaiting-receipt']);

/** Reuse the existing encrypted coordinator; only protocol and receipt-aware projection are specialized. */
export function createV2Synchronizer(dependencies: Omit<SharedSyncDependencies, 'v2' | 'project'> & {
  repository: ReturnType<typeof createV2EventRepository>; assertCurrentAccount: () => void;
  acceptMigrationSnapshot?: (snapshot: VerifiedSharedSnapshot, archive: readonly VerifiedSharedRoster[]) => Promise<void>;
  afterSnapshot?: (snapshot: VerifiedSharedSnapshot, archive: readonly VerifiedSharedRoster[]) => Promise<void>;
}) {
  const { repository, assertCurrentAccount, acceptMigrationSnapshot, afterSnapshot, ...deps } = dependencies;
  if (repository.scope.groupId !== deps.groupId || repository.scope.userId !== deps.userId
    || repository.scope.deviceId !== deps.identity.deviceId) throw new Error('V2 synchronization must use the same account, device and repository');
  const now = deps.now ?? Date.now;
  async function eventEvidence(facts: readonly AuthenticatedSharedOperation[], events: readonly SharedCloudEvent[], archive: readonly VerifiedSharedRoster[]) {
    assertCurrentAccount();
    const originals = new Map(facts.map((fact) => [fact.operation.operationId, fact])); const receipts: V2ServerReceipt[] = [];
    if (originals.size !== events.length || events.length !== facts.length) throw new Error('Receipt evidence has duplicate or missing events');
    for (const event of events) {
      const fact = originals.get(event.operationId); const receipt = event.serverReceipt;
      if (!fact || !receipt || receipt.uploadSequence !== event.uploadSequence || receipt.receivedKeyVersion !== event.envelope.keyVersion
        || receipt.authorProofDigest !== event.authorProofDigest) throw new V2AwaitingReceiptError('Missing independently committed receipt for a received event');
      bindV2ServerReceipt(receipt, fact, archive); receipts.push(receipt);
    }
    return repository.evidenceForServerReceipts(receipts);
  }
  async function snapshotEvidence(snapshot: VerifiedSharedSnapshot, archive: readonly VerifiedSharedRoster[], deadline: number) {
    assertCurrentAccount();
    await acceptMigrationSnapshot?.(snapshot, archive); assertCurrentAccount();
    const facts = new Map(snapshot.facts.filter((fact) => fact.operation.schemaVersion === 2).map((fact) => [fact.operation.operationId, fact]));
    const preservedReceipts = new Map<string, V2ServerReceipt>();
    const recoveries = verifyV2RecoveryWitnesses(snapshot.base.recoveryWitnesses ?? [], archive, deps.groupId);
    const recoveryOriginals = recoveries.length ? await readV2RecoveryEvidence(deps.cloud, deps.groupId, recoveries, assertCurrentAccount, deadline, {
      now, progress: createV2RecoveryEvidenceProgress({ database: deps.database, serialized: deps.serialized, assertCurrentAccount,
        keyVersion: archive.at(-1)!.body.keyVersion, scopeDigest: sharedDocumentDigest({ groupId: deps.groupId, userId: deps.userId,
          deviceId: deps.identity.deviceId, rosterDigest: sharedRosterDigest(archive.at(-1)!), retention: sharedDocumentDigest(snapshot.base.retention ?? null) }) }),
    }) : [];
    const index = new Map(snapshot.base.operationIndex.map(item => [item.operationId, item]));
    for (const recovery of recoveries) {
      if (recovery.body.throughSequence === snapshot.throughSequence && sharedRosterDigest(archive.at(-1)!) === recovery.body.nextRosterDigest
        && recovery.body.retainedIndexDigest !== recoveryArrayDigest(snapshot.base.operationIndex)) throw new Error('Recovery snapshot changed its reviewed retained history');
      for (const entry of recovery.body.entries) {
        if (entry.classification === 'restoredOriginal' ? !index.has(entry.operationId) : index.has(entry.operationId)) throw new Error('Quarantine and active history overlap');
      }
      for (const value of recovery.preservedFacts) {
        const id = value.fact.operation.operationId; const active = facts.get(id);
        if (active && canonicalJson(active) !== canonicalJson(value.fact)) throw new Error('Recovery rewrote a preserved original');
        facts.set(id, value.fact); preservedReceipts.set(id, value.receipt);
      }
    }
    const validateReceipt = (receipt: V2ServerReceipt, fact: AuthenticatedSharedOperation) => {
      bindV2ServerReceipt(receipt, fact, archive);
      const preserved = preservedReceipts.get(receipt.operationId);
      if (preserved && canonicalJson(preserved) !== canonicalJson(receipt)) throw new Error('Recovery changed an immutable server receipt');
    };
    const known = await deps.serialized(() => withIsolatedSqliteTransaction(deps.database, async (transaction) => {
      assertCurrentAccount(); return repository.readReceiptCache(transaction);
    }));
    for (const [id, fact] of facts) { const receipt = known.get(id); if (receipt) validateReceipt(receipt, fact); }
    const missing = [...facts.keys()].filter((id) => !known.has(id));
    for (let offset = 0; offset < missing.length; offset += 1000) {
      if (now() >= deadline) throw new V2ReceiptRecoveryPendingError('受付記録の復旧を保存しました。次の同期で続けます。');
      const ids = missing.slice(offset, offset + 1000); const requested = new Set(ids);
      const page = await deps.cloud.readReceipts(deps.groupId, ids, { deadlineAtMs: deadline }); assertCurrentAccount();
      if (new Set(page.map((receipt) => receipt.operationId)).size !== page.length) throw new Error('Duplicate recovered receipt');
      for (const receipt of page) {
        const fact = facts.get(receipt.operationId);
        if (!fact || !requested.has(receipt.operationId)) throw new Error('Recovered receipt belongs to an unrequested fact');
        validateReceipt(receipt, fact);
      }
      // Persist verified progress separately; the snapshot cursor/outbox stay unchanged until all evidence is available.
      await deps.serialized(() => withIsolatedSqliteTransaction(deps.database, async (transaction) => {
        assertCurrentAccount(); await repository.evidenceForServerReceipts(page).record(transaction); assertCurrentAccount();
      }));
      if (page.length !== ids.length) {
        if (now() >= deadline) throw new V2ReceiptRecoveryPendingError('受付記録の復旧を保存しました。次の同期で続けます。');
        throw new V2AwaitingReceiptError('Snapshotの操作に対応する受付記録を確認できません。');
      }
    }
    const evidence = repository.evidenceForServerReceipts([]);
    return { ...evidence, record: async (transaction: Parameters<typeof evidence.record>[0]) => {
      assertCurrentAccount(); const changed = await evidence.record(transaction);
      if (recoveryOriginals.length) await preserveV2RecoveryOriginalsInside(transaction, deps.groupId, recoveryOriginals);
      assertCurrentAccount(); return changed;
    } };
  }
  const configured: SharedSyncDependencies = { ...deps,
    readRecord: async () => { assertCurrentAccount(); const value = await deps.readRecord(); assertCurrentAccount(); return value; },
    saveArchive: async (archive) => { assertCurrentAccount(); await deps.saveArchive(archive); assertCurrentAccount(); },
    project: async (transaction, replica) => { assertCurrentAccount(); await repository.project(transaction, replica); assertCurrentAccount(); },
    v2: { schedulerVersion: V2_SCHEDULER_VERSION, eventEvidence, snapshotEvidence, afterSnapshot } };
  const synchronizer = createSharedSynchronizer(configured);
  return { ...synchronizer,
    sync: async (options: Parameters<typeof synchronizer.sync>[0] = {}) => {
      const deadline = now() + Math.max(1000, Math.min(options.budgetMs ?? 20_000, 120_000));
      try { return await synchronizer.sync(options); }
      catch (error) {
        assertCurrentAccount();
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code).replace(/^firestore\//u, '') : '';
        // A second request cannot explain transport/auth failures or replace a resumable evidence result.
        if (now() < deadline && deps.cloud.ownerRecoveryEnabled && !(error instanceof V2RecoveryInProgressError) && !unrelatedToRecoveryLock.has(code)) {
          try {
            const lock = await diagnosticRead(() => deps.cloud.readRecoveryLock(deps.groupId), deadline, now); assertCurrentAccount();
            if (lock) {
              const metadata = await diagnosticRead(() => deps.cloud.readGroup(deps.groupId), deadline, now); assertCurrentAccount();
              const history = await verifyCloudMembership(configured, metadata.roster); assertCurrentAccount();
              if (lock.body.keyVersion === history.at(-1)!.body.keyVersion) {
                verifyV2RecoveryLock(lock, history.at(-1)!); throw new V2RecoveryInProgressError();
              }
            }
          } catch (recoveryError) {
            assertCurrentAccount(); if (recoveryError instanceof V2RecoveryInProgressError) throw recoveryError;
          }
        }
        throw error;
      }
    },
    verifyMembership: (current: SignedSharedRoster) => { assertCurrentAccount(); return verifyCloudMembership(configured, current); } };
}

/** Only read-only diagnostic requests may be abandoned at the time boundary. */
async function diagnosticRead<T>(read: () => Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error('Recovery diagnostic deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Recovery diagnostic deadline')), remaining);
    })]);
    if (now() >= deadline) throw new Error('Recovery diagnostic deadline');
    return value;
  } finally { clearTimeout(timer); }
}
