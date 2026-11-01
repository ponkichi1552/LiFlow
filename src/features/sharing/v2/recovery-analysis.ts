import { buildSharedReplica, compactSharedReplica } from '../replica.ts';
import { recoveryArrayDigest } from './recovery-content.ts';
import type { SharedReplica } from '../replica.ts';
import { decryptAuthenticatedSharedOperation, sharedDocumentDigest, verifyAuthenticatedSharedOperation } from '../crypto.ts';
import type { AuthenticatedSharedOperation, SharingCryptoGateway } from '../crypto.ts';
import { parseSharedCloudEvent } from '../cloud-contract.ts';
import { sharedAuthorIdentity } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import { MAX_V2_RECOVERY_ENTRIES } from './recovery-witness.ts';
import type { V2RecoveryEntry, V2RecoveryPreservedFact } from './recovery-witness.ts';
import { MAX_V2_RECOVERY_SCAN_BYTES, MAX_V2_RECOVERY_SCAN_EVENTS, V2RecoveryLimitError, V2RecoveryOriginalRequiredError,
  V2RecoveryStaleError, validateRawV2RecoveryEvent } from './recovery-contract.ts';
import type { RawV2RecoveryEvent } from './recovery-contract.ts';

async function assertRecoveryCryptoWorking(crypto: SharingCryptoGateway) {
  const key = await crypto.randomBytes(32); const nonce = await crypto.randomBytes(12);
  try {
    const value = new TextEncoder().encode('LiFlow recovery health'); const aad = new TextEncoder().encode('liflow-recovery-health-v1');
    const opened = await crypto.decrypt(key, nonce, await crypto.encrypt(key, nonce, value, aad), aad);
    if (opened.length !== value.length || opened.some((byte, index) => byte !== value[index])) throw new Error('Unexpected crypto round trip');
  } catch {
    throw Object.assign(new Error('この端末の暗号処理を確認できません。変更を隔離せず、同期を停止しました。端末を再起動してから再確認してください。'), { code: 'sharing/recovery-crypto-unavailable' });
  } finally { key.fill(0); nonce.fill(0); }
}

/** Analyze a fixed server prefix without changing a cursor, authoring a fact, or inventing a missing causal dot. */
export async function analyzeV2Recovery(input: {
  crypto: SharingCryptoGateway; key: Uint8Array; archive: readonly VerifiedSharedRoster[]; baseline: SharedReplica;
  baselineSequence: number; throughSequence: number; originals: readonly AuthenticatedSharedOperation[];
  events: readonly RawV2RecoveryEvent[]; receipts: ReadonlyMap<string, V2ServerReceipt>;
}) {
  const { crypto, key, archive, baseline } = input; const roster = archive.at(-1);
  if (!roster || roster.body.schemaVersion !== 2 || baseline.groupId !== roster.body.groupId || key.length !== 32
    || !Number.isSafeInteger(input.baselineSequence) || input.baselineSequence < 0 || !Number.isSafeInteger(input.throughSequence)
    || input.throughSequence < input.baselineSequence || input.events.length !== input.throughSequence - input.baselineSequence) throw new V2RecoveryStaleError('共有の読取位置を更新してから検査してください。');
  if (input.events.length > MAX_V2_RECOVERY_SCAN_EVENTS || input.events.reduce((size, raw) => size + new TextEncoder().encode(raw.envelopeJson).length, 0) > MAX_V2_RECOVERY_SCAN_BYTES) {
    throw new V2RecoveryLimitError('一度に確認できる復旧データの上限を超えています。元のデータと未送信の変更は保持しています。');
  }
  const base = compactSharedReplica(baseline);
  const originals = new Map(input.originals.map(fact => [fact.operation.operationId, fact]));
  const entries = new Map<string, V2RecoveryEntry>(); const preserved = new Map<string, V2RecoveryPreservedFact>();
  const good = new Map<string, AuthenticatedSharedOperation>(); const rawById = new Map<string, RawV2RecoveryEvent>();
  for (const [index, value] of input.events.entries()) {
    const raw = validateRawV2RecoveryEvent(value, baseline.groupId);
    if (raw.uploadSequence !== input.baselineSequence + index + 1 || raw.keyVersion !== roster.body.keyVersion || rawById.has(raw.operationId)) {
      throw new V2RecoveryStaleError('受信順序か共有鍵の世代が変わりました。復旧内容を再確認してください。');
    }
    const author = sharedAuthorIdentity(roster, raw.authorUserId, raw.authorDeviceId, raw.keyVersion);
    rawById.set(raw.operationId, raw);
    const receipt = input.receipts.get(raw.operationId);
    const receiptMatches = receipt?.uploadSequence === raw.uploadSequence && receipt.receivedKeyVersion === raw.keyVersion
      && receipt.authorUserId === raw.authorUserId && receipt.authorDeviceId === raw.authorDeviceId
      && receipt.authorProofDigest === raw.authorProofDigest && receipt.receivedAtMs === raw.receivedAtMs;
    const entry: V2RecoveryEntry = { operationId: raw.operationId, uploadSequence: raw.uploadSequence, authorUserId: raw.authorUserId,
      authorDeviceId: raw.authorDeviceId, keyVersion: raw.keyVersion, rawDigest: sharedDocumentDigest(raw), receiptDigest: receipt ? sharedDocumentDigest(receipt) : null,
      classification: receiptMatches ? 'invalidEnvelope' : 'missingReceipt', preservedFactDigest: null };
    let fact: AuthenticatedSharedOperation | undefined;
    if (receiptMatches) {
      try {
        const event = parseSharedCloudEvent(raw.operationId, { schemaVersion: 2, authorUserId: raw.authorUserId, authorDeviceId: raw.authorDeviceId,
          keyVersion: raw.keyVersion, uploadSequence: raw.uploadSequence, envelopeJson: raw.envelopeJson, authorProofDigest: raw.authorProofDigest }, baseline.groupId);
        entry.classification = 'invalidAuthentication';
        const opened = await decryptAuthenticatedSharedOperation(crypto, event.envelope, key, author, baseline.groupId, roster.body.keyVersion);
        bindV2ServerReceipt(receipt!, opened, archive); fact = opened;
      } catch {
        // A broken native provider must not turn readable data into a proposed device revocation.
        if (entry.classification === 'invalidAuthentication') await assertRecoveryCryptoWorking(crypto);
        // Only the later owner review authorizes quarantine.
      }
      if (!fact) {
        const original = originals.get(raw.operationId);
        if (original) {
          try {
            const op = original.operation;
            if (op.authorUserId !== raw.authorUserId || op.authorDeviceId !== raw.authorDeviceId) throw new Error('Original author differs');
            const identity = sharedAuthorIdentity(roster, op.authorUserId, op.authorDeviceId, op.keyVersion);
            const verified = verifyAuthenticatedSharedOperation(original, identity, baseline.groupId);
            bindV2ServerReceipt(receipt!, verified, archive); fact = verified;
            const value = { fact, receipt: receipt! }; preserved.set(raw.operationId, value);
            entry.classification = 'restoredOriginal'; entry.preservedFactDigest = sharedDocumentDigest(value);
            entries.set(raw.operationId, entry);
          } catch { /* A merely local value cannot replace an immutable, independently bound original proof. */ }
        }
      }
    }
    if (fact) good.set(raw.operationId, fact);
    else entries.set(raw.operationId, entry);
  }
  const combined = buildSharedReplica(baseline.groupId, [...good.values()].map(fact => fact.operation), base);
  const pending = new Set(combined.pendingOperationIds);
  for (const id of pending) {
    const raw = rawById.get(id); const fact = good.get(id); const receipt = input.receipts.get(id);
    if (!raw || !fact || !receipt) throw new V2RecoveryStaleError('保存済みの正常な履歴に未確認の因果関係があります。');
    const value = { fact, receipt }; preserved.set(id, value);
    entries.set(id, { operationId: id, uploadSequence: raw.uploadSequence, authorUserId: raw.authorUserId,
      authorDeviceId: raw.authorDeviceId, keyVersion: raw.keyVersion, rawDigest: sharedDocumentDigest(raw), receiptDigest: sharedDocumentDigest(receipt),
      classification: 'blockedCausality', preservedFactDigest: sharedDocumentDigest(value) });
  }
  if (entries.size > MAX_V2_RECOVERY_ENTRIES) throw new V2RecoveryLimitError('確認が必要な変更が256件を超えています。元の証拠を残して復旧を停止しました。');
  const ordered = [...entries.values()].sort((a, b) => a.uploadSequence - b.uploadSequence);
  if (ordered.some(entry => entry.authorDeviceId === roster.body.ownerDeviceId && entry.classification !== 'restoredOriginal')) {
    throw new V2RecoveryOriginalRequiredError('所有者端末の元の署名付き変更を確認できません。この端末の鍵を解除したり、変更を消して復旧することはできません。');
  }
  const readyFacts = [...good.values()].filter(fact => !pending.has(fact.operation.operationId));
  const retained = buildSharedReplica(baseline.groupId, readyFacts.map(fact => fact.operation), base);
  const retainedBase = compactSharedReplica(retained);
  return { entries: ordered, preservedFacts: [...preserved.values()].sort((a, b) => a.receipt.uploadSequence - b.receipt.uploadSequence), readyFacts, retainedBase,
    baselineIndexDigest: recoveryArrayDigest(base.operationIndex), retainedIndexDigest: recoveryArrayDigest(retainedBase.operationIndex),
    removeDeviceIds: [...new Set(ordered.filter(entry => entry.classification !== 'restoredOriginal').map(entry => entry.authorDeviceId))].sort(),
    unreadableChanges: ordered.filter(entry => !['blockedCausality', 'restoredOriginal'].includes(entry.classification)).length,
    heldChanges: ordered.filter(entry => entry.classification === 'blockedCausality').length,
    restoredOriginals: ordered.filter(entry => entry.classification === 'restoredOriginal').length };
}
