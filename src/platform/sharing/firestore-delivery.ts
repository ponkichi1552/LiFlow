import { collection, doc, getDocFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query, runTransaction,
  serverTimestamp, setDoc, Timestamp, where } from 'firebase/firestore';
import type { DocumentData, DocumentReference, Firestore } from 'firebase/firestore';
import { fromByteArray, toByteArray } from 'base64-js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { SharedDeliveryArchive } from '../../features/sharing/delivery-archive';
import { SharedDeliveryPendingError } from '../../features/sharing/delivery-archive.ts';
import { assertSharedCloudAccess, parseSharedCloudGroup } from '../../features/sharing/cloud-contract.ts';
import type { SharedCloudGroup, SharedCloudEvent } from '../../features/sharing/cloud-contract';
import { canonicalJson, assertSharedIdentifier } from '../../features/sharing/operations.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import type { EncryptedSharedSnapshotChunk } from '../../features/sharing/crypto';

const TTL = 86400_000, PART_BYTES = 128 * 1024, MAX_BYTES = 16 * 1024 * 1024;
type Request = { schemaVersion: 1; userId: string; deviceId: string; kind: 'events' | 'chunk'; key: string;
  after: number; through: number; keyVersion: number; createdAt?: Timestamp; expiresAt: Timestamp; receivedAt?: Timestamp };
const validTime = (value: unknown): value is Timestamp => value instanceof Timestamp;
function validRequest(value: DocumentData): value is Request {
  return value.schemaVersion === 1 && ['events', 'chunk'].includes(value.kind)
    && typeof value.userId === 'string' && typeof value.deviceId === 'string' && typeof value.key === 'string' && value.key.length <= 200
    && [value.after, value.through, value.keyVersion].every(Number.isSafeInteger) && value.after >= 0 && value.through >= value.after
    && (value.kind === 'chunk' || value.through - value.after <= 10) && validTime(value.createdAt) && validTime(value.expiresAt);
}
export interface DeliveryRelayContext {
  firestore: Firestore; userId: string; checkAccount(): void; reference(groupId: string): DocumentReference;
  readGroup(groupId: string): Promise<{ group: SharedCloudGroup }>;
  parseRoot?: (raw: unknown, groupId: string) => SharedCloudGroup;
}
export function createSharingDeliveryRelay<Artifact = EncryptedSharedSnapshotChunk>(context: DeliveryRelayContext, deviceId: string, archive: SharedDeliveryArchive<Artifact>) {
  const { firestore, userId, checkAccount, reference, readGroup } = context;
  assertSharedIdentifier(deviceId);
  const requests = (groupId: string) => collection(reference(groupId), 'deliveryRequests');
  const policyRef = (groupId: string) => doc(reference(groupId), 'deliveryControl', 'policy');
  const capabilityRef = (groupId: string) => doc(reference(groupId), 'deliveryDevices', deviceId);
  let advertised = false;
  let advertising: Promise<void> | undefined;
  let acknowledgement: Promise<void> = Promise.resolve();
  const receivedRequests = new Map<string, number>();
  let wake: (() => void) | undefined; let failure: ((error: unknown) => void) | undefined;
  const responseObservers = new Map<string, () => void>();
  function observeResponse(target: DocumentReference) {
    if (!wake || responseObservers.has(target.id)) return;
    let last = '';
    responseObservers.set(target.id, onSnapshot(collection(target, 'responses'), snapshot => {
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      const fingerprint = snapshot.docs.filter(item => item.data().ready === true).map(item => `${item.id}:${item.data().digest}`).sort().join(',');
      if (fingerprint && fingerprint !== last) { last = fingerprint; wake?.(); }
    }, error => failure?.(error)));
  }
  async function writePages(groupId: string, requestId: string, request: Request, value: unknown) {
    const bytes = utf8ToBytes(canonicalJson(value)); if (bytes.length > MAX_BYTES) throw new Error('Delivery recovery page is too large');
    const parent = doc(requests(groupId), requestId, 'responses', deviceId);
    const metadata = { schemaVersion: 1, userId, deviceId, digest: sharedDocumentDigest(value), size: bytes.length,
      parts: Math.ceil(bytes.length / PART_BYTES), expiresAt: request.expiresAt };
    const completed = await runTransaction(firestore, async transaction => {
      const existing = await transaction.get(parent); checkAccount();
      if (existing.exists()) {
        const data = existing.data();
        if (data.digest !== metadata.digest || data.size !== metadata.size || data.parts !== metadata.parts) throw new Error('Immutable recovery response collision');
        return data.ready === true;
      }
      // The parent exists before any child is written, so interrupted uploads remain discoverable for deletion.
      transaction.set(parent, { ...metadata, ready: false, createdAt: serverTimestamp() }); return false;
    }); checkAccount(); if (completed) return;
    for (let offset = 0, index = 0; offset < bytes.length; offset += PART_BYTES, index++) {
      const target = doc(parent, 'parts', String(index)); const existing = await getDocFromServer(target); checkAccount();
      const data = fromByteArray(bytes.subarray(offset, offset + PART_BYTES));
      if (existing.exists()) { if (existing.data().data !== data) throw new Error('Immutable recovery page collision'); }
      else await setDoc(target, { index, data, expiresAt: request.expiresAt, createdAt: serverTimestamp() });
      checkAccount();
    }
    await runTransaction(firestore, async transaction => {
      const existing = await transaction.get(parent); checkAccount();
      if (existing.data()?.ready === false) transaction.update(parent, { ready: true });
    }); checkAccount();
  }
  async function recover(groupId: string, kind: Request['kind'], key: string, after: number, through: number): Promise<unknown> {
    checkAccount(); const { group } = await readGroup(groupId); assertSharedCloudAccess(group, userId, deviceId);
    // Stable within a bounded window: repeated wakeups reuse a request instead of uploading another full copy.
    const requestId = sharedDocumentDigest([groupId, userId, deviceId, kind, key, after, through, group.keyVersion, Math.floor(Date.now() / TTL)]);
    const target = doc(requests(groupId), requestId);
    receivedRequests.set(requestId, through);
    observeResponse(target);
    await runTransaction(firestore, async transaction => {
      const raw = (await transaction.get(reference(groupId))).data();
      const current = context.parseRoot ? context.parseRoot(raw, groupId) : parseSharedCloudGroup(raw, groupId).group;
      assertSharedCloudAccess(current, userId, deviceId); const old = await transaction.get(target); checkAccount();
      if (old.exists()) return;
      transaction.set(target, { schemaVersion: 1, userId, deviceId, kind, key, after, through,
        keyVersion: current.keyVersion, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + TTL) });
    }); checkAccount();
    const responses = await getDocsFromServer(query(collection(target, 'responses'), limit(16))); checkAccount();
    for (const response of responses.docs) {
      const metadata = response.data();
      if (metadata.ready !== true || !group.deviceOwners[response.id] || group.deviceOwners[response.id] !== metadata.userId
        || group.revokedUserIds.includes(metadata.userId) || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_BYTES
        || !Number.isSafeInteger(metadata.parts) || metadata.parts !== Math.ceil(metadata.size / PART_BYTES)
        || !validTime(metadata.expiresAt) || metadata.expiresAt.toMillis() <= Date.now()) continue;
      const pages = await getDocsFromServer(query(collection(response.ref, 'parts'), orderBy('index'), limit(129))); checkAccount();
      if (pages.docs.length !== metadata.parts) continue;
      const bytes = new Uint8Array(metadata.size); let offset = 0; let valid = true;
      for (const [index, page] of pages.docs.entries()) {
        const part = page.data();
        if (part.index !== index || typeof part.data !== 'string' || part.data.length > Math.ceil(PART_BYTES / 3) * 4) { valid = false; break; }
        let decoded: Uint8Array; try { decoded = toByteArray(part.data); } catch { valid = false; break; }
        if (decoded.length !== Math.min(PART_BYTES, bytes.length - offset) || fromByteArray(decoded) !== part.data) { valid = false; break; }
        bytes.set(decoded, offset); offset += decoded.length;
      }
      if (!valid || offset !== bytes.length) continue;
      let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { continue; }
      if (sharedDocumentDigest(value) === metadata.digest) return value;
    }
    throw new SharedDeliveryPendingError();
  }
  return {
    archive,
    async serve(groupId: string) {
      checkAccount(); const { group } = await readGroup(groupId); assertSharedCloudAccess(group, userId, deviceId);
      const page = await getDocsFromServer(query(requests(groupId), where('expiresAt', '>', Timestamp.now()), limit(8))); checkAccount();
      for (const item of page.docs) {
        const request = item.data();
        if (validRequest(request) && request.deviceId === deviceId && request.userId === userId) {
          receivedRequests.set(item.id, request.through); observeResponse(item.ref);
        }
        if (!validRequest(request) || request.receivedAt !== undefined || request.deviceId === deviceId || group.deviceOwners[request.deviceId] !== request.userId
          || group.revokedUserIds.includes(request.userId) || request.keyVersion !== group.keyVersion
          || request.createdAt!.toMillis() + TTL <= Date.now()) continue;
        const value = request.kind === 'chunk' ? await archive.chunk(request.key) : await archive.events(request.after, request.through);
        if (value !== null) await writePages(groupId, item.id, request, value);
      }
    },
    async eventPage(groupId: string, after: number, head: number): Promise<SharedCloudEvent[]> {
      const through = Math.min(head, after + 10);
      const local = await archive.events(after, through); if (local) return local;
      const result = await recover(groupId, 'events', String(after), after, through);
      if (!Array.isArray(result) || result.length !== through - after || result.some((value, index) => value?.uploadSequence !== after + index + 1
        || value?.envelope?.groupId !== groupId || !value.serverReceipt)) throw new Error('Invalid peer delivery page');
      // Original signatures, encryption, causal history and independent server receipts are still checked by the normal receiver.
      return result;
    },
    async snapshotChunk(groupId: string, id: string, through: number): Promise<Artifact> {
      const local = await archive.chunk(id); if (local) return local;
      return await recover(groupId, 'chunk', id, through, through) as Artifact;
    },
    async ready(groupId: string, position: number) {
      if (advertised) return;
      if (advertising) return advertising;
      const work = runTransaction(firestore, async transaction => {
        const [root, capability, policy] = await Promise.all([transaction.get(reference(groupId)), transaction.get(capabilityRef(groupId)), transaction.get(policyRef(groupId))]); checkAccount();
        const group = context.parseRoot ? context.parseRoot(root.data(), groupId) : parseSharedCloudGroup(root.data(), groupId).group;
        assertSharedCloudAccess(group, userId, deviceId);
        if (!capability.exists()) transaction.set(capabilityRef(groupId), { schemaVersion: 1, userId, deviceId, seededThrough: position, createdAt: serverTimestamp() });
        if (group.ownerDeviceId === deviceId && !policy.exists()) transaction.set(policyRef(groupId), { schemaVersion: 1, ttlMs: TTL, enabled: true, createdAt: serverTimestamp() });
      }).then(() => { checkAccount(); advertised = true; });
      advertising = work; try { await work; } finally { if (advertising === work) advertising = undefined; }
    },
    async active(groupId: string) { checkAccount(); const result = await getDocFromServer(policyRef(groupId)); checkAccount(); return result.data()?.active === true; },
    acknowledge(groupId: string, sequence: number) {
      const close = async () => {
        if (![...receivedRequests.values()].some(through => through <= sequence)) return;
        const page = await getDocsFromServer(query(requests(groupId), where('deviceId', '==', deviceId), limit(32))); checkAccount();
        const targets = page.docs.filter(request => request.data().userId === userId && request.data().through <= sequence);
        // Close before erasing: another peer must not upload a child after the final listing.
        // One receipt wakes the server worker; the phone need not enumerate/delete every encrypted part.
        await runTransaction(firestore, async transaction => {
          const current = await Promise.all(targets.map(target => transaction.get(target.ref))); checkAccount();
          for (const request of current) {
            const value = request.data();
            if (value?.userId === userId && value.deviceId === deviceId && value.through <= sequence && value.receivedAt === undefined) {
              transaction.update(request.ref, { receivedAt: serverTimestamp() });
            }
          }
        }); checkAccount();
        for (const request of targets) {
          receivedRequests.delete(request.id);
          responseObservers.get(request.id)?.(); responseObservers.delete(request.id);
        }
      };
      const pending = acknowledgement.then(close);
      acknowledgement = pending.catch(() => undefined);
      return pending;
    },
    watch(groupId: string, changed: () => void, failed: (error: unknown) => void) {
      wake = changed; failure = failed;
      const unsubscribe = onSnapshot(query(requests(groupId), where('expiresAt', '>', Timestamp.now()), limit(32)), snapshot => {
        try { checkAccount(); if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) changed(); } catch (error) { failed(error); }
      }, failed);
      return () => { unsubscribe(); wake = undefined; failure = undefined; for (const stop of responseObservers.values()) stop(); responseObservers.clear(); };
    },
  };
}
export type SharingDeliveryRelay = ReturnType<typeof createSharingDeliveryRelay<EncryptedSharedSnapshotChunk>>;
