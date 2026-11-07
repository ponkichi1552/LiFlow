import { doc, getDocFromServer, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore';
import type { DocumentData, DocumentSnapshot, Firestore, Transaction } from 'firebase/firestore';
import type { GoogleTaskCreateIdentity, GoogleTaskCreateIntent } from '../../features/google-sync/task-create-intent';
import { checkedSharedTaskClaim, deleteSharedTaskClaim, linkSharedTaskClaim, releaseSharedTaskClaim, reserveSharedTaskClaim, sharedTaskClaimKey } from '../../features/google-sync/shared-task-claim.ts';
import type { SharedTaskClaim, SharedTaskClaimCloud, SharedTaskClaimReader } from '../../features/google-sync/shared-task-claim';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';

/** Existing Firebase identity, owner-only atomic creation receipts; no Planner content or OAuth token. */
export function createSharedGoogleTaskClaims(input: { firestore: Firestore; userId: string; namespace: string;
  currentUserId(): string | null; assertCurrent(): Promise<void> }) : SharedTaskClaimCloud & SharedTaskClaimReader {
  assertSharedIdentifier(input.userId);
  const check = async () => {
    if (input.currentUserId() !== input.userId) throw new Error('Google家事を送信する本人アカウントが変わりました。');
    await input.assertCurrent();
    if (input.currentUserId() !== input.userId) throw new Error('Google家事を送信する本人アカウントが変わりました。');
  };
  const key = (identity: GoogleTaskCreateIdentity) => sharedTaskClaimKey(input.namespace, identity);
  const reference = (identity: GoogleTaskCreateIdentity) => doc(input.firestore, 'privateGoogleTaskClaims', input.userId, 'occurrences', key(identity).occurrenceHash);
  function body(snapshot: DocumentSnapshot<DocumentData>, identity: GoogleTaskCreateIdentity): SharedTaskClaim | null {
    if (!snapshot.exists()) return null; const data = snapshot.data();
    if (!(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)) throw new Error('Google家事のサーバー受付を確認してください。');
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = data; return checkedSharedTaskClaim(value, key(identity));
  }
  function write(transaction: Transaction, before: DocumentSnapshot<DocumentData>, next: SharedTaskClaim) {
    transaction.set(before.ref, { ...next, createdAt: before.exists() ? before.data()!.createdAt : serverTimestamp(), updatedAt: serverTimestamp() });
  }
  async function update(identity: GoogleTaskCreateIdentity, change: (row: SharedTaskClaim | null) => SharedTaskClaim | null) {
    await check();
    await runTransaction(input.firestore, async transaction => {
      await check(); const before = await transaction.get(reference(identity)); await check();
      const next = change(body(before, identity)); if (next) write(transaction, before, next);
    }, { maxAttempts: 3 });
    await check();
  }
  const rejectBatch = async (requests: readonly GoogleTaskCreateIntent[]) => {
    const intents = requests.map(intent => ({ ...intent }));
    if (!intents.length || intents.length > 100) throw new Error('Google家事は100件以内に分けて送信してください。');
    const refs = intents.map(reference); if (new Set(refs.map(ref => ref.path)).size !== refs.length) throw new Error('同じGoogle家事の作成記録が重複しています。');
    await check();
    await runTransaction(input.firestore, async transaction => {
      await check(); const before = await Promise.all(refs.map(ref => transaction.get(ref))); await check();
      for (const [index, snapshot] of before.entries()) {
        const intent = intents[index]; const next = releaseSharedTaskClaim(body(snapshot, intent), { attemptId: intent.attemptId });
        if (next) write(transaction, snapshot, next);
      }
    }, { maxAttempts: 3 });
    await check();
  };
  return {
    async read(identity) {
      const captured = { ...identity }; await check();
      const snapshot = await getDocFromServer(reference(captured)); await check();
      return body(snapshot, captured);
    },
    async reserveBatch(requests) {
      const intents = requests.map(intent => ({ ...intent }));
      if (!intents.length || intents.length > 100) throw new Error('Google家事は100件以内に分けて送信してください。');
      const refs = intents.map(reference);
      if (new Set(refs.map(ref => ref.path)).size !== refs.length) throw new Error('同じGoogle家事を一度に作成できません。');
      await check();
      const accepted = await runTransaction(input.firestore, async transaction => {
        await check(); const before = await Promise.all(refs.map(ref => transaction.get(ref))); await check();
        return before.map((snapshot, index) => {
          const intent = intents[index]; const next = reserveSharedTaskClaim(body(snapshot, intent), key(intent), intent);
          if (next) write(transaction, snapshot, next); return Boolean(next);
        });
      }, { maxAttempts: 3 });
      await check(); return accepted;
    },
    reject: intent => rejectBatch([intent]), rejectBatch,
    linked: (identity, taskId, expectedAttemptId) => { const captured = { ...identity }; return update(captured, row => linkSharedTaskClaim(row, key(captured), taskId, expectedAttemptId)); },
    deleted: (identity, taskId, attemptId) => update({ ...identity }, row => deleteSharedTaskClaim(row, taskId, attemptId)),
  };
}
