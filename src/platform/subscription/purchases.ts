import * as IAP from 'expo-iap';
import { Linking, Platform } from 'react-native';
import { createSubscriptionPurchaseFlow } from '../../features/subscription/purchase-flow';
import type { StorePurchase } from '../../features/subscription/purchase-flow';
import { acceptSubscription, subscriptionRequest, subscriptionSnapshot } from './runtime';

export interface SubscriptionProduct { price: string; productId: string; offerToken?: string }
export interface PurchaseState { product: SubscriptionProduct | null; busy: boolean; pending: boolean; message: string | null }
let state: PurchaseState = { product: null, busy: false, pending: false, message: null };
const listeners = new Set<() => void>();
export const subscriptionPurchaseSnapshot = () => state;
export function observeSubscriptionPurchases(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(next: Partial<PurchaseState>) { state = { ...state, ...next }; for (const listener of listeners) listener(); }
const productId = () => Platform.OS === 'ios' ? process.env.EXPO_PUBLIC_APPLE_SUBSCRIPTION_PRODUCT_ID : process.env.EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID;
let current: { userId: string; ready: Promise<void>; flow: ReturnType<typeof createSubscriptionPurchaseFlow>;
  identity: object; catalogue: () => Promise<void>;
  receive: (purchase: IAP.Purchase) => Promise<void>; stop: () => void } | undefined;

export function startSubscriptionPurchases(userId: string): Promise<void> {
  if (current?.userId === userId) {
    const session = current;
    return session.ready.then(() => { if (current === session && !state.product) return session.catalogue(); });
  }
  const previous = current; current = undefined; previous?.stop();
  publish({ product: null, busy: false, pending: false, message: null });
  const sku = productId(); if (!sku) return Promise.reject(new Error('このストアの月額契約は準備中です。'));
  const identity = {};
  const isCurrent = () => current?.identity === identity && subscriptionSnapshot().userId === userId;
  const originals = new Map<string, IAP.Purchase>();
  const flow = createSubscriptionPurchaseFlow({ userId, productId: sku, currentUserId: () => isCurrent() ? userId : null,
    verify: value => subscriptionRequest('verify', { store: value.store, proof: value.proof }), accept: acceptSubscription,
    finish: async value => { const purchase = originals.get(value.id); if (!purchase) throw new Error('復元して購入情報を再確認してください。'); await IAP.finishTransaction({ purchase, isConsumable: false }); },
  });
  const receive = async (purchase: IAP.Purchase) => {
    if (!isCurrent() || purchase.productId !== sku) return;
    const store = Platform.OS === 'ios' ? 'apple' : 'google';
    if (purchase.store !== store || purchase.storeId !== (store === 'apple' ? 'apple' : 'play')) throw new Error('購入元のストアを確認できません。');
    if (!['pending', 'purchased'].includes(purchase.purchaseState)) throw new Error('購入の状態を確認できません。');
    const value: StorePurchase = { id: purchase.id, productId: sku, store,
      proof: purchase.purchaseToken ?? '', state: purchase.purchaseState === 'purchased' ? 'purchased' : 'pending' };
    originals.set(value.id, purchase);
    const result = await flow.process(value);
    if (isCurrent()) publish({ busy: false, pending: result === 'pending', message: result === 'pending' ? 'ストアでの支払い確認を待っています。' : null });
  };
  const updated = IAP.purchaseUpdatedListener(purchase => { void receive(purchase).catch(() => { if (isCurrent()) publish({ busy: false, message: '購入確認が終わっていません。購入時のアカウントで復元してください。' }); }); });
  const errors = IAP.purchaseErrorListener(error => { if (isCurrent()) publish({ busy: false, pending: false, message: error.code === IAP.ErrorCode.UserCancelled ? null : '購入を確認できませんでした。もう一度お試しください。' }); });
  let cataloguePending: Promise<void> | undefined;
  const catalogue = () => {
    if (cataloguePending) return cataloguePending;
    const work = (async () => {
      if (!isCurrent()) return;
      const products = await IAP.fetchProducts({ skus: [sku], type: 'subs' });
      if (!isCurrent()) return;
      const product = products?.find(item => item.id === sku && item.type === 'subs') as IAP.ProductSubscription | undefined;
      if (!product) throw new Error('ストアの商品は準備中です。');
      if (product.platform === 'ios') {
        if (product.subscriptionPeriodUnitIOS !== 'month' || product.subscriptionPeriodNumberIOS !== '1'
          || product.typeIOS !== 'auto-renewable-subscription') throw new Error('月額商品の設定を確認できません。');
        publish({ product: { price: product.displayPrice, productId: sku } });
      } else {
        const basePlan = process.env.EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_BASE_PLAN_ID;
        const offer = basePlan && product.subscriptionOffers.find(item => item.basePlanIdAndroid === basePlan && item.offerTokenAndroid
          && item.pricingPhasesAndroid?.pricingPhaseList.length === 1
          && item.pricingPhasesAndroid.pricingPhaseList[0].billingPeriod === 'P1M'
          && item.pricingPhasesAndroid.pricingPhaseList[0].recurrenceMode === 1);
        if (!offer) throw new Error('月額プランの設定を確認できません。');
        publish({ product: { price: offer.pricingPhasesAndroid!.pricingPhaseList[0].formattedPrice, productId: sku, offerToken: offer.offerTokenAndroid! } });
      }
      if (state.message?.startsWith('新しい購入の価格')) publish({ message: null });
    })().catch(() => { if (isCurrent() && subscriptionSnapshot().phase !== 'active') publish({ message: '新しい購入の価格を確認できません。購入済みの場合は復元できます。' }); });
    cataloguePending = work;
    void work.finally(() => { if (cataloguePending === work) cataloguePending = undefined; });
    return work;
  };
  const session = { userId, identity, catalogue, flow, receive, ready: Promise.resolve(), stop: () => { updated.remove(); errors.remove(); } };
  current = session;
  session.ready = (async () => {
    if (!await IAP.initConnection()) throw new Error('ストアに接続できませんでした。');
    if (!isCurrent()) return;
    // Restoring an already paid transaction must not depend on fetching the current product catalogue.
    await Promise.allSettled([catalogue(),
    (async () => {
      const pending = await IAP.getAvailablePurchases({ alsoPublishToEventListenerIOS: false });
      for (const purchase of pending.slice(0, 32)) try { await receive(purchase); } catch {
        if (current === session && subscriptionSnapshot().phase !== 'active') publish({ message: '未確認の購入があります。購入時のアカウントで復元してください。' });
      }
    })().catch(() => { if (current === session) publish({ message: '購入情報を確認できませんでした。復元から再試行してください。' }); })]);
  })().catch(error => {
    if (current === session) { session.stop(); current = undefined; publish({ busy: false, message: 'ストアでの購入・復元はまだ確認できません。' }); }
    throw error;
  });
  return session.ready;
}

/** Non-interactive recovery on foreground; never calls App Store sync or opens a purchase sheet automatically. */
export async function recoverSubscriptionPurchases(userId: string): Promise<void> {
  if (current?.userId !== userId) { await startSubscriptionPurchases(userId); return; }
  const session = current; await startSubscriptionPurchases(userId);
  if (current !== session || subscriptionSnapshot().userId !== userId) return;
  const pending = await IAP.getAvailablePurchases({ alsoPublishToEventListenerIOS: false });
  if (current === session) publish({ pending: false });
  for (const purchase of pending.slice(0, 32)) {
    if (current !== session || subscriptionSnapshot().userId !== userId) return;
    try { await session.receive(purchase); } catch { /* Keep unverified transactions unfinished for the next explicit restore. */ }
  }
}

export async function purchaseSubscription() {
  if (state.busy || state.pending) return;
  const userId = subscriptionSnapshot().userId; if (!userId) throw new Error('ログインしてください。');
  const ready = startSubscriptionPurchases(userId); const session = current;
  const isCurrent = () => current === session && subscriptionSnapshot().userId === userId;
  publish({ busy: true, message: null });
  try {
    await ready; if (!isCurrent()) return;
    await subscriptionRequest('status'); if (!isCurrent()) return;
    const latest = subscriptionSnapshot(); if (latest.phase === 'active') { publish({ busy: false }); return; }
    if (latest.entitlement && ['pending', 'onHold'].includes(latest.entitlement.body.status)) {
      publish({ busy: false, message: '購入元のストアで支払いを確認してください。' }); return;
    }
    if (!state.product || !latest.account || latest.userId !== userId) throw new Error('購入情報を確認できません。');
    await IAP.requestPurchase({ type: 'subs', request: Platform.OS === 'ios'
      ? { apple: { sku: state.product.productId, appAccountToken: latest.account.appAccountToken } }
      : { google: { skus: [state.product.productId], obfuscatedAccountId: latest.account.obfuscatedAccountId,
        subscriptionOffers: [{ sku: state.product.productId, offerToken: state.product.offerToken! }] } } });
    // A resolved request is not a verified purchase. The listener keeps the action pending until server confirmation.
  } catch { if (isCurrent()) publish({ busy: false, message: '購入を確認できませんでした。再試行または復元してください。' }); }
}
export async function restoreSubscription() {
  if (state.busy) return;
  const userId = subscriptionSnapshot().userId; if (!userId) throw new Error('購入時のアカウントでログインしてください。');
  const ready = startSubscriptionPurchases(userId); const session = current;
  const isCurrent = () => current === session && subscriptionSnapshot().userId === userId;
  publish({ busy: true, message: null });
  try {
    await ready; if (!isCurrent()) return;
    await IAP.restorePurchases(); if (!isCurrent()) return;
    const purchases = await IAP.getAvailablePurchases({ alsoPublishToEventListenerIOS: true });
    // Explicitly consume this result too: Android does not promise a new purchase callback for restore.
    for (const purchase of purchases.slice(0, 32)) {
      if (!isCurrent()) return;
      try { await session!.receive(purchase); }
      catch { /* A foreign or unverified receipt stays unfinished; continue to this account's receipts. */ }
    }
    if (!isCurrent()) return;
    await subscriptionRequest('status');
    if (!isCurrent()) return;
    publish({ message: subscriptionSnapshot().phase === 'active' ? null : 'このアカウントの有効な購入は見つかりませんでした。' });
  } catch { if (isCurrent()) publish({ message: '購入を復元できませんでした。購入時のアカウントと通信状態を確認してください。' }); }
  finally { if (isCurrent()) publish({ busy: false }); }
}
export async function manageSubscription() {
  const store = subscriptionSnapshot().entitlement?.body.store;
  if (store === 'apple') await Linking.openURL('https://apps.apple.com/account/subscriptions');
  else await Linking.openURL(`https://play.google.com/store/account/subscriptions?package=jp.jphacks.tkb2633&sku=${encodeURIComponent(process.env.EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID ?? '')}`);
}
