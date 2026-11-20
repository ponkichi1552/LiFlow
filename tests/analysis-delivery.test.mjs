import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { publicStoreFixture } from './helpers/appliance-public-store.mjs';
import { createFirestoreUsageStore } from '../server/appliance-care-api/src/firestore-usage-store.mjs';
import { createPublicApiAccess, publicKey, PUBLIC_API_POLICY } from '../server/appliance-care-api/src/public-access.mjs';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { analysisDeliveryJson } from '../server/appliance-care-api/src/analysis-delivery-contract.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as manualDocument from '../src/features/appliance-care/manual-document.ts';
import { syntheticManual } from './helpers/synthetic-pdf.mjs';

const principal = uid => ({ uid, anonymous: false, deviceId: publicKey(uid), installationId: 'synthetic-installation-001' });
const input = uid => ({ principal: principal(uid), requestKey: 'synthetic-result', idempotencyKey: 'synthetic-delivery-attempt' });
const output = { status: 'not_found', message: '合成した解析結果' };

test('analysis content is erased only by the authenticated owner exact durable receipt and survives wrong missing and premature receipts', async () => {
  const f = publicStoreFixture(); const accepted = await f.store.admit(input('a'));
  const bogus = { token: 'a'.repeat(64), digest: 'b'.repeat(64), expiresAt: Date.now() + 1000 };
  assert.equal(await f.store.acknowledgeResult({ uid: 'a' }, accepted.jobId, bogus), false);
  await f.store.finish(accepted, output);
  const delivered = await f.store.read(principal('a'), accepted.jobId);
  assert.deepEqual(delivered.result, output, 'a GET is not a durable receipt');
  assert.equal(delivered.delivery.digest, publicKey(analysisDeliveryJson(output)));
  for (const [owner, receipt] of [['b', delivered.delivery], ['a', { ...delivered.delivery, token: bogus.token }],
    ['a', { ...delivered.delivery, digest: bogus.digest }], ['a', { ...delivered.delivery, expiresAt: delivered.delivery.expiresAt + 1 }]]) {
    assert.equal(await f.store.acknowledgeResult({ uid: owner }, accepted.jobId, receipt), false);
    assert.deepEqual((await f.store.read(principal('a'), accepted.jobId)).result, output);
  }
  assert.equal(await f.store.acknowledgeResult({ uid: 'a' }, accepted.jobId, delivered.delivery), true);
  const record = f.records.get(`applianceApi/v1/jobs/${accepted.jobId}`);
  assert.equal('result' in record, false); assert.equal('delivery' in record, false); assert.equal('inputManifest' in record, false);
  assert.equal(JSON.stringify(record).includes(output.message), false);
  assert.equal(await f.store.acknowledgeResult({ uid: 'a' }, accepted.jobId, delivered.delivery), true, 'lost HTTP acknowledgement can be retried');
  const restart = createFirestoreUsageStore({ firestore: f.firestore });
  assert.equal((await restart.admit(input('a'))).created, false);
  assert.equal((await restart.usage(principal('a'))).used, 1, 'erasure never repeats/refunds paid work');
});

test('AI deletion receipts remain usable without paid access or native attestation but never bypass owner authentication', async () => {
  const f = publicStoreFixture(); const accepted = await f.store.admit(input('a')); await f.store.finish(accepted, output);
  const { delivery } = await f.store.read(principal('a'), accepted.jobId); let paidChecks = 0;
  const access = createPublicApiAccess({ store: f.store,
    subscriptions: { handle: async () => false, service: { assertActive() { paidChecks++; throw new Error('synthetic expired subscription'); } } },
    verifyIdToken: async token => { if (!['a', 'b'].includes(token)) throw new Error('synthetic invalid'); return { uid: token, firebase: { sign_in_provider: 'google.com' } }; } });
  const server = createApplianceCareHttpServer({ publicAccess: access, subscriptionAccess: undefined });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/appliance-care/jobs/${accepted.jobId}/receipt`;
  try {
    for (const [token, expected] of [['invalid', 401], ['b', 404], ['a', 200], ['a', 200]]) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(delivery) });
      assert.equal(response.status, expected);
    }
    assert.equal(paidChecks, 0);
  } finally { server.closeAllConnections(); server.close(); }
});

test('AI unreceived content expires in twenty four hours while immutable admission hashes prevent a paid replay', async () => {
  let at = Date.now(); const f = publicStoreFixture({ now: () => at }); const accepted = await f.store.admit(input('a'));
  await f.store.finish(accepted, output); const { delivery } = await f.store.read(principal('a'), accepted.jobId);
  assert.equal(delivery.expiresAt - at, 86400_000); assert.equal(PUBLIC_API_POLICY.retentionMs, 86400_000);
  at = delivery.expiresAt;
  assert.equal(await f.store.read(principal('a'), accepted.jobId), null);
  assert.equal(await f.store.acknowledgeResult({ uid: 'a' }, accepted.jobId, delivery), false);
  await assert.rejects(f.store.admit(input('a')), error => error.code === 'REQUEST_CONFLICT');
});

test('device analysis inbox commits the PDF and result atomically before acknowledging and keeps receipts recoverable across connection restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = createDatabase();
  f.connection.exec('CREATE TABLE appliance_manual_documents(sha256 TEXT PRIMARY KEY,byte_length INTEGER,content_base64 TEXT)');
  let manualChecks = 0;
  const manualVerifier = { ...manualDocument, verifyManualContent(...args) { manualChecks++; return manualDocument.verifyManualContent(...args); } };
  const manualStorage = loadNativeModule('src/platform/storage/appliance-manual-storage.ts', {
    '../../features/appliance-care/manual-document.ts': manualVerifier,
  });
  const { deviceAnalysisDeliveries } = loadNativeModule('src/platform/storage/analysis-deliveries.ts', {
    './repository.ts': { withPlannerDatabaseOperation: (_database, work) => work() },
    './isolated-transaction.ts': { withIsolatedSqliteTransaction: async (database, work) => { let value; await database.withTransactionAsync(async () => { value = await work(database); }); return value; } },
    './appliance-manual-storage.ts': manualStorage, '../../features/appliance-care/manual-document.ts': manualVerifier,
  });
  const store = deviceAnalysisDeliveries(f.database); const saved = { jobId: 'a'.repeat(64), baseUrl: 'https://synthetic.invalid',
    receipt: { token: 'b'.repeat(64), digest: 'c'.repeat(64), expiresAt: Date.now() + 100000 } };
  assert.equal(deviceAnalysisDeliveries(f.database), store, 'all callers on one connection share receipt serialization');
  assert.equal(await store.hasPending(), false);
  assert.equal(f.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='appliance_analysis_deliveries'").get().n, 0, 'an empty check cannot add AI tables to cold startup');
  f.connection.exec(`CREATE TABLE appliance_analysis_admissions (owner TEXT NOT NULL,request_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,PRIMARY KEY(owner,request_key));
    INSERT INTO appliance_analysis_admissions VALUES('a','request','first-attempt');`);
  let changes = 0; const stop = store.subscribe(() => { changes++; });
  assert.deepEqual(await store.admission('a', 'request', 'retry-attempt'), { id: 'first-attempt', jobId: null });
  await store.recordJob('a', 'request', 'first-attempt', saved.jobId);
  await store.recordJob('a', 'request', 'different-attempt', 'different-job');
  assert.deepEqual(await store.admission('a', 'request', 'retry-attempt'), { id: 'first-attempt', jobId: saved.jobId });
  f.connection.exec("CREATE TRIGGER synthetic_save_failure BEFORE INSERT ON appliance_analysis_deliveries BEGIN SELECT RAISE(ABORT,'synthetic full disk'); END");
  await assert.rejects(store.save('a', 'request', saved, output, syntheticManual()), /synthetic full disk/);
  assert.equal(manualChecks, 1, 'the inbox validates the PDF once per save attempt');
  assert.equal(changes, 0, 'a failed save cannot wake receipt delivery');
  assert.deepEqual(await store.pending('a'), []);
  assert.equal(f.connection.prepare('SELECT count(*) AS n FROM appliance_manual_documents').get().n, 0, 'no partial PDF transaction');
  f.connection.exec('DROP TRIGGER synthetic_save_failure');
  await store.save('a', 'request', saved, output, syntheticManual());
  assert.equal(manualChecks, 2);
  assert.equal(changes, 1); assert.equal(await store.hasPending(), true);
  assert.deepEqual(await deviceAnalysisDeliveries(f.database).pending('a'), [saved]);
  assert.deepEqual(await store.read('a', 'request'), output); assert.equal(await store.read('b', 'request'), null);
  await store.acknowledged('b', saved.jobId); assert.equal((await store.pending('a')).length, 1);
  await store.acknowledged('a', saved.jobId); assert.deepEqual(await store.pending('a'), []); assert.deepEqual(await store.read('a', 'request'), output);
  await store.completeAdmission('a', 'request', 'wrong-attempt');
  assert.deepEqual(await store.admission('a', 'request', 'new'), { id: 'first-attempt', jobId: saved.jobId });
  await store.completeAdmission('a', 'request', 'first-attempt');
  assert.deepEqual(await store.admission('a', 'request', 'new'), { id: 'new', jobId: null });
  t.mock.timers.setTime(Date.now() - 5000);
  const newer = { ...output, message: '合成した最新の解析結果' };
  await store.save('a', 'request', { ...saved, jobId: 'd'.repeat(64) }, newer, syntheticManual());
  assert.deepEqual(await store.read('a', 'request'), newer, 'a clock rollback cannot make a previous job newer than a later reanalysis');
  stop(); f.connection.close();
});
