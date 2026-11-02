import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';
import { publicStoreFixture } from './helpers/appliance-public-store.mjs';
import { createFirestoreSubscriptionStore } from '../server/appliance-care-api/src/firestore-subscription-store.mjs';
import { createSubscriptionService, createSubscriptionSigner, newSubscriptionAccount } from '../server/appliance-care-api/src/subscription-service.mjs';
import { createAppleSubscriptionProvider, createGoogleSubscriptionProvider } from '../server/appliance-care-api/src/subscription-providers.mjs';
import { createSubscriptionHttp } from '../server/appliance-care-api/src/subscription-http.mjs';
import { createApplianceCareHttpServer, startApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { createPublicApiAccess } from '../server/appliance-care-api/src/public-access.mjs';
import { verifySubscriptionEntitlement, hasSubscriptionAccess } from '../src/features/subscription/entitlement.ts';
import { createSubscriptionPurchaseFlow } from '../src/features/subscription/purchase-flow.ts';

const at = Date.UTC(2026, 10, 1); const month = 30 * 24 * 60 * 60_000;
function signer() { const { privateKey } = generateKeyPairSync('ed25519'); return createSubscriptionSigner(privateKey.export({ type: 'pkcs8', format: 'pem' })); }
function setup() {
  const fixture = publicStoreFixture(); const store = createFirestoreSubscriptionStore({ firestore: fixture.firestore, tokenKey: Buffer.alloc(32, 7) });
  const signing = signer(); let clock = at; let providerStatus = 'active'; let acknowledgements = 0;
  const providers = Object.fromEntries(['apple', 'google'].map(name => [name, {
    verify: async proof => ({ store: name, purchaseId: proof, proof, productId: 'liflow.monthly', status: providerStatus, expiresAt: at + month, autoRenew: false }),
    refresh: async record => ({ ...record, status: providerStatus }), acknowledge: async () => { acknowledgements++; },
  }]));
  const service = createSubscriptionService({ store, providers, signer: signing, now: () => clock });
  return { fixture, store, signing, service, providers, clock: value => { clock = value; }, status: value => { providerStatus = value; }, acknowledgements: () => acknowledgements };
}

test('recent server subscription reads reuse verified state without extending expiry and a manual check still observes a fresh revocation', async () => {
  const h = setup(); const first = await h.service.verify('person-a', { store: 'google', proof: 'synthetic-private-purchase-token' });
  let reads = 0; const original = h.providers.google.refresh; h.providers.google.refresh = async (...args) => { reads++; return original(...args); };
  for (let i = 0; i < 20; i++) assert.deepEqual((await h.service.status('person-a')).entitlement.body, first.entitlement.body);
  assert.equal(reads, 0);
  h.clock(at + 5 * 60_000); const renewed = await h.service.status('person-a'); assert.equal(reads, 1);
  assert.equal(renewed.entitlement.body.expiresAt, first.entitlement.body.expiresAt);
  h.status('revoked'); const revoked = await h.service.status('person-a', true); assert.equal(reads, 2); assert.equal(revoked.entitlement.body.status, 'revoked');
  assert.equal((await h.service.status('person-a')).entitlement.body.status, 'revoked'); assert.equal(reads, 2);
});

test('subscription certificates verify real Ed25519 across server and mobile and reject tampering accounts keys replay and expired access', async () => {
  const h = setup(); const result = await h.service.verify('person-a', { store: 'apple', proof: 'original-transaction-a' });
  const options = { userId: 'person-a', publicKey: h.signing.publicKey, now: at };
  const verified = verifySubscriptionEntitlement(result.entitlement, options);
  assert.equal(hasSubscriptionAccess(verified.body, at), true);
  assert.equal(hasSubscriptionAccess(verified.body, verified.body.validUntil), false);
  assert.equal(hasSubscriptionAccess(verified.body, at - 60_001), false);
  for (const field of Object.keys(verified.body)) {
    const changed = structuredClone(verified); changed.body[field] = typeof changed.body[field] === 'number' ? changed.body[field] + 1 : 'forged';
    assert.throws(() => verifySubscriptionEntitlement(changed, options), /契約情報/);
  }
  assert.throws(() => verifySubscriptionEntitlement(verified, { ...options, userId: 'person-b' }));
  assert.throws(() => verifySubscriptionEntitlement(verified, { ...options, publicKey: signer().publicKey }));
  assert.throws(() => verifySubscriptionEntitlement(verified, { ...options, lastRevision: verified.body.revision + 1 }));
  assert.throws(() => verifySubscriptionEntitlement(verified, { ...options, lastCheckedAt: at + 1 }));
  const extended = h.signing.sign({ ...verified.body, validUntil: at + 2 * 24 * 60 * 60_000 });
  assert.throws(() => verifySubscriptionEntitlement(extended, options), 'even a signed incompatible offline interval is rejected');
  assert.equal(h.acknowledgements(), 1);
});

test('subscription ownership survives restart encrypted tokens cannot be rebound and cancelled paid time remains usable until expiry', async () => {
  const h = setup(); await h.service.verify('person-a', { store: 'google', proof: 'synthetic-private-purchase-token' });
  const saved = JSON.stringify([...h.fixture.records.values()]);
  assert.equal(saved.includes('synthetic-private-purchase-token'), false);
  assert.equal(saved.includes('original-transaction-a'), false);
  const restarted = createSubscriptionService({ store: createFirestoreSubscriptionStore({ firestore: h.fixture.firestore, tokenKey: Buffer.alloc(32, 7) }),
    providers: h.providers, signer: h.signing, now: () => at });
  assert.equal((await restarted.refresh('person-a')).entitlement.body.status, 'active');
  await assert.rejects(restarted.verify('person-b', { store: 'google', proof: 'synthetic-private-purchase-token' }), error => error.code === 'PURCHASE_ALREADY_BOUND');
  await h.service.assertActive('person-a');
  h.clock(at + month); const expired = await h.service.refresh('person-a');
  assert.equal(expired.entitlement.body.status, 'expired');
  assert.equal(h.acknowledgements(), 2, 'an expired confirmation must not acknowledge another purchase');
  await assert.rejects(h.service.assertActive('person-a'), error => error.code === 'SUBSCRIPTION_REQUIRED');
  assert.ok(h.fixture.records.size > 0, 'expiry preserves ownership and user data');
});
test('stored subscription proofs reject shortened GCM tags even when the shortened prefix authenticates in Node', async () => {
  const h = setup(); await h.service.verify('person-a', { store: 'google', proof: 'synthetic-private-purchase-token' });
  const [path, saved] = [...h.fixture.records].find(([path]) => path.startsWith('billingPurchases/'));
  const original = structuredClone(saved); const tag = Buffer.from(original.encryptedProof.tag, 'base64'); assert.equal(tag.length, 16);
  for (const length of [4, 8, 12, 13, 14, 15, 17]) {
    const changed = structuredClone(original); changed.encryptedProof.tag = (length <= 16 ? tag.subarray(0, length) : Buffer.concat([tag, Buffer.alloc(1)])).toString('base64');
    h.fixture.records.set(path, changed); await assert.rejects(h.store.purchases('person-a'));
  }
  h.fixture.records.set(path, original); assert.equal((await h.store.purchases('person-a'))[0].proof, 'synthetic-private-purchase-token');
});

test('subscription pending hold grace revocation and provider failure never invent a grant or finish a purchase', async () => {
  for (const status of ['pending', 'onHold', 'grace', 'revoked', 'expired']) {
    const h = setup(); h.status(status); const value = await h.service.verify('person-a', { store: 'apple', proof: 'original-transaction-a' });
    assert.equal(value.entitlement.body.status, status);
    assert.equal(hasSubscriptionAccess(value.entitlement.body, at), status === 'grace');
    assert.equal(h.acknowledgements(), status === 'grace' ? 1 : 0);
  }
  const h = setup(); const before = await h.service.verify('person-a', { store: 'apple', proof: 'original-transaction-a' });
  h.providers.apple.refresh = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(h.service.refresh('person-a'));
  assert.deepEqual(await h.store.entitlement('person-a'), before.entitlement.body);
  h.clock(at + 24 * 60 * 60_000); await assert.rejects(h.service.assertActive('person-a'));
});

test('subscription concurrent stale confirmation cannot overwrite a newer refund or revocation', async () => {
  const h = setup(); await h.service.verify('person-a', { store: 'apple', proof: 'original-transaction-a' });
  const stale = await h.store.begin('person-a'); const fresh = await h.store.begin('person-a');
  const records = await h.store.purchases('person-a');
  await h.store.commit('person-a', fresh.generation, records, () => ({ schemaVersion: 1, userId: 'person-a', revision: fresh.account.revision + 1,
    status: 'revoked', store: 'apple', productId: 'liflow.monthly', checkedAt: at, expiresAt: at + month, validUntil: 0, autoRenew: false }), at);
  await assert.rejects(h.store.commit('person-a', stale.generation, records, () => assert.fail('stale callback must not grant'), at), error => error.code === 'SUBSCRIPTION_RETRY_REQUIRED');
  assert.equal((await h.store.entitlement('person-a')).status, 'revoked');
});

test('Google subscription adapter uses authoritative v2 expiry account and base plan and acknowledges only after durable verification', async () => {
  const account = newSubscriptionAccount('person-a'); const calls = [];
  const data = { externalAccountIdentifiers: { obfuscatedExternalAccountId: account.obfuscatedAccountId },
    subscriptionState: 'SUBSCRIPTION_STATE_CANCELED', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    lineItems: [{ productId: 'monthly', expiryTime: new Date(at + month).toISOString(), offerDetails: { basePlanId: 'month' }, autoRenewingPlan: { autoRenewEnabled: false } }] };
  const provider = createGoogleSubscriptionProvider({ packageName: 'jp.jphacks.tkb2633', productId: 'monthly', basePlanId: 'month', request: async request => { calls.push(request); return { data }; } });
  const result = await provider.verify('synthetic-token', account); assert.equal(result.status, 'active'); assert.equal(result.autoRenew, false);
  assert.equal(result.expiresAt, at + month); assert.match(calls[0].url, /subscriptionsv2\/tokens\//); assert.equal(calls.length, 1);
  await provider.acknowledge(result); assert.match(calls[1].url, /:acknowledge$/);
  await provider.verify('opaque+token/with:=padding', account);
  assert.match(calls.at(-1).url, /opaque%2Btoken%2Fwith%3A%3Dpadding$/);
  await assert.rejects(provider.verify('synthetic-token', newSubscriptionAccount('person-b')), error => error.code === 'PURCHASE_NOT_OWNED');
  for (const state of ['ACTIVE', 'IN_GRACE_PERIOD', 'ON_HOLD', 'PAUSED', 'PENDING', 'EXPIRED', 'PENDING_PURCHASE_CANCELED']) {
    data.subscriptionState = `SUBSCRIPTION_STATE_${state}`; const value = await provider.verify('synthetic-token', account);
    assert.ok(['active', 'grace', 'onHold', 'pending', 'expired'].includes(value.status));
  }
  data.lineItems[0].offerDetails.basePlanId = 'unapproved-year'; await assert.rejects(provider.verify('synthetic-token', account));
  data.lineItems[0].offerDetails.basePlanId = 'month'; data.testPurchase = {};
  await assert.rejects(provider.verify('synthetic-token', account), 'production does not accept license-test purchases by accident');
  delete data.testPurchase; data.subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE'; delete data.acknowledgementState;
  await assert.rejects(provider.verify('synthetic-token', account), 'missing acknowledgement state is not treated as acknowledged');
});

test('Apple subscription adapter verifies current signed transactions account bundle environment and grace rather than a stale client expiry', async () => {
  const account = newSubscriptionAccount('person-a'); let status = 4;
  const transaction = { originalTransactionId: '1234', bundleId: 'jp.jphacks.tkb2633', productId: 'monthly', environment: 'Production',
    appAccountToken: account.appAccountToken, inAppOwnershipType: 'PURCHASED', type: 'Auto-Renewable Subscription', expiresDate: at - 1, signedDate: at };
  const renewal = { originalTransactionId: '1234', productId: 'monthly', environment: 'Production', gracePeriodExpiresDate: at + month, autoRenewStatus: 1 };
  let calls = 0;
  const provider = createAppleSubscriptionProvider({ bundleId: transaction.bundleId, productId: 'monthly', environment: 'Production',
    verifier: { verifyAndDecodeTransaction: async value => { assert.ok(['client-jws', 'current-jws'].includes(value)); return transaction; }, verifyAndDecodeRenewalInfo: async () => renewal },
    client: { getAllSubscriptionStatuses: async original => { assert.equal(original, '1234'); calls++; return { bundleId: transaction.bundleId, environment: transaction.environment,
      data: [{ lastTransactions: [{ originalTransactionId: '1234', status, signedTransactionInfo: 'current-jws', signedRenewalInfo: 'renewal-jws' }] }] }; } } });
  const active = await provider.verify('client-jws', account); assert.equal(active.status, 'grace'); assert.equal(active.expiresAt, at + month); assert.equal(calls, 1);
  status = 5; assert.equal((await provider.refresh(active, account)).status, 'revoked');
  await assert.rejects(provider.verify('client-jws', newSubscriptionAccount('person-b')));
  transaction.environment = 'Sandbox'; await assert.rejects(provider.verify('client-jws', account));
});

test('official Apple verifier refuses malformed and forged JWS without a successful purchase grant', async () => {
  const require = createRequire(new URL('../server/appliance-care-api/package.json', import.meta.url));
  const { SignedDataVerifier, Environment } = require('@apple/app-store-server-library');
  const verifier = new SignedDataVerifier([], false, Environment.PRODUCTION, 'jp.jphacks.tkb2633', 123);
  for (const value of ['', 'not-a-jws', 'eyJhbGciOiJub25lIn0.eyJleHBpcmVzRGF0ZSI6OTk5OTk5OTk5OTk5OX0.forged']) await assert.rejects(verifier.verifyAndDecodeTransaction(value));
});

test('mobile subscription flow deduplicates callbacks keeps pending unfinished retries failures and rejects an account switch', async () => {
  const h = setup(); const signed = (await h.service.verify('person-a', { store: 'apple', proof: 'original-transaction-a' })).entitlement;
  let user = 'person-a'; let verifies = 0; let accepts = 0; let finishes = 0; let fail = true; let resolve;
  const pause = new Promise(done => { resolve = done; });
  const flow = createSubscriptionPurchaseFlow({ userId: 'person-a', productId: 'liflow.monthly', currentUserId: () => user, now: () => at,
    verify: async () => { verifies++; await pause; if (fail) throw new Error('offline'); return signed; },
    accept: async () => { accepts++; }, finish: async () => { finishes++; } });
  const purchase = { id: 'tx-a', productId: 'liflow.monthly', store: 'apple', proof: 'original-transaction-a', state: 'purchased' };
  assert.equal(await flow.process({ ...purchase, state: 'pending' }), 'pending'); assert.equal(verifies, 0);
  const first = flow.process(purchase); const duplicate = flow.process(purchase); assert.equal(first, duplicate); resolve();
  await assert.rejects(first); assert.equal(finishes, 0); assert.equal(accepts, 0);
  fail = false; assert.equal(await flow.process(purchase), 'granted'); await flow.process(purchase);
  assert.deepEqual([verifies, accepts, finishes], [2, 1, 1]);
  user = 'person-b'; assert.throws(() => flow.process(purchase), /アカウント/);
});

test('subscription HTTP requires provider identity rejects body UID and never spends AI quota when no entitlement exists', async () => {
  const h = setup(); let admission = 0; let revokedCheck;
  const subscriptions = createSubscriptionHttp({ service: h.service, providers: h.providers,
    verifyIdToken: async (token, revoked) => { revokedCheck = revoked; if (token !== 'synthetic-valid') throw new Error('bad token'); return { uid: 'person-a', firebase: { sign_in_provider: 'google.com' } }; } });
  const server = createApplianceCareHttpServer({ dependencies: {}, subscriptionAccess: subscriptions,
    publicAccess: { authenticate: async () => ({ uid: 'person-a' }), store: { usage: async () => { admission++; } } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/subscriptions/status`)).status, 401);
    const status = await fetch(`${base}/api/subscriptions/status`, { headers: { authorization: 'Bearer synthetic-valid' } });
    assert.equal(status.status, 200); assert.equal((await status.json()).entitlement.body.status, 'none'); assert.equal(revokedCheck, true);
    assert.equal((await fetch(`${base}/api/subscriptions/verify`, { method: 'POST', headers: { authorization: 'Bearer synthetic-valid', 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'apple', proof: 'original-transaction-a', userId: 'person-b' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/appliance-care/usage`)).status, 402); assert.equal(admission, 0);
    assert.equal((await fetch(`${base}/api/subscriptions/notifications/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('unpaid AI requests stop before native attestation and a paid request checks its entitlement only once', async () => {
  const calls = []; let active = false;
  const access = createPublicApiAccess({ store: publicStoreFixture().store,
    subscriptions: { service: { assertActive: async () => { calls.push('subscription'); if (!active) throw new Error('unpaid'); } } },
    verifyIdToken: async () => { calls.push('identity'); return { uid: 'person-a', firebase: { sign_in_provider: 'google.com' } }; },
    verifyDevice: async () => { calls.push('device'); return { deviceId: 'a'.repeat(64), installationId: 'synthetic-installation-0001', reinstallProtection: 'verified' }; } });
  await assert.rejects(access.authenticate({ headers: { authorization: 'Bearer synthetic-token' } }));
  assert.deepEqual(calls, ['identity', 'subscription']); calls.length = 0; active = true;
  assert.equal((await access.authenticate({ headers: { authorization: 'Bearer synthetic-token' } })).uid, 'person-a');
  assert.deepEqual(calls, ['identity', 'subscription', 'device']);
});

test('public billing and restore remain available when AI attestation is unavailable while every analysis endpoint stays closed', async () => {
  const h = setup(); let work = 0; const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const subscriptions = createSubscriptionHttp({ service: h.service, providers: h.providers,
    verifyIdToken: async () => ({ uid: 'person-a', firebase: { sign_in_provider: 'google.com' } }) });
  let server;
  try {
    const access = createPublicApiAccess({ store: publicStoreFixture().store, subscriptions, verifyIdToken: async () => assert.fail('AI identity must not be used in billing-only mode') });
    server = startApplianceCareHttpServer({ host: '127.0.0.1', port: 0, publicAccess: access, billingOnly: true, aiConfigured: false,
      dependencies: { analyzeUploaded: async () => { work++; throw new Error('must not analyze'); } } });
  } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
  await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/subscriptions/status`, { headers: { authorization: 'Bearer synthetic-token' } })).status, 200);
    for (const path of ['jobs', 'analyze', 'usage']) assert.equal((await fetch(`${base}/api/appliance-care/${path}`, { method: path === 'usage' ? 'GET' : 'POST' })).status, 503);
    assert.equal(work, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
