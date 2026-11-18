import { collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query, runTransaction,
  serverTimestamp, setDoc, startAfter, Timestamp } from 'firebase/firestore';
import type { DocumentData, DocumentReference, Firestore, QueryDocumentSnapshot } from 'firebase/firestore';
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
  let lastEmptyClosedRequest: string | undefined;
  const receivedRequests = new Map<string, Pick<Request, 'kind' | 'key' | 'after' | 'through'> & { deadline: number }>();
  const knownRequests = new Map<string, Request>();
  const sentRequests = new Map<string, string>();
  let cursor: QueryDocumentSnapshot | undefined;
  let discoveryNeeded = true;
  let serving: Promise<void> | undefined;
  let again = false;
  let scope: { id: string; group: SharedCloudGroup } | undefined;
  let wake: (() => void) | undefined; let failure: ((error: unknown) => void) | undefined;
  const responseObservers = new Map<string, () => void>();
  const fingerprintOf = (request: Request) => `${request.createdAt!.seconds}:${request.createdAt!.nanoseconds}:${request.keyVersion}`;
  const deadlineOf = (request: Request) => Math.min(request.expiresAt.toMillis(), request.createdAt!.toMillis() + TTL);
  function forgetRequest(id: string) {
    knownRequests.delete(id); sentRequests.delete(id); receivedRequests.delete(id);
    responseObservers.get(id)?.(); responseObservers.delete(id);
  }
  function archiveChanged() {
    if (!scope || ![...knownRequests].some(([id, request]) => request.deviceId !== deviceId && request.receivedAt === undefined
      && request.expiresAt.toMillis() > Date.now() && sentRequests.get(id) !== fingerprintOf(request))) return;
    void serve(scope.id, scope.group, false).catch(error => failure?.(error));
  }
  const observedArchive: SharedDeliveryArchive<Artifact> = {
    saveEvents: async events => { await archive.saveEvents(events); checkAccount(); archiveChanged(); },
    saveChunk: async (id, value) => { await archive.saveChunk(id, value); checkAccount(); archiveChanged(); },
    events: (after, through) => archive.events(after, through), chunk: id => archive.chunk(id), seedPosition: floor => archive.seedPosition(floor),
  };
  function observeResponse(target: DocumentReference) {
    if (!wake || responseObservers.has(target.id)) return;
    let last = '';
    responseObservers.set(target.id, onSnapshot(collection(target, 'responses'), { includeMetadataChanges: true }, snapshot => {
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      const fingerprint = snapshot.docs.filter(item => item.data().ready === true).map(item => `${item.id}:${item.data().digest}`).sort().join(',');
      if (fingerprint && fingerprint !== last) { last = fingerprint; wake?.(); }
    }, error => { responseObservers.get(target.id)?.(); responseObservers.delete(target.id); failure?.(error); }));
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
  async function discover(groupId: string) {
    // Server-created timestamps plus the document cursor preserve all requests, including equal-time batches.
    for (;;) {
      const page = await getDocsFromServer(query(requests(groupId), orderBy('createdAt'), orderBy(documentId()),
        ...(cursor ? [startAfter(cursor)] : []), limit(8))); checkAccount();
      for (const item of page.docs) {
        const value = item.data(); if (validRequest(value)) knownRequests.set(item.id, value);
      }
      if (page.docs.length) cursor = page.docs.at(-1);
      if (page.size < 8) return;
    }
  }
  function serve(groupId: string, current?: SharedCloudGroup, refresh = true): Promise<void> {
    if (refresh) discoveryNeeded = true;
    if (serving) { again = true; return serving; }
    const work = (async () => {
      do {
        again = false; checkAccount(); const group = current ?? (await readGroup(groupId)).group;
        assertSharedCloudAccess(group, userId, deviceId);
        scope = { id: groupId, group };
        if (discoveryNeeded) { discoveryNeeded = false; await discover(groupId); }
        for (const [id, request] of knownRequests) {
          checkAccount();
          if (deadlineOf(request) <= Date.now() || request.receivedAt !== undefined) {
            forgetRequest(id); continue;
          }
          if (request.deviceId === deviceId && request.userId === userId) {
            receivedRequests.set(id, { kind: request.kind, key: request.key, after: request.after, through: request.through, deadline: deadlineOf(request) });
            observeResponse(doc(requests(groupId), id)); continue;
          }
          if (request.deviceId === deviceId || group.deviceOwners[request.deviceId] !== request.userId
            || group.revokedUserIds.includes(request.userId) || request.keyVersion !== group.keyVersion) continue;
          const fingerprint = fingerprintOf(request);
          if (sentRequests.get(id) === fingerprint) continue;
          const value = request.kind === 'chunk' ? await archive.chunk(request.key) : await archive.events(request.after, request.through);
          checkAccount(); if (value === null) continue;
          try { await writePages(groupId, id, request, value); sentRequests.set(id, fingerprint); }
          catch (error) {
            checkAccount();
            if (!['permission-denied', 'not-found', 'failed-precondition'].includes(String((error as { code?: unknown })?.code))) throw error;
            const live = await getDocFromServer(doc(requests(groupId), id)); checkAccount(); const latest = live.data();
            // A different peer can complete delivery while this one is preparing its response.
            if (!live.exists() || latest?.receivedAt !== undefined || latest?.expiresAt?.toMillis() <= Date.now()) {
              forgetRequest(id); continue;
            }
            throw error;
          }
        }
      } while (again || discoveryNeeded);
    })();
    serving = work;
    void work.finally(() => { if (serving === work) serving = undefined; }).catch(() => { discoveryNeeded = true; });
    return work;
  }
  async function recover(groupId: string, kind: Request['kind'], key: string, after: number, through: number): Promise<unknown> {
    checkAccount(); const { group } = await readGroup(groupId); assertSharedCloudAccess(group, userId, deviceId);
    // Stable within a bounded window: repeated wakeups reuse a request instead of uploading another full copy.
    const requestId = sharedDocumentDigest([groupId, userId, deviceId, kind, key, after, through, group.keyVersion, Math.floor(Date.now() / TTL)]);
    const target = doc(requests(groupId), requestId);
    const state = await runTransaction(firestore, async transaction => {
      const raw = (await transaction.get(reference(groupId))).data();
      const current = context.parseRoot ? context.parseRoot(raw, groupId) : parseSharedCloudGroup(raw, groupId).group;
      assertSharedCloudAccess(current, userId, deviceId); const old = await transaction.get(target); checkAccount();
      if (old.exists()) {
        const saved = old.data();
        if (!validRequest(saved)) return null;
        return { deadline: deadlineOf(saved), closed: saved.receivedAt === undefined ? null : fingerprintOf(saved) };
      }
      const expiresAt = Timestamp.fromMillis(Date.now() + TTL);
      transaction.set(target, { schemaVersion: 1, userId, deviceId, kind, key, after, through,
        keyVersion: current.keyVersion, createdAt: serverTimestamp(), expiresAt });
      return { deadline: expiresAt.toMillis(), closed: null };
    }); checkAccount();
    if (!state || state.deadline <= Date.now()) {
      forgetRequest(requestId); throw new SharedDeliveryPendingError();
    }
    const closed = state.closed && `${requestId}:${state.closed}`;
    if (closed) {
      forgetRequest(requestId);
      if (lastEmptyClosedRequest === closed) throw new SharedDeliveryPendingError();
    } else {
      receivedRequests.set(requestId, { kind, key, after, through, deadline: state.deadline });
      observeResponse(target);
    }
    const responses = await getDocsFromServer(query(collection(target, 'responses'), limit(64))); checkAccount();
    // Unexpired replies can restore a lost local copy after ACK. A closed request cannot gain replies after an empty server listing.
    if (closed && responses.empty) lastEmptyClosedRequest = closed;
    for (const response of responses.docs) {
      if (state.deadline <= Date.now()) break;
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
      if (sharedDocumentDigest(value) === metadata.digest && state.deadline > Date.now()) return value;
    }
    throw new SharedDeliveryPendingError();
  }
  return {
    archive: observedArchive,
    serve,
    request(groupId: string, group: SharedCloudGroup) {
      if (!discoveryNeeded && !knownRequests.size) return;
      // Recovery for other devices cannot extend a normal read/edit's network deadline.
      void serve(groupId, group, false).catch(error => failure?.(error));
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
        const targets: string[] = [];
        for (const [id, request] of receivedRequests) {
          if (request.deadline <= Date.now()) { forgetRequest(id); continue; }
          if (request.through > sequence) continue;
          const durable = request.kind === 'chunk' ? await archive.chunk(request.key) : await archive.events(request.after, request.through);
          checkAccount(); if (durable !== null) targets.push(id);
        }
        if (!targets.length) return;
        // Close before erasing: another peer must not upload a child after the final listing.
        // One receipt wakes the server worker; the phone need not enumerate/delete every encrypted part.
        for (let offset = 0; offset < targets.length; offset += 32) {
          await runTransaction(firestore, async transaction => {
            const current = await Promise.all(targets.slice(offset, offset + 32).map(id => transaction.get(doc(requests(groupId), id)))); checkAccount();
            for (const request of current) {
              const value = request.data(); const expected = receivedRequests.get(request.id);
              if (expected && value?.userId === userId && value.deviceId === deviceId && value.through <= sequence && value.receivedAt === undefined
                && value.kind === expected.kind && value.key === expected.key && value.after === expected.after && value.through === expected.through) {
                transaction.update(request.ref, { receivedAt: serverTimestamp() });
              }
            }
          }); checkAccount();
        }
        for (const id of targets) forgetRequest(id);
      };
      const pending = acknowledgement.then(close);
      acknowledgement = pending.catch(() => undefined);
      return pending;
    },
    watch(groupId: string, changed: () => void, failed: (error: unknown) => void) {
      wake = changed; failure = failed;
      let latest: string | undefined;
      const unsubscribe = onSnapshot(query(requests(groupId), orderBy('createdAt', 'desc'), limit(1)), { includeMetadataChanges: true }, snapshot => {
        try { checkAccount(); if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
          const value = snapshot.docs[0]; const createdAt = value?.data().createdAt;
          const fingerprint = value && validTime(createdAt) ? `${value.id}:${createdAt.seconds}:${createdAt.nanoseconds}` : '';
          if (fingerprint !== latest) { latest = fingerprint; if (fingerprint) { discoveryNeeded = true; if (serving) again = true; changed(); } }
        } } catch (error) { failed(error); }
      }, failed);
      return () => { unsubscribe(); wake = undefined; failure = undefined; for (const stop of responseObservers.values()) stop(); responseObservers.clear(); };
    },
  };
}
export type SharingDeliveryRelay = ReturnType<typeof createSharingDeliveryRelay<EncryptedSharedSnapshotChunk>>;
