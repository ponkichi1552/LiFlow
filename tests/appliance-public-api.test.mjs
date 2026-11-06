import { syntheticManual } from './helpers/synthetic-pdf.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { createPublicApiAccess, PUBLIC_API_POLICY, publicJobId, publicKey, usagePeriods } from '../server/appliance-care-api/src/public-access.mjs';
import { createFirestoreUsageStore } from '../server/appliance-care-api/src/firestore-usage-store.mjs';
import { publicStoreFixture } from './helpers/appliance-public-store.mjs';
import { runAnalysisQueueBatch } from '../server/appliance-care-api/src/analysis-queue-worker.mjs';

const principal = (uid, device = uid, installationId = 'synthetic-installation-0001') => ({ uid, anonymous: false, deviceId: publicKey(device), installationId });
const admission = (uid, key, force = false) => ({ principal: principal(uid), requestKey: key,
  forceReanalysis: force, idempotencyKey: `synthetic-request-${key}` });
const result = { status: 'not_found', code: 'PRODUCT_NOT_FOUND', message: '合成した検査結果' };

test('public API monthly boundary is every first day at 09:00 Japan time including leap years and year rollover', () => {
  for (let year = 2024; year <= 2030; year++) for (let month = 0; month < 12; month++) {
    const boundary = Date.UTC(year, month, 1);
    const before = usagePeriods(boundary - 1); const after = usagePeriods(boundary);
    assert.equal(before.monthResetAt, boundary); assert.notEqual(before.month, after.month);
    assert.equal(after.month, `${year}-${String(month + 1).padStart(2, '0')}`);
    assert.equal(after.monthResetAt, Date.UTC(year, month + 1, 1));
    assert.equal(new Date(boundary).toLocaleString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }), '09:00');
  }
});

test('public API authenticates with revocation checking and rejects missing malformed expired foreign and disabled identities', async () => {
  const calls = [];
  const access = createPublicApiAccess({ verifyDevice: async (_req, { uid }) => ({ ...principal(uid), reinstallProtection: 'verified' }), store: publicStoreFixture().store, verifyIdToken: async (token, revoked) => {
    calls.push([token, revoked]); if (token !== 'synthetic-valid') throw new Error('sensitive upstream detail');
    return { uid: 'user-a', firebase: { sign_in_provider: 'google.com' } };
  } });
  for (const header of [undefined, '', 'Basic synthetic', ['Bearer synthetic-valid'], 'Bearer x\ny', 'Bearer ' + 'x'.repeat(17000)]) {
    await assert.rejects(access.authenticate({ headers: { authorization: header } }), error => error.status === 401);
  }
  for (const token of ['expired', 'wrong-audience', 'disabled', 'unsigned', 'revoked']) {
    await assert.rejects(access.authenticate({ headers: { authorization: `Bearer ${token}` } }), error => error.status === 401 && !error.message.includes('sensitive'));
  }
  assert.deepEqual(await access.authenticate({ headers: { authorization: 'Bearer synthetic-valid' } }), principal('user-a'));
  assert.ok(calls.every(call => call[1] === true));
  for (const provider of ['anonymous', 'password', 'custom', undefined]) {
    const blocked = createPublicApiAccess({ verifyDevice: async (_req, { uid }) => ({ ...principal(uid), reinstallProtection: 'verified' }), store: publicStoreFixture().store,
      verifyIdToken: async () => ({ uid: 'a', firebase: { sign_in_provider: provider } }) });
    await assert.rejects(blocked.authenticate({ headers: { authorization: 'Bearer synthetic' } }), error => error.status === 403);
  }
});

test('public API allows exactly five monthly admissions counts reanalysis and preserves the counter across store restart', async () => {
  let clock = Date.parse('2026-10-31T23:59:59.999Z');
  const f = publicStoreFixture({ now: () => clock });
  for (let i = 0; i < 5; i++) {
    const item = await f.store.admit(admission('a', `a-${i}`, i % 2 === 0));
    assert.equal(item.usage.remaining, 4 - i); await f.store.finish(item, result);
  }
  const restarted = createFirestoreUsageStore({ firestore: f.firestore, now: () => clock });
  await assert.rejects(restarted.admit(admission('a', 'sixth')), error => error.code === 'MONTHLY_LIMIT_REACHED' && error.details.usage.used === 5);
  clock++;
  assert.equal((await restarted.admit(admission('a', 'next-month'))).usage.remaining, 4);
});

test('public API concurrent resends start one job and charge once while other identities never reuse or read that result', async () => {
  const f = publicStoreFixture();
  const all = await Promise.all(Array.from({ length: 80 }, () => f.store.admit(admission('a', 'same', true))));
  assert.equal(all.filter(item => item.created).length, 1); assert.equal(new Set(all.map(item => item.jobId)).size, 1);
  assert.equal((await f.store.usage(principal('a'))).used, 1);
  assert.equal(await f.store.read(principal('b'), all[0].jobId), null);
  assert.equal(await f.store.read(principal('a'), '../control/global'), null);
  await f.store.finish(all.find(item => item.created), result);
  const other = await f.store.admit(admission('b', 'same', true)); assert.notEqual(other.jobId, all[0].jobId);
  const conflict = { ...admission('a', 'different', true), idempotencyKey: admission('a', 'same', true).idempotencyKey };
  await assert.rejects(f.store.admit(conflict), error => error.code === 'REQUEST_CONFLICT');
});

test('public API global daily quota survives account churn and resets only at the server boundary', async () => {
  let clock = Date.parse('2026-11-01T23:59:59.999Z'); const f = publicStoreFixture({ now: () => clock });
  for (let i = 0; i < 20; i++) await f.store.finish(await f.store.admit(admission(`user-${i}`, `job-${i}`)), result);
  await assert.rejects(f.store.admit(admission('new-account-id', 'blocked')), error => error.code === 'SERVICE_LIMIT_REACHED');
  assert.equal((await f.store.usage(principal('new-account-id'))).used, 0);
  clock++;
  assert.equal((await f.store.admit(admission('new-account-id', 'next-day'))).created, true);
});

test('public API admission rolls back busy requests and never refunds or repeats a possibly charged interrupted analysis', async () => {
  let clock = Date.now(); const f = publicStoreFixture({ now: () => clock });
  const first = await f.store.admit(admission('a', 'first'));
  await assert.rejects(f.store.admit(admission('a', 'other')), error => error.code === 'RATE_LIMITED');
  assert.equal((await f.store.usage(principal('a'))).used, 1);
  await f.store.admit(admission('b', 'two')); await f.store.admit(admission('c', 'three'));
  await assert.rejects(f.store.admit(admission('d', 'four')), error => error.code === 'RATE_LIMITED');
  assert.equal((await f.store.usage(principal('d'))).used, 0);
  clock += PUBLIC_API_POLICY.jobTimeoutMs;
  assert.equal((await f.store.read(principal('a'), first.jobId)).result.code, 'ANALYSIS_INTERRUPTED');
  assert.equal((await f.store.admit(admission('a', 'first'))).created, false);
  await f.store.finish(first, result);
  assert.equal((await f.store.read(principal('a'), first.jobId)).result.code, 'ANALYSIS_INTERRUPTED');
  assert.equal((await f.store.admit(admission('d', 'four'))).created, true);
});

test('public API user retries can recover failed products while in-flight and verified reuse never charges twice', async () => {
  let clock = Date.now(); const f = publicStoreFixture({ now: () => clock });
  const first = await f.store.admit(admission('a', 'same-product'));
  const retry = { ...admission('a', 'same-product'), idempotencyKey: 'different-user-initiated-attempt' };
  assert.equal((await f.store.admit(retry)).jobId, first.jobId, 'in-flight reuse works across different taps');
  await f.store.finish(first, { status: 'error', code: 'TEMPORARY_NETWORK_ERROR', message: '合成した通信失敗' });
  assert.equal((await f.store.admit(retry)).jobId, first.jobId, 'a resend of the same reused admission cannot start new paid work');
  const second = await f.store.admit({ ...retry, idempotencyKey: 'new-explicit-user-attempt' }); assert.equal(second.created, true); assert.equal(second.usage.used, 2);
  await f.store.finish(second, { status: 'verified', synthetic: true });
  const third = { ...retry, idempotencyKey: 'third-user-initiated-attempt' };
  assert.equal((await f.store.admit(third)).jobId, second.jobId, 'verified reuse is owner-scoped and free');
  clock += PUBLIC_API_POLICY.retentionMs + 1;
  assert.equal(await f.store.read(principal('a'), second.jobId), null);
  await assert.rejects(f.store.admit(third), error => error.code === 'REQUEST_CONFLICT', 'an expired admission never becomes a new paid job');
  const fresh = await f.store.admit({ ...third, idempotencyKey: 'fresh-explicit-attempt-after-expiry' }); assert.equal(fresh.created, true, 'a new search can use a fresh admission after cached result expiry');
});

test('reused AI admissions stay permanently bound to their original job through a lost response failure and server restart', async () => {
  const f = publicStoreFixture(); const first = await f.store.admit(admission('a', 'same-reused-product'));
  const retry = { ...admission('a', 'same-reused-product'), idempotencyKey: 'reused-admission-with-lost-response' };
  assert.equal((await f.store.admit(retry)).jobId, first.jobId);
  await f.store.finish(first, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: '合成したOpenAI無応答' });
  const restarted = createFirestoreUsageStore({ firestore: f.firestore });
  const repeated = await restarted.admit(retry);
  assert.equal(repeated.jobId, first.jobId); assert.equal(repeated.created, false); assert.equal(repeated.usage.used, 0);
  await assert.rejects(restarted.admit({ ...retry, forceReanalysis: true }), error => error.code === 'REQUEST_CONFLICT');
  const fresh = await restarted.admit({ ...retry, idempotencyKey: 'new-user-tap-after-no-result' });
  assert.equal(fresh.created, true); assert.equal(fresh.usage.used, 1);
});

test('steady AI status polls use read-only quota checks while device changes and refunds still synchronize the strict allowance', async () => {
  const f = publicStoreFixture(); const first = await f.store.admit(admission('a', 'read-only-status'));
  let transactions = 0; const transact = f.firestore.runTransaction;
  f.firestore.runTransaction = async callback => { transactions++; return transact(callback); };
  for (let i = 0; i < 50; i++) assert.equal((await f.store.read(principal('a'), first.jobId)).usage.used, 1);
  assert.equal(transactions, 0, 'informational polling must not contend on the admission transaction');
  await f.store.finish(first, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: '合成したOpenAI無応答' });
  assert.equal((await f.store.read(principal('a'), first.jobId)).usage.used, 0);
  assert.equal((await f.store.read(principal('a', 'new-phone'), first.jobId)).usage.used, 0);
  assert.ok(transactions > 1, 'a changed device or refund still persists its stricter quota evidence');
  await assert.rejects(f.store.usage(principal('b', 'new-phone', 'synthetic-reinstalled-0002')), error => error.code === 'REINSTALL_ACCOUNT_LOCKED');
  assert.equal(await f.store.read(principal('b', 'new-phone', 'synthetic-reinstalled-0002'), first.jobId), null);
});

test('normal AI admissions can durably reuse a successful explicit reanalysis without changing either request identity', async () => {
  const f = publicStoreFixture();
  const original = await f.store.admit(admission('a', 'reanalysed-manual', true));
  await f.store.finish(original, { status: 'verified', synthetic: true });
  const normal = { ...admission('a', 'reanalysed-manual'), idempotencyKey: 'normal-request-reuses-reanalysis' };
  const firstReply = await f.store.admit(normal);
  assert.equal(firstReply.jobId, original.jobId); assert.equal(firstReply.created, false);
  const restarted = createFirestoreUsageStore({ firestore: f.firestore });
  const retry = await restarted.admit(normal);
  assert.equal(retry.jobId, original.jobId); assert.equal(retry.created, false); assert.equal(retry.usage.used, 1);
  await assert.rejects(restarted.admit({ ...normal, forceReanalysis: true }), e => e.code === 'REQUEST_CONFLICT');
});

test('public API per-day documents retain previous counts when two server clocks cross midnight in opposite directions', async () => {
  let clock = Date.parse('2026-10-31T23:59:59.999Z'); const f = publicStoreFixture({ now: () => clock });
  for (let i = 0; i < 20; i++) await f.store.finish(await f.store.admit(admission(`a-${i}`, `job-${i}`)), result);
  clock++; await f.store.finish(await f.store.admit(admission('tomorrow', 'new-day')), result);
  clock--;
  await assert.rejects(f.store.admit(admission('yesterday', 'clock-skew')), error => error.code === 'SERVICE_LIMIT_REACHED');
});

test('public API invalid IDs unavailable quota storage and an incorrect worker cannot mutate counters or accepted results', async () => {
  const f = publicStoreFixture();
  for (const id of ['', 'short', '../other', 'a'.repeat(101), ['array']]) {
    assert.throws(() => publicJobId(principal('a'), id), error => error.status === 400);
  }
  assert.equal(f.records.size, 0);
  f.fail(true); await assert.rejects(f.store.admit(admission('a', 'one')), /unavailable/); assert.equal(f.records.size, 0);
  f.fail(false); const item = await f.store.admit(admission('a', 'one'));
  await f.store.finish({ ...item, runId: 'incorrect-worker' }, result);
  assert.equal((await f.store.read(principal('a'), item.jobId)).done, false);
  await f.store.finish(item, result); await f.store.progress(item, 'official_manual_analysis');
  assert.deepEqual((await f.store.read(principal('a'), item.jobId)).result, result);
});

async function httpFixture() {
  const fixture = publicStoreFixture(); let aiCalls = 0;
  const publicAccess = createPublicApiAccess({ verifyDevice: async (_req, { uid }) => ({ ...principal(uid), reinstallProtection: 'verified' }), store: fixture.store, verifyIdToken: async token => {
    if (!['user-a', 'user-b'].includes(token)) throw new Error('invalid token');
    return { uid: token, firebase: { sign_in_provider: 'google.com' } };
  } });
  const dependencies = { async analyzeUploaded() { aiCalls++; throw new Error('synthetic no paid AI'); } };
  const server = createApplianceCareHttpServer({ publicAccess, allowedOrigins: ['https://allowed.example'], dependencies });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { ...fixture, server, base: `http://127.0.0.1:${server.address().port}`, calls: () => aiCalls,
    work: () => runAnalysisQueueBatch({ store: createFirestoreUsageStore({ firestore: fixture.firestore, analysisQueueKeys: fixture.analysisQueueKeys }), createDependencies: () => dependencies, authorize: async () => {} }),
    close: async () => { const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing; } };
}

test('public AI rejects an invalid admission identity before decoding a PDF and never reserves a paid slot', async () => {
  const f = await httpFixture();
  try {
    const response = await fetch(f.base + '/api/appliance-care/jobs', { method: 'POST',
      headers: { authorization: 'Bearer user-a', 'content-type': 'application/json', 'x-idempotency-key': 'bad' },
      body: JSON.stringify({ manufacturer: '検査', productName: '合成製品', modelNumber: 'QA', manual: { base64: 'invalid', rightsConfirmed: true } }) });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_REQUEST');
    assert.equal(f.calls(), 0); assert.equal(f.records.size, 0);
  } finally { await f.close(); }
});

test('public HTTP API rejects anonymous unauthenticated requests before paid work and keeps results owner-only with no sync-endpoint bypass', async () => {
  const f = await httpFixture(); const body = JSON.stringify({ manufacturer: 'Dyson', productName: '合成製品', modelNumber: 'QA', manual: syntheticManual() });
  const headers = { authorization: 'Bearer user-a', 'content-type': 'application/json', 'x-idempotency-key': 'synthetic-http-request' };
  try {
    assert.equal((await fetch(f.base + '/health')).status, 200);
    for (const origin of ['https://allowed.example.attacker.example', 'http://allowed.example', 'null']) {
      const denied = await fetch(f.base + '/api/appliance-care/usage', { headers: { ...headers, origin } });
      assert.equal(denied.status, 403); assert.equal(denied.headers.has('access-control-allow-origin'), false);
    }
    const preflight = await fetch(f.base + '/api/appliance-care/jobs', { method: 'OPTIONS', headers: { origin: 'https://allowed.example' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type, authorization, x-idempotency-key');
    for (const path of ['/api/appliance-care/jobs', '/api/appliance-care/analyze']) {
      assert.equal((await fetch(f.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
    }
    assert.equal(f.calls(), 0); assert.equal(f.records.size, 0);
    assert.equal((await fetch(f.base + '/api/appliance-care/analyze', { method: 'POST', headers, body })).status, 405);
    await f.store.heartbeatAnalysisWorker();
    const starts = await Promise.all(Array.from({ length: 10 }, () => fetch(f.base + '/api/appliance-care/jobs', { method: 'POST', headers, body }).then(res => res.json())));
    assert.equal(new Set(starts.map(item => item.jobId)).size, 1); assert.equal(starts[0].usage.used, 1);
    const path = '/api/appliance-care/jobs/' + starts[0].jobId;
    const others = await fetch(f.base + path, { headers: { authorization: 'Bearer user-b' } }); assert.equal(others.status, 404);
    assert.equal((await fetch(f.base + path)).status, 401);
    const waiting = await fetch(f.base + path, { headers }); assert.equal((await waiting.json()).done, false);
    assert.equal(f.calls(), 0, 'HTTP admission never executes work after sending its response');
    assert.equal((await f.work()).settled, 1);
    const mine = await fetch(f.base + path, { headers }); assert.equal(mine.status, 200);
    assert.equal((await mine.json()).done, true); assert.equal(f.calls(), 1);
    const usage = await fetch(f.base + '/api/appliance-care/usage', { headers }); assert.equal((await usage.json()).usage.used, 1);
  } finally { await f.close(); }
});

test('device and account usage synchronize to the smaller allowance on login without spending another analysis', async () => {
  const f = publicStoreFixture();
  const run = async (uid, device, key) => {
    const item = await f.store.admit({ ...admission(uid, key), principal: principal(uid, device) });
    await f.store.finish(item, result); return item;
  };
  for (let i = 0; i < 3; i++) await run('a', 'phone-a', `one-${i}`);
  assert.equal((await f.store.usage(principal('b', 'phone-a'))).used, 3);
  assert.equal((await f.store.usage(principal('b', 'phone-b'))).used, 3, 'new phone cannot reset an existing account');
  await run('b', 'phone-b', 'one-more');
  assert.equal((await f.store.usage(principal('b', 'phone-a'))).used, 4, 'larger account count raises the old phone count');
  assert.equal((await f.store.usage(principal('a', 'phone-a'))).used, 4, 'larger device count raises the old account count');
  assert.equal((await f.store.usage({ ...principal('a', 'phone-a'), remaining: 5, used: 0 })).remaining, 1, 'client counters are ignored');
});

test('reinstall locks a device to its first monthly account, even after switching accounts, denied retries and a cold server restart', async () => {
  let clock = Date.parse('2026-10-31T23:59:59.999Z'); const f = publicStoreFixture({ now: () => clock });
  const first = principal('first', 'phone'); const second = principal('second', 'phone');
  await f.store.usage(first);
  await f.store.usage(second); // Normal account switching must not replace the first linked account.
  const reinstalled = { ...second, installationId: 'synthetic-installation-0002' };
  await assert.rejects(f.store.admit({ ...admission('second', 'blocked'), principal: reinstalled }), e => e.code === 'REINSTALL_ACCOUNT_LOCKED');
  const restarted = createFirestoreUsageStore({ firestore: f.firestore, now: () => clock });
  await assert.rejects(restarted.usage(second), e => e.code === 'REINSTALL_ACCOUNT_LOCKED', 'replaying an old install cannot unlock the month');
  const restored = { ...first, installationId: reinstalled.installationId };
  const item = await restarted.admit({ ...admission('first', 'restored'), principal: restored });
  await restarted.finish(item, result); assert.equal(item.usage.used, 1);
  clock++;
  assert.equal((await restarted.usage(reinstalled)).remaining, 5, 'next month another account can become the first account');
});

test('different accounts racing on one verified device share five admissions and cannot run paid work concurrently', async () => {
  const f = publicStoreFixture(); let accepted = 0;
  for (let n = 0; n < 5; n++) {
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => f.store.admit({
      ...admission(`account-${n}-${i}`, `race-${n}-${i}`), principal: principal(`account-${n}-${i}`, 'same-phone'),
    })));
    const winners = outcomes.filter(x => x.status === 'fulfilled'); assert.equal(winners.length, 1); accepted++;
    for (const loser of outcomes.filter(x => x.status === 'rejected')) assert.ok(['RATE_LIMITED', 'MONTHLY_LIMIT_REACHED'].includes(loser.reason.code));
    await f.store.finish(winners[0].value, result);
  }
  assert.equal(accepted, 5);
  await assert.rejects(f.store.admit({ ...admission('fresh', 'sixth-on-phone'), principal: principal('fresh', 'same-phone') }), e => e.code === 'MONTHLY_LIMIT_REACHED');
});

test('missing native verification, forged continuity and corrupted server counts stop analysis instead of resetting allowance', async () => {
  const store = publicStoreFixture().store;
  for (const fake of [{ uid: 'a', anonymous: false }, { ...principal('a'), anonymous: true }, { ...principal('a'), deviceId: 'raw-device' }]) {
    await assert.rejects(store.usage(fake), e => e.code === 'DEVICE_VERIFICATION_REQUIRED');
  }
  const make = verifyDevice => createPublicApiAccess({ store, verifyIdToken: async () => ({ uid: 'a', firebase: { sign_in_provider: 'google.com' } }), verifyDevice });
  const request = { headers: { authorization: 'Bearer synthetic', 'x-device-id': publicKey('fake') } };
  assert.equal(make().securityReady, false);
  await assert.rejects(make().authenticate(request), e => e.code === 'DEVICE_VERIFICATION_UNAVAILABLE');
  for (const proof of [null, { ...principal('a'), reinstallProtection: 'unknown' }, { ...principal('a'), deviceId: 'unverified', reinstallProtection: 'verified' }]) {
    await assert.rejects(make(async () => proof).authenticate(request), e => e.code === 'DEVICE_VERIFICATION_REQUIRED');
  }
  const f = publicStoreFixture(); await f.store.usage(principal('a'));
  const entry = [...f.records].find(([path]) => path.includes('/usage/'));
  f.records.set(entry[0], { ...entry[1], count: -1 });
  await assert.rejects(f.store.usage(principal('a')), /Invalid stored usage/);
});

 test('production paid API refuses an absent native device verifier and a public legacy-search override', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    const access = createPublicApiAccess({ store: publicStoreFixture().store, verifyIdToken: async () => ({}) });
    assert.throws(() => createApplianceCareHttpServer({ publicAccess: access, dependencies: {} }), e => e.code === 'DEVICE_SECURITY_NOT_CONFIGURED');
    assert.throws(() => createApplianceCareHttpServer({ publicAccess: { ...access, securityReady: true }, dependencies: {}, manualUploadsOnly: false }), /requires uploaded manuals/);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('quota reads and acknowledged admission retries do not rewrite unchanged counters or duplicate paid workers', async () => {
  const f = publicStoreFixture(); const first = await f.store.admit(admission('a', 'write-once'));
  const written = f.writes();
  const receipts = await Promise.all(Array.from({ length: 80 }, () => f.store.admit(admission('a', 'write-once'))));
  assert.equal(receipts.some(item => item.created), false);
  await Promise.all(Array.from({ length: 50 }, () => f.store.usage(principal('a'))));
  assert.equal(f.writes(), written, 'polling and duplicate sends must not create counter-write contention');
  assert.equal(first.created, true);
});

test('a server-confirmed OpenAI no-result failure releases the same monthly slot on every copied account and device without multiplying refunds', async () => {
  const f = publicStoreFixture(); const first = principal('first', 'phone');
  const item = await f.store.admit({ ...admission('first', 'no-result'), principal: first });
  assert.equal((await f.store.usage(principal('second', 'phone'))).remaining, 4);
  assert.equal((await f.store.usage(principal('second', 'other-phone'))).remaining, 4);
  await f.store.finish(item, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: '合成したOpenAIの無応答' });
  for (let n = 0; n < 10; n++) await f.store.finish(item, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: 'same' });
  for (const person of [first, principal('second', 'phone'), principal('second', 'other-phone')]) assert.equal((await f.store.usage(person)).remaining, 5);
  assert.equal((await f.store.read(first, item.jobId)).usage.used, 0);
  const charged = await f.store.admit({ ...admission('first', 'invalid-result'), principal: first });
  await f.store.finish(charged, { status: 'error', code: 'ANALYSIS_FAILED', message: '結果は返ったが検証NG' });
  assert.equal((await f.store.usage(first)).remaining, 4);
  await f.store.finish(charged, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: 'late attempted refund' });
  assert.equal((await f.store.usage(first)).remaining, 4, 'a finalized result cannot be rewritten as a refund');
});

test('minimum-allowance merging preserves independent successful usage while refunding all failed alternatives and retaining the daily cost cap', async () => {
  const f = publicStoreFixture();
  const a = await f.store.admit(admission('a', 'a-pending')); const b = await f.store.admit(admission('b', 'b-pending'));
  assert.equal((await f.store.usage(principal('b', 'a'))).used, 1);
  await f.store.finish(a, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: 'OpenAI無応答' });
  await f.store.finish(b, result);
  assert.equal((await f.store.usage(principal('b', 'a'))).used, 1, 'a different successful charge still consumes its slot');
  const g = publicStoreFixture();
  for (let n = 0; n < 20; n++) {
    const item = await g.store.admit(admission('refunded', `outage-${n}`));
    await g.store.finish(item, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: 'OpenAI無応答' });
  }
  assert.equal((await g.store.usage(principal('refunded'))).remaining, 5);
  await assert.rejects(g.store.admit(admission('refunded', 'outage-21')), e => e.code === 'SERVICE_LIMIT_REACHED', 'monthly refunds cannot bypass the service cost ceiling');
});

test('a verified first account with no analyses keeps all five attempts after reinstall while another account remains blocked that month', async () => {
  const f = publicStoreFixture(); const person = principal('first', 'phone');
  assert.equal((await f.store.usage(person)).used, 0);
  const restored = { ...person, installationId: 'synthetic-reinstalled-0002' };
  assert.equal((await f.store.usage(restored)).remaining, 5);
  await assert.rejects(f.store.usage({ ...restored, uid: 'another' }), e => e.code === 'REINSTALL_ACCOUNT_LOCKED');
  const item = await f.store.admit({ ...admission('first', 'first-ever-analysis'), principal: restored });
  assert.equal(item.usage.remaining, 4);
});

test('quota provenance matches the max-then-charge specification through randomized account switches late refunds and overlapping device histories', async () => {
  for (const seed of [17, 503, 20261031]) {
    const f = publicStoreFixture(); let random = seed; let ordinal = 0; const refunds = new Set();
    const users = new Map(); const devices = new Map(); const active = [];
    const next = limit => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % limit; };
    const value = (expression, memo = new Map()) => {
      if (!expression) return 0; if (memo.has(expression)) return memo.get(expression);
      const result = expression.kind === 'max' ? Math.max(value(expression.a, memo), value(expression.b, memo))
        : value(expression.base, memo) + (refunds.has(expression.id) ? 0 : 1);
      memo.set(expression, result); return result;
    };
    const synchronize = (uid, device) => {
      const a = users.get(uid); const b = devices.get(device); const expression = a === b ? a : { kind: 'max', a, b };
      users.set(uid, expression); devices.set(device, expression); return expression;
    };
    for (let step = 0; step < 80; step++) {
      const uid = `model-${next(4)}`; const device = `phone-${next(4)}`;
      if (active.length && next(3) === 0) {
        const [item] = active.splice(next(active.length), 1); const failed = next(2) === 0;
        if (failed) refunds.add(item.jobId);
        await f.store.finish(item, failed ? { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: '合成した無応答' } : result);
      } else {
        const before = synchronize(uid, device); const expected = value(before);
        assert.equal((await f.store.usage(principal(uid, device))).used, expected);
        if (next(2) === 0 && ordinal < 20) {
          const request = { ...admission(uid, `model-${seed}-${++ordinal}`), principal: principal(uid, device) };
          const blocked = expected >= 5 ? 'MONTHLY_LIMIT_REACHED'
            : active.length >= 3 || active.some(item => item.uid === uid || item.device === device) ? 'RATE_LIMITED' : null;
          if (blocked) await assert.rejects(f.store.admit(request), e => e.code === blocked);
          else {
            const item = await f.store.admit(request); const expression = { kind: 'add', base: before, id: item.jobId };
            users.set(uid, expression); devices.set(device, expression); active.push({ ...item, uid, device });
            assert.equal(item.usage.used, value(expression));
          }
        }
      }
    }
    for (const item of active) { refunds.add(item.jobId); await f.store.finish(item, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: 'late refund' }); }
    for (const uid of users.keys()) for (const device of devices.keys()) {
      const expression = synchronize(uid, device); assert.equal((await f.store.usage(principal(uid, device))).used, value(expression));
    }
  }
});
