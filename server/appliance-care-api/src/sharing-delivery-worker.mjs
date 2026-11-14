const TTL = 86400_000;
const time = value => typeof value?.toMillis === 'function' ? value.toMillis() : value instanceof Date ? value.getTime() : NaN;

/** Admin-only erasure. No user content is returned to logging or stored in another collection. */
export async function sweepSharedDeliveries(firestore, groupId, now = Date.now()) {
  if (!/^[A-Za-z0-9_.:-]{1,150}$/u.test(groupId) || !Number.isSafeInteger(now)) throw new Error('Invalid delivery sweep scope');
  const root = firestore.collection('sharingGroups').doc(groupId);
  const result = await firestore.runTransaction(async transaction => {
    const policyRef = root.collection('deliveryControl').doc('policy');
    const [rootDoc, policyDoc, recoveryDoc] = await transaction.getAll(root, policyRef, root.collection('recoveryLocks').doc('current'));
    const group = rootDoc.data(); const policy = policyDoc.data();
    if (!group || !policy || policy.schemaVersion !== 1 || policy.enabled !== true || policy.ttlMs !== TTL) return { active: false, deleted: 0, nextAt: null };
    const recipients = Object.entries(group.deviceOwners ?? {}).filter(([, uid]) => group.memberIds?.includes(uid) && !group.revokedUserIds?.includes(uid));
    const capable = recipients.length ? await transaction.getAll(...recipients.map(([device]) => root.collection('deliveryDevices').doc(device))) : [];
    const recovering = recoveryDoc.exists && recoveryDoc.data().keyVersion === group.keyVersion;
    const allCapable = recipients.length > 0 && capable.every((entry, index) => { const value = entry.data(); return value?.schemaVersion === 1
        && value.deviceId === recipients[index][0] && value.userId === recipients[index][1]
        && Number.isSafeInteger(value.seededThrough) && value.seededThrough >= 0; });
    const active = group.schemaVersion === 2 && !group.closed && !group.rotationRequired && !recovering && allCapable;
    // Closing or revoking a negotiated group must not strand its old ciphertext forever.
    const expireOnly = Number.isSafeInteger(policy.activatedAt) && !recovering && (group.closed || allCapable);
    if (!active && !expireOnly) {
      if (policy.active === true) transaction.update(policyRef, { active: false });
      return { active: false, deleted: 0, nextAt: null };
    }
    const acknowledged = recipients.length ? await transaction.getAll(...recipients.map(([device]) => root.collection('acknowledgements').doc(device))) : [];
    const floor = active ? Math.min(...acknowledged.map((entry, index) => {
      const value = entry.data(); return value?.userId === recipients[index][1] && Number.isSafeInteger(value.sequence) ? value.sequence : -1;
    })) : -1;
    // Rules bound each ciphertext document to 800KB. Ten deletes plus metadata stay below the transaction byte limit.
    // Erasure only needs metadata; never download a PDF/event body just to decide to delete it.
    const events = await transaction.get(root.collection('events').orderBy('uploadSequence').limit(5).select('uploadSequence', 'createdAt'));
    const chunks = await transaction.get(root.collection('snapshotChunks').orderBy('createdAt').limit(5).select('snapshotId', 'keyVersion', 'createdAt'));
    const snapshotIds = [...new Set(chunks.docs.map(part => part.data().snapshotId).filter(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/u.test(id)))];
    const snapshots = snapshotIds.length ? await transaction.getAll(...snapshotIds.map(id => root.collection('snapshots').doc(id))) : [];
    const metadata = new Map(snapshots.map(snapshot => [snapshot.id, snapshot.data()]));
    const deletions = []; let nextAt = Infinity;
    for (const event of events.docs) {
      const value = event.data(); const expiry = time(value.createdAt) + TTL;
      if (!Number.isFinite(expiry) || !Number.isSafeInteger(value.uploadSequence) || value.uploadSequence > group.headSequence) continue;
      if (value.uploadSequence <= floor || expiry <= now) deletions.push(event.ref); else nextAt = Math.min(nextAt, expiry);
    }
    for (const chunk of chunks.docs) {
      const value = chunk.data(); const expiry = time(value.createdAt) + TTL; const snapshot = metadata.get(value.snapshotId);
      if (!Number.isFinite(expiry) || !Number.isSafeInteger(value.keyVersion) || value.keyVersion > group.keyVersion) continue;
      if (snapshot && Number.isSafeInteger(snapshot.throughSequence) && snapshot.throughSequence <= floor || expiry <= now) deletions.push(chunk.ref);
      else nextAt = Math.min(nextAt, expiry);
    }
    if (policy.active !== active || active && policy.activatedAt === undefined) transaction.update(policyRef, {
      active, ...(policy.activatedAt === undefined && active ? { activatedAt: now } : {}),
    });
    for (const ref of deletions) transaction.delete(ref);
    return { active, deleted: deletions.length, nextAt: deletions.length ? now : Number.isFinite(nextAt) ? nextAt : null };
  });
  await pruneDeliveryRequests(root, result, now, firestore);
  return result;
}

async function pruneDeliveryRequests(root, result, now, firestore) {
  // A parent-document delete does not delete subcollections. Remove every response part explicitly.
  const requests = await root.collection('deliveryRequests').orderBy('createdAt').limit(32).get();
  for (const request of requests.docs) {
    const value = request.data(); const expiry = Number.isFinite(time(value.receivedAt)) ? now
      : Math.min(time(value.expiresAt), time(value.createdAt) + TTL);
    if (!Number.isFinite(expiry)) continue;
    if (expiry > now) { result.nextAt = Math.min(result.nextAt ?? Infinity, expiry); continue; }
    const responses = await request.ref.collection('responses').get();
    for (const response of responses.docs) {
      const parts = await response.ref.collection('parts').select('index').get();
      for (let offset = 0; offset < parts.docs.length; offset += 32) {
        const batch = firestore.batch(); for (const part of parts.docs.slice(offset, offset + 32)) batch.delete(part.ref); await batch.commit();
      }
      await response.ref.delete();
    }
    await request.ref.delete(); result.deleted++;
  }
}

export async function sweepPrivateDeliveries(firestore, userId, now = Date.now()) {
  if (!/^[A-Za-z0-9_.:-]{1,150}$/u.test(userId) || !Number.isSafeInteger(now)) throw new Error('Invalid private delivery scope');
  const root = firestore.collection('privateCalendars').doc(userId);
  const result = await firestore.runTransaction(async transaction => {
    const policyRef = root.collection('deliveryControl').doc('policy'); const preferencesRef = root.collection('plannerPreferences').doc('current');
    const [rootDoc, policyDoc, preferencesDoc] = await transaction.getAll(root, policyRef, preferencesRef);
    const head = rootDoc.data(), policy = policyDoc.data(), preferences = preferencesDoc.data();
    if (!head || head.ownerUserId !== userId || !policy || policy.schemaVersion !== 1 || policy.enabled !== true || policy.ttlMs !== TTL) return { active: false, deleted: 0, nextAt: null };
    const devices = head.deviceIds;
    if (!Array.isArray(devices) || !devices.length || devices.length > 16 || new Set(devices).size !== devices.length) throw new Error('Invalid private delivery recipients');
    const capable = await transaction.getAll(...devices.map(device => root.collection('deliveryDevices').doc(device)));
    const active = capable.every((entry, index) => { const value = entry.data(); return value?.schemaVersion === 1 && value.userId === userId && value.deviceId === devices[index] && value.seededThrough === 0; });
    if (!active) { if (policy.active === true) transaction.update(policyRef, { active: false }); return { active: false, deleted: 0, nextAt: null }; }
    const receipts = await transaction.getAll(...devices.map(device => root.collection('deliveryAcknowledgements').doc(device)));
    const allReceived = (domain, digest) => receipts.every((entry, index) => {
      const value = entry.data(); return value?.userId === userId && value.deviceId === devices[index]
        && value.authorityDigest === head.authorityDigest && value[domain] === digest;
    });
    const cacheRef = head.cacheHead ? root.collection('caches').doc(head.cacheHead.cacheId) : null;
    const cacheDoc = cacheRef ? await transaction.get(cacheRef) : null; const cache = cacheDoc?.data();
    const parts = cache && cache.erasedAt === undefined ? await transaction.get(cacheRef.collection('parts').select('index')) : null;
    let deleted = 0, nextAt = Infinity;
    const shouldErase = (createdAt, received) => { const expiry = time(createdAt) + TTL;
      if (!Number.isFinite(expiry)) return false; if (received || expiry <= now) return true; nextAt = Math.min(nextAt, expiry); return false; };
    if (preferences && preferences.encryptedJson !== null && shouldErase(preferences.updatedAt, allReceived('preferencesDigest', preferences.digest))) {
      transaction.set(preferencesRef, { ...preferences, encryptedJson: null, erasedAt: new Date(now) }); deleted++;
    }
    if (cache && cache.erasedAt === undefined && shouldErase(cache.createdAt, allReceived('calendarDigest', cache.manifestDigest))) {
      for (const part of parts.docs) { transaction.delete(part.ref); deleted++; }
      transaction.update(cacheRef, { erasedAt: new Date(now) });
    }
    if (policy.active !== true) transaction.update(policyRef, { active: true });
    return { active: true, deleted, nextAt: Number.isFinite(nextAt) ? nextAt : null };
  });
  await pruneDeliveryRequests(root, result, now, firestore); return result;
}

/** Wake on actual metadata/receipt changes, or on the next outstanding expiry. No fixed idle poll. */
export function startSharedDeliveryWorker(firestore, monitor = () => {}) {
  const groups = new Map(); let stopped = false;
  function observe(target, changed) {
    let ended = false, unsubscribe, retry, failures = 0;
    const connect = () => {
      if (stopped || ended) return;
      unsubscribe = target.onSnapshot(snapshot => { if (!stopped && !ended) { failures = 0; changed(snapshot); } }, () => {
        if (stopped || ended) return;
        unsubscribe?.(); monitor({ event: 'shared_delivery_listener_retry' });
        retry = setTimeout(connect, Math.min(300_000, 30_000 * 2 ** Math.min(failures++, 4))); retry.unref?.();
      });
    };
    connect(); return () => { ended = true; clearTimeout(retry); unsubscribe?.(); };
  }
  const discovery = observe(firestore.collectionGroup('deliveryControl').where('enabled', '==', true), snapshot => {
    for (const change of snapshot.docChanges()) {
      const root = change.doc.ref.parent.parent; if (!root || change.doc.id !== 'policy') continue;
      if (!['sharingGroups', 'privateCalendars'].includes(root.parent.id)) continue;
      if (change.type === 'removed') { groups.get(root.path)?.stop(); groups.delete(root.path); continue; }
      if (groups.has(root.path)) continue;
      let running = false, again = false, timer, disposed = false;
      const schedule = delay => { clearTimeout(timer); if (!stopped && !disposed) { timer = setTimeout(run, Math.max(50, delay)); timer.unref?.(); } };
      const run = async () => {
        if (stopped || disposed) return; if (running) { again = true; return; }
        running = true; clearTimeout(timer);
        try {
          const result = root.parent.id === 'privateCalendars'
            ? await sweepPrivateDeliveries(firestore, root.id) : await sweepSharedDeliveries(firestore, root.id);
          if (result.deleted) monitor({ event: 'shared_delivery_erased', records: result.deleted });
          if (again) { again = false; schedule(50); }
          else if (result.nextAt !== null) schedule(result.nextAt - Date.now());
        } catch { monitor({ event: 'shared_delivery_cleanup_failed' }); schedule(30_000); }
        finally { running = false; }
      };
      const wake = () => { if (running) again = true; else schedule(50); };
      const privateScope = root.parent.id === 'privateCalendars';
      const subscriptions = [observe(root, wake), ...[privateScope ? 'deliveryAcknowledgements' : 'acknowledgements', 'deliveryDevices', 'deliveryRequests'].map(name => observe(root.collection(name), wake)),
        ...(privateScope ? [observe(root.collection('plannerPreferences').select('digest', 'updatedAt'), wake)]
          : [observe(root.collection('snapshotChunks').select('createdAt', 'snapshotId'), wake)])];
      groups.set(root.path, { stop() { disposed = true; clearTimeout(timer); subscriptions.forEach(unsubscribe => unsubscribe()); } }); wake();
    }
  });
  return () => { stopped = true; discovery(); for (const group of groups.values()) group.stop(); groups.clear(); };
}
