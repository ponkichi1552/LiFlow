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
  const rejectLocal = async (intents: readonly GoogleTaskCreateIntent[]) => {
    if (local.rejectBatch) await local.rejectBatch(intents); else for (const intent of intents) await local.reject(intent);
  };
  const reserveBatch = async (identities: readonly GoogleTaskCreateIdentity[]) => {
    if (!identities.length || identities.length > 100) throw new Error('Google家事は100件以内に分けて送信してください。');
    const intents: (GoogleTaskCreateIntent | null)[] = [];
    try {
      await bounded(async () => {
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
    if (unused.length) await bounded(() => rejectLocal(unused));
    return result;
  };
  const rejectBatch = async (intents: readonly GoogleTaskCreateIntent[]) => {
    await bounded(() => cloud.rejectBatch(intents));
    await bounded(() => rejectLocal(intents));
  };
  return {
    reserve: async identity => (await reserveBatch([identity]))[0], reserveBatch,
    reject: intent => rejectBatch([intent]), rejectBatch,
    async linked(identity, taskId) {
      // Keep the local receipt even if the later acknowledgement cannot reach Cloud.
      await bounded(() => local.linked(identity, taskId)); await bounded(() => cloud.linked(identity, taskId));
    },
    async deleted(identity, taskId) { await bounded(() => cloud.deleted(identity, taskId)); await bounded(() => local.deleted(identity, taskId)); },
  };
}
