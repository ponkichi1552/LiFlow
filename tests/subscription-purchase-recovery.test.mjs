import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as purchaseFlow from '../src/features/subscription/purchase-flow.ts';
import { loadNativeModule } from './helpers/native-module.mjs';

async function fixture(platform, run) {
  const fields = ['EXPO_PUBLIC_APPLE_SUBSCRIPTION_PRODUCT_ID', 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID', 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_BASE_PLAN_ID'];
  const old = fields.map(key => process.env[key]); fields.forEach(key => { process.env[key] = 'monthly'; });
  const state = { userId: 'person-a', phase: 'locked', account: { appAccountToken: '12345678-1234-1234-1234-123456789012', obfuscatedAccountId: 'a'.repeat(64) } };
  let catalogueFailures = 0; let queries = 0; let available = []; let request = async () => {}; let verify = async () => ({ body: {
    userId: 'person-a', status: 'active', checkedAt: Date.now(), expiresAt: Date.now() + 60_000, validUntil: Date.now() + 60_000 } });
  const updated = []; const removed = []; const finished = []; let accepted = 0; const requests = [];
  const product = platform === 'ios' ? { id: 'monthly', type: 'subs', platform, displayPrice: '¥90', subscriptionPeriodUnitIOS: 'month', subscriptionPeriodNumberIOS: '1', typeIOS: 'auto-renewable-subscription' }
    : { id: 'monthly', type: 'subs', platform, subscriptionOffers: [{ basePlanIdAndroid: 'monthly', offerTokenAndroid: 'offer', pricingPhasesAndroid: { pricingPhaseList: [{ billingPeriod: 'P1M', recurrenceMode: 1, formattedPrice: '¥90' }] } }] };
  try {
    const api = loadNativeModule('src/platform/subscription/purchases.ts', {
      'react-native': { Platform: { OS: platform }, Linking: {} }, '../../features/subscription/purchase-flow': purchaseFlow,
      './runtime': { subscriptionSnapshot: () => state, subscriptionCurrentTime: () => state.clock ?? Date.now(), acceptSubscription: async () => { accepted++; },
        subscriptionRequest: async (path, evidence) => path === 'status' ? {} : verify(evidence) },
      'expo-iap': { initConnection: async () => true, purchaseUpdatedListener: fn => { updated.push(fn); return { remove() { removed.push(fn); } }; },
        purchaseErrorListener: () => ({ remove() {} }), ErrorCode: {},
        fetchProducts: async () => { queries++; if (catalogueFailures-- > 0) throw new Error('catalogue offline'); return [product]; },
        getAvailablePurchases: async () => available, requestPurchase: async value => { requests.push(value); await request(value); },
        restorePurchases: async () => {}, finishTransaction: async value => { finished.push(value.purchase.id); } },
    });
    const receipt = { id: 'receipt-a', productId: 'monthly', store: platform === 'ios' ? 'apple' : 'google', storeId: platform === 'ios' ? 'apple' : 'play', purchaseState: 'purchased', purchaseToken: 'synthetic-paid-proof' };
    await run({ api, state, updated, removed, receipt, requests, finished, accepted: () => accepted, queries: () => queries,
      failCatalogue: count => { catalogueFailures = count; }, setAvailable: value => { available = value; }, setRequest: fn => { request = fn; }, setVerify: fn => { verify = fn; } });
  } finally { fields.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }); }
}

test('audit100 restoring the paid SKU is not blocked by thirty two unrelated store purchases', () => fixture('android', async h => {
  h.setAvailable([...Array.from({ length: 32 }, (_, i) => ({ ...h.receipt, id: `other-${i}`, productId: 'unrelated' })), h.receipt]);
  await h.api.startSubscriptionPurchases('person-a');
  assert.equal(h.accepted(), 1); assert.deepEqual(h.finished, [h.receipt.id]);
}));

test('audit100 store verification uses the authenticated subscription clock after a wall clock correction', () => fixture('ios', async h => {
  const at = Date.now(); const originalNow = Date.now;
  h.state.clock = at;
  h.setVerify(async () => ({ body: { userId: 'person-a', status: 'active', checkedAt: at, expiresAt: at + 60_000, validUntil: at + 60_000 } }));
  try {
    await h.api.startSubscriptionPurchases('person-a');
    Date.now = () => at + 365 * 86400_000;
    h.updated[0](h.receipt); await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(h.accepted(), 1); assert.deepEqual(h.finished, [h.receipt.id]);
  } finally { Date.now = originalNow; }
}));

test('audit100 an expired finished purchase is verified again before reporting a restored grant', async () => {
  let at = 1000; let checks = 0; let accepts = 0;
  const flow = purchaseFlow.createSubscriptionPurchaseFlow({ userId: 'person-a', productId: 'monthly', currentUserId: () => 'person-a', now: () => at,
    verify: async () => { checks++; return { body: { userId: 'person-a', status: 'active', checkedAt: at, expiresAt: at + 1000, validUntil: at + 1000 } }; },
    accept: async () => { accepts++; }, finish: async () => {} });
  const receipt = { id: 'same-token', productId: 'monthly', store: 'google', proof: 'synthetic-proof', state: 'purchased' };
  assert.equal(await flow.process(receipt), 'granted'); at = 2001;
  assert.equal(await flow.process(receipt), 'granted');
  assert.equal(checks, 2); assert.equal(accepts, 2);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} a recovered store catalogue can be fetched again without signing out or losing the purchase observer`, () => fixture(platform, async h => {
    h.failCatalogue(1); await h.api.startSubscriptionPurchases('person-a');
    assert.equal(h.api.subscriptionPurchaseSnapshot().product, null);
    await h.api.recoverSubscriptionPurchases('person-a');
    assert.equal(h.api.subscriptionPurchaseSnapshot().product.price, '¥90');
    assert.equal(h.queries(), 2); assert.equal(h.updated.length, 1);
  }));
  test(`${platform} a failed purchase from a previous login cannot clear the current accounts in-flight action`, () => fixture(platform, async h => {
    await h.api.startSubscriptionPurchases('person-a'); let failOld;
    h.setRequest(() => new Promise((_, reject) => { failOld = reject; }));
    const oldPurchase = h.api.purchaseSubscription(); await new Promise(setImmediate);
    h.state.userId = 'person-b'; await h.api.startSubscriptionPurchases('person-b');
    let releaseNew; h.setRequest(() => new Promise(resolve => { releaseNew = resolve; }));
    const currentPurchase = h.api.purchaseSubscription(); await new Promise(setImmediate);
    assert.equal(h.api.subscriptionPurchaseSnapshot().busy, true);
    const currentState = { ...h.api.subscriptionPurchaseSnapshot() };
    failOld(new Error('late store failure')); await oldPurchase;
    assert.deepEqual(h.api.subscriptionPurchaseSnapshot(), currentState);
    releaseNew(); await currentPurchase;
  }));
  test(`${platform} a purchase callback cannot resume after signing out and back into the same account`, () => fixture(platform, async h => {
    await h.api.startSubscriptionPurchases('person-a'); let release;
    h.setVerify(() => new Promise(resolve => { release = resolve; }));
    h.updated[0](h.receipt); await new Promise(setImmediate);
    h.state.userId = 'person-b'; await h.api.startSubscriptionPurchases('person-b');
    h.state.userId = 'person-a'; await h.api.startSubscriptionPurchases('person-a');
    const replacement = { ...h.api.subscriptionPurchaseSnapshot() };
    release({ body: { userId: 'person-a', status: 'active', checkedAt: Date.now(), expiresAt: Date.now() + 60_000, validUntil: Date.now() + 60_000 } });
    await new Promise(setImmediate);
    assert.equal(h.accepted(), 0); assert.deepEqual(h.finished, []);
    assert.deepEqual(h.api.subscriptionPurchaseSnapshot(), replacement);
  }));
}
