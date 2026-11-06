import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { syntheticManual } from './helpers/synthetic-pdf.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc } from 'firebase/firestore';
import { createPublicApiAccess, PUBLIC_API_POLICY, publicKey } from '../server/appliance-care-api/src/public-access.mjs';
import { createFirestoreUsageStore as buildFirestoreUsageStore } from '../server/appliance-care-api/src/firestore-usage-store.mjs';
import { syntheticAnalysisQueueKeys } from './helpers/appliance-public-store.mjs';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { createFirebasePublicRuntime } from '../server/appliance-care-api/src/firebase-public-runtime.mjs';
import { runAnalysisQueueBatch } from '../server/appliance-care-api/src/analysis-queue-worker.mjs';
import { analysisRequestKey } from '../server/appliance-care-api/src/analysis-runner.mjs';
import { decodeUploadedManual, MAX_MANUAL_BYTES } from '../server/appliance-care-api/src/uploaded-manual.mjs';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST
  || !/^127\.0\.0\.1:\d+$/u.test(process.env.FIRESTORE_EMULATOR_HOST)
  || !/^127\.0\.0\.1:\d+$/u.test(process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error('Use isolated local Firestore and Auth emulators only');
const serverRequire = createRequire(new URL('../server/appliance-care-api/package.json', import.meta.url));
const { initializeApp, deleteApp } = serverRequire('firebase-admin/app');
const { getAuth } = serverRequire('firebase-admin/auth');
const { getFirestore } = serverRequire('firebase-admin/firestore');
const projectId = 'demo-liflow-sharing'; let env; let admin; let firestore; let auth;
const createFirestoreUsageStore = options => buildFirestoreUsageStore({ analysisQueueKeys: syntheticAnalysisQueueKeys(), ...options });
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  admin = initializeApp({ projectId }, 'appliance-api-integration'); firestore = getFirestore(admin); auth = getAuth(admin);
});
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await firestore?.terminate(); await deleteApp(admin); await env?.cleanup(); });
const who = (uid, device = uid, installationId = 'synthetic-installation-0001') => ({ uid, anonymous: false, deviceId: publicKey(device), installationId });
const input = (uid, key, forceReanalysis = false) => ({ principal: who(uid), requestKey: key, forceReanalysis, idempotencyKey: `request-${key}-synthetic` });
const output = { status: 'not_found', code: 'PRODUCT_NOT_FOUND', message: '合成した検査用製品です。' };

test('real Firestore queues a maximum PDF atomically and independent workers claim paid execution once without exposing its chunks', async () => {
  const bytes = Buffer.alloc(MAX_MANUAL_BYTES, 32); bytes.write('%PDF-1.4\n'); bytes.write('%%EOF', bytes.length - 5);
  const request = { manufacturer: '検査', productName: '合成製品', modelNumber: 'QA', manual: decodeUploadedManual({ rightsConfirmed: true, base64: bytes.toString('base64') }) };
  const stores = [createFirestoreUsageStore({ firestore }), createFirestoreUsageStore({ firestore })];
  await stores[0].heartbeatAnalysisWorker();
  const receipt = await stores[0].admit({ ...input('queue-owner', 'maximum-pdf'), requestKey: analysisRequestKey(request), analysisRequest: request });
  const chunks = await firestore.collection('applianceApi/v1/analysisInputChunks').get();
  const queued = (await firestore.doc(`applianceApi/v1/jobs/${receipt.jobId}`).get()).data();
  assert.ok(chunks.size > 1); assert.equal(chunks.docs.reduce((sum, doc) => sum + doc.data().bytes.length, 0), queued.inputManifest.bytes);
  assert.ok(queued.inputManifest.bytes < 10 * 1024 * 1024); assert.doesNotMatch(JSON.stringify(queued), /合成製品|base64|manufacturer/u);
  for (const uid of [null, 'queue-owner', 'someone-else']) {
    const client = uid === null ? env.unauthenticatedContext().firestore() : env.authenticatedContext(uid).firestore();
    await assertFails(getDocFromServer(doc(client, chunks.docs[0].ref.path)));
    await assertFails(setDoc(doc(client, chunks.docs[0].ref.path), { bytes: 'changed' }));
  }
  const claims = await Promise.all(stores.map(store => store.claimAnalysis(receipt.jobId))); assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean); const decoded = await stores[1].readAnalysisInput(claim); assert.deepEqual(decoded.manual.bytes, bytes);
  assert.equal(await stores[1].startAnalysis(claim.admission), true); assert.equal(await stores[0].startAnalysis(claim.admission), false);
  const largeResult = { status: 'verified', synthetic: 'x'.repeat(690 * 1024) };
  assert.equal(await stores[1].stageAnalysisResult(claim.admission, largeResult), true);
  await stores[0].finish(claim.admission, { status: 'error', code: 'AI_SERVICE_NO_RESULT' });
  assert.deepEqual((await stores[0].read(who('queue-owner'), receipt.jobId)).result, largeResult, 'settlement uses the single durable result field');
  assert.equal((await firestore.collection('applianceApi/v1/analysisInputChunks').get()).size, 0);
  assert.equal((await stores[1].usage(who('queue-owner'))).used, 1);
});

test('real Firestore resumes staged AI settlement after a worker restart without another paid invocation or lost no-result refund', async () => {
  let clock = Date.now(); const now = () => clock; const store = () => createFirestoreUsageStore({ firestore, now });
  const request = { manufacturer: '検査', productName: '合成製品', modelNumber: 'QA', manual: decodeUploadedManual(syntheticManual()) };
  await store().heartbeatAnalysisWorker();
  const receipt = await store().admit({ ...input('queue-owner', 'staged-result'), requestKey: analysisRequestKey(request), analysisRequest: request });
  let calls = 0; const monitor = [];
  const execute = change => runAnalysisQueueBatch({ store: store(), now, authorize: async () => {}, createDependencies: () => ({}), monitor: event => monitor.push(event),
    analyze: async () => { calls++; return { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: '合成したOpenAI無応答' }; }, ...change });
  assert.equal((await execute({ checkpoint: async phase => { if (phase === 'resultStaged') throw new Error('synthetic worker stop'); } })).failed, 1);
  clock += PUBLIC_API_POLICY.jobTimeoutMs + 1;
  assert.equal((await execute({})).settled, 1); assert.equal(calls, 1);
  assert.equal((await store().read(who('queue-owner'), receipt.jobId)).result.code, 'AI_SERVICE_NO_RESULT');
  assert.equal((await store().usage(who('queue-owner'))).used, 0);
});

test('real Firestore replaces an expired preparing claimant but never takes over paid execution before its hard deadline', async () => {
  let clock = Date.now(); const now = () => clock; const store = () => createFirestoreUsageStore({ firestore, now });
  const request = { manufacturer: '検査', productName: '合成製品', modelNumber: 'QA', manual: decodeUploadedManual(syntheticManual()) };
  await store().heartbeatAnalysisWorker();
  const receipt = await store().admit({ ...input('queue-owner', 'claim-recovery'), requestKey: analysisRequestKey(request), analysisRequest: request });
  const first = await store().claimAnalysis(receipt.jobId); clock += 30_000;
  const second = await store().claimAnalysis(receipt.jobId);
  assert.equal(await store().startAnalysis(first.admission), false); assert.equal(await store().startAnalysis(second.admission), true);
  clock += 30_000; assert.equal(await store().claimAnalysis(receipt.jobId), null);
  clock = receipt.deadlineAt; const expired = await store().claimAnalysis(receipt.jobId);
  assert.equal(expired.result.code, 'ANALYSIS_INTERRUPTED'); await store().finish(expired.admission, expired.result);
  assert.equal((await store().read(who('queue-owner'), receipt.jobId)).done, true);
});

test('real Firestore refuses a new paid admission without a live worker and prunes expired private input without downloading it into the query', async () => {
  let clock = Date.now(); const now = () => clock; const store = () => createFirestoreUsageStore({ firestore, now });
  const request = { manufacturer: '検査', productName: '合成製品', modelNumber: 'QA', manual: decodeUploadedManual(syntheticManual()) };
  const admission = { ...input('queue-owner', 'worker-gate'), requestKey: analysisRequestKey(request), analysisRequest: request };
  await assert.rejects(store().admit(admission), error => error.code === 'ANALYSIS_WORKER_UNAVAILABLE');
  assert.equal((await firestore.collection('applianceApi/v1/admissions').get()).size, 0);
  await store().heartbeatAnalysisWorker(); const receipt = await store().admit(admission);
  clock += 90_000;
  await assert.rejects(store().admit({ ...admission, forceReanalysis: true, idempotencyKey: 'synthetic-stale-worker-admission' }), error => error.code === 'ANALYSIS_WORKER_UNAVAILABLE');
  assert.equal((await store().admit(admission)).jobId, receipt.jobId); assert.equal((await store().usage(who('queue-owner'))).used, 1);
  clock = receipt.deadlineAt + 1; assert.ok(await store().prune());
  assert.equal((await firestore.collection('applianceApi/v1/analysisInputChunks').get()).size, 0);
  let calls = 0;
  assert.equal((await runAnalysisQueueBatch({ store: store(), now, authorize: async () => {}, createDependencies: () => ({}), analyze: async () => { calls++; return output; } })).settled, 1);
  assert.equal(calls, 0); assert.equal((await store().read(who('queue-owner'), receipt.jobId)).result.code, 'ANALYSIS_INTERRUPTED');
});

async function guest() {
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic-test-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  const body = await response.json(); assert.equal(response.status, 200);
  return { uid: body.localId, token: body.idToken };
}

async function google() {
  const sub = randomUUID();
  const idToken = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub, email: `${sub}@synthetic.example`, email_verified: true, aud: 'synthetic-google-client', iss: 'https://accounts.google.com' })).toString('base64url') + '.';
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=synthetic-test-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestUri: 'http://localhost',
      postBody: new URLSearchParams({ providerId: 'google.com', id_token: idToken }).toString(), returnSecureToken: true }),
  });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  return { uid: body.localId, token: body.idToken };
}

test('real Firestore transactions collapse forty concurrent identical admissions across two server instances to one charge and one worker', async () => {
  const stores = [createFirestoreUsageStore({ firestore }), createFirestoreUsageStore({ firestore })];
  const receipts = await Promise.all(Array.from({ length: 40 }, (_, i) => stores[i % 2].admit(input('a', 'shared', true))));
  assert.equal(receipts.filter(item => item.created).length, 1); assert.equal(new Set(receipts.map(item => item.jobId)).size, 1);
  assert.equal((await stores[0].usage(who('a'))).used, 1);
  assert.equal(await stores[1].read(who('other-user'), receipts[0].jobId), null);
  const receipt = receipts.find(item => item.created); await stores[1].finish(receipt, output);
  assert.deepEqual((await stores[0].read(who('a'), receipt.jobId)).result, output);
});

test('real Firestore enforces monthly five, reanalysis, cold restart, and the exact Japan 09:00 monthly reset', async () => {
  let clock = Date.parse('2026-12-31T23:59:59.999Z');
  const create = () => createFirestoreUsageStore({ firestore, now: () => clock });
  const store = create();
  for (let i = 0; i < 5; i++) await store.finish(await store.admit(input('monthly-user', `monthly-${i}`, true)), output);
  const restart = create();
  await assert.rejects(restart.admit(input('monthly-user', 'sixth')), error => error.code === 'MONTHLY_LIMIT_REACHED');
  assert.equal((await restart.usage(who('monthly-user'))).used, 5);
  clock++;
  assert.equal((await restart.admit(input('monthly-user', 'january'))).usage.remaining, 4);
});

test('real Firestore cannot exceed global daily twenty by generating more accounts or racing server reservations', async () => {
  const policy = { ...PUBLIC_API_POLICY, maxConcurrent: 50 };
  const stores = [createFirestoreUsageStore({ firestore, policy }), createFirestoreUsageStore({ firestore, policy })];
  const outcomes = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => stores[i % 2].admit(input(`guest-${i}`, `job-${i}`))));
  let accepted = outcomes.filter(item => item.status === 'fulfilled').length;
  assert.ok(accepted > 0 && accepted <= 20);
  for (const item of outcomes.filter(item => item.status === 'rejected')) {
    assert.ok(item.reason.code === 'SERVICE_LIMIT_REACHED' || item.reason.code === 10, 'contention may abort without accepting work');
  }
  const counts = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[0].usage(who(`guest-${i}`))));
  assert.equal(counts.reduce((sum, item) => sum + item.used, 0), accepted, 'aborted races neither charge nor reserve a job');
  // Fill unused capacity sequentially, then prove the hard ceiling independently of contention/retry scheduling.
  for (; accepted < 20; accepted++) await stores[0].admit(input(`refill-${accepted}`, `refill-${accepted}`));
  await assert.rejects(stores[1].admit(input('last-new-identity', 'over-global-limit')), error => error.code === 'SERVICE_LIMIT_REACHED');
});

test('real Firestore quotas and private job results cannot be read or rewritten directly by guests account owners or other users', async () => {
  const store = createFirestoreUsageStore({ firestore }); const receipt = await store.admit(input('owner', 'private-job'));
  await store.finish(receipt, output);
  for (const uid of [null, 'owner', 'other']) {
    const client = uid === null ? env.unauthenticatedContext().firestore() : env.authenticatedContext(uid).firestore();
    for (const path of [`applianceApi/v1/jobs/${receipt.jobId}`, 'applianceApi/v1/control/global', 'applianceApi/v1/usage/synthetic']) {
      await assertFails(getDocFromServer(doc(client, path))); await assertFails(setDoc(doc(client, path), { count: 0 }));
    }
  }
});

test('real Firebase Admin authentication accepts an emulator Google user and rejects anonymous identity, rejects disabled users and never reveals other users jobs over HTTP', async () => {
  const a = await google(); const b = await google();
  const store = createFirestoreUsageStore({ firestore });
  const access = createPublicApiAccess({ verifyDevice: async (_req, { uid }) => ({ ...who(uid), reinstallProtection: 'verified' }), store, verifyIdToken: (token, revoked) => auth.verifyIdToken(token, revoked) });
  let calls = 0;
  const dependencies = { async analyzeUploaded() { calls++; throw new Error('synthetic no paid AI'); } };
  const server = createApplianceCareHttpServer({ publicAccess: access, dependencies });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ manufacturer: 'Dyson', productName: '合成製品', modelNumber: 'QA', manual: syntheticManual() });
    const anonymous = await guest();
    assert.equal((await fetch(base + '/api/appliance-care/usage', { headers: { authorization: `Bearer ${anonymous.token}` } })).status, 403);
    await store.heartbeatAnalysisWorker();
    const response = await fetch(base + '/api/appliance-care/jobs', { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'x-idempotency-key': 'synthetic-integration-job', 'content-type': 'application/json' }, body });
    assert.equal(response.status, 202); const receipt = await response.json(); assert.equal(receipt.usage.used, 1);
    assert.equal((await fetch(base + '/api/appliance-care/jobs/' + receipt.jobId, { headers: { authorization: `Bearer ${b.token}` } })).status, 404);
    assert.equal(calls, 0);
    assert.equal((await runAnalysisQueueBatch({ store: createFirestoreUsageStore({ firestore }), authorize: async () => {}, createDependencies: () => dependencies })).settled, 1);
    assert.equal(calls, 1);
    await auth.updateUser(a.uid, { disabled: true });
    assert.equal((await fetch(base + '/api/appliance-care/usage', { headers: { authorization: `Bearer ${a.token}` } })).status, 401);
    assert.equal((await fetch(base + '/api/appliance-care/jobs', { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body })).status, 401);
    assert.equal(calls, 1);
  } finally { const done = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await done; }
});

test('public production configuration refuses emulator authentication and the official Admin verifier rejects an unsigned token outside emulator mode', async () => {
  assert.throws(() => createFirebasePublicRuntime({ NODE_ENV: 'production', APPLIANCE_CARE_FIREBASE_PROJECT_ID: projectId,
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST }), /cannot use an emulator/);
  const a = await guest();
  const source = `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(new URL('../server/appliance-care-api/package.json', import.meta.url).href)});
    const {initializeApp}=require('firebase-admin/app');const {getAuth}=require('firebase-admin/auth');
    const app=initializeApp({projectId:'demo-liflow-sharing'});let rejected=false;
    try{await getAuth(app).verifyIdToken(process.env.SYNTHETIC_EMULATOR_ID_TOKEN)}catch{rejected=true}
    if(!rejected)throw new Error('Unsigned token accepted in production');console.log('unsigned-token-rejected');`;
  const childEnv = { ...process.env, SYNTHETIC_EMULATOR_ID_TOKEN: a.token };
  delete childEnv.FIREBASE_AUTH_EMULATOR_HOST; delete childEnv.FIRESTORE_EMULATOR_HOST;
  const check = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { env: childEnv, encoding: 'utf8', timeout: 10_000 });
  assert.equal(check.status, 0, check.stderr); assert.equal(check.stdout.trim(), 'unsigned-token-rejected');
});

test('expired API records prune without resetting monthly usage or deleting a concurrently renewed cache pointer or group data', async () => {
  let clock = Date.parse('2026-10-10T00:00:00Z'); const store = createFirestoreUsageStore({ firestore, now: () => clock });
  const item = await store.admit(input('prune-user', 'prune-first')); await store.finish(item, output);
  const unrelated = firestore.doc('sharingGroups/preserved-by-api-pruning'); await unrelated.set({ synthetic: true });
  clock += PUBLIC_API_POLICY.retentionMs + 1;
  await store.ready(); assert.equal(await store.prune(), 2);
  assert.equal((await store.usage(who('prune-user'))).used, 1); assert.equal((await unrelated.get()).exists, true);
  assert.equal(await store.read(who('prune-user'), item.jobId), null);
  const reuse = firestore.doc('applianceApi/v1/reuse/synthetic-renewed-pointer');
  await reuse.set({ jobId: 'before', expiresAt: new Date(clock - 1) });
  const renewalStore = createFirestoreUsageStore({ now: () => clock, firestore: {
    collection: (...args) => firestore.collection(...args),
    batch() { const batch = firestore.batch(); return {
      delete: (...args) => batch.delete(...args), async commit() {
        await reuse.set({ jobId: 'newer-accepted-job', expiresAt: new Date(clock + 86400_000) }); return batch.commit();
      },
    }; },
  } });
  await assert.rejects(renewalStore.prune(), error => error.code === 9);
  assert.equal((await reuse.get()).data().jobId, 'newer-accepted-job');
});

test('revoked Firebase refresh tokens cannot poll or start further API work even while the original ID token has not expired', async () => {
  const user = await google(); const access = createPublicApiAccess({ verifyDevice: async (_req, { uid }) => ({ ...who(uid), reinstallProtection: 'verified' }), store: createFirestoreUsageStore({ firestore }),
    verifyIdToken: (token, revoked) => auth.verifyIdToken(token, revoked) });
  const req = { headers: { authorization: `Bearer ${user.token}` } };
  assert.equal((await access.authenticate(req)).uid, user.uid);
  // Firebase auth_time has second resolution; move the revocation into a strictly later second.
  await new Promise(resolve => setTimeout(resolve, 1100)); await auth.revokeRefreshTokens(user.uid);
  await assert.rejects(access.authenticate(req), error => error.status === 401);
});

test('real Firestore synchronizes device and account minimum quotas and retains a first-account reinstall lock across denied requests and server restart', async () => {
  let clock = Date.parse('2026-10-31T23:59:59.999Z'); const store = createFirestoreUsageStore({ firestore, now: () => clock });
  const first = who('first-monthly', 'same-device'); const second = who('second-monthly', 'same-device');
  for (let n = 0; n < 3; n++) { const accepted = await store.admit({ ...input(first.uid, `device-count-${n}`), principal: first }); await store.finish(accepted, output); }
  assert.equal((await store.usage(second)).remaining, 2);
  const reinstalled = { ...second, installationId: 'synthetic-installation-0002' };
  await assert.rejects(store.admit({ ...input(second.uid, 'after-reinstall'), principal: reinstalled }), e => e.code === 'REINSTALL_ACCOUNT_LOCKED');
  const restarted = createFirestoreUsageStore({ firestore, now: () => clock });
  await assert.rejects(restarted.usage(second), e => e.code === 'REINSTALL_ACCOUNT_LOCKED');
  assert.equal((await restarted.usage({ ...first, installationId: reinstalled.installationId })).remaining, 2);
  clock++;
  assert.equal((await restarted.usage(reinstalled)).remaining, 5);
});

test('real Firestore refunds a confirmed OpenAI no-result failure through copied quotas while retaining zero-use first-account bindings and the daily attempt count', async () => {
  let clock = Date.parse('2026-10-10T00:00:00Z'); const store = createFirestoreUsageStore({ firestore, now: () => clock });
  const first = who('refund-first', 'phone'); const copy = who('refund-second', 'phone');
  assert.equal((await store.usage(first)).remaining, 5);
  const item = await store.admit({ ...input(first.uid, 'upstream-outage'), principal: first });
  assert.equal((await store.usage(copy)).remaining, 4);
  assert.ok((await firestore.collection('applianceApi/v1/quotaStates').limit(1).get()).size > 0, 'immutable quota provenance is persisted');
  await store.finish(item, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: '合成したOpenAIの無応答' });
  assert.equal((await store.usage(copy)).remaining, 5); assert.equal((await store.usage(first)).remaining, 5);
  // The no-use monthly binding survives a reinstall and is independent of a refunded admission.
  assert.equal((await store.usage({ ...first, installationId: 'synthetic-reinstalled-0002' })).remaining, 5);
  await assert.rejects(store.usage({ ...copy, installationId: 'synthetic-reinstalled-0002' }), e => e.code === 'REINSTALL_ACCOUNT_LOCKED');
  const daily = (await firestore.doc('applianceApi/v1/dailyUsage/2026-10-10').get()).data(); assert.equal(daily.count, 1);
  // Result retention expires after seven days; the refund evidence must last through the quota period.
  clock += PUBLIC_API_POLICY.retentionMs + 1; await store.prune();
  const cold = createFirestoreUsageStore({ firestore, now: () => clock });
  assert.equal((await cold.usage({ ...first, installationId: 'synthetic-reinstalled-0002' })).remaining, 5);
});
