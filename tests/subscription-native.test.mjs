import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import * as entitlement from '../src/features/subscription/entitlement.ts';
import { createSubscriptionSigner } from '../server/appliance-care-api/src/subscription-service.mjs';
import { loadNativeModule as load } from './helpers/native-module.mjs';
import { reconcileLocalNotifications } from '../src/features/notifications/reconcile-local-notifications.ts';
import * as purchaseFlow from '../src/features/subscription/purchase-flow.ts';
import { createRequire } from 'node:module';

test('mobile verified subscription cache presents the same account before a network response and never grants to a switched account', async () => {
  const { privateKey } = generateKeyPairSync('ed25519'); const signer = createSubscriptionSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const at = Date.now(); const body = { schemaVersion: 1, userId: 'person-a', revision: 2, status: 'active', store: 'apple',
    productId: 'monthly', autoRenew: false, checkedAt: at, expiresAt: at + 86400_000, validUntil: at + 3600_000 };
  const certificate = signer.sign(body); const saved = new Map([['subscription-certificate:person-a', JSON.stringify({ entitlement: certificate, lastWall: at })]]);
  let changed; let response; let calls = 0;
  const auth = { currentUser: { uid: 'person-a', getIdToken: async () => 'synthetic-firebase-token' }, authStateReady: async () => {} };
  const previousFetch = globalThis.fetch; const env = ['EXPO_PUBLIC_LIFLOW_SUBSCRIPTIONS', 'EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY', 'EXPO_PUBLIC_APPLIANCE_CARE_API_URL'];
  const previous = env.map(key => process.env[key]);
  process.env.EXPO_PUBLIC_LIFLOW_SUBSCRIPTIONS = 'required'; process.env.EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY = signer.publicKey;
  process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = 'https://billing.example.invalid';
  globalThis.fetch = async () => { calls++; return new Promise(done => { response = done; }); };
  const timers = [];
  try {
    const runtime = load('src/platform/subscription/runtime.ts', {
      '../../features/subscription/entitlement': entitlement, '../sharing/firebase-services': { getSharingServices: () => ({ auth }) },
      '../sharing/secure-store': { sharingSecureVault: { getItem: async key => saved.get(key) ?? null, setItem: async (key, value) => saved.set(key, value) } },
      'firebase/auth': { onAuthStateChanged: (_auth, observer) => { changed = observer; return () => {}; } },
    }, { setTimeout: (callback, ms) => { const value = { callback, ms }; timers.push(value); return value; }, clearTimeout() {} });
    await runtime.startSubscriptions();
    assert.equal(runtime.subscriptionSnapshot().phase, 'active', 'cached valid content does not wait for HTTPS');
    assert.equal(runtime.subscriptionSnapshot().userId, 'person-a');
    await new Promise(setImmediate); assert.equal(calls, 1);
    const refresh = runtime.refreshSubscription();
    auth.currentUser = { uid: 'person-b', getIdToken: async () => 'synthetic-other-token' }; changed(auth.currentUser);
    assert.notEqual(runtime.subscriptionSnapshot().phase, 'active');
    response({ ok: true, json: async () => ({ entitlement: signer.sign({ ...body, revision: 3 }),
      account: { appAccountToken: '12345678-1234-1234-1234-123456789012', obfuscatedAccountId: 'a'.repeat(64) } }) });
    await refresh; await new Promise(setImmediate);
    assert.equal(runtime.subscriptionSnapshot().userId, 'person-b');
    assert.equal(runtime.subscriptionSnapshot().entitlement, null);
    assert.equal(saved.has('subscription-certificate:person-b'), false);
    // Complete the new account's pending request so no synthetic network operation is left in flight.
    response({ ok: true, json: async () => ({ entitlement: signer.sign({ ...body, userId: 'person-b', revision: 1, status: 'none', store: null, productId: null, expiresAt: 0, validUntil: 0 }),
      account: { appAccountToken: '12345678-1234-1234-1234-123456789012', obfuscatedAccountId: 'b'.repeat(64) } }) });
    await runtime.refreshSubscription(); assert.equal(runtime.subscriptionSnapshot().phase, 'locked');
    const callsBeforeTimeout = calls;
    auth.currentUser.getIdToken = () => new Promise(() => {});
    const timeout = runtime.subscriptionRequest('status').then(() => false, error => /タイムアウト/.test(error.message));
    await new Promise(setImmediate); timers.filter(value => value.ms === 15_000).at(-1).callback(); await new Promise(setImmediate);
    assert.equal(await Promise.race([timeout, Promise.resolve(false)]), true, 'the identity-provider promise must be bounded too');
    assert.equal(calls, callsBeforeTimeout, 'an expired token wait cannot start a late HTTP request');
  } finally {
    globalThis.fetch = previousFetch;
    env.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

for (const platform of ['ios', 'android']) test(`${platform} an expired subscription stops the background worker before database tasks calendar or sharing begin`, async () => {
  let worker; let opened = 0;
  load('src/features/google-sync/background-task.ts', {
    'expo-background-task': { BackgroundTaskResult: { Failed: 'failed', Success: 'success' } },
    'expo-sqlite': { openDatabaseAsync: async () => { opened++; throw new Error('must not open'); } },
    'expo-task-manager': { defineTask: (_name, callback) => { worker = callback; } },
    './coordinator': { syncGoogleTasks: () => assert.fail('must not sync') },
    '@/platform/storage/repository': {}, './background-audit': {},
    '@/platform/subscription/runtime': { subscriptionRequired: true, subscriptionAccessDeadline: async () => Date.now() - 1 },
  });
  assert.equal(await worker({}), 'failed'); assert.equal(opened, 0);
});

test('notification reconciliation cancels old reservations beyond the verified subscription deadline without removing another scope', async () => {
  const existing = new Map([['own:future', { key: 'own:future', fireAt: '2030-01-03T00:00:00Z' }], ['other:future', { key: 'other:future', fireAt: '2030-01-03T00:00:00Z' }]]);
  const sent = [];
  const gateway = { hasPermission: async () => true, schedulingDeadline: async () => Date.parse('2030-01-02T00:00:00Z'),
    getScheduledRequests: async () => [...existing.values()], schedule: async value => { sent.push(value.key); existing.set(value.key, value); return value.key; }, cancel: async key => existing.delete(key) };
  await reconcileLocalNotifications(gateway, { prefix: 'own:', enabled: true, desired: [
    { key: 'own:before', title: '', body: '', fireAt: '2030-01-01T00:00:00Z' },
    { key: 'own:boundary', title: '', body: '', fireAt: '2030-01-02T00:00:00Z' },
    { key: 'own:future', title: '', body: '', fireAt: '2030-01-03T00:00:00Z' },
  ] });
  assert.deepEqual(sent, ['own:before']); assert.deepEqual([...existing.keys()].sort(), ['other:future', 'own:before']);
});

test('paid widget expiry timeline preserves current pending actions and does not replay old generations', async () => {
  const updates = []; let entries = [];
  const value = load('src/platform/widgets/expo-widget-gateway.ts', {
    'react-native': { Platform: { OS: 'ios' } }, '../subscription/runtime': { subscriptionRequired: true, subscriptionAccessDeadline: async () => Date.now() + 3600_000 },
    '@/platform/widgets/NextChoreWidget': { __esModule: true, default: { updateSnapshot: props => updates.push(props), updateTimeline: next => { entries = next; }, getTimeline: async () => entries } },
  });
  value.expoWidgetGateway.updateNextChore({ chores: [{ id: 'current', name: '検査', completed: false }], remainingCount: 0, updatedAt: '2030-01-01T00:00:00Z' });
  await new Promise(setImmediate); assert.equal(entries.length, 2); assert.equal(entries[1].props.subscriptionLocked, true);
  entries.unshift({ date: new Date('2020-01-01'), props: { pendingWidgetCompletionIds: ['old'], updatedAt: '2020-01-01T00:00:00Z' } });
  entries[1].props.pendingWidgetCompletionIds = ['current'];
  assert.deepEqual(await value.expoWidgetGateway.getPendingWidgetCompletionIds(), ['current']);
  await value.lockSubscriptionWidget(); assert.deepEqual(updates[0].pendingWidgetCompletionIds, ['current']);
  assert.equal(updates[0].chores.length, 0);
});

for (const platform of ['ios', 'android']) test(`${platform} store purchase uses the server account and store price while foreground recovery verifies and finishes a transaction once`, async () => {
  const fields = ['EXPO_PUBLIC_APPLE_SUBSCRIPTION_PRODUCT_ID', 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID', 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_BASE_PLAN_ID'];
  const previous = fields.map(key => process.env[key]); fields.forEach((key, i) => { process.env[key] = i === 2 ? 'month' : 'monthly'; });
  const state = { userId: 'person-a', phase: 'locked', account: { appAccountToken: '12345678-1234-1234-1234-123456789012', obfuscatedAccountId: 'a'.repeat(64) } };
  const body = { userId: 'person-a', status: 'active', checkedAt: Date.now(), expiresAt: Date.now() + 86400_000, validUntil: Date.now() + 3600_000 };
  let available = []; let verify = 0, finish = 0, init = 0, queries = 0; const purchases = [];
  const product = platform === 'ios' ? { id: 'monthly', type: 'subs', platform, displayPrice: '¥90', typeIOS: 'auto-renewable-subscription', subscriptionPeriodUnitIOS: 'month', subscriptionPeriodNumberIOS: '1' }
    : { id: 'monthly', type: 'subs', platform, subscriptionOffers: [{ basePlanIdAndroid: 'month', offerTokenAndroid: 'native-offer', pricingPhasesAndroid: { pricingPhaseList: [{ billingPeriod: 'P1M', recurrenceMode: 1, formattedPrice: '￥90' }] } }] };
  try {
    const module = load('src/platform/subscription/purchases.ts', {
      'react-native': { Platform: { OS: platform }, Linking: { openURL: async () => {} } }, '../../features/subscription/purchase-flow': purchaseFlow,
      './runtime': { subscriptionSnapshot: () => state, acceptSubscription: async () => { state.phase = 'active'; }, subscriptionRequest: async path => { if (path === 'verify') verify++; return { body }; } },
      'expo-iap': { initConnection: async () => { init++; return true; }, purchaseUpdatedListener: () => ({ remove() {} }), purchaseErrorListener: () => ({ remove() {} }),
        fetchProducts: async () => [product], getAvailablePurchases: async () => { queries++; return available; }, requestPurchase: async value => { purchases.push(value); return null; },
        finishTransaction: async ({ isConsumable }) => { assert.equal(isConsumable, false); finish++; }, ErrorCode: { UserCancelled: 'user-cancelled' } },
    });
    await module.startSubscriptionPurchases('person-a');
    assert.equal(module.subscriptionPurchaseSnapshot().product.price, platform === 'ios' ? '¥90' : '￥90');
    await module.purchaseSubscription(); assert.equal(state.phase, 'locked'); assert.equal(finish, 0);
    const request = purchases[0].request;
    if (platform === 'ios') assert.equal(request.apple.appAccountToken, state.account.appAccountToken);
    else { assert.equal(request.google.obfuscatedAccountId, state.account.obfuscatedAccountId); assert.equal(request.google.subscriptionOffers[0].offerToken, 'native-offer'); }
    const purchase = { id: 'synthetic-paid', productId: 'monthly', store: platform === 'ios' ? 'apple' : 'google', storeId: platform === 'ios' ? 'apple' : 'play', purchaseState: 'purchased', purchaseToken: 'synthetic-proof' };
    available = [purchase, purchase]; await module.recoverSubscriptionPurchases('person-a');
    assert.deepEqual([init, queries, verify, finish], [1, 2, 1, 1]); assert.equal(state.phase, 'active');
    await module.recoverSubscriptionPurchases('person-a'); assert.equal(verify, 1); assert.equal(finish, 1);
  } finally { fields.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});

for (const platform of ['ios', 'android']) test(`${platform} a product catalogue outage or another account receipt cannot block recovery of this accounts paid transaction`, async () => {
  const field = platform === 'ios' ? 'EXPO_PUBLIC_APPLE_SUBSCRIPTION_PRODUCT_ID' : 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID'; const old = process.env[field]; process.env[field] = 'monthly';
  const state = { userId: 'person-a', phase: 'locked' }; let finish = 0; const valid = { id: 'valid', productId: 'monthly', store: platform === 'ios' ? 'apple' : 'google', storeId: platform === 'ios' ? 'apple' : 'play', purchaseState: 'purchased', purchaseToken: 'owned-proof' };
  try {
    const module = load('src/platform/subscription/purchases.ts', {
      'react-native': { Platform: { OS: platform }, Linking: {} }, '../../features/subscription/purchase-flow': purchaseFlow,
      './runtime': { subscriptionSnapshot: () => state, acceptSubscription: async () => { state.phase = 'active'; }, subscriptionRequest: async (_path, value) => {
        if (value.proof === 'another-account-proof') throw new Error('wrong account');
        return { body: { userId: 'person-a', status: 'active', checkedAt: Date.now(), validUntil: Date.now() + 60_000, expiresAt: Date.now() + 60_000 } };
      } },
      'expo-iap': { initConnection: async () => true, purchaseUpdatedListener: () => ({ remove() {} }), purchaseErrorListener: () => ({ remove() {} }),
        fetchProducts: async () => { throw new Error('catalogue unavailable'); }, getAvailablePurchases: async () => [{ ...valid, id: 'other', purchaseToken: 'another-account-proof' }, valid],
        finishTransaction: async ({ purchase }) => { assert.equal(purchase.id, 'valid'); finish++; }, ErrorCode: {} },
    });
    await module.startSubscriptionPurchases('person-a'); assert.equal(state.phase, 'active'); assert.equal(finish, 1);
    assert.equal(module.subscriptionPurchaseSnapshot().product, null);
  } finally { if (old === undefined) delete process.env[field]; else process.env[field] = old; }
});

test('public store builds reject missing billing setup and keep the native Google billing provider pinned to Play', () => {
  const require = createRequire(import.meta.url); const configure = require('../app.config.js');
  const fields = ['EAS_BUILD_PROFILE', 'EXPO_PUBLIC_LIFLOW_SUBSCRIPTIONS', 'EXPO_PUBLIC_APPLE_SUBSCRIPTION_PRODUCT_ID', 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID',
    'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_BASE_PLAN_ID', 'EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY', 'EXPO_PUBLIC_APPLIANCE_CARE_API_URL', 'EXPO_PUBLIC_LIFLOW_TERMS_URL', 'EXPO_PUBLIC_LIFLOW_PRIVACY_URL'];
  const old = fields.map(key => process.env[key]);
  try {
    fields.forEach(key => delete process.env[key]); process.env.EAS_BUILD_PROFILE = 'production';
    assert.throws(() => configure({ config: {} }), /require verified/);
    process.env.EXPO_PUBLIC_LIFLOW_SUBSCRIPTIONS = 'required'; assert.throws(() => configure({ config: {} }), /required/);
    const values = ['production', 'required', 'monthly', 'monthly', 'month', 'a'.repeat(64), 'https://api.example.invalid', 'https://example.invalid/terms', 'https://example.invalid/privacy'];
    fields.forEach((key, i) => { process.env[key] = values[i]; });
    const config = configure({ config: {} }); const plugin = config.plugins.find(item => Array.isArray(item) && item[0] === 'expo-iap');
    assert.equal(plugin[1].android.store, 'play');
    process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = 'http://localhost'; assert.throws(() => configure({ config: {} }), /HTTPS/);
  } finally { fields.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }); }
});
for (const platform of ['ios', 'android']) test(`${platform} explicit restore continues past a foreign receipt without finishing it or disturbing a switched account`, async () => {
  const key = platform === 'ios' ? 'EXPO_PUBLIC_APPLE_SUBSCRIPTION_PRODUCT_ID' : 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID';
  const previous = process.env[key]; process.env[key] = 'monthly';
  const state = { userId: 'person-a', phase: 'locked' }; let available = []; let restoreHook; const finished = []; const verified = [];
  const purchase = proof => ({ id: proof, productId: 'monthly', store: platform === 'ios' ? 'apple' : 'google', storeId: platform === 'ios' ? 'apple' : 'play', purchaseState: 'purchased', purchaseToken: proof });
  try {
    const module = load('src/platform/subscription/purchases.ts', {
      'react-native': { Platform: { OS: platform }, Linking: {} }, '../../features/subscription/purchase-flow': purchaseFlow,
      './runtime': { subscriptionSnapshot: () => state, acceptSubscription: async () => { state.phase = 'active'; }, subscriptionRequest: async (path, value) => {
        if (path === 'status') return {};
        verified.push(value.proof); if (value.proof === 'foreign-proof') throw new Error('owned by another account');
        return { body: { userId: state.userId, status: 'active', checkedAt: Date.now(), validUntil: Date.now() + 60_000, expiresAt: Date.now() + 60_000 } };
      } },
      'expo-iap': { initConnection: async () => true, purchaseUpdatedListener: () => ({ remove() {} }), purchaseErrorListener: () => ({ remove() {} }),
        fetchProducts: async () => [], getAvailablePurchases: async () => available, restorePurchases: async () => { await restoreHook?.(); },
        finishTransaction: async ({ purchase: value }) => finished.push(value.id), ErrorCode: {} },
    });
    await module.startSubscriptionPurchases('person-a'); available = [purchase('foreign-proof'), purchase('owned-proof')];
    await module.restoreSubscription();
    assert.deepEqual(verified, ['foreign-proof', 'owned-proof']); assert.deepEqual(finished, ['owned-proof']);
    assert.equal(state.phase, 'active'); assert.equal(module.subscriptionPurchaseSnapshot().message, null);
    state.phase = 'locked'; available = [purchase('foreign-proof')]; await module.restoreSubscription();
    assert.deepEqual(finished, ['owned-proof']); assert.match(module.subscriptionPurchaseSnapshot().message, /見つかりません|復元できません/);
    let release; restoreHook = () => new Promise(done => { release = done; });
    const restoring = module.restoreSubscription(); await new Promise(setImmediate);
    state.userId = 'person-b'; await module.startSubscriptionPurchases('person-b');
    const replacement = { ...module.subscriptionPurchaseSnapshot() }; release(); await restoring;
    assert.deepEqual(module.subscriptionPurchaseSnapshot(), replacement, 'a late restore cannot alter the new account UI');
    assert.deepEqual(finished, ['owned-proof']);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});
for (const platform of ['ios', 'android']) test(`${platform} immediate notices stop if paid access expires or is revoked during preparation`, async () => {
  const identities = await import('../src/features/sharing/v2/native-identity.ts');
  const queue = await import('../src/features/notifications/reconcile-local-notifications.ts');
  const dates = await import('../src/domain/scheduling/local-date.ts');
  let deadline = Infinity; const sent = [];
  const module = load('src/platform/sharing/v2-immediate-notices.ts', {
    'react-native': { Platform: { OS: platform } }, '../../features/sharing/v2/native-identity': identities,
    '../../features/notifications/reconcile-local-notifications': queue, '../../domain/scheduling/local-date': dates,
    '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: { schedulingDeadline: async () => deadline } },
    'expo-notifications': { AndroidImportance: { DEFAULT: 3 }, setNotificationChannelAsync: async () => {}, scheduleNotificationAsync: async value => sent.push(value) },
  });
  const present = module.createV2ImmediateNoticePresenter({ userId: 'person-a', groupId: 'group-a' }, { prefix: 'notice:', kind: 'v2-housework-completed', channelId: 'completion', channelName: '完了' });
  await present({ key: `notice:${'a'.repeat(64)}`, title: '完了', body: '完了', count: 1 }, async () => {}, async () => { deadline = Date.now() - 1; return true; });
  assert.equal(sent.length, 0);
});
