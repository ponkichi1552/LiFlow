import { doc, getDocFromServer, onSnapshot, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore';
import type { DocumentData, Firestore } from 'firebase/firestore';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { exactRecord, hexBytes } from '../../features/sharing/private-calendar/validation.ts';
import { snapshotConnectionGrant } from '../../features/sharing/private-calendar/connection-code.ts';
import type { PrivateCalendarConnectionClaim, PrivateCalendarConnectionGrant, PrivateCalendarConnectionRecord } from '../../features/sharing/private-calendar/connection-code.ts';
import { verifyPrivateCalendarPairingRequest } from '../../features/sharing/private-calendar/pairing.ts';
import { sharingCloudWithDeadline } from './network-deadline.ts';

/** Only public signed grants and possession proofs reach Firestore. The bearer secret stays off the server. */
export function createPrivateCalendarConnectionCloud(firestore: Firestore, userId: string, currentUserId: () => string | null) {
  assertSharedIdentifier(userId);
  const check = () => { if (currentUserId() !== userId) throw new Error('接続するアカウントが変わりました。'); };
  const ref = (id: string) => { hexBytes(id, 32); return doc(firestore, 'privateCalendars', userId, 'connectionCodes', id); };
  function parse(data: DocumentData | undefined, id: string): PrivateCalendarConnectionRecord {
    exactRecord(data, ['schemaVersion', 'issuerDeviceId', 'authorityDigest', 'grantJson', 'expiresAt', 'state', 'requestJson', 'proof', 'claimedAt', 'createdAt', 'updatedAt']);
    if (data.schemaVersion !== 1 || !(data.expiresAt instanceof Timestamp) || !(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)
      || typeof data.grantJson !== 'string' || data.grantJson.length > 4000 || typeof data.state !== 'string' || !['open', 'claimed', 'complete'].includes(data.state)) throw new Error('接続コードの受付を確認できません。');
    const grant = snapshotConnectionGrant(JSON.parse(data.grantJson)); const body = grant.body;
    if (body.codeId !== id || body.reference.anchor.ownerUserId !== userId || data.issuerDeviceId !== body.issuerDeviceId
      || data.authorityDigest !== body.reference.authorityDigest || data.expiresAt.toMillis() !== body.expiresAt) throw new Error('接続コードの発行元が異なります。');
    if (data.state === 'open') {
      if (data.requestJson !== null || data.proof !== null || data.claimedAt !== null) throw new Error('接続コードの受付が異なります。');
      return { grant, state: 'open', claim: null };
    }
    if (!(data.claimedAt instanceof Timestamp) || data.claimedAt.toMillis() > body.expiresAt || typeof data.requestJson !== 'string'
      || data.requestJson.length > 4000) throw new Error('接続コードの受付を確認できません。');
    hexBytes(data.proof, 32);
    return { grant, state: data.state as 'claimed' | 'complete', claim: { request: verifyPrivateCalendarPairingRequest(JSON.parse(data.requestJson)), proof: data.proof as string } };
  }
  function matches(record: PrivateCalendarConnectionRecord, grant: PrivateCalendarConnectionGrant) {
    if (canonicalJson(record.grant) !== canonicalJson(grant)) throw new Error('接続コードが更新されています。新しいコードを受け取ってください。');
  }
  async function read(id: string, assertBudget: () => void = () => {}) { assertBudget(); check(); const value = await getDocFromServer(ref(id)); check(); return value.exists() ? parse(value.data(), id) : null; }
  return sharingCloudWithDeadline({
    read,
    async create(incoming: PrivateCalendarConnectionGrant, assertBudget: () => void = () => {}) {
      assertBudget();
      check(); const grant = snapshotConnectionGrant(incoming), b = grant.body;
      if (b.reference.anchor.ownerUserId !== userId) throw new Error('接続コードのアカウントが異なります。');
      await runTransaction(firestore, async transaction => {
        assertBudget(); check(); const target = ref(b.codeId), previous = await transaction.get(target); check(); assertBudget();
        if (previous.exists()) { const record = parse(previous.data(), b.codeId); matches(record, grant); return; }
        transaction.set(target, { schemaVersion: 1, issuerDeviceId: b.issuerDeviceId, authorityDigest: b.reference.authorityDigest,
          grantJson: canonicalJson(grant), expiresAt: Timestamp.fromMillis(b.expiresAt), state: 'open', requestJson: null, proof: null, claimedAt: null,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }); check();
    },
    async claim(incoming: PrivateCalendarConnectionGrant, value: PrivateCalendarConnectionClaim, assertBudget: () => void = () => {}) {
      assertBudget();
      check(); const grant = snapshotConnectionGrant(incoming), claim = { request: verifyPrivateCalendarPairingRequest(value.request), proof: value.proof }; hexBytes(claim.proof, 32);
      return runTransaction(firestore, async transaction => {
        assertBudget(); check(); const target = ref(grant.body.codeId), previous = await transaction.get(target); check(); assertBudget();
        if (!previous.exists()) throw new Error('接続コードが見つかりません。');
        const record = parse(previous.data(), grant.body.codeId); matches(record, grant);
        if (record.state !== 'open') {
          if (canonicalJson(record.claim) !== canonicalJson(claim)) throw new Error('この接続コードは使用済みです。');
          return record;
        }
        transaction.update(target, { state: 'claimed', requestJson: canonicalJson(claim.request), proof: claim.proof, claimedAt: serverTimestamp(), updatedAt: serverTimestamp() });
        return { grant, state: 'claimed' as const, claim };
      }).then(value => { check(); return value; });
    },
    async complete(grant: PrivateCalendarConnectionGrant, requestDigest: string, assertBudget: () => void = () => {}) {
      assertBudget();
      check(); hexBytes(requestDigest, 32);
      await runTransaction(firestore, async transaction => {
        assertBudget(); check(); const target = ref(grant.body.codeId), previous = await transaction.get(target); check(); assertBudget();
        if (!previous.exists()) throw new Error('接続コードの受付がありません。');
        const record = parse(previous.data(), grant.body.codeId); matches(record, grant);
        if (!record.claim || sharedDocumentDigest(record.claim.request) !== requestDigest) throw new Error('接続する端末が変わっています。');
        if (record.state !== 'complete') transaction.update(target, { state: 'complete', updatedAt: serverTimestamp() });
      }); check();
    },
    watch(id: string, changed: () => void, failed: () => void) {
      check(); return onSnapshot(ref(id), snapshot => {
        if (currentUserId() !== userId || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
        changed();
      }, () => { if (currentUserId() === userId) failed(); });
    },
  });
}
