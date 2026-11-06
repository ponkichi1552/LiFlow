import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDocFromServer } from 'firebase/firestore';
import { createFirestoreSubscriptionStore } from '../server/appliance-care-api/src/firestore-subscription-store.mjs';
import { createSubscriptionService, createSubscriptionSigner } from '../server/appliance-care-api/src/subscription-service.mjs';

if (!/^127\.0\.0\.1:\d+$/u.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Subscription attack tests require the isolated local Firestore emulator');
const require = createRequire(new URL('../server/appliance-care-api/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app'); const { getFirestore } = require('firebase-admin/firestore');
let env, app, firestore;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  app = initializeApp({ projectId: 'demo-liflow-sharing' }, 'liflow-subscription-tests'); firestore = getFirestore(app);
});
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await firestore?.terminate(); await deleteApp(app); await env?.cleanup(); });
function service(overrides = {}, now = Date.now) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createSubscriptionSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const store = createFirestoreSubscriptionStore({ firestore, tokenKey: Buffer.alloc(32, 9) });
  const google = { verify: async proof => ({ store: 'google', purchaseId: proof, proof, productId: 'monthly', status: 'active', expiresAt: Date.now() + 30 * 86400_000, autoRenew: true }),
    refresh: async record => record, ...overrides };
  return { store, value: createSubscriptionService({ store, signer, providers: { google }, now }) };
}

test('real Firestore acknowledgement queue survives a failed reply and server restart while all client access is denied', async () => {
  let at = Date.now(); let acknowledged = false; let failed = false; let calls = 0;
  const provider = {
    verify: async proof => ({ store: 'google', purchaseId: proof, proof, productId: 'monthly', status: 'active', expiresAt: at + 30 * 86400_000, autoRenew: true, acknowledgementPending: !acknowledged }),
    refresh: async record => ({ ...record, acknowledgementPending: !acknowledged }),
    acknowledge: async () => { calls++; if (!failed) { failed = true; throw new Error('synthetic lost acknowledgement'); } acknowledged = true; },
  };
  const original = service(provider, () => at);
  await assert.rejects(original.value.verify('person-a', { store: 'google', proof: 'synthetic-private-queued-token' }));
  const pending = await firestore.collection('billingAcknowledgements').get(); assert.equal(pending.size, 1);
  assert.equal(JSON.stringify(pending.docs[0].data()).includes('synthetic-private-queued-token'), false);
  for (const userId of ['person-a', 'person-b']) {
    const client = env.authenticatedContext(userId).firestore(); const ref = doc(client, 'billingAcknowledgements', pending.docs[0].id);
    await assertFails(getDocFromServer(ref)); await assertFails(setDoc(ref, { userId, nextAttemptAt: 0 }));
  }
  at += 60_000;
  const results = await Promise.all([service(provider, () => at).value.retryAcknowledgements(), service(provider, () => at).value.retryAcknowledgements()]);
  assert.equal(results.reduce((sum, result) => sum + result.completed, 0), 1);
  assert.equal(calls, 2); assert.equal((await firestore.collection('billingAcknowledgements').get()).size, 0);
  assert.equal((await service(provider, () => at).value.refresh('person-a')).entitlement.body.status, 'active');
  assert.equal(calls, 2);
});

test('real paid Firestore access refuses unpaid expired held and forged grants while paid members still cannot read another group', async () => {
  await firestore.doc('serviceConfiguration/billing').set({ enforced: true });
  await firestore.doc('sharingGroups/own-house').set({ memberIds: ['person-a'], revokedUserIds: [], closed: false });
  await firestore.doc('sharingGroups/another-house').set({ memberIds: ['person-b'], revokedUserIds: [], closed: false });
  const client = env.authenticatedContext('person-a').firestore();
  await assertFails(getDocFromServer(doc(client, 'sharingGroups/own-house')));
  for (const status of ['pending', 'onHold', 'revoked', 'expired']) {
    await firestore.doc('billingEntitlements/person-a').set({ userId: 'person-a', status, expiresAt: Date.now() + 60_000, validUntil: Date.now() + 60_000 });
    await assertFails(getDocFromServer(doc(client, 'sharingGroups/own-house')));
  }
  for (const status of ['active', 'grace']) {
    await firestore.doc('billingEntitlements/person-a').set({ userId: 'person-a', status, expiresAt: Date.now() + 60_000, validUntil: Date.now() + 60_000 });
    await assertSucceeds(getDocFromServer(doc(client, 'sharingGroups/own-house')));
    await assertFails(getDocFromServer(doc(client, 'sharingGroups/another-house')));
  }
  await firestore.doc('billingEntitlements/person-a').set({ userId: 'person-a', status: 'active', expiresAt: Date.now() + 60_000, validUntil: Date.now() - 1 });
  // A fresh connection evaluates the current deadline rather than a just-completed watch's reused result.
  const expiredClient = env.authenticatedContext('person-a').firestore();
  await assertFails(getDocFromServer(doc(expiredClient, 'sharingGroups/own-house')));
  for (const path of ['serviceConfiguration/billing', 'billingEntitlements/person-a', 'billingEntitlements/person-b', 'billingAccounts/person-a', 'billingPurchases/forged']) {
    await assertFails(setDoc(doc(client, path), { enforced: false, userId: 'person-a', status: 'active', validUntil: Date.now() + 86400_000 }));
  }
});

test('real Firestore atomically binds one store purchase to one account across server restarts and concurrent requests', async () => {
  const a = service(), b = service();
  const results = await Promise.allSettled([a.value.verify('person-a', { store: 'google', proof: 'synthetic-shared-token' }), b.value.verify('person-b', { store: 'google', proof: 'synthetic-shared-token' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const denied = results.find(result => result.status === 'rejected'); assert.equal(denied.reason.code, 'PURCHASE_ALREADY_BOUND');
  const winner = results[0].status === 'fulfilled' ? 'person-a' : 'person-b'; const loser = winner === 'person-a' ? 'person-b' : 'person-a';
  assert.equal((await service().value.refresh(winner)).entitlement.body.status, 'active');
  await assert.rejects(service().value.verify(loser, { store: 'google', proof: 'synthetic-shared-token' }), error => error.code === 'PURCHASE_ALREADY_BOUND');
  const rows = await firestore.collection('billingPurchases').get(); assert.equal(rows.size, 1);
  assert.equal(JSON.stringify(rows.docs[0].data()).includes('synthetic-shared-token'), false);
  const data = rows.docs[0].data(); data.encryptedProof.tag = Buffer.alloc(16).toString('base64'); await rows.docs[0].ref.set(data);
  await assert.rejects(service().value.refresh(winner));
});

test('public subscription startup refuses a missing disabled or client-forged enforcement switch', async () => {
  const h = service(); await assert.rejects(h.store.ready());
  await firestore.doc('serviceConfiguration/billing').set({ enforced: false }); await assert.rejects(h.store.ready());
  await firestore.doc('serviceConfiguration/billing').set({ enforced: true }); await h.store.ready();
});
