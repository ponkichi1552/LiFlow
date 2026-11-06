import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { publicStoreFixture, syntheticAnalysisQueueKeys } from './helpers/appliance-public-store.mjs';
import { syntheticManual } from './helpers/synthetic-pdf.mjs';
import { createFirestoreUsageStore } from '../server/appliance-care-api/src/firestore-usage-store.mjs';
import { analysisRequestKey } from '../server/appliance-care-api/src/analysis-runner.mjs';
import { decodeUploadedManual, MAX_MANUAL_BYTES } from '../server/appliance-care-api/src/uploaded-manual.mjs';
import { prepareAnalysisQueueInput, decodeAnalysisQueueInput, readAnalysisQueueKeys } from '../server/appliance-care-api/src/analysis-queue-input.mjs';
import { runAnalysisQueueBatch } from '../server/appliance-care-api/src/analysis-queue-worker.mjs';
import { PUBLIC_API_POLICY, publicKey } from '../server/appliance-care-api/src/public-access.mjs';

const principal = { uid: 'synthetic-queue-owner', anonymous: false, deviceId: publicKey('synthetic-queue-device'), installationId: 'synthetic-installation-0001' };
const request = { manufacturer: '検査', productName: '合成した製品', modelNumber: 'QA', manual: decodeUploadedManual(syntheticManual()) };
const result = { status: 'verified', synthetic: true };
function fixture() {
  let clock = Date.parse('2026-11-05T01:00:00Z'); const now = () => clock;
  const f = publicStoreFixture({ now }); let calls = 0; const logs = [];
  const store = () => createFirestoreUsageStore({ firestore: f.firestore, now, analysisQueueKeys: f.analysisQueueKeys });
  return { ...f, now, advance: delta => { clock += delta; }, restart: store, logs, calls: () => calls,
    async admit(change = {}) { await f.store.heartbeatAnalysisWorker(); return f.store.admit({ principal, requestKey: analysisRequestKey(request), idempotencyKey: 'synthetic-durable-analysis', analysisRequest: request, ...change }); },
    work: (change = {}) => runAnalysisQueueBatch({ store: store(), now, authorize: async () => {}, createDependencies: () => ({}),
      analyze: async (value, _deps, progress) => { calls++; assert.equal(value.manual.reference, request.manual.reference); progress('official_manual_analysis'); return result; },
      monitor: event => logs.push(event), ...change }),
  };
}

test('durable AI admission stores the exact uploaded input with its quota transaction and a cold worker alone invokes analysis', async () => {
  const f = fixture(); const receipt = await f.admit();
  assert.equal(f.calls(), 0); assert.equal((await f.store.read(principal, receipt.jobId)).done, false);
  assert.equal((await f.restart().admit({ principal, requestKey: analysisRequestKey(request), idempotencyKey: 'synthetic-durable-analysis', analysisRequest: request })).created, false);
  assert.equal((await f.work()).settled, 1); assert.equal(f.calls(), 1);
  assert.deepEqual((await f.restart().read(principal, receipt.jobId)).result, result);
  assert.equal((await f.store.usage(principal)).used, 1);
  assert.equal([...f.records.keys()].some(path => path.includes('/analysisInputChunks/')), false, 'raw input is removed with final settlement');
  assert.equal((await f.work()).attempted, 0);
});

test('independent concurrent AI workers cannot start the same paid job twice and resends keep the same monthly charge', async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 12 }, () => f.admit()));
  const workers = await Promise.all(Array.from({ length: 12 }, () => f.work()));
  assert.equal(workers.reduce((sum, row) => sum + row.settled, 0), 1); assert.equal(f.calls(), 1);
  assert.equal((await f.store.usage(principal)).used, 1);
});

test('a worker stopped before paid execution can renew its preparation lease while the obsolete claimant is fenced', async () => {
  const f = fixture(); const receipt = await f.admit(); const old = await f.store.claimAnalysis(receipt.jobId);
  assert.ok(old); assert.equal(await f.restart().claimAnalysis(receipt.jobId), null);
  f.advance(30_000); const replacement = await f.restart().claimAnalysis(receipt.jobId);
  assert.ok(replacement); assert.notEqual(replacement.admission.claimId, old.admission.claimId);
  assert.equal(await f.store.startAnalysis(old.admission), false);
  f.advance(30_000); assert.equal((await f.work()).settled, 1); assert.equal(f.calls(), 1);
  assert.equal((await f.store.usage(principal)).used, 1);
});

test('an AI worker stopped after the paid start or provider response is never rerun and expires as an explicit interrupted job', async () => {
  for (const point of ['analysisStarted', 'providerReturned']) {
    const f = fixture(); const receipt = await f.admit();
    const first = await f.work({ checkpoint: async phase => { if (phase === point) throw new Error('synthetic process termination, never log this text'); } });
    assert.equal(first.failed, 1); assert.equal(f.calls(), point === 'analysisStarted' ? 0 : 1);
    assert.equal((await f.work()).attempted, 0);
    f.advance(PUBLIC_API_POLICY.jobTimeoutMs); assert.equal((await f.work()).settled, 1);
    assert.equal((await f.store.read(principal, receipt.jobId)).result.code, 'ANALYSIS_INTERRUPTED');
    assert.equal((await f.store.usage(principal)).used, 1);
    assert.equal((await f.admit()).created, false);
    assert.ok(f.logs.every(value => Object.keys(value).every(key => ['event', 'jobId', 'stage'].includes(key))));
    assert.doesNotMatch(JSON.stringify(f.logs), /termination|合成した製品|base64|accessToken/u);
  }
});

test('a staged AI result survives termination and later settlement without rerunning analysis or losing a proved no-result refund', async () => {
  for (const output of [result, { status: 'error', code: 'AI_SERVICE_NO_RESULT', message: '合成した無応答' }]) {
    const f = fixture(); const receipt = await f.admit(); let paidCalls = 0;
    assert.equal((await f.work({ analyze: async () => { paidCalls++; return output; }, checkpoint: async phase => {
      if (phase === 'resultStaged') throw new Error('synthetic termination after durable result');
    } })).failed, 1);
    f.advance(PUBLIC_API_POLICY.jobTimeoutMs + 1);
    assert.equal((await f.work({ analyze: async () => { throw new Error('must not rerun'); } })).settled, 1);
    assert.deepEqual((await f.restart().read(principal, receipt.jobId)).result, output); assert.equal(paidCalls, 1);
    assert.equal((await f.store.usage(principal)).used, output.status === 'error' ? 0 : 1);
  }
});

test('failed AI final writes are observable and a cold worker retries only the persisted result', async () => {
  const f = fixture(); const receipt = await f.admit(); const store = f.restart();
  const outcome = await f.work({ store: { ...store, finish: async () => { throw new Error('synthetic permanent storage failure containing private input'); } } });
  assert.equal(outcome.failed, 1); assert.equal(f.calls(), 1);
  assert.deepEqual(f.logs.at(-1), { event: 'analysis_worker_failed', jobId: receipt.jobId, stage: 'settlement' });
  assert.equal((await f.work()).settled, 1); assert.equal(f.calls(), 1);
});

test('AI queued work rechecks user authority before the paid start and does not bypass it after a preparation restart', async () => {
  const f = fixture(); const receipt = await f.admit(); let checked = 0;
  const denied = () => f.work({ authorize: async (owner, createdAt) => {
    assert.equal(owner, principal.uid); assert.ok(createdAt < f.now() + 1); checked++; throw new Error('synthetic disabled user');
  } });
  assert.equal((await denied()).failed, 1); assert.equal(f.calls(), 0);
  f.advance(30_000); assert.equal((await denied()).failed, 1); assert.equal(checked, 2); assert.equal(f.calls(), 0);
  assert.equal((await f.store.read(principal, receipt.jobId)).done, false);
  await assert.rejects(runAnalysisQueueBatch({ store: f.store }), /authorization/u);
});

test('AI input chunks preserve a maximum-size PDF and reject corrupt missing reordered oversized or foreign input without paid work', async () => {
  const bytes = Buffer.alloc(MAX_MANUAL_BYTES, 32); bytes.write('%PDF-1.4\n'); bytes.write('%%EOF', bytes.length - 5);
  const input = { ...request, manual: decodeUploadedManual({ base64: bytes.toString('base64'), rightsConfirmed: true }) };
  const key = analysisRequestKey(input); const keys = syntheticAnalysisQueueKeys();
  const context = { owner: principal.uid, jobId: publicKey('synthetic-input-job'), requestDigest: publicKey(key) };
  const prepared = prepareAnalysisQueueInput(input, key, keys, context);
  assert.ok(prepared.chunks.length > 1 && prepared.chunks.every(chunk => Buffer.byteLength(chunk) < 1024 * 1024));
  assert.deepEqual(decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, keys, context).manual.bytes, bytes);
  const corrupt = Buffer.from(prepared.chunks[0]); corrupt[0] ^= 1;
  for (const chunks of [prepared.chunks.slice(1), [...prepared.chunks].reverse(), [Buffer.alloc(1024 * 1024), ...prepared.chunks.slice(1)],
    [corrupt, ...prepared.chunks.slice(1)]]) assert.throws(() => decodeAnalysisQueueInput(prepared.manifest, chunks, keys, context));
  assert.throws(() => decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, keys, { ...context, requestDigest: publicKey('another-request') }));
  assert.throws(() => prepareAnalysisQueueInput({ ...request, manual: { ...request.manual, reference: 'file:///private' } }, analysisRequestKey(request), keys, context));
  const f = fixture(); await f.admit(); const path = [...f.records.keys()].find(value => value.includes('/analysisInputChunks/'));
  f.records.get(path).runId = 'foreign-run'; assert.equal((await f.work()).failed, 1); assert.equal(f.calls(), 0);
});

test('AI queue encryption binds the account job input and key version and rejects missing keys forged tags and rotated-away keys before paid work', async () => {
  const keys = syntheticAnalysisQueueKeys(); const context = { owner: principal.uid, jobId: publicKey('encrypted-input-job'), requestDigest: publicKey(analysisRequestKey(request)) };
  const prepared = prepareAnalysisQueueInput(request, analysisRequestKey(request), keys, context);
  const next = prepareAnalysisQueueInput(request, analysisRequestKey(request), keys, context);
  assert.notEqual(prepared.manifest.nonce, next.manifest.nonce); assert.notDeepEqual(prepared.chunks, next.chunks);
  assert.equal(prepared.manifest.product, undefined);
  for (const changed of [{ ...context, owner: 'other-owner' }, { ...context, jobId: publicKey('other-job') }, { ...context, requestDigest: publicKey('other-input') }]) {
    assert.throws(() => decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, keys, changed));
  }
  for (const manifest of [{ ...prepared.manifest, tag: '0'.repeat(32) }, { ...prepared.manifest, nonce: '0'.repeat(24) },
    { ...prepared.manifest, sha256: '0'.repeat(64) }, { ...prepared.manifest, keyId: 'different-key' }]) assert.throws(() => decodeAnalysisQueueInput(manifest, prepared.chunks, keys, context));
  assert.throws(() => prepareAnalysisQueueInput(request, analysisRequestKey(request), undefined, context), error => error.code === 'ANALYSIS_INPUT_SECURITY_UNAVAILABLE');
  assert.throws(() => decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, undefined, context));
  const rotated = { activeKeyId: 'synthetic-new-key', keys: new Map([...keys.keys, ['synthetic-new-key', Buffer.alloc(32, 17)]]) };
  assert.equal(decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, rotated, context).manual.reference, request.manual.reference);
  rotated.keys.delete(keys.activeKeyId); assert.throws(() => decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, rotated, context));
  assert.equal(readAnalysisQueueKeys({}), undefined);
  for (const env of [{ APPLIANCE_CARE_QUEUE_KEYS: 'not-json' }, { APPLIANCE_CARE_QUEUE_KEYS: '{}', APPLIANCE_CARE_QUEUE_ACTIVE_KEY_ID: 'missing' },
    { APPLIANCE_CARE_QUEUE_KEYS: '{"synthetic":"not-a-key"}', APPLIANCE_CARE_QUEUE_ACTIVE_KEY_ID: 'synthetic' }]) {
    assert.throws(() => readAnalysisQueueKeys(env), error => error.code === 'ANALYSIS_INPUT_SECURITY_UNAVAILABLE' && !error.message.includes('not-a-key'));
  }
  const f = fixture(); const receipt = await f.admit();
  const metadata = f.records.get(`applianceApi/v1/jobs/${receipt.jobId}`);
  assert.doesNotMatch(JSON.stringify(metadata), /合成した製品|base64|manufacturer/u);
  const withoutKeys = createFirestoreUsageStore({ firestore: f.firestore, now: f.now });
  const claim = await withoutKeys.claimAnalysis(receipt.jobId); await assert.rejects(withoutKeys.readAnalysisInput(claim));
  assert.equal(f.calls(), 0);
});

test('AI admission chunk failure rolls back the job receipt monthly quota and global reservation together', async () => {
  const f = fixture(); const transact = f.firestore.runTransaction;
  f.firestore.runTransaction = callback => transact(transaction => callback({ ...transaction, create(ref, value) {
    if (ref.path.includes('/analysisInputChunks/')) throw new Error('synthetic chunk write failure'); transaction.create(ref, value);
  } }));
  await assert.rejects(f.admit(), /chunk write/u);
  assert.deepEqual([...f.records.keys()], ['applianceApi/v1/control/analysisWorker']);
  f.firestore.runTransaction = transact;
  assert.equal((await f.admit()).usage.used, 1); assert.equal((await f.work()).settled, 1);
});

test('AI admissions without a recently running independent worker fail before reserving quota while old receipts remain readable', async () => {
  const f = fixture(); const input = { principal, requestKey: analysisRequestKey(request), idempotencyKey: 'synthetic-without-worker', analysisRequest: request };
  await assert.rejects(f.store.admit(input), error => error.code === 'ANALYSIS_WORKER_UNAVAILABLE'); assert.equal(f.records.size, 0);
  await f.store.heartbeatAnalysisWorker(); const receipt = await f.store.admit(input); assert.equal(receipt.usage.used, 1);
  f.advance(90_000);
  await assert.rejects(f.store.admit({ ...input, forceReanalysis: true, idempotencyKey: 'synthetic-with-stale-worker' }), error => error.code === 'ANALYSIS_WORKER_UNAVAILABLE');
  assert.equal((await f.store.admit(input)).jobId, receipt.jobId); assert.equal((await f.store.usage(principal)).used, 1);
  assert.equal((await f.store.read(principal, receipt.jobId)).done, false);
});
