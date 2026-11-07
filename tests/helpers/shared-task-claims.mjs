import './typescript-loader.mjs';
import { sharedTaskClaimKey, reserveSharedTaskClaim, linkSharedTaskClaim, releaseSharedTaskClaim, deleteSharedTaskClaim } from '../../src/features/google-sync/shared-task-claim.ts';
/** Unit-only transport. Actual transaction isolation and Rules are tested with Firestore separately. */
export function memoryTaskClaims(namespace) {
  const rows = new Map(); let tail = Promise.resolve(); const calls = [];
  const atomic = work => { const result = tail.then(work); tail = result.catch(() => {}); return result; };
  const key = identity => sharedTaskClaimKey(namespace, identity);
  const update = (identity, change) => atomic(() => { const k = key(identity); const value = change(rows.get(k.occurrenceHash) ?? null, k); if (value) rows.set(k.occurrenceHash, value); });
  return { rows, calls, cloud: {
    read: identity => atomic(() => structuredClone(rows.get(key(identity).occurrenceHash) ?? null)),
    reserveBatch: intents => atomic(() => { calls.push(['reserveBatch', intents.length]); return intents.map(intent => {
      const k = key(intent); const value = reserveSharedTaskClaim(rows.get(k.occurrenceHash) ?? null, k, intent);
      if (value) rows.set(k.occurrenceHash, value); return Boolean(value);
    }); }),
    reject: intent => update(intent, row => releaseSharedTaskClaim(row, { attemptId: intent.attemptId })),
    rejectBatch: intents => atomic(() => { for (const intent of intents) {
      const k = key(intent); const value = releaseSharedTaskClaim(rows.get(k.occurrenceHash) ?? null, { attemptId: intent.attemptId });
      if (value) rows.set(k.occurrenceHash, value);
    } }),
    linked: (identity, taskId, expectedAttemptId) => update(identity, (row, k) => linkSharedTaskClaim(row, k, taskId, expectedAttemptId)),
    deleted: (identity, taskId, attemptId) => update(identity, row => deleteSharedTaskClaim(row, taskId, attemptId)),
  } };
}
