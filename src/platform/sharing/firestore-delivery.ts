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
import { DELIVERY_TTL_MS, parseDeliveryPolicy, recoveryReceiptInput } from '../../features/sharing/delivery-proof.ts';
import type { DeliveryProofClient } from './delivery-proof-cloud.ts';

const TTL = DELIVERY_TTL_MS, PART_BYTES = 128 * 1024, MAX_BYTES = 16 * 1024 * 1024, RELAY_LEASE_MS = 30_000;
type Request = { schemaVersion: 1 | 2; userId: string; deviceId: string; kind: 'events' | 'chunk'; key: string;
  after: number; through: number; keyVersion: number; createdAt: Timestamp; expiresAt: Timestamp; receivedAt?: Timestamp; receiptSignature?: string };
const validTime = (value: unknown): value is Timestamp => value instanceof Timestamp;
function validRequest(value: DocumentData): value is Request {
  return [1, 2].includes(value.schemaVersion) && ['events', 'chunk'].includes(value.kind)
    && typeof value.userId === 'string' && typeof value.deviceId === 'string' && typeof value.key === 'string' && value.key.length <= 200
    && [value.after, value.through, value.keyVersion].every(Number.isSafeInteger) && value.after >= 0 && value.through >= value.after
    && (value.kind === 'chunk' || value.through - value.after <= 10) && validTime(value.createdAt) && validTime(value.expiresAt);
}
export interface DeliveryRelayContext {
  firestore: Firestore; userId: string; checkAccount(): void; reference(groupId: string): DocumentReference;
  readGroup(groupId: string): Promise<{ group: SharedCloudGroup }>;
  parseRoot?: (raw: unknown, groupId: string) => SharedCloudGroup;
  proof?: DeliveryProofClient;
}
export function createSharingDeliveryRelay<Artifact = EncryptedSharedSnapshotChunk>(context: DeliveryRelayContext, deviceId: string, archive: SharedDeliveryArchive<Artifact>) {
  const { firestore, userId, checkAccount, reference, readGroup } = context;
  assertSharedIdentifier(deviceId);
  const requests = (groupId: string) => collection(reference(groupId), 'deliveryRequests');
  const policyRef = (groupId: string) => doc(reference(groupId), 'deliveryControl', 'policy');
  let acknowledgement: Promise<void> = Promise.resolve();
  let lastExhaustedClosedRequest: string | undefined;
  const receivedRequests = new Map<string, Pick<Request, 'kind' | 'key' | 'after' | 'through' | 'keyVersion'> & { groupId: string; deadline: number; fingerprint: string | null }>();
  const knownRequests = new Map<string, Request>();
  const sentRequests = new Map<string, string>();
  const delayedResponses = new Map<string, number>();
  let relayTimer: ReturnType<typeof setTimeout> | undefined;
  let cursor: QueryDocumentSnapshot | undefined;
  let discoveryNeeded = true;
  let serving: Promise<void> | undefined;
  let again = false;
  let scope: { id: string; group: SharedCloudGroup } | undefined;
  let wake: (() => void) | undefined; let failure: ((error: unknown) => void) | undefined;
  const responseObservers = new Map<string, () => void>();
  const responsePresent = new Map<string, boolean>();
  function updateScope(id: string, group: SharedCloudGroup) {
    if (scope && (scope.id !== id || canonicalJson([scope.group.deviceOwners, scope.group.revokedUserIds]) !== canonicalJson([group.deviceOwners, group.revokedUserIds]))) {
      sentRequests.clear(); delayedResponses.clear();
    }
    scope = { id, group };
  }
  function usableResponse(group: SharedCloudGroup, responder: string, metadata: DocumentData | undefined) {
    return metadata?.ready === true && group.deviceOwners[responder] === metadata.userId && typeof metadata.userId === 'string'
      && !group.revokedUserIds.includes(metadata.userId) && Number.isSafeInteger(metadata.size) && metadata.size >= 1 && metadata.size <= MAX_BYTES
      && Number.isSafeInteger(metadata.parts) && metadata.parts === Math.ceil(metadata.size / PART_BYTES)
      && validTime(metadata.expiresAt) && metadata.expiresAt.toMillis() > Date.now();
  }
  const fingerprintOf = (request: Request) => `${request.createdAt.seconds}:${request.createdAt.nanoseconds}:${request.keyVersion}`;
  const deadlineOf = (request: Request) => Math.min(request.expiresAt.toMillis(), request.createdAt.toMillis() + TTL);
  function forgetRequest(id: string) {
    knownRequests.delete(id); sentRequests.delete(id); receivedRequests.delete(id); delayedResponses.delete(id);
    responseObservers.get(id)?.(); responseObservers.delete(id); responsePresent.delete(id);
  }
  function archiveChanged() {
    if (!scope || ![...knownRequests].some(([id, request]) => request.deviceId !== deviceId && request.receivedAt === undefined
      && request.expiresAt.toMillis() > Date.now() && sentRequests.get(id) !== fingerprintOf(request))) return;
    void serve(scope.id, scope.group, false).catch(error => failure?.(error));
  }
  const observedArchive: SharedDeliveryArchive<Artifact> = {
    saveEvents: async events => { await archive.saveEvents(events); checkAccount(); archiveChanged(); },
    saveChunk: async (id, value) => { await archive.saveChunk(id, value); checkAccount(); archiveChanged(); },
    events: (after, through) => archive.events(after, through), legacyEvents: archive.legacyEvents,
    chunk: id => archive.chunk(id), seedPosition: floor => archive.seedPosition(floor),
  };
  function observeResponse(target: DocumentReference) {
    if (!wake || responseObservers.has(target.id)) return;
    let last = '';
    responseObservers.set(target.id, onSnapshot(collection(target, 'responses'), { includeMetadataChanges: true }, snapshot => {
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      const fingerprint = snapshot.docs.filter(item => item.id !== '_relay' && item.data().ready === true).map(item => `${item.id}:${item.data().digest}`).sort().join(',');
      responsePresent.set(target.id, Boolean(fingerprint));
      if (fingerprint && fingerprint !== last) { last = fingerprint; wake?.(); }
    }, error => { responseObservers.get(target.id)?.(); responseObservers.delete(target.id); responsePresent.delete(target.id); failure?.(error); }));
  }
  function scheduleRelay() {
    clearTimeout(relayTimer);
    if (!wake || !scope || !delayedResponses.size) return;
    const at = Math.min(...delayedResponses.values());
    relayTimer = setTimeout(() => { if (scope && wake) void serve(scope.id, scope.group, false).catch(error => failure?.(error)); }, Math.max(50, at - Date.now()));
  }
  async function leaseRelay(target: DocumentReference, digest: string, group: SharedCloudGroup, ready = false) {
    const result = await runTransaction(firestore, async transaction => {
      const stored = (await transaction.get(target)).data(); checkAccount();
      if (stored?.ready === true && stored.digest === digest && typeof stored.deviceId === 'string' && stored.deviceId && !stored.deviceId.includes('/')) {
        const completed = (await transaction.get(doc(target.parent, stored.deviceId))).data(); checkAccount();
        if (completed?.digest === digest && usableResponse(group, stored.deviceId, completed)) return { kind: 'ready' as const };
      }
      if (stored?.deviceId !== deviceId && (stored?.ready === false || stored?.digest === digest) && validTime(stored?.updatedAt)) {
        const retryAt = stored.updatedAt.toMillis() + RELAY_LEASE_MS;
        if (retryAt > Date.now()) return { kind: 'waiting' as const, retryAt };
      }
      transaction.set(target, { deviceId, userId, digest, ready, updatedAt: serverTimestamp() });
      return { kind: 'owned' as const };
    }); checkAccount(); return result;
  }
  async function writePages(groupId: string, group: SharedCloudGroup, requestId: string, request: Request, value: unknown): Promise<number | null> {
    const bytes = utf8ToBytes(canonicalJson(value)); if (bytes.length > MAX_BYTES) throw new Error('Delivery recovery page is too large');
    const parent = doc(requests(groupId), requestId, 'responses', deviceId);
    const metadata = { schemaVersion: 1, userId, deviceId, digest: sharedDocumentDigest(value), size: bytes.length,
      parts: Math.ceil(bytes.length / PART_BYTES), expiresAt: request.expiresAt };
    const lease = doc(requests(groupId), requestId, 'responses', '_relay');
    let renewedAt = Date.now();
    const acquired = await leaseRelay(lease, metadata.digest, group).catch(error => {
      // During a Rules rollout older deployments still accept their original response format.
      if ((error as { code?: string })?.code !== 'permission-denied') throw error;
      return { kind: 'legacy' as const };
    });
    if (acquired.kind === 'ready') return null;
    if (acquired.kind === 'waiting') return acquired.retryAt;
    const completed = await runTransaction(firestore, async transaction => {
      const existing = await transaction.get(parent); checkAccount();
      if (existing.exists()) {
        const data = existing.data();
        if (data.digest !== metadata.digest || data.size !== metadata.size || data.parts !== metadata.parts) throw new Error('Immutable recovery response collision');
        return data.ready === true;
      }
      // The parent exists before any child is written, so interrupted uploads remain discoverable for deletion.
      transaction.set(parent, { ...metadata, ready: false, createdAt: serverTimestamp() }); return false;
    }); checkAccount();
    if (!completed) {
      for (let offset = 0, index = 0; offset < bytes.length; offset += PART_BYTES, index++) {
        if (acquired.kind === 'owned' && Date.now() - renewedAt >= RELAY_LEASE_MS / 2) {
          const current = await leaseRelay(lease, metadata.digest, group);
          if (current.kind === 'ready') return null;
          if (current.kind === 'waiting') return current.retryAt;
          renewedAt = Date.now();
        }
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
    if (acquired.kind === 'owned') await leaseRelay(lease, metadata.digest, group, true);
    return null;
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
        again = false; checkAccount();
        let group = current ?? (await readGroup(groupId)).group;
        if (scope?.id === groupId && scope.group.keyVersion > group.keyVersion) group = scope.group;
        assertSharedCloudAccess(group, userId, deviceId);
        updateScope(groupId, group);
        if (discoveryNeeded) { discoveryNeeded = false; await discover(groupId); }
        for (const [id, request] of knownRequests) {
          checkAccount();
          if (deadlineOf(request) <= Date.now() || request.receivedAt !== undefined || request.keyVersion !== group.keyVersion) {
            forgetRequest(id); continue;
          }
          if (request.deviceId === deviceId && request.userId === userId) {
            receivedRequests.set(id, { kind: request.kind, key: request.key, after: request.after, through: request.through,
              groupId, keyVersion: request.keyVersion, deadline: deadlineOf(request), fingerprint: fingerprintOf(request) });
            observeResponse(doc(requests(groupId), id)); continue;
          }
          if (request.deviceId === deviceId || group.deviceOwners[request.deviceId] !== request.userId
            || group.revokedUserIds.includes(request.userId) || request.keyVersion !== group.keyVersion) continue;
          const fingerprint = fingerprintOf(request);
          if (sentRequests.get(id) === fingerprint) continue;
          if ((delayedResponses.get(id) ?? 0) > Date.now()) continue;
          delayedResponses.delete(id);
          const value = request.kind === 'chunk' ? await archive.chunk(request.key) : await archive.events(request.after, request.through);
          checkAccount(); if (value === null) continue;
          const compact = request.kind === 'events' && request.key === `compact.${request.after}` && Array.isArray(value);
          const wire = compact ? value.map(({ envelope: _parsed, ...event }: SharedCloudEvent) => event) : value;
          try {
            const retryAt = await writePages(groupId, group, id, request, wire);
            if (retryAt === null) sentRequests.set(id, fingerprint);
            else delayedResponses.set(id, retryAt);
          }
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
      scheduleRelay();
    })();
    serving = work;
    void work.finally(() => { if (serving === work) serving = undefined; }).catch(() => { discoveryNeeded = true; });
    return work;
  }
  async function recover(groupId: string, kind: Request['kind'], key: string, after: number, through: number, reusePrevious = true): Promise<unknown> {
    checkAccount();
    for (const [id, pending] of receivedRequests) {
      if (pending.groupId !== groupId) continue;
      if (scope?.id === groupId && pending.keyVersion !== scope.group.keyVersion) { forgetRequest(id); continue; }
      if (responsePresent.get(id) === false && pending.kind === kind && pending.key === key && pending.after === after
        && pending.through === through && pending.deadline > Date.now() && scope?.id === groupId) throw new SharedDeliveryPendingError(pending.deadline);
    }
    checkAccount();
    const stamp = Date.now();
    const bucket = Math.floor(stamp / TTL);
    const state = await runTransaction(firestore, async transaction => {
      const raw = (await transaction.get(reference(groupId))).data();
      const group = context.parseRoot ? context.parseRoot(raw, groupId) : parseSharedCloudGroup(raw, groupId).group;
      assertSharedCloudAccess(group, userId, deviceId);
      const requestRef = (window: number) => doc(requests(groupId), sharedDocumentDigest([
        groupId, userId, deviceId, kind, key, after, through, group.keyVersion, window,
      ]));
      const existing = (target: DocumentReference, saved: DocumentData) => {
        if (!validRequest(saved) || saved.userId !== userId || saved.deviceId !== deviceId || saved.keyVersion !== group.keyVersion
          || saved.kind !== kind || saved.key !== key || saved.after !== after || saved.through !== through) return null;
        const deadline = deadlineOf(saved);
        return { target, group, deadline, closed: saved.receivedAt !== undefined, fingerprint: fingerprintOf(saved) };
      };
      const target = requestRef(bucket);
      const old = await transaction.get(target); checkAccount();
      if (old.exists()) {
        return existing(target, old.data()) ?? { target, group, deadline: 0, closed: false, fingerprint: null };
      }
      // A daily ID bounds deduplication, but the previous day's response can still be within its actual lifetime.
      if (reusePrevious) {
        const previousTarget = requestRef(bucket - 1);
        const previous = await transaction.get(previousTarget); checkAccount();
        const live = previous.exists() && existing(previousTarget, previous.data());
        if (live && live.deadline > stamp && (!live.closed || `${previousTarget.id}:${live.fingerprint}` !== lastExhaustedClosedRequest)) {
          return { ...live, previous: true };
        }
      }
      const policy = context.proof ? (await transaction.get(policyRef(groupId))).data() : null;
      const signedScope = context.proof?.resolve(groupId, policy, raw);
      const expiresAt = Timestamp.fromMillis(stamp + TTL);
      transaction.set(target, { schemaVersion: signedScope ? 2 : 1, userId, deviceId, kind, key, after, through,
        keyVersion: group.keyVersion, createdAt: serverTimestamp(), expiresAt });
      return { target, group, deadline: expiresAt.toMillis(), closed: false, fingerprint: null };
    }); checkAccount();
    const { group, target } = state;
    if (scope?.id === groupId && scope.group.keyVersion <= group.keyVersion) updateScope(groupId, group);
    const requestId = target.id;
    if (state.deadline <= Date.now()) { forgetRequest(requestId); throw new SharedDeliveryPendingError(); }
    const closed = state.closed && `${requestId}:${state.fingerprint}`;
    if (closed) {
      forgetRequest(requestId);
      if (lastExhaustedClosedRequest === closed) throw new SharedDeliveryPendingError();
    } else {
      receivedRequests.set(requestId, { kind, key, after, through, groupId, keyVersion: group.keyVersion, deadline: state.deadline, fingerprint: state.fingerprint });
      observeResponse(target);
    }
    const responses = await getDocsFromServer(query(collection(target, 'responses'), limit(65))); checkAccount();
    for (const response of responses.docs) {
      if (state.deadline <= Date.now()) break;
      const metadata = response.data();
      if (!usableResponse(group, response.id, metadata)) continue;
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
    // A sealed request cannot gain replies. An interrupted cleanup can leave a reply header without its parts.
    if (closed) {
      lastExhaustedClosedRequest = closed;
      if ('previous' in state) return recover(groupId, kind, key, after, through, false);
    }
    throw new SharedDeliveryPendingError(responseObservers.has(requestId) ? state.deadline : undefined);
  }
  return {
    archive: observedArchive,
    serve,
    request(groupId: string, group: SharedCloudGroup) {
      if (scope?.id === groupId && scope.group.keyVersion <= group.keyVersion) updateScope(groupId, group);
      if (!discoveryNeeded && !knownRequests.size) return;
      // Recovery for other devices cannot extend a normal read/edit's network deadline.
      void serve(groupId, group, false).catch(error => failure?.(error));
    },
    async eventPage(groupId: string, after: number, head: number): Promise<SharedCloudEvent[]> {
      const through = Math.min(head, after + 10);
      const local = await archive.events(after, through); if (local) return local;
      const result = await recover(groupId, 'events', `compact.${after}`, after, through);
      if (!Array.isArray(result) || result.length !== through - after) throw new Error('Invalid peer delivery page');
      const events = result.map((value, index) => {
        if (value?.uploadSequence !== after + index + 1 || !value.serverReceipt || typeof value.envelopeJson !== 'string') throw new Error('Invalid peer delivery page');
        const envelope = value.envelope ?? JSON.parse(value.envelopeJson);
        if (envelope?.groupId !== groupId) throw new Error('Invalid peer delivery group');
        return { ...value, envelope } as SharedCloudEvent;
      });
      // Original signatures, encryption, causal history and independent server receipts are still checked by the normal receiver.
      return events;
    },
    async snapshotChunk(groupId: string, id: string, through: number): Promise<Artifact> {
      const local = await archive.chunk(id); if (local) return local;
      return await recover(groupId, 'chunk', id, through, through) as Artifact;
    },
    async active(groupId: string) {
      checkAccount(); const result = await getDocFromServer(policyRef(groupId)); checkAccount();
      return parseDeliveryPolicy(result.data())?.enabled === true && result.data()?.active === true;
    },
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
        // Only the worker can close a signed request. It verifies the receipt before fencing late responders.
        for (let offset = 0; offset < targets.length; offset += 32) {
          await runTransaction(firestore, async transaction => {
            const current = await Promise.all(targets.slice(offset, offset + 32).map(id => transaction.get(doc(requests(groupId), id)))); checkAccount();
            const proof = context.proof;
            const signed = proof && current.some(row => row.data()?.schemaVersion === 2)
              ? await Promise.all([transaction.get(policyRef(groupId)), transaction.get(reference(groupId))]).then(([policy, root]) => proof.resolve(groupId, policy.data(), root.data())) : null;
            for (const request of current) {
              const value = request.data(); const expected = receivedRequests.get(request.id);
              if (!expected || !value || !validRequest(value) || value.userId !== userId || value.deviceId !== deviceId || value.through > sequence
                || value.receivedAt !== undefined || value.kind !== expected.kind || value.key !== expected.key
                || value.after !== expected.after || value.through !== expected.through) continue;
              // A new request first has a client deadline. The server timestamp becomes available on its first read.
              if (expected.fingerprint === null ? value.expiresAt.toMillis() !== expected.deadline : fingerprintOf(value) !== expected.fingerprint) continue;
              if (value.schemaVersion === 1) { transaction.update(request.ref, { receivedAt: serverTimestamp() }); continue; }
              if (signed && proof && signed.keyVersion === value.keyVersion && deadlineOf(value) > Date.now()) {
                const signature = await proof.sign(recoveryReceiptInput(signed, userId, deviceId, { id: request.id, kind: value.kind, key: value.key,
                  after: value.after, through: value.through, keyVersion: value.keyVersion, createdSeconds: value.createdAt.seconds, createdNanoseconds: value.createdAt.nanoseconds }));
                checkAccount();
                if (signature !== value.receiptSignature) transaction.update(request.ref, { receiptSignature: signature, receiptReportedAt: serverTimestamp() });
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
      let enrollment: string | null | undefined;
      const stopPolicy = context.proof && onSnapshot(policyRef(groupId), { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
        try {
          checkAccount(); const policy = parseDeliveryPolicy(snapshot.data()); const next = policy ? `${policy.enrollmentId}:${policy.enabled}` : null;
          if (next !== enrollment) { enrollment = next; if (next !== null) changed(); }
        } catch (error) { failed(error); }
      }, failed);
      scheduleRelay();
      return () => { unsubscribe(); stopPolicy?.(); wake = undefined; failure = undefined; clearTimeout(relayTimer);
        for (const stop of responseObservers.values()) stop(); responseObservers.clear(); responsePresent.clear(); };
    },
  };
}
export type SharingDeliveryRelay = ReturnType<typeof createSharingDeliveryRelay<EncryptedSharedSnapshotChunk>>;
