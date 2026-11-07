import test from 'node:test';
import assert from 'node:assert/strict';
import { publicStoreFixture } from './helpers/appliance-public-store.mjs';
import { syntheticManual } from './helpers/synthetic-pdf.mjs';
import { decodeUploadedManual } from '../server/appliance-care-api/src/uploaded-manual.mjs';
import { analysisRequestKey } from '../server/appliance-care-api/src/analysis-runner.mjs';
import { publicKey } from '../server/appliance-care-api/src/public-access.mjs';
import { createMetWeatherEvaluator } from '../server/appliance-care-api/src/weather/forecast.mjs';

test('audit100 due analysis work cannot be hidden behind three unexpired execution or preparation leases', async () => {
  const at = Date.parse('2026-11-07T03:00:00Z');
  for (const executionState of ['executing', 'preparing']) {
    const f = publicStoreFixture({ now: () => at });
    for (let i = 0; i < 3; i++) f.records.set(`applianceApi/v1/jobs/a-${i}`, { executionState, queueVersion: 1, done: false, deadlineAt: at + 60_000, claimExpiresAt: at + 30_000 });
    f.records.set('applianceApi/v1/jobs/z-expired', { executionState, queueVersion: 1, done: false, deadlineAt: at - 1, claimExpiresAt: at - 1 });
    assert.deepEqual(await f.store.listAnalysisWork(1), ['z-expired'], executionState);
  }
});

test('audit100 concurrent retries prepare and encrypt one uploaded analysis input rather than every duplicate', async () => {
  const at = Date.parse('2026-11-07T03:00:00Z'); const f = publicStoreFixture({ now: () => at });
  await f.store.heartbeatAnalysisWorker();
  const request = { manufacturer: 'QA', productName: 'fixture', modelNumber: 'test', manual: decodeUploadedManual(syntheticManual()) };
  const input = { principal: { uid: 'synthetic-owner', anonymous: false, deviceId: publicKey('synthetic-device'), installationId: 'synthetic-installation-0001' },
    requestKey: analysisRequestKey(request), idempotencyKey: 'synthetic-request-100', analysisRequest: request };
  const stringify = Buffer.prototype.toString; let encodings = 0;
  Buffer.prototype.toString = function (...args) { if (this === request.manual.bytes && args[0] === 'base64') encodings++; return stringify.apply(this, args); };
  try {
    const results = await Promise.all(Array.from({ length: 16 }, () => f.store.admit(input)));
    assert.equal(results.filter(value => value.created).length, 1);
    assert.equal(encodings, 1, 'only the admitted copy needs a PDF Base64 envelope and encryption');
    assert.equal((await f.store.usage(input.principal)).used, 1);
  } finally { Buffer.prototype.toString = stringify; }
});

test('audit100 repeated weather slot evaluations do not scan the whole nine hundred interval forecast', () => {
  const at = Date.parse('2026-11-07T00:00:00Z'); const hour = 3_600_000;
  const intervals = Array.from({ length: 300 }, (_, i) => [1, 6, 12].map(hours => ({ start: at + i * hour, end: at + (i + hours) * hour,
    precipitationMm: 0, precipitationProbability: 0, symbol: 'clearsky_day' }))).flat();
  const evaluator = createMetWeatherEvaluator({ transformVersion: 1, generatedAt: new Date(at).toISOString(), from: new Date(at).toISOString(), through: new Date(at + 311 * hour).toISOString(), intervals });
  assert.ok(evaluator); const filter = Array.prototype.filter; let scanned = 0;
  Array.prototype.filter = function (predicate, thisArg) { if (this.length === 900 && this[0]?.precipitationMm === 0) scanned += this.length; return filter.call(this, predicate, thisArg); };
  try {
    for (let i = 0; i < 1000; i++) { const start = at + 100 * hour + i * 60_000; assert.equal(evaluator.evaluate(start, start + 30 * 60_000).known, true); }
    assert.ok(scanned < 50_000, `full forecast interval scans: ${scanned}`);
  } finally { Array.prototype.filter = filter; }
});
