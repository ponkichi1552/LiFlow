import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import * as entitlement from '../src/features/subscription/entitlement.ts';
import { createSubscriptionSigner } from '../server/appliance-care-api/src/subscription-service.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';

async function fixture(run, options = {}) {
  const fields = ['EXPO_PUBLIC_LIFLOW_SUBSCRIPTIONS', 'EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY', 'EXPO_PUBLIC_APPLIANCE_CARE_API_URL'];
  const previous = fields.map(key => process.env[key]); const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createSubscriptionSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const at = Date.now(); const saved = new Map(); let watcherCount = 0; let failures = options.failures ?? 0;
  let write = async (key, value) => saved.set(key, value);
  const proof = (revision, status = 'active', checkedAt = at) => signer.sign({ schemaVersion: 1, userId: 'person-a', revision,
    status, store: 'google', productId: 'monthly', autoRenew: false, checkedAt, expiresAt: at + 86400_000, validUntil: at + 3600_000 });
  if (options.cached !== false) saved.set('subscription-certificate:person-a', JSON.stringify({ entitlement: proof(10), lastWall: at }));
  process.env[fields[0]] = 'required'; process.env[fields[1]] = signer.publicKey; process.env[fields[2]] = 'https://billing.example.invalid';
  let reply = () => new Promise(() => {}); globalThis.fetch = (...args) => reply(...args);
  const auth = { currentUser: { uid: 'person-a', getIdToken: async () => 'synthetic-token' },
    authStateReady: async () => { if (failures-- > 0) throw new Error('temporary auth failure'); } };
  try {
    const runtime = loadNativeModule('src/platform/subscription/runtime.ts', {
      '../../features/subscription/entitlement': entitlement,
      '../sharing/firebase-services': { getSharingServices: () => ({ auth }) },
      '../sharing/secure-store': { sharingSecureVault: { getItem: async key => saved.get(key) ?? null,
        setItem: (key, value) => write(key, value), removeItem: async key => saved.delete(key) } },
      'firebase/auth': { onAuthStateChanged: () => { watcherCount++; return () => { watcherCount--; }; } },
    }, { setTimeout: () => 1, clearTimeout() {} });
    await run({ runtime, proof, saved, auth, at, watcherCount: () => watcherCount,
      setWrite: fn => { write = fn; }, setReply: fn => { reply = fn; } });
  } finally {
    globalThis.fetch = originalFetch;
    fields.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
}

test('subscription initialization retries after a partial auth failure and leaves exactly one observer', async () => fixture(async h => {
  await h.runtime.startSubscriptions();
  assert.equal(h.watcherCount(), 0, 'a failed initialization must release its auth listener');
  await h.runtime.startSubscriptions();
  assert.equal(h.watcherCount(), 1);
  assert.equal(h.runtime.subscriptionSnapshot().phase, 'active');
}, { failures: 1 }));

test('concurrent signed entitlement acceptance cannot roll back a newer persisted revocation', async () => fixture(async h => {
  await h.runtime.startSubscriptions();
  let release; const writes = [];
  h.setWrite(async (key, value) => {
    const revision = JSON.parse(value).entitlement.body.revision; writes.push(revision);
    if (revision === 12) await new Promise(done => { release = done; });
    h.saved.set(key, value);
  });
  const newer = h.runtime.acceptSubscription(h.proof(12, 'revoked'));
  await new Promise(setImmediate);
  const older = h.runtime.acceptSubscription(h.proof(11));
  const refusal = assert.rejects(older);
  release(); await newer; await refusal;
  assert.deepEqual(writes, [12]);
  assert.equal(h.runtime.subscriptionSnapshot().entitlement.body.revision, 12);
  assert.equal(h.runtime.subscriptionSnapshot().phase, 'locked');
  assert.equal(JSON.parse(h.saved.get('subscription-certificate:person-a')).entitlement.body.revision, 12);
}));

test('verified revocation denies local access despite a failed secure write while forged revocation cannot lock an account', async () => fixture(async h => {
  await h.runtime.startSubscriptions();
  const forged = h.proof(11, 'revoked'); forged.signature = '0'.repeat(128);
  await assert.rejects(h.runtime.acceptSubscription(forged));
  assert.equal(h.runtime.subscriptionSnapshot().phase, 'active');
  h.setWrite(async () => { throw new Error('secure storage unavailable'); });
  await assert.rejects(h.runtime.acceptSubscription(h.proof(12, 'revoked')));
  assert.equal(h.runtime.subscriptionSnapshot().phase, 'locked');
  assert.equal(h.runtime.subscriptionSnapshot().entitlement.body.revision, 12);
  await assert.rejects(h.runtime.acceptSubscription(h.proof(11)));
}));

test('a fresh authenticated server response recovers an accidental future wall clock without accepting an old signed revision', async () => fixture(async h => {
  const originalNow = Date.now;
  try {
    await h.runtime.startSubscriptions();
    Date.now = () => h.at + 365 * 86400_000;
    await h.runtime.acceptSubscription(h.proof(11));
    assert.equal(h.runtime.subscriptionSnapshot().phase, 'locked');
    Date.now = () => h.at + 1000;
    h.setReply(async () => ({ ok: true, json: async () => ({ entitlement: h.proof(12, 'active', h.at + 1000),
      account: { appAccountToken: '12345678-1234-1234-1234-123456789012', obfuscatedAccountId: 'a'.repeat(64) } }) }));
    await h.runtime.subscriptionRequest('status');
    assert.equal(h.runtime.subscriptionSnapshot().phase, 'active');
    await assert.rejects(h.runtime.acceptSubscription(h.proof(10)));
    assert.equal(h.runtime.subscriptionSnapshot().entitlement.body.revision, 12);
  } finally { Date.now = originalNow; }
}));
