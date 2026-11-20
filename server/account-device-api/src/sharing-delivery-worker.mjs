import { DELIVERY_PROOF_COLLECTION, DELIVERY_TTL_MS, parseDeliveryPolicy, readSignedDeliveryProgress,
  validRecoveryReceipt } from '../../../src/features/sharing/delivery-proof.ts';
import { sharedDocumentDigest } from '../../../src/features/sharing/crypto.ts';
import { assertSharedIdentifier } from '../../../src/features/sharing/identifier.ts';
import { verifiedDeliveryAuthority } from './delivery-authority.mjs';
import { randomBytes } from 'node:crypto';

const requestBatch = 32;
const time = value => typeof value?.toMillis === 'function' ? value.toMillis() : value instanceof Date ? value.getTime() : NaN;
const sameTimestamp = (a, b) => Number.isSafeInteger(a?.seconds) && Number.isInteger(a.nanoseconds)
  && a.seconds === b?.seconds && a.nanoseconds === b.nanoseconds;
function safeId(value) { try { assertSharedIdentifier(value); return true; } catch { return false; } }
const digest = /^[a-f0-9]{64}$/u;
const inactive = () => ({ active: false, deleted: 0, nextAt: null });
const projectIdFrom = firestore => firestore.projectId;
const proofScope = (projectId, kind, root, policy, authority) => ({ projectId, kind, scopeId: root.id,
  enrollmentId: policy.enrollmentId, authorityDigest: authority.digest, keyVersion: authority.metadata.keyVersion });

async function readEnrollments(firestore, transaction, root, kind, raw, policy, projectId, verified) {
  const authority = verified ?? await verifiedDeliveryAuthority(firestore, root, raw, kind);
  if (!authority) return null;
  const scope = proofScope(projectId, kind, root, policy, authority);
  const refs = authority.devices.map(device => root.collection(DELIVERY_PROOF_COLLECTION).doc(device.identity.deviceId));
  const proofs = refs.length ? await transaction.getAll(...refs) : [];
  const progress = authority.devices.map(({ userId, identity }, index) => {
    const value = readSignedDeliveryProgress(scope, userId, identity, proofs[index].data());
    return value && (kind === 'shared' ? value.sequence <= authority.metadata.headSequence : value.ready) ? value : null;
  });
  return { ...authority, scope, progress, approved: refs.length, ready: progress.filter(Boolean).length };
}

async function countCaughtUp(transaction, root, kind, enrollment) {
  if (!enrollment?.ready) return 0;
  const { metadata, progress } = enrollment;
  if (kind === 'shared') {
    const snapshotDigest = await currentSnapshotDigest(transaction, root, metadata);
    if (metadata.snapshotId && snapshotDigest === null) return 0;
    return progress.filter(proof => proof?.sequence === metadata.headSequence && proof.snapshotId === metadata.snapshotId
      && proof.snapshotDigest === snapshotDigest).length;
  }
  const preferences = (await transaction.get(root.collection('plannerPreferences').doc('current'))).data();
  if (preferences && (preferences.authorityDigest !== metadata.authorityDigest || typeof preferences.digest !== 'string' || !digest.test(preferences.digest))) return 0;
  const calendarDigest = metadata.cacheHead?.authorityDigest === metadata.authorityDigest ? metadata.cacheHead.manifestDigest : null;
  const preferenceDigest = preferences?.digest ?? null;
  return progress.filter(proof => proof?.ready && proof.calendarDigest === calendarDigest && proof.preferencesDigest === preferenceDigest).length;
}

/** Read-only, including on scopes that have never opted into expiration. */
export async function inspectDeliveryReadiness(firestore, projectId = projectIdFrom(firestore)) {
  const output = {};
  for (const [kind, name] of [['shared', 'sharingGroups'], ['private', 'privateCalendars']]) {
    const total = { scopes: 0, approved: 0, ready: 0, caughtUp: 0, fullyReadyScopes: 0, fullyCaughtUpScopes: 0, enabledScopes: 0, closedEnabledScopes: 0,
      invalidAuthorityScopes: 0, recoveryLockedScopes: 0 };
    for (const root of await firestore.collection(name).listDocuments()) {
      const outcome = await firestore.runTransaction(async transaction => {
        const [current, policyDoc] = await transaction.getAll(root, root.collection('deliveryControl').doc('policy'));
        const raw = current.data();
        if (!raw || kind === 'shared' && raw.schemaVersion !== 2) return null;
        const policy = parseDeliveryPolicy(policyDoc.data());
        const enabled = policy?.enabled === true;
        const lock = kind === 'shared' ? (await transaction.get(root.collection('recoveryLocks').doc('current'))).data() : undefined;
        const locked = lock?.keyVersion === raw.keyVersion;
        const authority = await verifiedDeliveryAuthority(firestore, root, raw, kind).catch(() => null);
        if (!authority) return { invalid: true, enabled, locked };
        if (kind === 'shared' && authority.metadata.closed) return { closed: true, enabled, locked };
        const enrollment = policy ? await readEnrollments(firestore, transaction, root, kind, raw, policy, projectId, authority) : null;
        return { approved: authority.devices.length, ready: enrollment?.ready ?? 0, caughtUp: await countCaughtUp(transaction, root, kind, enrollment),
          enabled, locked };
      }, { readOnly: true });
      if (!outcome) continue;
      if (outcome.enabled) total.enabledScopes++;
      if (outcome.locked) total.recoveryLockedScopes++;
      if (outcome.closed) {
        if (outcome.enabled) total.closedEnabledScopes++;
        continue;
      }
      total.scopes++;
      if (outcome.invalid) { total.invalidAuthorityScopes++; continue; }
      total.approved += outcome.approved; total.ready += outcome.ready; total.caughtUp += outcome.caughtUp;
      if (outcome.approved > 0 && outcome.ready === outcome.approved) total.fullyReadyScopes++;
      if (outcome.approved > 0 && outcome.caughtUp === outcome.approved) total.fullyCaughtUpScopes++;
    }
    output[kind] = total;
  }
  return output;
}

export async function setDeliveryPolicyState(firestore, { kind, scopeId, action }, projectId = projectIdFrom(firestore)) {
  if (!['shared', 'private'].includes(kind) || !safeId(scopeId)
    || !['enroll', 'enable', 'pause'].includes(action)) throw new Error('Invalid delivery policy action');
  const root = firestore.collection(kind === 'shared' ? 'sharingGroups' : 'privateCalendars').doc(scopeId);
  const policyRef = root.collection('deliveryControl').doc('policy');
  const enrollmentId = randomBytes(32).toString('hex');
  return firestore.runTransaction(async transaction => {
    const [current, existing] = await transaction.getAll(root, policyRef);
    const raw = current.data(), previous = existing.data(), policy = parseDeliveryPolicy(previous);
    if (action === 'pause') {
      const legacy = previous?.schemaVersion === 1 && previous.ttlMs === DELIVERY_TTL_MS && typeof previous.enabled === 'boolean';
      if (!policy && !legacy) throw new Error('Delivery is not enrolled');
      if (legacy) {
        // The disabled V2 policy also stops legacy client cleanup in Rules. There is no gap between pause and enrollment.
        transaction.set(policyRef, { schemaVersion: 2, enabled: false, enrollmentId, ttlMs: DELIVERY_TTL_MS, createdAt: new Date() });
      } else transaction.update(policyRef, { enabled: false, active: false });
      return { enabled: false };
    }
    if (!raw || kind === 'shared' && (raw.schemaVersion !== 2 || raw.closed)) throw new Error('Delivery scope is unavailable');
    if (action === 'enroll') {
      if (policy) return { enabled: policy.enabled };
      await verifiedDeliveryAuthority(firestore, root, raw, kind);
      if (previous?.active === true) throw new Error('Legacy delivery must be stopped first');
      transaction.set(policyRef, { schemaVersion: 2, enabled: false, enrollmentId, ttlMs: DELIVERY_TTL_MS, createdAt: new Date() });
      return { enabled: false };
    }
    if (!policy || kind === 'shared' && raw.rotationRequired) throw new Error('Delivery authority is not ready');
    if (kind === 'shared' && (await transaction.get(root.collection('recoveryLocks').doc('current'))).data()?.keyVersion === raw.keyVersion) {
      throw new Error('Shared recovery blocks erasure');
    }
    const enrolled = await readEnrollments(firestore, transaction, root, kind, raw, policy, projectId);
    if (!enrolled?.approved || enrolled.approved !== enrolled.ready) throw new Error('All approved devices must be ready');
    if (enrolled.approved !== await countCaughtUp(transaction, root, kind, enrolled)) throw new Error('All approved devices must acknowledge the current data');
    if (!policy.enabled) transaction.update(policyRef, { enabled: true, activatedAt: previous.activatedAt ?? Date.now() });
    return { enabled: true, approved: enrolled.approved };
  });
}

function due(result, saved, holder, all, now) {
  const expires = time(saved) + DELIVERY_TTL_MS;
  // Time alone never turns the transport's only copy into a recoverable copy.
  if (!holder || !Number.isFinite(expires)) return false;
  if (all || expires <= now) return true;
  result.nextAt = Math.min(result.nextAt ?? Infinity, expires);
  return false;
}

async function currentSnapshotDigest(transaction, root, group) {
  if (!group.snapshotId) return null;
  const data = (await transaction.get(root.collection('snapshots').doc(group.snapshotId))).data();
  if (typeof data?.manifestJson !== 'string' || data.manifestJson.length > 100_000 || data.throughSequence !== group.snapshotThroughSequence) return null;
  let manifest;
  try { manifest = JSON.parse(data.manifestJson); } catch { return null; }
  return manifest?.body?.snapshotId === group.snapshotId && manifest.body.groupId === root.id
    && manifest.body.throughSequence === group.snapshotThroughSequence && manifest.body.keyVersion === data.keyVersion
    ? sharedDocumentDigest(manifest) : null;
}

async function* deliveryPages(transaction, query, cursor, continued) {
  const size = 25;
  for (let count = 0; count < 2; count++) {
    const page = await transaction.get((cursor ? query.startAfter(cursor) : query).limit(size));
    if (page.docs.length) yield page.docs;
    if (page.docs.length < size) return;
    cursor = page.docs.at(-1);
  }
  continued(cursor);
}

export async function sweepSharedDeliveries(firestore, groupId, now = Date.now(), projectId = projectIdFrom(firestore), previousScan) {
  if (!safeId(groupId) || !Number.isSafeInteger(now)) throw new Error('Invalid delivery sweep scope');
  const root = firestore.collection('sharingGroups').doc(groupId);
  let claim;
  const result = await firestore.runTransaction(async transaction => {
    claim = undefined;
    const policyRef = root.collection('deliveryControl').doc('policy');
    const [current, policyDoc, recovery] = await transaction.getAll(root, policyRef, root.collection('recoveryLocks').doc('current'));
    const raw = current.data(), policyData = policyDoc.data(), policy = parseDeliveryPolicy(policyData);
    if (!policy?.enabled || raw?.schemaVersion !== 2) return inactive();
    if (recovery.data()?.keyVersion === raw.keyVersion || raw.rotationRequired) {
      if (policyData.active === true) transaction.update(policyRef, { active: false });
      return inactive();
    }
    const enrolled = await readEnrollments(firestore, transaction, root, 'shared', raw, policy, projectId);
    const { metadata: group, approved, ready, progress } = enrolled;
    const recovering = recovery.data()?.keyVersion === group.keyVersion;
    const active = !group.closed && !group.rotationRequired && !recovering
      && approved > 0 && approved === ready;
    const closed = group.closed && Number.isSafeInteger(policyData.activatedAt) && !recovering;
    if (!active && !closed) {
      if (policyData.active === true) transaction.update(policyRef, { active: false });
      if (!recovering && !group.rotationRequired) claim = { ...enrolled, authorityJson: raw.rosterJson, expiredOnly: true };
      return inactive();
    }
    const result = { ...inactive(), active };
    const snapshotDigest = closed ? null : await currentSnapshotDigest(transaction, root, group);
    const holdsCurrent = proof => proof && proof.snapshotId === group.snapshotId && proof.snapshotDigest === snapshotDigest
      && (!group.snapshotId || snapshotDigest !== null && proof.sequence >= group.snapshotThroughSequence);
    const holders = progress.filter(holdsCurrent);
    const floor = active && holders.length === approved ? Math.min(...holders.map(proof => proof.sequence)) : -1;
    const owner = progress[enrolled.devices.findIndex(device => device.identity.deviceId === group.ownerDeviceId)];
    // Owner recovery reads a continuous raw prefix from its last durable cursor, including unreadable originals.
    const ceiling = closed ? group.headSequence : holdsCurrent(owner) ? owner.sequence : 0;
    const scanKey = JSON.stringify([enrolled.scope.enrollmentId, enrolled.digest, group.snapshotId, snapshotDigest, floor, ceiling,
      group.retentionThroughSequence, group.retentionKeyVersion, holders.length, closed]);
    const scan = previousScan?.key === scanKey ? previousScan : undefined;
    const continuation = { key: scanKey, events: scan?.events, chunks: scan?.chunks,
      eventsDone: scan?.eventsDone ?? ceiling === 0, chunksDone: scan?.chunksDone ?? false, nextAt: scan?.nextAt ?? null };
    result.nextAt = continuation.nextAt;
    const deletions = [];
    if (!continuation.eventsDone) {
      const events = root.collection('events').where('uploadSequence', '<=', ceiling).orderBy('uploadSequence').select('uploadSequence', 'createdAt', 'keyVersion');
      let more = false;
      for await (const page of deliveryPages(transaction, events, scan?.events, cursor => { continuation.events = cursor; more = true; })) {
        let waiting = false;
        const eligible = page.filter(event => {
          const { createdAt, uploadSequence } = event.data();
          if (due(result, createdAt, true, uploadSequence <= floor, now)) return true;
          // Server-created times increase by sequence. Later pages can wait for the first future expiry.
          waiting ||= time(createdAt) + DELIVERY_TTL_MS > now;
          return false;
        });
        const quarantines = !closed && eligible.length ? await transaction.getAll(...eligible.map(event => root.collection('quarantines').doc(event.id))) : [];
        for (const [index, event] of eligible.entries()) {
          const { uploadSequence, keyVersion } = event.data();
          if (!quarantines[index]?.exists || group.retentionThroughSequence >= uploadSequence && group.retentionKeyVersion >= keyVersion) deletions.push(event.ref);
          if (deletions.length === 5) break;
        }
        if (deletions.length === 5 || waiting) break;
      }
      continuation.eventsDone = !more && deletions.length < 5;
    }
    const chunkLimit = deletions.length + 5;
    const chunks = root.collection('snapshotChunks').orderBy('createdAt').select('snapshotId', 'keyVersion', 'createdAt');
    let moreChunks = false;
    if (!continuation.chunksDone) for await (const page of deliveryPages(transaction, chunks, scan?.chunks, cursor => { continuation.chunks = cursor; moreChunks = true; })) {
      const candidates = [...new Set(page.map(chunk => chunk.data())
        .filter(({ snapshotId, keyVersion }) => safeId(snapshotId) && snapshotId !== group.snapshotId && keyVersion <= group.keyVersion + 1)
        .map(({ snapshotId }) => snapshotId))];
      const manifests = candidates.length ? await transaction.getAll(...candidates.map(snapshotId => root.collection('snapshots').doc(snapshotId))) : [];
      const unpublished = manifests.filter(manifest => !manifest.exists).map(manifest => manifest.id);
      const stages = unpublished.length ? await transaction.getAll(...unpublished.map(id => root.collection('snapshotStages').doc(id))) : [];
      const stageData = new Map(stages.map(stage => [stage.id, stage.data()]));
      for (const chunk of page) {
        const { createdAt, snapshotId, keyVersion } = chunk.data();
        if (!Number.isSafeInteger(keyVersion) || keyVersion > group.keyVersion + 1) continue;
        const stage = stageData.get(snapshotId);
        const prepared = stage?.keyVersion === keyVersion;
        if (keyVersion > group.keyVersion && !prepared) continue;
        const recoverable = closed || stageData.has(snapshotId) || Boolean(group.snapshotId) && holders.length > 0;
        if (due(result, prepared ? stage.updatedAt : createdAt, recoverable,
          active && snapshotId === group.snapshotId && holders.length === approved, now)) deletions.push(chunk.ref);
        if (deletions.length === chunkLimit) break;
      }
      if (deletions.length === chunkLimit) break;
    }
    continuation.chunksDone ||= !moreChunks && deletions.length < chunkLimit;
    if (policyData.active !== active || active && policyData.activatedAt === undefined) transaction.update(policyRef, {
      active, ...(active && policyData.activatedAt === undefined ? { activatedAt: now } : {}),
    });
    for (const target of deletions) transaction.delete(target);
    result.deleted = deletions.length;
    if (!continuation.eventsDone || !continuation.chunksDone) {
      continuation.nextAt = result.nextAt;
      result.continuation = continuation;
      result.nextAt = now;
    }
    if (result.deleted) result.nextAt = now;
    claim = { ...enrolled, authorityJson: raw.rosterJson };
    return result;
  });
  if (claim) await pruneDeliveryRequests(root, result, now, firestore, claim);
  return result;
}

export async function sweepPrivateDeliveries(firestore, userId, now = Date.now(), projectId = projectIdFrom(firestore)) {
  if (!safeId(userId) || !Number.isSafeInteger(now)) throw new Error('Invalid private delivery scope');
  const root = firestore.collection('privateCalendars').doc(userId);
  let claim;
  const result = await firestore.runTransaction(async transaction => {
    claim = undefined;
    const policyRef = root.collection('deliveryControl').doc('policy'), preferencesRef = root.collection('plannerPreferences').doc('current');
    const [current, policyDoc, preferencesDoc] = await transaction.getAll(root, policyRef, preferencesRef);
    const raw = current.data(), policyData = policyDoc.data(), policy = parseDeliveryPolicy(policyData), preferences = preferencesDoc.data();
    if (!policy?.enabled || !raw) return inactive();
    const enrolled = await readEnrollments(firestore, transaction, root, 'private', raw, policy, projectId);
    const { metadata: head, approved, ready, progress } = enrolled;
    if (approved === 0 || approved !== ready) {
      if (policyData.active === true) transaction.update(policyRef, { active: false });
      claim = { ...enrolled, authorityJson: raw.authorityJson, expiredOnly: true };
      return inactive();
    }
    const result = { ...inactive(), active: true };
    const count = (field, value) => typeof value === 'string' && digest.test(value) ? progress.filter(proof => proof[field] === value).length : 0;
    const cacheRef = head.cacheHead?.authorityDigest === head.authorityDigest && root.collection('caches').doc(head.cacheHead.cacheId);
    const cache = cacheRef && (await transaction.get(cacheRef)).data();
    const preferenceHolders = count('preferencesDigest', preferences?.digest), cacheHolders = count('calendarDigest', cache?.manifestDigest);
    const eraseCache = cache && cache.erasedAt === undefined && cache.manifestDigest === head.cacheHead.manifestDigest
      && due(result, cache.createdAt, cacheHolders > 0, cacheHolders === approved, now);
    const parts = eraseCache || cache?.erasedAt !== undefined && cacheHolders > 0
      ? await transaction.get(cacheRef.collection('parts').select('index')) : null;
    if (preferences?.authorityDigest === head.authorityDigest && typeof preferences.encryptedJson === 'string'
      && due(result, preferences.updatedAt, preferenceHolders > 0, preferenceHolders === approved, now)) {
      transaction.update(preferencesRef, { encryptedJson: null, erasedAt: new Date(now) }); result.deleted++;
    }
    if (parts) {
      for (const part of parts.docs) { transaction.delete(part.ref); result.deleted++; }
      if (eraseCache) transaction.update(cacheRef, { erasedAt: new Date(now) });
    }
    if (policyData.active !== true) transaction.update(policyRef, { active: true });
    claim = { ...enrolled, authorityJson: raw.authorityJson };
    return result;
  });
  if (claim) await pruneDeliveryRequests(root, result, now, firestore, claim);
  return result;
}

function requestReference(requestId, row) {
  return { id: requestId, kind: row.kind, key: row.key, after: row.after, through: row.through, keyVersion: row.keyVersion,
    createdSeconds: row.createdAt.seconds, createdNanoseconds: row.createdAt.nanoseconds };
}

async function requestsForCleanup(transaction, root, candidates, claim) {
  const shared = claim.scope.kind === 'shared';
  const controls = [root, root.collection('deliveryControl').doc('policy')];
  if (shared) controls.push(root.collection('recoveryLocks').doc('current'));
  const snapshots = await transaction.getAll(...controls, ...candidates.map(candidate => candidate.ref));
  const raw = snapshots[0].data(), policy = parseDeliveryPolicy(snapshots[1].data());
  const recovery = shared ? snapshots[2].data() : undefined;
  if (!policy?.enabled || policy.enrollmentId !== claim.scope.enrollmentId || !raw
    || (shared ? raw.rosterJson : raw.authorityJson) !== claim.authorityJson
    || shared && (raw.rotationRequired || recovery?.keyVersion === raw.keyVersion)) return [];
  return snapshots.slice(controls.length).flatMap((document, index) => {
    const candidate = candidates[index], row = document.data();
    return row && sameTimestamp(row.createdAt, candidate.data().createdAt) ? [{ candidate, document, row }] : [];
  });
}

async function closeRequests(firestore, root, candidates, claim, now) {
  if (!candidates.length) return [];
  return firestore.runTransaction(async transaction => {
    const requests = await requestsForCleanup(transaction, root, candidates, claim);
    const sealed = [];
    for (const { candidate, document, row } of requests) {
      const expires = Math.min(time(row.expiresAt), time(row.createdAt) + DELIVERY_TTL_MS);
      const device = claim.devices.find(({ userId, identity }) => userId === row.userId && identity.deviceId === row.deviceId);
      const proof = !claim.expiredOnly && row.schemaVersion === 2 && device
        && validRecoveryReceipt(claim.scope, row.userId, device.identity, requestReference(document.id, row), row.receiptSignature);
      if (!proof && !(Number.isFinite(expires) && expires <= now)) continue;
      if (row.receivedAt === undefined) transaction.update(document.ref, { receivedAt: new Date(now) });
      sealed.push(candidate);
    }
    return sealed;
  });
}

async function deleteSealedRequest(firestore, root, candidate, claim) {
  for (;;) {
    const result = await firestore.runTransaction(async transaction => {
      const [current] = await requestsForCleanup(transaction, root, [candidate], claim);
      if (!current || current.row.receivedAt === undefined) return 'stopped';
      // Keep the parent and its incarnation in the transaction until the last child is gone.
      const response = (await transaction.get(current.document.ref.collection('responses').limit(1).select('ready'))).docs[0];
      if (!response) { transaction.delete(current.document.ref); return 'erased'; }
      const parts = await transaction.get(response.ref.collection('parts').limit(requestBatch + 1).select('index'));
      for (const part of parts.docs.slice(0, requestBatch)) transaction.delete(part.ref);
      if (parts.docs.length <= requestBatch) transaction.delete(response.ref);
      return 'next';
    });
    if (result !== 'next') return result === 'erased';
  }
}

export async function pruneDeliveryRequests(root, result, now, firestore, claim) {
  const collection = root.collection('deliveryRequests');
  const [reported, oldest, earliest] = await Promise.all([
    claim.expiredOnly ? { docs: [], size: 0 } : collection.orderBy('receiptReportedAt', 'desc').limit(requestBatch).get(),
    collection.orderBy('createdAt').limit(requestBatch).get(),
    collection.orderBy('expiresAt').limit(requestBatch).get(),
  ]);
  const requests = new Map([...oldest.docs, ...earliest.docs, ...reported.docs].map(request => [request.id, request]));
  const removed = new Set();
  const candidates = [];
  for (const request of requests.values()) {
    const value = request.data();
    const expires = Math.min(time(value.expiresAt), time(value.createdAt) + DELIVERY_TTL_MS);
    if (expires > now) result.nextAt = Math.min(result.nextAt ?? Infinity, expires);
    if (!claim.expiredOnly && value.receiptReportedAt !== undefined || expires <= now) candidates.push(request);
  }
  for (const request of await closeRequests(firestore, root, candidates, claim, now)) {
    if (await deleteSealedRequest(firestore, root, request, claim)) { result.deleted++; removed.add(request.id); }
  }
  if ([reported, oldest, earliest].some(page => page.size === requestBatch && page.docs.some(request => removed.has(request.id)))) result.nextAt = now;
}

/** Wakes only for changes or a known expiry. Listener failures retry with backoff. */
export function startSharedDeliveryWorker(firestore, monitor = () => {}, projectId = projectIdFrom(firestore)) {
  const groups = new Map(); let stopped = false;
  const queuedSweeps = new Set(); let activeSweeps = 0;
  function dispatch() {
    while (!stopped && activeSweeps < 2 && queuedSweeps.size) {
      const run = queuedSweeps.values().next().value; queuedSweeps.delete(run); activeSweeps++;
      void run().finally(() => { activeSweeps--; dispatch(); });
    }
  }
  function observe(target, changed) {
    let ended = false, unsubscribe, retry, failures = 0;
    const connect = () => {
      if (stopped || ended) return;
      let first = true;
      unsubscribe = target.onSnapshot(snapshot => {
        if (stopped || ended) return;
        failures = 0;
        const initial = first;
        first = false;
        changed(snapshot, initial);
      }, error => {
        if (stopped || ended) return;
        unsubscribe?.();
        monitor({ event: 'shared_delivery_listener_retry', ...(Number.isInteger(error?.code) ? { code: error.code } : {}) });
        // A failed discovery stream can leave this timer as the process's only work.
        retry = setTimeout(connect, Math.min(300_000, 30_000 * 2 ** Math.min(failures++, 4)));
      });
    };
    connect(); return () => { ended = true; clearTimeout(retry); unsubscribe?.(); };
  }
  const deliveryTarget = document => {
    const root = document.ref.parent.parent;
    return root && document.id === 'policy' && ['sharingGroups', 'privateCalendars'].includes(root.parent.id) ? root : null;
  };
  const discovery = observe(firestore.collectionGroup('deliveryControl').where('enabled', '==', true), (snapshot, initial) => {
    if (initial && groups.size) {
      const enabled = new Set(snapshot.docs.flatMap(document => {
        const root = deliveryTarget(document);
        return root && parseDeliveryPolicy(document.data()) ? [root.path] : [];
      }));
      for (const [path, group] of groups) {
        if (enabled.has(path)) continue;
        group.stop();
        groups.delete(path);
      }
    }
    for (const change of snapshot.docChanges()) {
      const root = deliveryTarget(change.doc);
      if (!root) continue;
      if (change.type === 'removed' || !parseDeliveryPolicy(change.doc.data())) { groups.get(root.path)?.stop(); groups.delete(root.path); continue; }
      if (groups.has(root.path)) { groups.get(root.path).wake(); continue; }
      let running = false, again = false, timer, disposed = false, next = Infinity, failures = 0, errorUntil = 0;
      let continuation;
      const schedule = delay => {
        const at = Math.max(errorUntil, Date.now() + Math.max(50, delay));
        if (stopped || disposed || at >= next) return;
        next = at; clearTimeout(timer); timer = setTimeout(() => { queuedSweeps.add(run); dispatch(); }, at - Date.now());
      };
      const run = async () => {
        if (stopped || disposed) return; if (running) { again = true; return; }
        running = true; next = Infinity;
        try {
          const sweep = root.parent.id === 'privateCalendars' ? sweepPrivateDeliveries : sweepSharedDeliveries;
          const result = await sweep(firestore, root.id, Date.now(), projectId, continuation);
          continuation = result.continuation;
          failures = 0; errorUntil = 0;
          if (result.deleted) monitor({ event: 'shared_delivery_erased', records: result.deleted });
          if (again) { again = false; schedule(50); }
          else if (result.nextAt !== null) schedule(result.nextAt - Date.now());
        } catch (error) {
          monitor({ event: 'shared_delivery_cleanup_failed', ...(Number.isInteger(error?.code) ? { code: error.code } : {}) });
          errorUntil = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures++, 6));
          schedule(0);
        }
        finally { running = false; }
      };
      const wake = () => { if (running) again = true; else schedule(50); };
      const privateScope = root.parent.id === 'privateCalendars';
      const subscriptions = [observe(root, wake), ...[DELIVERY_PROOF_COLLECTION, 'deliveryRequests'].map(name => observe(root.collection(name), wake)),
        // Private preference publication is followed by a durable signed receipt, which already wakes this worker.
        ...(privateScope ? [] : [observe(root.collection('snapshotChunks').orderBy('createdAt', 'desc').limit(1), wake),
          observe(root.collection('snapshotStages').orderBy('updatedAt', 'desc').limit(1), wake),
          observe(root.collection('recoveryLocks').doc('current'), wake)])];
      groups.set(root.path, { wake, stop() { disposed = true; clearTimeout(timer); queuedSweeps.delete(run); subscriptions.forEach(unsubscribe => unsubscribe()); } }); wake();
    }
  });
  return () => { stopped = true; discovery(); for (const group of groups.values()) group.stop(); groups.clear(); };
}
