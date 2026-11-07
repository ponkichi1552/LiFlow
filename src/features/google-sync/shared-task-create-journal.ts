import type { GoogleTaskCreateIdentity, GoogleTaskCreateIntent, GoogleTaskCreateJournal } from './task-create-intent';
import type { SharedTaskClaimCloud } from './shared-task-claim';
import { withinGoogleOperationBudget } from './operation-budget.ts';
import type { GoogleOperationBudget } from './operation-budget';

/** Global grant before POST; an uncertain grant is held, never opened by a lease timeout. */
export function sharedTaskCreateJournal(local: GoogleTaskCreateJournal, cloud: SharedTaskClaimCloud,
  context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> }): GoogleTaskCreateJournal {
  const bounded = <T>(work: () => Promise<T>) => withinGoogleOperationBudget(context.budget, async () => {
    await context.assertCurrent(); const value = await work(); await context.assertCurrent(); return value;
  });
  const storage = async <T>(work: () => Promise<T>): Promise<T> => {
    await bounded(async () => undefined);
    // Native SQL cannot be cancelled by racing a promise. Keep its serialized
    // caller until commit/rollback, then enforce the remaining network budget.
    const value = await work(); await bounded(async () => undefined); return value;
  };
  const rejectLocal = async (intents: readonly GoogleTaskCreateIntent[]) => {
    if (local.rejectBatch) await local.rejectBatch(intents); else for (const intent of intents) await local.reject(intent);
  };
  const reserveBatch = async (identities: readonly GoogleTaskCreateIdentity[]) => {
    if (!identities.length || identities.length > 100) throw new Error('Google家事は100件以内に分けて送信してください。');
    const intents: (GoogleTaskCreateIntent | null)[] = [];
    try {
      await storage(async () => {
        if (local.reserveBatch) intents.push(...await local.reserveBatch(identities, context.budget.assert));
        else for (const identity of identities) intents.push(await local.reserve(identity));
      });
    } catch (error) {
      // Cloud and provider requests have not begun, even if the local read outlived its budget.
      const known = intents.filter((intent): intent is GoogleTaskCreateIntent => intent !== null);
      if (known.length) await rejectLocal(known).catch(() => undefined);
      throw error;
    }
    if (intents.length !== identities.length) throw new Error('Google家事の作成記録を確認してください。');
    const ready = intents.filter((intent): intent is GoogleTaskCreateIntent => intent !== null);
    if (!ready.length) return intents;
    let accepted: readonly boolean[]; let cloudStarted = false;
    try { accepted = await bounded(() => { cloudStarted = true; return cloud.reserveBatch(ready); }); }
    catch (error) {
      // These explicit authorization/input rejections cannot have committed a grant.
      // A timeout, lost response, or unavailable transport is deliberately excluded.
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (!cloudStarted || ['permission-denied', 'unauthenticated', 'invalid-argument'].includes(code)) {
        await rejectLocal(ready);
      }
      throw error;
    }
    if (accepted.length !== ready.length || accepted.some(value => typeof value !== 'boolean')) throw new Error('Google家事の作成許可を確認してください。');
    let position = 0;
    const result: (GoogleTaskCreateIntent | null)[] = []; const unused: GoogleTaskCreateIntent[] = [];
    for (const intent of intents) {
      if (!intent) { result.push(null); continue; }
      if (accepted[position++]) result.push(intent);
      else { unused.push(intent); result.push(null); }
    }
    if (unused.length) await storage(() => rejectLocal(unused));
    return result;
  };
  const rejectBatch = async (intents: readonly GoogleTaskCreateIntent[]) => {
    await bounded(() => cloud.rejectBatch(intents));
    await storage(() => rejectLocal(intents));
  };
  return {
    ...(local.read ? { read: (identity: GoogleTaskCreateIdentity) => storage(() => local.read!(identity)) } : {}),
    ...(local.received ? { received: (results: Parameters<NonNullable<GoogleTaskCreateJournal['received']>>[0]) => storage(() => local.received!(results)) } : {}),
    ...(local.pending ? { pending: (scope: { accountSubject: string; taskListId: string }) => storage(() => local.pending!(scope)) } : {}),
    ...(local.settled ? { settled: (results: Parameters<NonNullable<GoogleTaskCreateJournal['settled']>>[0]) => storage(() => local.settled!(results)) } : {}),
    reserve: async identity => (await reserveBatch([identity]))[0], reserveBatch,
    reject: intent => rejectBatch([intent]), rejectBatch,
    async linked(identity, taskId, intent) {
      const stored = await storage(async () => local.read?.(identity));
      const proof = intent ?? (stored?.taskId === taskId && stored.intent.attemptId !== 'observed' ? stored.intent : undefined);
      if (!proof) {
        // Inventory adoption cannot borrow an unrelated outstanding attempt.
        // Check Cloud before writing a local receipt that would falsely bind it.
        await bounded(() => cloud.linked(identity, taskId));
        await storage(() => local.linked(identity, taskId)); return;
      }
      // Keep the local receipt even if the later acknowledgement cannot reach Cloud.
      await storage(() => local.linked(identity, taskId, proof)); await bounded(() => cloud.linked(identity, taskId, proof?.attemptId));
    },
    async deleted(identity, taskId) {
      const stored = await storage(async () => local.read?.(identity));
      // The exact successful local receipt can also release its still-reserved
      // Cloud grant. Replaying an already committed deletion stays idempotent.
      const attempt = stored?.taskId === taskId && stored.intent.attemptId !== 'observed' ? stored.intent.attemptId : undefined;
      await bounded(() => cloud.deleted(identity, taskId, attempt)); await storage(() => local.deleted(identity, taskId));
    },
  };
}
