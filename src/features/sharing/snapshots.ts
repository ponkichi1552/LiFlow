import { assertJsonRecord, assertSharedIdentifier, canonicalJson, SHARED_SCHEDULER_VERSION } from './operations.ts';
import type { VersionVector } from './operations.ts';
import { compactSharedReplica, validateSharedSnapshotBase } from './replica.ts';
import type { SharedOperationReceipt, SharedReplica, SharedSnapshotBase } from './replica.ts';
import { MAX_SHARED_SNAPSHOT_CHUNK_BYTES, openSharedSnapshotChunk, sealSharedSnapshotChunk, sharedDocumentDigest,
  signSharedDocument, verifyAuthenticatedSharedOperation, verifySharedDocument } from './crypto.ts';
import type { AuthenticatedSharedOperation, DevicePublicIdentity, DeviceSecretIdentity, EncryptedSharedSnapshotChunk, SharingCryptoGateway } from './crypto.ts';
import { sharedRosterDigest } from './roster.ts';
import type { VerifiedSharedRoster } from './roster.ts';
import { isSupportedV2Scheduler } from './v2/payload-schema.ts';
import type { SignedLegacyMigrationWitness } from './v2/legacy-migration-witness.ts';
import { validateLegacyMigrationWitness } from './v2/legacy-migration-witness.ts';
import { validateV2RecoveryWitness } from './v2/recovery-witness.ts';
import type { SignedV2RecoveryHeader, SignedV2RecoveryWitness, V2RecoveryPreservedFact } from './v2/recovery-witness.ts';
import { assertV2RetentionBase } from './v2/history-retention-certificate.ts';
import type { V2RetentionWitness } from './v2/history-retention-certificate';
import type { V2ServerReceipt } from './v2/server-receipts';
import type { V2RetentionBody } from './v2/history-retention-schema';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';

export type SharedAuthorResolver = (userId: string, deviceId: string, keyVersion: number) => DevicePublicIdentity;
interface SharedSnapshotManifestBody {
  schemaVersion: 1 | 2; groupId: string; snapshotId: string; keyVersion: number; throughSequence: number;
  ownerDeviceId: string; rosterDigest: string; schedulerVersion: string;
  frontier: VersionVector; logicalClock: number; receiptCount: number; factCount: number;
  recoveryCount?: number;
  retentionCutoff?: string;
  retentionThroughSequence?: number;
  retentionKeyVersion?: number;
  chunks: { id: string; digest: string; bytes: number }[];
}
export interface SignedSharedSnapshotManifest { body: SharedSnapshotManifestBody; signature: string }
export interface EncryptedSharedSnapshot { manifest: SignedSharedSnapshotManifest; chunks: EncryptedSharedSnapshotChunk[] }
export interface VerifiedSharedSnapshot { base: SharedSnapshotBase; facts: AuthenticatedSharedOperation[]; snapshotId: string; throughSequence: number }
type SnapshotRecord = { kind: 'receipt'; value: SharedOperationReceipt } | { kind: 'fact'; value: AuthenticatedSharedOperation }
  | { kind: 'legacyMigrationWitness'; value: SignedLegacyMigrationWitness }
  | { kind: 'recoveryWitness'; value: SignedV2RecoveryHeader }
  | { kind: 'recoveryPreservedFact'; value: V2RecoveryPreservedFact & { snapshotId: string } };
type RetentionRecord = { kind: 'retentionProposal'; value: AuthenticatedSharedOperation }
  | { kind: 'retentionReceipt'; value: V2ServerReceipt } | { kind: 'retentionApproval'; value: AuthenticatedSharedOperation };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function authenticate(fact: AuthenticatedSharedOperation, groupId: string, keyVersion: number, author: SharedAuthorResolver) {
  const op = fact.operation;
  if (op.keyVersion > keyVersion) throw new Error('Snapshot contains a future authoring epoch');
  return verifyAuthenticatedSharedOperation(fact, author(op.authorUserId, op.authorDeviceId, op.keyVersion), groupId);
}

function snapshotSigner(roster: VerifiedSharedRoster, deviceId: string): DevicePublicIdentity {
  // A handover snapshot is atomically committed by the outgoing owner who signed this transition.
  if (roster.body.accountDeviceRestore && deviceId !== roster.body.ownerDeviceId) throw new Error('Account device restoration does not grant snapshot ownership');
  if (deviceId !== roster.body.ownerDeviceId && deviceId !== roster.signer.deviceId) throw new Error('Untrusted snapshot owner');
  const identity = roster.body.members.flatMap((member) => member.devices).find((device) => device.identity.deviceId === deviceId)?.identity;
  if (!identity || (deviceId === roster.signer.deviceId && canonicalJson(identity) !== canonicalJson(roster.signer))) throw new Error('Missing snapshot owner authority');
  return identity;
}

export async function createEncryptedSharedSnapshot(crypto: SharingCryptoGateway, replica: SharedReplica,
  availableFacts: readonly AuthenticatedSharedOperation[], roster: VerifiedSharedRoster, owner: DeviceSecretIdentity,
  key: Uint8Array, snapshotId: string, throughSequence: number, author: SharedAuthorResolver, archive?: readonly VerifiedSharedRoster[]): Promise<EncryptedSharedSnapshot> {
  assertSharedIdentifier(snapshotId);
  if (snapshotId.length > 150 || roster.body.groupId !== replica.groupId
    || roster.body.closed || !Number.isSafeInteger(throughSequence) || throughSequence < 0
    || replica.operations.some((op) => op.schemaVersion > roster.body.schemaVersion)) throw new Error('Invalid snapshot authority or delivery position');
  if (canonicalJson(snapshotSigner(roster, owner.deviceId)) !== canonicalJson({ deviceId: owner.deviceId, signingPublicKey: owner.signingPublicKey,
    agreementPublicKey: owner.agreementPublicKey })) throw new Error('Invalid snapshot signing identity');
  const base = compactSharedReplica(replica); const facts = new Map(availableFacts.map((fact) => [fact.operation.operationId, fact]));
  if (base.retention) { if (!archive || roster.body.schemaVersion !== 2) throw new Error('Missing retention authority archive'); assertV2RetentionBase(replica, base.retention, archive); }
  if (base.legacyMigrationWitness && roster.body.schemaVersion !== 2) throw new Error('A v1 snapshot cannot carry a migration statement');
  if (base.recoveryWitnesses?.length && roster.body.schemaVersion !== 2) throw new Error('A v1 snapshot cannot carry recovery evidence');
  const retained = base.operations.map((operation) => {
    const fact = facts.get(operation.operationId);
    if (!fact || canonicalJson(fact.operation) !== canonicalJson(operation)) throw new Error('Snapshot is missing an original author proof');
    return authenticate(fact, replica.groupId, roster.body.keyVersion, author);
  });
  const records: (SnapshotRecord | RetentionRecord)[] = [...base.operationIndex.map((value): SnapshotRecord => ({ kind: 'receipt', value })),
    ...retained.map((value): SnapshotRecord => ({ kind: 'fact', value })),
    ...(base.legacyMigrationWitness ? [{ kind: 'legacyMigrationWitness' as const, value: base.legacyMigrationWitness }] : []),
    ...(base.recoveryWitnesses ?? []).flatMap((witness): SnapshotRecord[] => [
      { kind: 'recoveryWitness', value: { body: witness.body, signature: witness.signature } },
      ...witness.preservedFacts.map((value): SnapshotRecord => ({ kind: 'recoveryPreservedFact', value: { ...value, snapshotId: witness.body.snapshotId } })),
    ]), ...(base.retention ? [{ kind: 'retentionProposal' as const, value: base.retention.proposal },
      { kind: 'retentionReceipt' as const, value: base.retention.proposalReceipt },
      ...base.retention.approvals.map(value => ({ kind: 'retentionApproval' as const, value }))] : [])];
  const chunks: EncryptedSharedSnapshotChunk[] = []; let page: (SnapshotRecord | RetentionRecord)[] = []; let bytes = 2;
  const flush = async () => {
    if (!page.length) return;
    chunks.push(await sealSharedSnapshotChunk(crypto, encoder.encode(canonicalJson(page)),
      { groupId: replica.groupId, snapshotId, chunkIndex: chunks.length, keyVersion: roster.body.keyVersion }, key, owner));
    page = []; bytes = 2;
  };
  for (const record of records) {
    const length = encoder.encode(canonicalJson(record)).length + (page.length ? 1 : 0);
    if (length + 2 > MAX_SHARED_SNAPSHOT_CHUNK_BYTES) throw new Error('Snapshot record exceeds the encrypted chunk limit');
    if (bytes + length > MAX_SHARED_SNAPSHOT_CHUNK_BYTES || page.length >= 1000) await flush();
    page.push(record); bytes += length;
  }
  await flush();
  const body: SharedSnapshotManifestBody = { schemaVersion: roster.body.schemaVersion, groupId: replica.groupId, snapshotId, keyVersion: roster.body.keyVersion,
    throughSequence, ownerDeviceId: owner.deviceId, rosterDigest: sharedRosterDigest(roster), schedulerVersion: roster.body.schedulerVersion,
    frontier: base.frontier, logicalClock: base.logicalClock, receiptCount: base.operationIndex.length, factCount: retained.length,
    ...(roster.body.schemaVersion === 2 ? { recoveryCount: base.recoveryWitnesses?.length ?? 0 } : {}),
    ...(base.retention ? (() => { const checkpoint = base.retention.proposal.operation.payload.checkpoint as unknown as V2RetentionBody;
      return { retentionCutoff: checkpoint.cutoff, retentionThroughSequence: checkpoint.throughSequence, retentionKeyVersion: checkpoint.keyVersion }; })() : {}),
    chunks: chunks.map((chunk, index) => ({ id: `${snapshotId}.${index}`, digest: sharedDocumentDigest(chunk),
      bytes: encoder.encode(canonicalJson(chunk)).length })) };
  const manifest = { body, signature: signSharedDocument({ domain: 'liflow-shared-snapshot-v1', body }, owner) };
  if (encoder.encode(canonicalJson(manifest)).length > 100_000) throw new Error('Snapshot manifest exceeds the cloud limit');
  return { manifest, chunks };
}

export function verifySharedSnapshotManifest(input: SignedSharedSnapshotManifest, roster: VerifiedSharedRoster): SignedSharedSnapshotManifest {
  assertJsonRecord(input);
  if (Object.keys(input).sort().join(',') !== 'body,signature') throw new Error('Unknown snapshot manifest field');
  const { body } = input; assertJsonRecord(body);
  const fields = ['chunks', 'factCount', 'frontier', 'groupId', 'keyVersion', 'logicalClock', 'ownerDeviceId', 'receiptCount', 'rosterDigest', 'schedulerVersion', 'schemaVersion', 'snapshotId', 'throughSequence',
    ...(roster.body.schemaVersion === 2 ? ['recoveryCount', ...('retentionCutoff' in body ? ['retentionCutoff', 'retentionThroughSequence', 'retentionKeyVersion'] : [])] : [])];
  if (Object.keys(body).sort().join(',') !== fields.sort().join(',')
    || body.schemaVersion !== roster.body.schemaVersion || body.groupId !== roster.body.groupId
    || body.keyVersion !== roster.body.keyVersion || body.rosterDigest !== sharedRosterDigest(roster)
    || body.schedulerVersion !== roster.body.schedulerVersion
    || (roster.body.schemaVersion === 2 ? !isSupportedV2Scheduler(body.schedulerVersion) : body.schedulerVersion !== SHARED_SCHEDULER_VERSION)
    || !Array.isArray(body.chunks) || body.chunks.length > 512) throw new Error('Untrusted snapshot manifest');
  assertSharedIdentifier(body.snapshotId);
  for (const value of [body.throughSequence, body.logicalClock, body.receiptCount, body.factCount]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid snapshot count');
  }
  if (body.schemaVersion === 2 && (!Number.isSafeInteger(body.recoveryCount) || body.recoveryCount! < 0 || body.recoveryCount! > 64)) throw new Error('Invalid recovery witness count');
  if (body.retentionCutoff !== undefined) {
    parseLocalDate(body.retentionCutoff as LocalDate);
    if (body.schemaVersion !== 2 || !Number.isSafeInteger(body.retentionThroughSequence) || body.retentionThroughSequence! < 0
      || body.retentionThroughSequence! > body.throughSequence || !Number.isSafeInteger(body.retentionKeyVersion)
      || body.retentionKeyVersion! < 1 || body.retentionKeyVersion! > body.keyVersion) throw new Error('Invalid retention position');
  }
  if (body.factCount > body.receiptCount) throw new Error('Snapshot fact count exceeds causal receipts');
  for (const [index, chunk] of body.chunks.entries()) {
    assertJsonRecord(chunk);
    if (Object.keys(chunk).sort().join(',') !== 'bytes,digest,id' || chunk.id !== `${body.snapshotId}.${index}`
      || !/^[a-f0-9]{64}$/u.test(chunk.digest) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > 800_000) throw new Error('Invalid snapshot chunk descriptor');
  }
  const owner = snapshotSigner(roster, body.ownerDeviceId);
  verifySharedDocument({ domain: 'liflow-shared-snapshot-v1', body }, input.signature, owner);
  return input;
}

export async function openEncryptedSharedSnapshot(crypto: SharingCryptoGateway, input: EncryptedSharedSnapshot,
  key: Uint8Array, roster: VerifiedSharedRoster, author: SharedAuthorResolver, archive?: readonly VerifiedSharedRoster[]): Promise<VerifiedSharedSnapshot> {
  const { body } = verifySharedSnapshotManifest(input.manifest, roster);
  if (input.chunks.length !== body.chunks.length) throw new Error('Snapshot is missing encrypted chunks');
  const owner = snapshotSigner(roster, body.ownerDeviceId);
  const operationIndex: SharedOperationReceipt[] = []; const facts: AuthenticatedSharedOperation[] = [];
  let legacyMigrationWitness: SignedLegacyMigrationWitness | undefined;
  const recoveryHeaders = new Map<string, SignedV2RecoveryHeader>();
  const heldRecoveryFacts = new Map<string, V2RecoveryPreservedFact[]>();
  let retentionProposal: AuthenticatedSharedOperation | undefined; let retentionReceipt: V2ServerReceipt | undefined; const retentionApprovals: AuthenticatedSharedOperation[] = [];
  for (const [index, chunk] of input.chunks.entries()) {
    if (sharedDocumentDigest(chunk) !== body.chunks[index].digest || encoder.encode(canonicalJson(chunk)).length !== body.chunks[index].bytes) throw new Error('Snapshot chunk hash mismatch');
    const plaintext = await openSharedSnapshotChunk(crypto, chunk, { groupId: body.groupId, snapshotId: body.snapshotId,
      keyVersion: body.keyVersion, chunkIndex: index }, key, owner);
    const records = JSON.parse(decoder.decode(plaintext)) as (SnapshotRecord | RetentionRecord)[];
    if (!Array.isArray(records) || records.length > 1000) throw new Error('Invalid snapshot page');
    for (const record of records) {
      assertJsonRecord(record);
      if (Object.keys(record).sort().join(',') !== 'kind,value') throw new Error('Unknown snapshot record field');
      if (record.kind === 'receipt') operationIndex.push(record.value);
      else if (record.kind === 'fact') facts.push(authenticate(record.value, body.groupId, body.keyVersion, author));
      else if (record.kind === 'legacyMigrationWitness' && body.schemaVersion === 2 && legacyMigrationWitness === undefined) legacyMigrationWitness = validateLegacyMigrationWitness(record.value);
      else if (record.kind === 'recoveryWitness' && body.schemaVersion === 2) {
        assertJsonRecord(record.value); assertJsonRecord(record.value.body);
        assertSharedIdentifier(record.value.body.snapshotId);
        if (Object.keys(record.value).sort().join(',') !== 'body,signature' || recoveryHeaders.has(record.value.body.snapshotId)) throw new Error('Invalid duplicate recovery header');
        recoveryHeaders.set(record.value.body.snapshotId, record.value);
      } else if (record.kind === 'recoveryPreservedFact' && body.schemaVersion === 2) {
        assertJsonRecord(record.value); assertSharedIdentifier(record.value.snapshotId);
        if (Object.keys(record.value).sort().join(',') !== 'fact,receipt,snapshotId') throw new Error('Unknown held recovery fact');
        const list = heldRecoveryFacts.get(record.value.snapshotId) ?? [];
        list.push({ fact: authenticate(record.value.fact, body.groupId, body.keyVersion, author), receipt: record.value.receipt });
        heldRecoveryFacts.set(record.value.snapshotId, list);
      }
      else if (body.retentionCutoff && record.kind === 'retentionProposal' && !retentionProposal) retentionProposal = authenticate(record.value, body.groupId, body.keyVersion, author);
      else if (body.retentionCutoff && record.kind === 'retentionReceipt' && !retentionReceipt) retentionReceipt = record.value;
      else if (body.retentionCutoff && record.kind === 'retentionApproval') retentionApprovals.push(authenticate(record.value, body.groupId, body.keyVersion, author));
      else throw new Error('Unknown snapshot record');
    }
  }
  if (operationIndex.length !== body.receiptCount || facts.length !== body.factCount) throw new Error('Snapshot count mismatch');
  if (body.schemaVersion === 2 && recoveryHeaders.size !== body.recoveryCount
    || [...heldRecoveryFacts.keys()].some(id => !recoveryHeaders.has(id))) throw new Error('Snapshot lost recovery evidence');
  const recoveryWitnesses: SignedV2RecoveryWitness[] = [...recoveryHeaders.values()].map(header => validateV2RecoveryWitness({ ...header, preservedFacts: heldRecoveryFacts.get(header.body.snapshotId) ?? [] }));
  let retention: V2RetentionWitness | undefined;
  if (body.retentionCutoff) {
    if (!archive || !retentionProposal || !retentionReceipt) throw new Error('Missing collective retention certificate');
    retention = { proposal: retentionProposal, proposalReceipt: retentionReceipt, approvals: retentionApprovals };
  }
  const base = validateSharedSnapshotBase(body.groupId, { groupId: body.groupId, frontier: body.frontier,
    logicalClock: body.logicalClock, operationIndex, operations: facts.map((fact) => fact.operation),
    ...(legacyMigrationWitness ? { legacyMigrationWitness } : {}),
    ...(recoveryWitnesses.length ? { recoveryWitnesses } : {}), ...(retention ? { retention } : {}) });
  if (retention) { const checkpoint = assertV2RetentionBase({ ...base }, retention, archive!);
    if (checkpoint.cutoff !== body.retentionCutoff || checkpoint.throughSequence !== body.retentionThroughSequence
      || checkpoint.keyVersion !== body.retentionKeyVersion) throw new Error('Snapshot retention position differs from its collective certificate'); }
  return { base, facts, snapshotId: body.snapshotId, throughSequence: body.throughSequence };
}
