import { doc, onSnapshot, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore';
import type { DocumentData, Firestore } from 'firebase/firestore';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import type { VerifiedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority.ts';
import { assertPrivateCalendarCloudAuthority, parsePrivateCalendarCloudHead } from '../../features/sharing/private-calendar/cloud-contract.ts';
import { exactRecord } from '../../features/sharing/private-calendar/validation.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { MAX_PRIVATE_PREFERENCE_ENVELOPE_CHARS, privatePreferenceCursor, samePrivatePreferenceCursor, snapshotEncryptedPrivatePreferences,
  verifyEncryptedPrivatePreferences, PrivatePreferenceCloudConflict, snapshotPrivatePreferenceCursor } from '../../features/sharing/private-planner/preference-crypto.ts';
import type { EncryptedPrivatePreferences } from '../../features/sharing/private-planner/preference-crypto.ts';
import type { PrivateDeliveryPort } from './private-delivery.ts';
import { sharingCloudWithDeadline } from './network-deadline.ts';

const fields = ['schemaVersion', 'ownerUserId', 'accountGeneration', 'rootDigest', 'authorityDigest', 'keyVersion', 'authorDeviceId',
  'revision', 'parentDigest', 'digest', 'encryptedJson', 'createdAt', 'updatedAt'];
function content(value: EncryptedPrivatePreferences) {
  const b = value.body; return { schemaVersion: 1, ownerUserId: b.ownerUserId, accountGeneration: b.accountGeneration, rootDigest: b.rootDigest,
    authorityDigest: b.authorityDigest, keyVersion: b.keyVersion, authorDeviceId: b.authorDeviceId, revision: b.revision,
    parentDigest: b.parent?.digest ?? null, digest: privatePreferenceCursor(value).digest, encryptedJson: canonicalJson(value) };
}
function decode(data: DocumentData): EncryptedPrivatePreferences {
  exactRecord(data, fields);
  if (!(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp) || typeof data.encryptedJson !== 'string'
    || data.encryptedJson.length > MAX_PRIVATE_PREFERENCE_ENVELOPE_CHARS) throw new Error('本人設定のサーバー受付を確認できません。');
  const own = snapshotEncryptedPrivatePreferences(JSON.parse(data.encryptedJson)); const expected = content(own);
  for (const [key, value] of Object.entries(expected)) if (data[key] !== value) throw new Error('本人設定の公開情報と暗号文が異なります。'); return own;
}
function erasedCursor(data: DocumentData) {
  exactRecord(data, [...fields, 'erasedAt']);
  if (data.encryptedJson !== null || !(data.erasedAt instanceof Timestamp) || !(data.createdAt instanceof Timestamp)
    || !(data.updatedAt instanceof Timestamp) || typeof data.revision !== 'number' || typeof data.digest !== 'string') throw new Error('Invalid private delivery erasure marker');
  return snapshotPrivatePreferenceCursor({ revision: data.revision, digest: data.digest });
}
/** One bounded encrypted snapshot per UID. A server arrival never resolves an offline edit conflict. */
export function createPrivatePlannerCloud(firestore: Firestore, ownerUserId: string, currentUserId: () => string | null, delivery?: PrivateDeliveryPort) {
  assertSharedIdentifier(ownerUserId); const root = doc(firestore, 'privateCalendars', ownerUserId); const reference = doc(root, 'plannerPreferences', 'current');
  const check = () => { if (currentUserId() !== ownerUserId) throw Object.assign(new Error('本人設定のアカウントが切り替わりました。'), { code: 'private-planner/access-denied' }); };
  function assertRoot(data: DocumentData | undefined, authority: VerifiedPrivateCalendarAuthority) {
    if (!data || authority.signed.body.ownerUserId !== ownerUserId || !(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)) throw new Error('本人端末の承認を確認してください。');
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...head } = data;
    assertPrivateCalendarCloudAuthority(parsePrivateCalendarCloudHead(head as unknown as Parameters<typeof parsePrivateCalendarCloudHead>[0], ownerUserId), authority);
  }
  const read = async (authority: VerifiedPrivateCalendarAuthority, assertBudget: () => void = () => {}) => {
    const guard = () => { check(); assertBudget(); };
    guard();
    const result = await runTransaction(firestore, async transaction => {
      guard(); const [head, saved] = await Promise.all([transaction.get(root), transaction.get(reference)]); guard(); assertRoot(head.data(), authority);
      return saved.exists() ? saved.data() : null;
    }); guard();
    const value = !result ? null : result.encryptedJson === null && delivery
      ? snapshotEncryptedPrivatePreferences(await delivery.recover(authority, `preferences.${erasedCursor(result).digest}`) as EncryptedPrivatePreferences)
      : decode(result);
      if (result && value && result.encryptedJson === null) {
        const expected = content(value); for (const [key, field] of Object.entries(expected)) if (key !== 'encryptedJson' && result[key] !== field) throw new Error('Private peer preferences differ from the committed header');
        const latest = await runTransaction(firestore, async transaction => {
          const [head, saved] = await Promise.all([transaction.get(root), transaction.get(reference)]); guard(); assertRoot(head.data(), authority);
          return saved.data()?.digest;
        }); guard(); if (latest !== result.digest) throw new PrivatePreferenceCloudConflict();
      }
      if (value && (value.body.ownerUserId !== ownerUserId || value.body.accountGeneration !== authority.anchor.accountGeneration
        || value.body.rootDigest !== authority.anchor.rootDigest || value.body.keyVersion > authority.signed.body.keyVersion)) throw new Error('本人設定の信頼・鍵世代を確認してください。');
    if (value && delivery && value.body.authorityDigest === authority.digest) {
      verifyEncryptedPrivatePreferences(value, authority); const digest = privatePreferenceCursor(value).digest;
      await delivery.remember(authority, `preferences.${digest}`, value); guard();
    }
    guard(); return value;
  };
  return sharingCloudWithDeadline({ read,
    confirmDelivery: delivery ? (authority: VerifiedPrivateCalendarAuthority, digest: string | null) => digest === null
      ? delivery.prepare(authority) : delivery.confirm(authority, 'preferences', digest) : undefined,
    async publish(authority: VerifiedPrivateCalendarAuthority, incoming: EncryptedPrivatePreferences, assertBudget: () => void = () => {}) {
      const guard = () => { check(); assertBudget(); };
      guard(); const own = verifyEncryptedPrivatePreferences(incoming, authority); const wanted = privatePreferenceCursor(own); const body = content(own);
      if (delivery) { await delivery.remember(authority, `preferences.${wanted.digest}`, own); guard(); }
      try {
        const result = await runTransaction(firestore, async transaction => {
          guard(); const [head, saved] = await Promise.all([transaction.get(root), transaction.get(reference)]); guard(); assertRoot(head.data(), authority);
          const previous = saved.exists() ? saved.data() : null;
          const cursor = previous ? previous.encryptedJson === null && delivery ? erasedCursor(previous) : privatePreferenceCursor(decode(previous)) : null;
          if (samePrivatePreferenceCursor(cursor, wanted)) return { published: false };
          if (!samePrivatePreferenceCursor(cursor, own.body.parent)) throw new PrivatePreferenceCloudConflict();
          transaction.set(reference, { ...body, createdAt: saved.exists() ? saved.data().createdAt : serverTimestamp(), updatedAt: serverTimestamp() });
          return { published: true };
        }); guard(); return result;
      } catch (error) {
        guard(); if (error instanceof PrivatePreferenceCloudConflict) throw error;
        // The server can have committed before a lost reply. Read the exact envelope, never reseal/rebase in a transaction retry.
        if (error && typeof error === 'object' && 'code' in error && ['aborted', 'failed-precondition', 'unavailable', 'deadline-exceeded', 'permission-denied'].includes(String(error.code))) {
          try { const saved = await read(authority, assertBudget); if (saved && samePrivatePreferenceCursor(privatePreferenceCursor(saved), wanted)) return { published: false }; }
          catch { guard(); }
        }
        throw error;
      }
    },
    watch(changed: () => void, failed: () => void) {
      check(); let last: string | null | undefined; let stopped = false;
      const unsubscribe = onSnapshot(reference, { includeMetadataChanges: true }, snapshot => {
        if (stopped) return;
        try {
          check(); if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
          const data = snapshot.data();
          const next = snapshot.exists() ? data!.encryptedJson === null && delivery ? erasedCursor(data!).digest : privatePreferenceCursor(decode(data!)).digest : null;
          if (next !== last) { last = next; changed(); }
        } catch { failed(); }
      }, () => { if (!stopped) failed(); });
      const stopDelivery = delivery?.watch(changed, failed);
      return () => { stopped = true; unsubscribe(); stopDelivery?.(); };
    },
  });
}
