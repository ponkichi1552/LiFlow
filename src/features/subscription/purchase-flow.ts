import { hasSubscriptionAccess } from './entitlement.ts';
import type { SignedSubscriptionEntitlement, SubscriptionStore } from './entitlement.ts';

export interface StorePurchase {
  id: string; productId: string; store: SubscriptionStore; proof: string; state: 'purchased' | 'pending';
}
/** One account owns one flow. A callback from an old account can never finish or grant on the new account. */
export function createSubscriptionPurchaseFlow(options: {
  userId: string; productId: string; currentUserId: () => string | null; now?: () => number;
  verify: (purchase: StorePurchase) => Promise<SignedSubscriptionEntitlement>;
  accept: (value: SignedSubscriptionEntitlement) => Promise<void>;
  finish: (purchase: StorePurchase) => Promise<void>;
}) {
  const pending = new Map<string, Promise<'pending' | 'granted'>>(); const finished = new Set<string>();
  const current = () => { if (options.currentUserId() !== options.userId) throw new Error('購入中にアカウントが変わりました。購入時のアカウントで復元してください。'); };
  return {
    process(purchase: StorePurchase): Promise<'pending' | 'granted'> {
      current();
      if (purchase.productId !== options.productId || !['apple', 'google'].includes(purchase.store)
        || typeof purchase.id !== 'string' || !purchase.id.length || purchase.id.length > 4096) return Promise.reject(new Error('対象の購入情報ではありません。'));
      if (purchase.state === 'pending') return Promise.resolve('pending');
      if (purchase.state !== 'purchased' || typeof purchase.proof !== 'string' || purchase.proof.length < 8 || purchase.proof.length > 32_768) return Promise.reject(new Error('購入情報を確認できません。'));
      const key = JSON.stringify([purchase.store, purchase.id]);
      if (finished.has(key)) return Promise.resolve('granted');
      const running = pending.get(key); if (running) return running;
      const work = (async () => {
        const verified = await options.verify(purchase); current();
        if (verified.body.userId !== options.userId || !hasSubscriptionAccess(verified.body, (options.now ?? Date.now)())) throw new Error('有効な契約を確認できません。購入情報は保持されています。');
        await options.accept(verified); current();
        await options.finish(purchase); current();
        finished.add(key); if (finished.size > 200) finished.delete(finished.values().next().value!);
        return 'granted' as const;
      })();
      pending.set(key, work); void work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => undefined);
      return work;
    },
  };
}
