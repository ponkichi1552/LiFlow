import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { assertSharedIdentifier, canonicalJson } from '../../../src/features/sharing/operations.ts';
import { sharedDocumentDigest, verifySharedDocument } from '../../../src/features/sharing/crypto.ts';
import { parseSharedCloudGroup, assertSharedCloudAccess, rosterCloudFields } from '../../../src/features/sharing/cloud-contract.ts';
import { validateSharedRoster, verifySharedRosterTransition, sharedRosterDigest } from '../../../src/features/sharing/roster.ts';
import { verifySharedSnapshotManifest } from '../../../src/features/sharing/snapshots.ts';
import { ACCOUNT_DEVICE_RESTORE_SLOTS, ACCOUNT_DEVICE_RESTORE_TTL_MS, verifyAccountDeviceRestoreRequest,
  verifyAccountDeviceRestoreGrant } from '../../../src/features/sharing/account-device-restore.ts';

export class AccountDeviceApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const refuse = (status, code) => { throw new AccountDeviceApiError(status, code); };
function checked(operation) { try { return operation(); } catch { refuse(400, 'invalid_request'); } }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) refuse(400, 'invalid_request');
}
const millis = value => value && typeof value.toMillis === 'function' ? value.toMillis() : NaN;

/** Metadata only. This service never receives a device private key, plaintext group key or housework payload. */
export function createAccountDeviceService({ firestore, now = Date.now, accountDailyLimit = 120, globalDailyLimit = 2000 }) {
  for (const limit of [accountDailyLimit, globalDailyLimit]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid account device service limit');
  const root = groupId => firestore.doc(`sharingGroups/${groupId}`);
  const slots = (groupId, uid) => Array.from({ length: ACCOUNT_DEVICE_RESTORE_SLOTS }, (_, slot) => root(groupId).collection('accountDeviceRestores').doc(uid).collection('accountDeviceRequests').doc(String(slot)));
  const signal = uid => firestore.doc(`sharingUsers/${uid}/deviceRestoreSignals/current`);
  function identify(actor, groupId) {
    checked(() => { assertSharedIdentifier(actor?.uid); assertSharedIdentifier(groupId); });
    if (!['google.com', 'apple.com'].includes(actor.provider)) refuse(403, 'identity_required');
  }
  async function scope(tx, actor, groupId) {
    const [saved, membership, configuration, entitlement] = await tx.getAll(root(groupId),
      firestore.doc(`sharingUsers/${actor.uid}/memberships/current`), firestore.doc('serviceConfiguration/billing'), firestore.doc(`billingEntitlements/${actor.uid}`));
    let parsed;
    try { parsed = parseSharedCloudGroup(saved.data(), groupId); assertSharedCloudAccess(parsed.group, actor.uid); }
    catch { refuse(403, 'membership_required'); }
    if (parsed.group.schemaVersion !== 2 || parsed.group.rotationRequired || membership.data()?.groupId !== groupId) refuse(409, 'group_changed');
    const access = entitlement.data();
    if (configuration.data()?.enforced === true && (!access || access.userId !== actor.uid || !['active', 'grace'].includes(access.status)
      || !Number.isSafeInteger(access.validUntil) || !Number.isSafeInteger(access.expiresAt)
      || access.validUntil <= now() || access.expiresAt <= now())) refuse(403, 'subscription_required');
    return parsed;
  }
  const publish = (tx, uid, groupId) => tx.set(signal(uid), { groupId, revision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  async function meter(tx, uid) {
    const day = new Date(now()).toISOString().slice(0, 10), identity = sharedDocumentDigest({ uid, day });
    const account = firestore.doc(`accountDeviceServiceUsage/${identity}`), global = firestore.doc(`accountDeviceServiceUsage/global-${day}`);
    const rows = await tx.getAll(account, global);
    if ((rows[0].data()?.count ?? 0) >= accountDailyLimit || (rows[1].data()?.count ?? 0) >= globalDailyLimit) refuse(429, 'retry_later');
    return () => { for (const ref of [account, global]) tx.set(ref, { count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now() + 2 * 24 * 60 * 60_000) }, { merge: true }); };
  }
  async function minimum(tx, group) {
    if (!group.snapshotId) { if (group.retentionKeyVersion) refuse(409, 'snapshot_changed'); return 1; }
    const saved = await tx.get(root(group.groupId).collection('snapshots').doc(group.snapshotId));
    const raw = saved.data(), value = raw?.keyVersion;
    if (!Number.isSafeInteger(value) || value <= (group.retentionKeyVersion ?? 0) || value > group.keyVersion
      || raw.throughSequence !== group.snapshotThroughSequence || typeof raw.manifestJson !== 'string'
      || raw.manifestJson.length > 100000) refuse(409, 'snapshot_changed');
    let manifest, epoch;
    try {
      manifest = JSON.parse(raw.manifestJson);
      epoch = JSON.parse((await tx.get(root(group.groupId).collection('rosters').doc(String(value)))).data().rosterJson);
      verifySharedSnapshotManifest(manifest, validateSharedRoster(epoch));
    } catch { refuse(409, 'snapshot_changed'); }
    if (manifest.body.snapshotId !== group.snapshotId || manifest.body.groupId !== group.groupId
      || manifest.body.keyVersion !== value || manifest.body.throughSequence !== group.snapshotThroughSequence
      || manifest.body.retentionCutoff !== group.retentionCutoff || manifest.body.retentionThroughSequence !== group.retentionThroughSequence
      || manifest.body.retentionKeyVersion !== group.retentionKeyVersion) refuse(409, 'snapshot_changed');
    return value;
  }
  function validRecord(raw, groupId, uid) {
    if (!raw || raw.userId !== uid || !Number.isSafeInteger(millis(raw.createdAt)) || raw.createdAt.toMillis() > now() + 30000
      || !['requested', 'accepted', 'acknowledged'].includes(raw.status) || typeof raw.requestJson !== 'string' || raw.requestJson.length > 8000) refuse(409, 'request_changed');
    const request = checked(() => verifyAccountDeviceRestoreRequest(JSON.parse(raw.requestJson), uid, groupId));
    if (request.body.requestId !== raw.requestId || request.body.identity.deviceId !== raw.deviceId || sharedDocumentDigest(request) !== raw.requestDigest) refuse(409, 'request_changed');
    return request;
  }
  async function verifiedHistory(groupId, expected, deviceId) {
    // The immutable creation record anchors the exact same verifier used on-device.
    if (expected.body.revision > 4096) refuse(409, 'history_limit');
    let previous, seen = false;
    for (let first = 1; first <= expected.body.revision; first += 100) {
      const refs = Array.from({ length: Math.min(100, expected.body.revision - first + 1) }, (_, index) => root(groupId).collection('rosters').doc(String(first + index)));
      const rows = await firestore.getAll(...refs);
      for (const row of rows) {
        const text = row.data()?.rosterJson;
        if (typeof text !== 'string' || text.length > 60000) refuse(409, 'history_changed');
        const roster = JSON.parse(text);
        if (!previous && (roster.body?.revision !== 1 || roster.body?.groupId !== groupId)) refuse(409, 'history_changed');
        previous = previous ? verifySharedRosterTransition(previous, roster) : validateSharedRoster(roster);
        seen ||= previous.body.members.some(member => member.devices.some(device => device.identity.deviceId === deviceId));
      }
    }
    if (!previous || previous.body.revision !== expected.body.revision || sharedRosterDigest(previous) !== sharedRosterDigest(expected)) refuse(409, 'history_changed');
    return { roster: previous, seen };
  }
  return {
    async read(actor, input) {
      exact(input, ['groupId']); input = JSON.parse(canonicalJson(input)); actor = { ...actor }; identify(actor, input.groupId); const { groupId } = input;
      return firestore.runTransaction(async tx => {
        const { group } = await scope(tx, actor, groupId), refs = slots(groupId, actor.uid), rows = await tx.getAll(...refs), result = [];
        let removed = false;
        for (let slot = 0; slot < rows.length; slot++) {
          const raw = rows[slot].data(); if (!raw) continue;
          const request = validRecord(raw, groupId, actor.uid);
          if (millis(raw.createdAt) + ACCOUNT_DEVICE_RESTORE_TTL_MS <= now()
            || raw.status === 'accepted' && raw.minimumKeyVersion <= (group.retentionKeyVersion ?? 0)) {
            tx.delete(refs[slot]); removed = true; continue;
          }
          result.push({ slot, request, receivedAt: millis(raw.createdAt), status: raw.status,
            ...(raw.status === 'accepted' ? { grant: JSON.parse(raw.grantJson), acceptedAt: millis(raw.acceptedAt) } : {}) });
        }
        if (removed) publish(tx, actor.uid, groupId);
        return { records: result };
      });
    },
    async request(actor, input) {
      exact(input, ['groupId', 'slot', 'request', 'replaceRequestId']); identify(actor, input.groupId);
      input = JSON.parse(canonicalJson(input)); actor = { ...actor };
      if (!Number.isInteger(input.slot) || input.slot < 0 || input.slot >= ACCOUNT_DEVICE_RESTORE_SLOTS) refuse(400, 'invalid_slot');
      // Firebase checks the current token expiry and account revocation. A valid
      // refreshed session must not require another manual login after 24 hours.
      if (!Number.isFinite(actor.authTime) || actor.authTime <= 0 || actor.authTime > now() + 30000) refuse(401, 'identity_required');
      const request = checked(() => verifyAccountDeviceRestoreRequest(input.request, actor.uid, input.groupId));
      await firestore.runTransaction(async tx => {
        const { group, roster } = await scope(tx, actor, input.groupId);
        if (request.body.rosterDigest !== sharedRosterDigest(roster)) refuse(409, 'group_changed');
        if (group.deviceOwners[request.body.identity.deviceId] && group.deviceOwners[request.body.identity.deviceId] !== actor.uid) refuse(403, 'device_mismatch');
        const devices = roster.body.members.find(member => member.userId === actor.uid)?.devices ?? [];
        if (!devices.some(device => device.identity.deviceId === request.body.identity.deviceId) && devices.length >= ACCOUNT_DEVICE_RESTORE_SLOTS) refuse(409, 'device_limit');
        const ref = slots(input.groupId, actor.uid)[input.slot], old = (await tx.get(ref)).data();
        if (old && old.requestJson === canonicalJson(request)) return;
        if (old && old.requestId !== input.replaceRequestId || !old && input.replaceRequestId !== null) refuse(409, 'request_changed');
        if (old && old.deviceId !== request.body.identity.deviceId && millis(old.createdAt) + ACCOUNT_DEVICE_RESTORE_TTL_MS > now()) refuse(409, 'slot_busy');
        const count = await meter(tx, actor.uid); count();
        tx.set(ref, { schemaVersion: 1, userId: actor.uid, deviceId: request.body.identity.deviceId, requestId: request.body.requestId,
          requestDigest: sharedDocumentDigest(request), requestJson: canonicalJson(request), status: 'requested', createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(now() + ACCOUNT_DEVICE_RESTORE_TTL_MS) });
        publish(tx, actor.uid, input.groupId);
      });
      return { status: 'requested' };
    },
    async accept(actor, input) {
      exact(input, ['groupId', 'slot', 'requestId', 'grant']); identify(actor, input.groupId);
      input = JSON.parse(canonicalJson(input)); actor = { ...actor };
      if (!Number.isInteger(input.slot) || input.slot < 0 || input.slot >= ACCOUNT_DEVICE_RESTORE_SLOTS) refuse(400, 'invalid_slot');
      const preflight = await firestore.runTransaction(async tx => {
        const metadata = await scope(tx, actor, input.groupId);
        const raw = (await tx.get(slots(input.groupId, actor.uid)[input.slot])).data();
        const request = validRecord(raw, input.groupId, actor.uid);
        if (raw.requestId !== input.requestId) refuse(409, 'request_changed');
        const accepted = raw.status === 'accepted' && raw.grantJson === canonicalJson(input.grant)
          || raw.status === 'acknowledged' && raw.grantDigest === sharedDocumentDigest(input.grant);
        if (!accepted && (raw.status !== 'requested' || millis(raw.createdAt) + ACCOUNT_DEVICE_RESTORE_TTL_MS <= now())) refuse(409, 'request_expired');
        if (!accepted) { const min = await minimum(tx, { ...metadata.group, groupId: input.groupId });
          checked(() => verifyAccountDeviceRestoreGrant(input.grant, request, metadata.roster, min)); }
        return { ...metadata, request, accepted };
      });
      if (preflight.accepted) return { status: 'accepted' };
      const history = await verifiedHistory(input.groupId, preflight.roster, preflight.request.body.identity.deviceId);
      await firestore.runTransaction(async tx => {
        const { group, roster } = await scope(tx, actor, input.groupId);
        const ref = slots(input.groupId, actor.uid)[input.slot], raw = (await tx.get(ref)).data();
        const request = validRecord(raw, input.groupId, actor.uid);
        if (raw.requestId !== input.requestId) refuse(409, 'request_changed');
        if (raw.status === 'accepted' && raw.grantJson === canonicalJson(input.grant)
          || raw.status === 'acknowledged' && raw.grantDigest === sharedDocumentDigest(input.grant)) return;
        if (raw.status !== 'requested' || millis(raw.createdAt) + ACCOUNT_DEVICE_RESTORE_TTL_MS <= now()) refuse(409, 'request_expired');
        if (sharedRosterDigest(roster) !== sharedRosterDigest(history.roster)) refuse(409, 'group_changed');
        const current = roster.body.members.find(member => member.userId === actor.uid);
        const existing = current?.devices.some(device => device.identity.deviceId === request.body.identity.deviceId);
        if (!existing && history.seen) refuse(403, 'device_removed');
        const minimumVersion = await minimum(tx, { ...group, groupId: input.groupId });
        const next = checked(() => verifyAccountDeviceRestoreGrant(input.grant, request, history.roster, minimumVersion));
        const recovery = await tx.get(root(input.groupId).collection('recoveryLocks').doc('current'));
        if (recovery.exists && recovery.data()?.keyVersion === group.keyVersion) refuse(409, 'recovery_active');
        const count = await meter(tx, actor.uid); count();
        if (!existing) {
          tx.update(root(input.groupId), { ...rosterCloudFields(next), updatedAt: FieldValue.serverTimestamp() });
          tx.create(root(input.groupId).collection('rosters').doc(String(next.body.revision)), { rosterJson: canonicalJson(next), createdAt: FieldValue.serverTimestamp() });
          const envelope = input.grant.body.keys.at(-1);
          tx.create(root(input.groupId).collection('keyEnvelopes').doc(`${next.body.keyVersion}_${envelope.recipientDeviceId}`),
            { userId: actor.uid, deviceId: envelope.recipientDeviceId, keyVersion: next.body.keyVersion, wrappedKeyJson: canonicalJson(envelope), createdAt: FieldValue.serverTimestamp() });
        }
        tx.update(ref, { status: 'accepted', grantJson: canonicalJson(input.grant), minimumKeyVersion: minimumVersion, acceptedAt: FieldValue.serverTimestamp() });
        publish(tx, actor.uid, input.groupId);
      });
      return { status: 'accepted' };
    },
    async acknowledge(actor, input) {
      exact(input, ['groupId', 'slot', 'requestId', 'grantDigest', 'signature']); identify(actor, input.groupId);
      input = JSON.parse(canonicalJson(input)); actor = { ...actor };
      if (!Number.isInteger(input.slot) || input.slot < 0 || input.slot >= ACCOUNT_DEVICE_RESTORE_SLOTS) refuse(400, 'invalid_slot');
      await firestore.runTransaction(async tx => {
        await scope(tx, actor, input.groupId);
        const ref = slots(input.groupId, actor.uid)[input.slot], raw = (await tx.get(ref)).data();
        const request = validRecord(raw, input.groupId, actor.uid);
        if (raw.requestId !== input.requestId) refuse(409, 'request_changed');
        if (raw.status === 'acknowledged' && raw.grantDigest === input.grantDigest) return;
        if (raw.status !== 'accepted' || sharedDocumentDigest(JSON.parse(raw.grantJson)) !== input.grantDigest) refuse(409, 'request_changed');
        checked(() => verifySharedDocument({ domain: 'liflow-account-device-ack-v1', groupId: input.groupId, userId: actor.uid,
          requestDigest: sharedDocumentDigest(request), grantDigest: input.grantDigest }, input.signature, request.body.identity));
        tx.update(ref, { status: 'acknowledged', grantDigest: input.grantDigest, grantJson: FieldValue.delete(), acceptedAt: FieldValue.delete(), minimumKeyVersion: FieldValue.delete() });
        publish(tx, actor.uid, input.groupId);
      });
      return { status: 'acknowledged' };
    },
  };
}
