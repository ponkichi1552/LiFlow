import type { SQLiteDatabase } from 'expo-sqlite';
import type { createSharingCloud } from '../../platform/sharing/firestore-cloud.ts';
import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry.ts';
import type { SharedReplica } from './replica.ts';
import { canonicalJson, SHARED_SCHEDULER_VERSION } from './operations.ts';
import { decryptAuthenticatedSharedOperation, encryptSharedOperation, sharedDocumentDigest, signSharedOperation, unwrapGroupKey } from './crypto.ts';
import type { AuthenticatedSharedOperation, DeviceSecretIdentity, SharingCryptoGateway } from './crypto.ts';
import { assertSharedCloudAccess, SharingAccessError, SharingKeyVersionError, SharingSchedulerVersionError, SharingSnapshotRequiredError } from './cloud-contract.ts';
import type { SharedCloudGroup, SharedCloudEvent } from './cloud-contract.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifySharedRosterTransition } from './roster.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from './roster.ts';
import { openEncryptedSharedSnapshot } from './snapshots.ts';
import type { VerifiedSharedSnapshot } from './snapshots.ts';
import { V2_SCHEDULER_VERSION, isSupportedV2Scheduler } from './v2/payload-schema.ts';
import { readCloudWorkspaceArchive } from './workspace-protocol.ts';
import { v2AuthorProofDigest } from './v2/server-receipts.ts';
import type { SharedLedgerEvidence } from '../../platform/storage/sharing-ledger.ts';
import { acknowledgeSharingUpload, applyReceivedSharedFacts, applySharingSnapshot, deferSharingUpload, listSharingOutbox,
  loadSharedReplica, readSharingCheckpoint, replaceSharingEnvelopeAfterRotation, saveSharingEnvelope } from '../../platform/storage/sharing-ledger.ts';

export type SharingCloud = ReturnType<typeof createSharingCloud>;
export interface SharingSyncResult { sent: number; received: number; pending: number; waitingForApproval: boolean; complete: boolean }
export interface SharedV2SyncProtocol {
  schedulerVersion: typeof V2_SCHEDULER_VERSION;
  eventEvidence: (facts: readonly AuthenticatedSharedOperation[], events: readonly SharedCloudEvent[], archive: readonly VerifiedSharedRoster[]) => Promise<SharedLedgerEvidence>;
  snapshotEvidence: (snapshot: VerifiedSharedSnapshot, archive: readonly VerifiedSharedRoster[], deadline: number) => Promise<SharedLedgerEvidence>;
}
export interface SharedSyncDependencies {
  database: SQLiteDatabase; groupId: string; userId: string; identity: DeviceSecretIdentity; crypto: SharingCryptoGateway; cloud: SharingCloud;
  readRecord: () => Promise<SharingWorkspaceRecord>; saveArchive: (archive: VerifiedSharedRoster[]) => Promise<void>;
  readKey: (version: number) => Promise<Uint8Array | null>; saveKey: (version: number, bytes: Uint8Array) => Promise<void>;
  project: (transaction: SQLiteDatabase, replica: SharedReplica) => Promise<void>;
  serialized: <T>(operation: () => Promise<T>) => Promise<T>; changed: () => void; now?: () => number;
  /** Default callers remain v1. V2 requires its receipt-aware business projection and complete evidence callbacks. */
  v2?: SharedV2SyncProtocol;
}
const verifiedArchives = new WeakMap<SharedSyncDependencies, { pin: string; archive: VerifiedSharedRoster[] }>();
function assertSupportedProtocol(deps: SharedSyncDependencies, roster: VerifiedSharedRoster): void {
  if (roster.body.schemaVersion !== (deps.v2 ? 2 : 1)
    || (deps.v2 ? !isSupportedV2Scheduler(roster.body.schedulerVersion) : roster.body.schedulerVersion !== SHARED_SCHEDULER_VERSION)
    || deps.v2 && (deps.v2.schedulerVersion !== V2_SCHEDULER_VERSION
      || typeof deps.v2.eventEvidence !== 'function' || typeof deps.v2.snapshotEvidence !== 'function')) throw new SharingSchedulerVersionError();
}

/** A durable trust pin, never a server-supplied public key, anchors every epoch. */
export async function verifyCloudMembership(deps: SharedSyncDependencies, current: SignedSharedRoster): Promise<VerifiedSharedRoster[]> {
  const record = await deps.readRecord();
  if (record.userId !== deps.userId || record.groupId !== deps.groupId || ['left', 'removed'].includes(record.status)) throw new SharingAccessError('この共有グループは利用できません。');
  const last = record.rosterArchive.at(-1);
  if (current.body.revision > 4096 || (last && current.body.revision < last.body.revision)) throw new Error('Shared membership rollback or history limit');
  const pin = 'body' in record.anchor ? { groupId: record.groupId, digest: sharedRosterDigest(record.anchor),
    ownerUserId: record.anchor.body.ownerUserId, ownerIdentity: record.anchor.signer } : record.anchor;
  const cached = verifiedArchives.get(deps);
  if (cached?.pin === pin.digest && cached.archive.length <= current.body.revision) {
    const archive = [...cached.archive];
    for (let revision = archive.length + 1; revision <= current.body.revision; revision++) archive.push(verifySharedRosterTransition(archive.at(-1)!,
      revision === current.body.revision ? current : record.rosterArchive[revision - 1] ?? await deps.cloud.readRoster(deps.groupId, revision)));
    const latest = archive.at(-1)!;
    if (sharedRosterDigest(latest) !== sharedRosterDigest(current)) throw new Error('Shared membership changed at an existing revision');
    if (record.join && sharedRosterDigest(archive[record.join.invitation.body.pin.revision - 1]) !== record.join.invitation.body.pin.digest) throw new Error('Invitation does not reach the previously trusted membership chain');
    assertSupportedProtocol(deps, latest);
    await deps.saveArchive(archive); verifiedArchives.set(deps, { pin: pin.digest, archive }); return archive;
  }
  const archive = await readCloudWorkspaceArchive(record, current, (groupId, revision) => deps.cloud.readRoster(groupId, revision));
  const latest = archive.at(-1)!;
  assertSupportedProtocol(deps, latest);
  await deps.saveArchive(archive); verifiedArchives.set(deps, { pin: pin.digest, archive }); return archive;
}

/** One coordinator per workspace. Process exits leave events, never a persisted "syncing" lock. */
export function createSharedSynchronizer(deps: SharedSyncDependencies) {
  const now = deps.now ?? Date.now; let running: Promise<SharingSyncResult> | null = null; let requested = false; let forceRequested = false;
  let maintenance: Promise<unknown> | null = null;
  async function keyFor(roster: VerifiedSharedRoster): Promise<Uint8Array> {
    const version = roster.body.keyVersion; const saved = await deps.readKey(version); if (saved) return saved.slice();
    const wrapped = await deps.cloud.readGroupKey(deps.groupId, version, deps.identity.deviceId);
    const owner = roster.body.members.flatMap((member) => member.devices).find((device) => device.identity.deviceId === roster.body.ownerDeviceId)?.identity;
    const sender = wrapped.senderDeviceId === roster.signer.deviceId ? roster.signer : owner;
    if (!sender || wrapped.senderDeviceId !== sender.deviceId) throw new Error('共有鍵の配布元を確認できません。');
    const key = await unwrapGroupKey(deps.crypto, wrapped, deps.identity, deps.userId, sender, deps.groupId, version);
    await deps.saveKey(version, key); return key;
  }
  async function perform(options: { force?: boolean; budgetMs?: number }): Promise<SharingSyncResult> {
    const deadline = now() + Math.max(1000, Math.min(options.budgetMs ?? 20_000, 120_000));
    let sent = 0; let received = 0; let metadata;
    const waiting = async (): Promise<SharingSyncResult> => ({ sent, received,
      pending: (await readSharingCheckpoint(deps.database, deps.groupId)).pendingCount, waitingForApproval: true, complete: false });
    try { metadata = await deps.cloud.readGroup(deps.groupId); }
    catch (error) {
      if ((await deps.readRecord()).status === 'joining' && error && typeof error === 'object' && 'code' in error
        && ['permission-denied', 'sharing/access-denied'].includes(String(error.code))) return waiting();
      throw error;
    }
    let archive = await verifyCloudMembership(deps, metadata.roster); let roster = archive.at(-1)!;
    if (metadata.group.deviceOwners[deps.identity.deviceId] !== deps.userId && (await deps.readRecord()).status === 'joining') return waiting();
    assertSharedCloudAccess(metadata.group, deps.userId, deps.identity.deviceId);
    const historicalAuthor = (uid: string, device: string, version: number) => {
      const epoch = archive.find((item) => item.body.keyVersion === version);
      if (!epoch) throw new Error('Missing original author membership'); return sharedAuthorIdentity(epoch, uid, device, version);
    };
    const keys = new Map<number, Uint8Array>();
    const getKey = async (epoch: VerifiedSharedRoster) => {
      let bytes = keys.get(epoch.body.keyVersion);
      if (!bytes) { bytes = await keyFor(epoch); keys.set(epoch.body.keyVersion, bytes); } return bytes;
    };
    const acceptedV2: { fact: AuthenticatedSharedOperation; event: SharedCloudEvent }[] = [];
    const flushAcceptedV2 = async () => {
      const protocol = deps.v2; if (!protocol || !acceptedV2.length) return;
      const facts = acceptedV2.map((item) => item.fact); const events = acceptedV2.map((item) => item.event);
      const evidence = await protocol.eventEvidence(facts, events, archive);
      await deps.serialized(async () => {
        const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
        await applyReceivedSharedFacts(deps.database, deps.groupId, facts, checkpoint.cursor ?? '0', deps.project, checkpoint.cursor, now(), evidence);
      });
      acceptedV2.length = 0; deps.changed();
    };
    const adoptSnapshot = async (group: SharedCloudGroup, force = false) => {
      const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
      if (!group.snapshotId || !force && group.snapshotId === checkpoint.snapshotId) return;
      const encrypted = await deps.cloud.readSnapshot(deps.groupId, group.snapshotId, archive);
      const epoch = archive.find((item) => sharedRosterDigest(item) === encrypted.manifest.body.rosterDigest);
      if (!epoch || encrypted.manifest.body.throughSequence !== group.snapshotThroughSequence) throw new Error('Snapshot does not match shared metadata');
      const snapshot = await openEncryptedSharedSnapshot(deps.crypto, encrypted, await getKey(epoch), epoch, historicalAuthor);
      const evidence = await deps.v2?.snapshotEvidence(snapshot, archive, deadline);
      await deps.serialized(() => applySharingSnapshot(deps.database, deps.groupId, snapshot, deps.project, checkpoint.cursor, now(), evidence)); deps.changed();
    };
    const refreshMetadata = async (forceSnapshot = false) => {
      metadata = await deps.cloud.readGroup(deps.groupId); archive = await verifyCloudMembership(deps, metadata.roster); roster = archive.at(-1)!;
      assertSharedCloudAccess(metadata.group, deps.userId, deps.identity.deviceId); await getKey(roster); await adoptSnapshot(metadata.group, forceSnapshot);
    };
    try {
      await getKey(roster); await adoptSnapshot(metadata.group);
      const pull = async () => {
        let races = 0;
        do {
          const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId); let page;
          try { page = await deps.cloud.pull(deps.groupId, checkpoint.sequence); }
          catch (error) { if (!(error instanceof SharingSnapshotRequiredError) || ++races > 3) throw error; await refreshMetadata(); continue; }
          if (sharedRosterDigest(page.roster) !== sharedRosterDigest(roster)) { await refreshMetadata(); continue; }
          metadata = page;
          if (page.group.snapshotId && page.group.snapshotId !== checkpoint.snapshotId) { await adoptSnapshot(page.group); continue; }
          const facts: AuthenticatedSharedOperation[] = [];
          for (const event of page.events) {
            // Removed authors' history comes from a signed snapshot. New transport events use the current epoch.
            if (event.envelope.keyVersion !== roster.body.keyVersion) throw new SharingKeyVersionError('共有履歴を最新の鍵で再取得する必要があります。');
            const author = sharedAuthorIdentity(roster, event.envelope.authorUserId, event.envelope.authorDeviceId, event.envelope.keyVersion);
            const fact = await decryptAuthenticatedSharedOperation(deps.crypto, event.envelope, await getKey(roster), author, deps.groupId, roster.body.keyVersion);
            if (fact.operation.schemaVersion !== roster.body.schemaVersion) throw new SharingSchedulerVersionError();
            sharedAuthorIdentity(roster, fact.operation.authorUserId, fact.operation.authorDeviceId, fact.operation.keyVersion); facts.push(fact);
          }
          if (facts.length) {
            const evidence = await deps.v2?.eventEvidence(facts, page.events, archive);
            await deps.serialized(() => applyReceivedSharedFacts(deps.database, deps.groupId, facts, String(page.throughSequence), deps.project, checkpoint.cursor, now(), evidence));
            received += facts.length; deps.changed();
          }
          if (page.throughSequence >= page.group.headSequence) return true;
        } while (now() < deadline);
        return false;
      };
      let complete = await pull();
      if (metadata.group.rotationRequired) throw new SharingKeyVersionError('退出したメンバーを除いて共有鍵を更新する必要があります。');
      while (now() < deadline) {
        const items = await listSharingOutbox(deps.database, deps.groupId, options.force ? Number.MAX_SAFE_INTEGER : now()); if (!items.length) break;
        for (const item of items) {
          if (now() >= deadline) break;
          const op = item.operation;
          if (op.schemaVersion !== roster.body.schemaVersion) throw new SharingSchedulerVersionError();
          if (op.authorUserId !== deps.userId || op.authorDeviceId !== deps.identity.deviceId) throw new Error('共有の未送信操作が別の端末に属しています。');
          sharedAuthorIdentity(roster, op.authorUserId, op.authorDeviceId, op.keyVersion);
          let encoded = item.encryptedEnvelope;
          if (!encoded) { encoded = canonicalJson(await encryptSharedOperation(deps.crypto, op, await getKey(roster), deps.identity, roster.body.keyVersion)); await saveSharingEnvelope(deps.database, op.operationId, encoded); }
          let accepted;
          const uploadOptions = deps.v2 ? { authorProofDigest: v2AuthorProofDigest(signSharedOperation(op, deps.identity)) } : undefined;
          try {
            try { accepted = await deps.cloud.upload(JSON.parse(encoded), uploadOptions); }
            catch (error) {
              if (error instanceof SharingSnapshotRequiredError && deps.v2) {
                await flushAcceptedV2();
                await refreshMetadata(true);
                if ((await listSharingOutbox(deps.database, deps.groupId, Number.MAX_SAFE_INTEGER)).some((pending) => pending.operation.operationId === op.operationId)) throw error;
                continue;
              }
              if (!(error instanceof SharingKeyVersionError)) throw error;
              // upload() checked absence transactionally before reporting the changed server epoch.
              await flushAcceptedV2(); await refreshMetadata(); if (metadata.group.rotationRequired) throw error;
              sharedAuthorIdentity(roster, op.authorUserId, op.authorDeviceId, op.keyVersion);
              const replacement = canonicalJson(await encryptSharedOperation(deps.crypto, op, await getKey(roster), deps.identity, roster.body.keyVersion));
              await replaceSharingEnvelopeAfterRotation(deps.database, deps.groupId, op.operationId, encoded, replacement, roster.body.keyVersion);
              encoded = replacement; accepted = await deps.cloud.upload(JSON.parse(encoded), uploadOptions);
            }
          } catch (error) {
            const random = await deps.crypto.randomBytes(4);
            await deferSharingUpload(deps.database, op.operationId, now(), new DataView(random.buffer, random.byteOffset, random.byteLength).getUint32(0) / 0x100000000); throw error;
          }
          const epoch = archive.find((item) => item.body.keyVersion === accepted.envelope.keyVersion); if (!epoch) throw new Error('Accepted event uses an unknown key epoch');
          const fact = await decryptAuthenticatedSharedOperation(deps.crypto, accepted.envelope, await getKey(epoch), deps.identity, deps.groupId, epoch.body.keyVersion);
          if (sharedDocumentDigest(fact.operation) !== sharedDocumentDigest(op)) throw new Error('Server acknowledged a different shared operation');
          if (deps.v2) {
            acceptedV2.push({ fact, event: accepted });
            if (acceptedV2.length >= 25) await flushAcceptedV2();
          } else await acknowledgeSharingUpload(deps.database, op.operationId, { groupId: deps.groupId, envelope: encoded });
          sent++;
        }
        await flushAcceptedV2();
      }
      if (now() < deadline) complete = await pull();
      const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
      if (complete && !(await loadSharedReplica(deps.database, deps.groupId)).pendingOperationIds.length) await deps.cloud.acknowledge(deps.groupId, deps.identity.deviceId, checkpoint.sequence);
      return { sent, received, pending: checkpoint.pendingCount, waitingForApproval: false, complete };
    } finally {
      try { await flushAcceptedV2(); }
      finally { for (const bytes of keys.values()) bytes.fill(0); }
    }
  }
  function sync(options: { force?: boolean; budgetMs?: number } = {}): Promise<SharingSyncResult> {
    if (maintenance) return maintenance.then(() => sync(options), () => sync(options));
    if (running) { requested = true; forceRequested ||= Boolean(options.force); return running; }
    const pending = (async () => {
      let result = await perform(options);
      if (requested) { const force = forceRequested; requested = false; forceRequested = false;
        const next = await perform({ ...options, force: options.force || force }); result = { ...next, sent: result.sent + next.sent, received: result.received + next.received }; }
      return result;
    })(); running = pending;
    void pending.finally(() => { if (running === pending) running = null; requested = false; forceRequested = false; }).catch(() => undefined); return pending;
  }
  return { sync,
    /** Network maintenance waits for the current delivery, while local SQLite edits remain available.
     * The callback must not recursively call sync; trigger adoption after this promise settles. */
    withMaintenance<T>(work: () => Promise<T>): Promise<T> {
      if (maintenance) return Promise.reject(new Error('共有の復旧処理を実行中です。'));
      const prior = running;
      const pending = Promise.resolve().then(async () => { if (prior) await prior.catch(() => undefined); return work(); });
      maintenance = pending;
      void pending.finally(() => { if (maintenance === pending) maintenance = null; }).catch(() => undefined);
      return pending;
    },
  };
}
