import { collection, doc, getDocFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, Timestamp, where } from 'firebase/firestore';
import type { DocumentData, DocumentReference, Firestore } from 'firebase/firestore';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import type { VerifiedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority.ts';
import { verifyPrivateCalendarAuthorityUpdate, verifyPrivateCalendarRoot } from '../../features/sharing/private-calendar/authority.ts';
import { assertPrivateCalendarCloudAuthority, parsePrivateCalendarCloudAuthority, parsePrivateCalendarCloudHead, privateCalendarCloudFields,
  PRIVATE_CALENDAR_CLOUD_HEAD_FIELDS, PrivateCalendarCloudConflict } from '../../features/sharing/private-calendar/cloud-contract.ts';
import type { PrivateCalendarCloudHead } from '../../features/sharing/private-calendar/cloud-contract.ts';
import type { WrappedPrivateCalendarKey } from '../../features/sharing/private-calendar/key-envelope.ts';
import { verifyPrivateCalendarWrappedKey } from '../../features/sharing/private-calendar/key-envelope.ts';
import type { EncryptedPrivateCalendarCache, PrivateCalendarCacheChunk } from '../../features/sharing/private-calendar/cache-crypto.ts';
import { snapshotPrivateCalendarCacheManifest, verifyPrivateCalendarCacheCiphertext } from '../../features/sharing/private-calendar/cache-crypto.ts';
import type { PrivateCalendarCryptoGateway } from '../../features/sharing/private-calendar/crypto-gateway.ts';
import { exactRecord } from '../../features/sharing/private-calendar/validation.ts';
import { sharingCloudWithDeadline } from './network-deadline.ts';

function bodyWithoutServerTime(data: DocumentData | undefined, fields: readonly string[], updated = false): Record<string, unknown> {
  exactRecord(data, [...fields, 'createdAt', ...(updated ? ['updatedAt'] : [])]);
  if (!(data.createdAt instanceof Timestamp) || updated && !(data.updatedAt instanceof Timestamp)) throw new Error('本人用Calendarのサーバー受付を確認できません。');
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...body } = data; return body;
}
function headFromDocument(data: DocumentData | undefined, userId: string): PrivateCalendarCloudHead {
  return parsePrivateCalendarCloudHead(bodyWithoutServerTime(data, PRIVATE_CALENDAR_CLOUD_HEAD_FIELDS, true) as unknown as PrivateCalendarCloudHead, userId);
}
const keyId = (authority: VerifiedPrivateCalendarAuthority, deviceId: string) => `${authority.digest}_${deviceId}`;

/** UID-only transport. Cloud metadata never establishes the caller's trust anchor or approves a device. */
export function createPrivateCalendarCloud(firestore: Firestore, userId: string, currentUserId: () => string | null, crypto: PrivateCalendarCryptoGateway) {
  assertSharedIdentifier(userId); const reference = doc(firestore, 'privateCalendars', userId);
  const checkAccount = () => {
    if (currentUserId() !== userId) throw Object.assign(new Error('本人用Calendarのアカウントが切り替わりました。'), { code: 'private-calendar/access-denied' });
  };
  const authorityForUser = (authority: VerifiedPrivateCalendarAuthority) => {
    checkAccount(); if (authority.signed.body.ownerUserId !== userId) throw new Error('本人用Calendarの所有アカウントが異なります。');
  };
  async function serverRead(ref: DocumentReference) { checkAccount(); const result = await getDocFromServer(ref); checkAccount(); return result; }
  async function recoverImmutable<T>(write: () => Promise<T>, recover: () => Promise<T | null>): Promise<T> {
    try { return await write(); }
    catch (error) {
      checkAccount();
      if (!error || typeof error !== 'object' || !('code' in error) || !['permission-denied', 'aborted', 'failed-precondition', 'unavailable', 'deadline-exceeded'].includes(String(error.code))) throw error;
      try { const accepted = await recover(); checkAccount(); if (accepted !== null) return accepted; }
      catch (recoveryError) { checkAccount(); if (recoveryError instanceof PrivateCalendarCloudConflict) throw recoveryError; }
      throw error;
    }
  }
  const readHead = async () => {
    const result = await serverRead(reference); return result.exists() ? headFromDocument(result.data(), userId) : null;
  };
  function authorityFromDocument(data: DocumentData | undefined, revision: number) {
    const row = bodyWithoutServerTime(data, ['schemaVersion', 'revision', 'authorityDigest', 'authorityJson']);
    const signed = parsePrivateCalendarCloudAuthority(row.authorityJson as string);
    if (row.schemaVersion !== 1 || row.revision !== revision || signed.body.revision !== revision || signed.body.ownerUserId !== userId
      || sharedDocumentDigest(signed) !== row.authorityDigest) throw new Error('本人端末の認証履歴が欠けているか異なります。'); return signed;
  }
  function parseKey(data: DocumentData | undefined, authority: VerifiedPrivateCalendarAuthority, recipient: string) {
    const row = bodyWithoutServerTime(data, ['schemaVersion', 'authorityDigest', 'recipientDeviceId', 'wrappedKeyJson']);
    if (row.schemaVersion !== 1 || row.authorityDigest !== authority.digest || row.recipientDeviceId !== recipient
      || typeof row.wrappedKeyJson !== 'string' || row.wrappedKeyJson.length > 8_000) throw new Error('本人用Calendarの鍵配布を確認できません。');
    return verifyPrivateCalendarWrappedKey(JSON.parse(row.wrappedKeyJson), authority, recipient);
  }
  function parseManifest(data: DocumentData | undefined, authority: VerifiedPrivateCalendarAuthority, expected: NonNullable<PrivateCalendarCloudHead['cacheHead']>) {
    const row = bodyWithoutServerTime(data, ['schemaVersion', 'authorityDigest', 'sequence', 'chunkCount', 'manifestDigest', 'manifestJson']);
    if (row.schemaVersion !== 1 || row.authorityDigest !== authority.digest || row.sequence !== expected.sequence || row.chunkCount !== expected.chunkCount
      || row.manifestDigest !== expected.manifestDigest || typeof row.manifestJson !== 'string' || row.manifestJson.length > 16_000) throw new Error('本人用Calendarの分割manifestを確認できません。');
    const manifest = snapshotPrivateCalendarCacheManifest(JSON.parse(row.manifestJson), authority);
    if (manifest.body.cacheId !== expected.cacheId || manifest.body.sequence !== expected.sequence || manifest.body.chunkCount !== expected.chunkCount
      || sharedDocumentDigest(manifest) !== expected.manifestDigest) throw new Error('本人用Calendarの署名と送信位置が異なります。'); return manifest;
  }
  function parsePart(data: DocumentData | undefined, id: string): PrivateCalendarCacheChunk {
    const row = bodyWithoutServerTime(data, ['schemaVersion', 'index', 'partJson']);
    if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.index) || (row.index as number) < 0 || (row.index as number) > 31 || id !== String(row.index)
      || typeof row.partJson !== 'string' || row.partJson.length > 140_000) throw new Error('本人用Calendarの分割情報を確認できません。');
    const part = JSON.parse(row.partJson); exactRecord(part, ['index', 'salt', 'nonce', 'encryptedPayload']);
    if (part.index !== row.index) throw new Error('本人用Calendarの分割位置が異なります。'); return part as unknown as PrivateCalendarCacheChunk;
  }
  return sharingCloudWithDeadline({
    readHead,
    async createRoot(authority: VerifiedPrivateCalendarAuthority) {
      authorityForUser(authority); authority = verifyPrivateCalendarRoot(authority.signed, authority.anchor);
      const fields = privateCalendarCloudFields(authority); const archive = doc(reference, 'authorities', '1');
      const result = await recoverImmutable(() => runTransaction(firestore, async (transaction) => {
        checkAccount(); const existing = await transaction.get(reference); checkAccount();
        if (existing.exists()) {
          const current = headFromDocument(existing.data(), userId);
          if (current.rootDigest !== authority.anchor.rootDigest || current.accountGeneration !== authority.anchor.accountGeneration) throw new PrivateCalendarCloudConflict();
          const accepted = await transaction.get(archive); checkAccount();
          if (!accepted.exists() || canonicalJson(authorityFromDocument(accepted.data(), 1)) !== fields.authorityJson) throw new PrivateCalendarCloudConflict();
          return { created: false, head: current };
        }
        const orphan = await transaction.get(archive); checkAccount(); if (orphan.exists()) throw new PrivateCalendarCloudConflict();
        transaction.set(reference, { ...fields, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        transaction.set(archive, { schemaVersion: 1, revision: 1, authorityDigest: authority.digest, authorityJson: fields.authorityJson, createdAt: serverTimestamp() });
        return { created: true, head: fields };
      }), async () => {
        const current = await readHead(); if (!current) return null;
        if (current.rootDigest !== authority.anchor.rootDigest || current.accountGeneration !== authority.anchor.accountGeneration) throw new PrivateCalendarCloudConflict();
        const accepted = await serverRead(archive);
        return accepted.exists() && canonicalJson(authorityFromDocument(accepted.data(), 1)) === fields.authorityJson ? { created: false, head: current } : null;
      });
      checkAccount(); return result;
    },
    async authorityPage(afterRevision: number) {
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new Error('本人用Calendarの取得位置が無効です。');
      const head = await readHead(); if (!head) return null;
      if (afterRevision > head.authorityRevision) throw new PrivateCalendarCloudConflict();
      checkAccount(); const page = await getDocsFromServer(query(collection(reference, 'authorities'), where('revision', '>', afterRevision),
        where('revision', '<=', head.authorityRevision), orderBy('revision'), limit(100))); checkAccount();
      const authorities = page.docs.map((entry, index) => {
        const revision = afterRevision + index + 1; const signed = authorityFromDocument(entry.data(), revision);
        if (entry.id !== String(revision) || signed.body.accountGeneration !== head.accountGeneration) throw new Error('本人端末の認証履歴が欠けているか異なります。');
        return signed;
      });
      if (afterRevision < head.authorityRevision && !authorities.length) throw new Error('本人端末の認証履歴を取得できません。');
      return { head, authorities };
    },
    async commitAuthority(before: VerifiedPrivateCalendarAuthority, next: VerifiedPrivateCalendarAuthority) {
      authorityForUser(before); next = verifyPrivateCalendarAuthorityUpdate(before, next.signed);
      const fields = privateCalendarCloudFields(next); const archive = doc(reference, 'authorities', String(next.signed.body.revision));
      const result = await recoverImmutable(() => runTransaction(firestore, async (transaction) => {
        checkAccount(); let [currentDoc, accepted] = await Promise.all([transaction.get(reference), transaction.get(archive)]); checkAccount();
        if (!currentDoc.exists()) throw new PrivateCalendarCloudConflict(); let current = headFromDocument(currentDoc.data(), userId);
        // The Web SDK verifies read versions at commit. Separate reads can straddle
        // another client's atomic commit; throwing our own conflict first would
        // bypass that verification and its bounded retry. Re-read the older side
        // so the SDK detects a changed version before we judge the signed pair.
        if (accepted.exists() && current.authorityRevision < next.signed.body.revision) {
          currentDoc = await transaction.get(reference); checkAccount();
          if (!currentDoc.exists()) throw new PrivateCalendarCloudConflict(); current = headFromDocument(currentDoc.data(), userId);
        } else if (!accepted.exists() && current.authorityRevision >= next.signed.body.revision) {
          accepted = await transaction.get(archive); checkAccount();
        }
        if (accepted.exists()) {
          if (current.rootDigest !== before.anchor.rootDigest || canonicalJson(authorityFromDocument(accepted.data(), next.signed.body.revision)) !== fields.authorityJson
            || current.authorityRevision < next.signed.body.revision) throw new PrivateCalendarCloudConflict();
          return { accepted: true, head: current };
        }
        assertPrivateCalendarCloudAuthority(current, before);
        const oldKeys = await Promise.all(before.signed.body.devices.map((device) => transaction.get(doc(reference, 'keyEnvelopes', keyId(before, device.deviceId))))); checkAccount();
        transaction.update(reference, { ...fields, cacheHead: current.cacheHead, updatedAt: serverTimestamp() });
        transaction.set(archive, { schemaVersion: 1, revision: next.signed.body.revision, authorityDigest: next.digest, authorityJson: fields.authorityJson, createdAt: serverTimestamp() });
        // Only obsolete wrapped transport copies are retired; never delete protected device keys or authority history.
        for (const key of oldKeys) if (key.exists()) transaction.delete(key.ref);
        return { accepted: true, head: { ...fields, cacheHead: current.cacheHead } };
      }), async () => {
        const current = await readHead(); if (!current) return null;
        if (current.rootDigest !== before.anchor.rootDigest || current.accountGeneration !== before.anchor.accountGeneration) throw new PrivateCalendarCloudConflict();
        const accepted = await serverRead(archive);
        if (accepted.exists() && canonicalJson(authorityFromDocument(accepted.data(), next.signed.body.revision)) === fields.authorityJson
          && current.authorityRevision >= next.signed.body.revision) return { accepted: true, head: current };
        assertPrivateCalendarCloudAuthority(current, before); return null;
      });
      checkAccount(); return result;
    },
    async sendKey(authority: VerifiedPrivateCalendarAuthority, incoming: WrappedPrivateCalendarKey) {
      authorityForUser(authority); const wrapped = verifyPrivateCalendarWrappedKey(incoming, authority, incoming.body.recipientDeviceId);
      const json = canonicalJson(wrapped); const key = doc(reference, 'keyEnvelopes', keyId(authority, wrapped.body.recipientDeviceId));
      await recoverImmutable(() => runTransaction(firestore, async (transaction) => {
        checkAccount(); const [current, previous] = await Promise.all([transaction.get(reference), transaction.get(key)]); checkAccount();
        if (!current.exists()) throw new PrivateCalendarCloudConflict(); assertPrivateCalendarCloudAuthority(headFromDocument(current.data(), userId), authority);
        if (previous.exists()) {
          if (canonicalJson(parseKey(previous.data(), authority, wrapped.body.recipientDeviceId)) !== json) throw new PrivateCalendarCloudConflict(); return;
        }
        transaction.set(key, { schemaVersion: 1, authorityDigest: authority.digest, recipientDeviceId: wrapped.body.recipientDeviceId, wrappedKeyJson: json, createdAt: serverTimestamp() });
      }), async () => {
        const current = await readHead(); if (!current) return null; assertPrivateCalendarCloudAuthority(current, authority);
        const accepted = await serverRead(key); if (!accepted.exists()) return null;
        if (canonicalJson(parseKey(accepted.data(), authority, wrapped.body.recipientDeviceId)) !== json) throw new PrivateCalendarCloudConflict();
        return undefined;
      });
      checkAccount();
    },
    async readKey(authority: VerifiedPrivateCalendarAuthority, deviceId: string) {
      authorityForUser(authority); assertSharedIdentifier(deviceId);
      if (!authority.signed.body.devices.some((device) => device.deviceId === deviceId)) throw new Error('未承認の本人端末です。');
      const current = await readHead(); if (!current) throw new PrivateCalendarCloudConflict(); assertPrivateCalendarCloudAuthority(current, authority);
      const key = await serverRead(doc(reference, 'keyEnvelopes', keyId(authority, deviceId)));
      const after = await readHead(); if (!after) throw new PrivateCalendarCloudConflict(); assertPrivateCalendarCloudAuthority(after, authority);
      return key.exists() ? parseKey(key.data(), authority, deviceId) : null;
    },
    async uploadCache(authority: VerifiedPrivateCalendarAuthority, incoming: EncryptedPrivateCalendarCache) {
      authorityForUser(authority);
      const owned = await verifyPrivateCalendarCacheCiphertext(crypto, incoming, authority); checkAccount();
      const manifestJson = canonicalJson(owned.manifest); const digest = sharedDocumentDigest(owned.manifest);
      const head = { cacheId: owned.manifest.body.cacheId, manifestDigest: digest, authorityDigest: authority.digest,
        sequence: owned.manifest.body.sequence, chunkCount: owned.manifest.body.chunkCount };
      const cacheRef = doc(reference, 'caches', head.cacheId);
      const prepared = owned.chunks.map((part) => ({ reference: doc(cacheRef, 'parts', String(part.index)), part, json: canonicalJson(part) }));
      let attemptedCacheHead: string | undefined;
      const publish = () => runTransaction(firestore, async (transaction) => {
        checkAccount(); const [currentDoc, target] = await Promise.all([transaction.get(reference), transaction.get(cacheRef)]); checkAccount();
        if (!currentDoc.exists()) throw new PrivateCalendarCloudConflict(); const current = headFromDocument(currentDoc.data(), userId);
        assertPrivateCalendarCloudAuthority(current, authority);
        attemptedCacheHead = canonicalJson(current.cacheHead);
        if (current.cacheHead?.cacheId === head.cacheId) {
          if (!target.exists() || canonicalJson(current.cacheHead) !== canonicalJson(head)) throw new PrivateCalendarCloudConflict();
          parseManifest(target.data(), authority, head);
          const pieces = await Promise.all(prepared.map((part) => transaction.get(part.reference))); checkAccount();
          if (pieces.some((piece, index) => !piece.exists() || canonicalJson(parsePart(piece.data(), piece.id)) !== prepared[index].json)) throw new Error('送信済みのCalendarが欠けているか異なります。');
          return { published: false, head };
        }
        if (target.exists() || current.cacheHead?.authorityDigest === authority.digest && current.cacheHead.sequence >= head.sequence) throw new PrivateCalendarCloudConflict();
        // Max 32 new parts + manifest + root + 32 old parts + old manifest = 67 writes, below the app's 100-write bound.
        transaction.set(cacheRef, { schemaVersion: 1, authorityDigest: authority.digest, sequence: head.sequence,
          chunkCount: head.chunkCount, manifestDigest: digest, manifestJson, createdAt: serverTimestamp() });
        for (const part of prepared) transaction.set(part.reference, { schemaVersion: 1, index: part.part.index, partJson: part.json, createdAt: serverTimestamp() });
        transaction.update(reference, { cacheHead: head, updatedAt: serverTimestamp() });
        if (current.cacheHead) {
          const old = doc(reference, 'caches', current.cacheHead.cacheId);
          for (let index = 0; index < current.cacheHead.chunkCount; index++) transaction.delete(doc(old, 'parts', String(index)));
          transaction.delete(old);
        }
        return { published: true, head };
      });
      for (let retry = 0; ; retry++) {
        try { const result = await publish(); checkAccount(); return result; }
        catch (error) {
          checkAccount();
          if (!error || typeof error !== 'object' || !('code' in error) || !['permission-denied', 'aborted', 'failed-precondition', 'unavailable', 'deadline-exceeded'].includes(String(error.code))) throw error;
          let latest: PrivateCalendarCloudHead | null;
          try { latest = await readHead(); } catch { checkAccount(); throw error; }
          if (!latest) throw error; assertPrivateCalendarCloudAuthority(latest, authority);
          if (latest.cacheHead?.cacheId === head.cacheId && latest.cacheHead.manifestDigest === digest) {
            // Rules can reject a concurrent create as an update before SDK precondition retries.
            // Recover only by rechecking every exact stored part in the read-only idempotent branch.
            const recovered = await publish(); checkAccount(); return recovered;
          }
          if (latest.cacheHead?.authorityDigest === authority.digest && latest.cacheHead.sequence >= head.sequence) throw new PrivateCalendarCloudConflict();
          // A newer root can also change which old parts this atomic publication must retire.
          // Retry that specific race with the exact prepared envelope, never new randomness or a new sequence.
          if (retry >= 2 || attemptedCacheHead === undefined || canonicalJson(latest.cacheHead) === attemptedCacheHead) throw error;
        }
      }
    },
    async readCache(authority: VerifiedPrivateCalendarAuthority) {
      authorityForUser(authority); const current = await readHead(); if (!current) throw new PrivateCalendarCloudConflict();
      assertPrivateCalendarCloudAuthority(current, authority);
      if (!current.cacheHead || current.cacheHead.authorityDigest !== authority.digest) return null;
      const cacheRef = doc(reference, 'caches', current.cacheHead.cacheId); const manifestDoc = await serverRead(cacheRef);
      if (!manifestDoc.exists()) throw new Error('本人用Calendarの取得が完了していません。');
      const manifest = parseManifest(manifestDoc.data(), authority, current.cacheHead);
      checkAccount(); const page = await getDocsFromServer(query(collection(cacheRef, 'parts'), orderBy('index'), limit(33))); checkAccount();
      if (page.size !== manifest.body.chunkCount) throw new Error('本人用Calendarの分割が揃っていません。');
      const chunks = page.docs.map((entry) => parsePart(entry.data(), entry.id));
      const verified = await verifyPrivateCalendarCacheCiphertext(crypto, { manifest, chunks }, authority); checkAccount();
      const after = await readHead(); if (!after) throw new PrivateCalendarCloudConflict(); assertPrivateCalendarCloudAuthority(after, authority);
      if (after.cacheHead?.manifestDigest !== current.cacheHead.manifestDigest || after.cacheHead.cacheId !== current.cacheHead.cacheId) throw new PrivateCalendarCloudConflict();
      return verified;
    },
    watch(onChange: () => void, onError: () => void) {
      checkAccount(); return onSnapshot(reference, { includeMetadataChanges: true }, (snapshot) => {
        if (currentUserId() !== userId || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return; onChange();
      }, () => { if (currentUserId() === userId) onError(); });
    },
  });
}
