import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndDeduplicateTasks } from '../server/appliance-care-api/src/manual-analyzer.mjs';
import { isBackedByOfficialSearchResult } from '../server/appliance-care-api/src/official-domains.mjs';
import { persistAnalysisResult } from '../server/appliance-care-api/src/persist-result.mjs';
import { publicStoreFixture } from './helpers/appliance-public-store.mjs';
import { publicKey } from '../server/appliance-care-api/src/public-access.mjs';

const manual = 'https://www.dyson.co.jp/manual?id=one';
const task = (extra = {}) => ({ name: 'フィルターの清掃', recommendedConditions: [], steps: ['水で洗う'], tools: [], safetyCautions: [], evidence: [{ url: manual }], ...extra });
test('duplicate AI tasks remain bounded after merging rather than returning an unusable paid result', () => {
  for (const [field, maximum] of [['recommendedConditions', 12], ['steps', 30], ['tools', 30], ['safetyCautions', 30], ['evidence', 12]]) {
    const list = prefix => Array.from({ length: maximum }, (_, n) => field === 'evidence' ? { url: manual, pageOrSection: `${prefix}-${n}` } : `${prefix}-${n}`);
    assert.throws(() => validateAndDeduplicateTasks([task({ [field]: list('a') }), task({ [field]: list('b') })], manual, ['dyson.co.jp']), undefined, field);
    assert.equal(validateAndDeduplicateTasks([task({ [field]: list('a') }), task({ [field]: list('a') })], manual, ['dyson.co.jp'])[0][field].length, maximum);
  }
});
test('an official URL query selecting another document cannot inherit the first document provenance', () => {
  assert.equal(isBackedByOfficialSearchResult('https://www.dyson.co.jp/manual?id=two', [manual], ['dyson.co.jp']), false);
  assert.equal(isBackedByOfficialSearchResult(`${manual}#page=2`, [manual], ['dyson.co.jp']), true);
  assert.throws(() => validateAndDeduplicateTasks([task({ evidence: [{ url: 'https://www.dyson.co.jp/manual?id=two' }] })], manual, ['dyson.co.jp']));
});

for (const responseLost of [false, true]) test(`a transient result-write failure recovers the same paid result and quota with responseLost=${responseLost}`, async () => {
  const f = publicStoreFixture(); const principal = { uid: 'audit', anonymous: false, deviceId: publicKey('device'), installationId: 'synthetic-installation-0001' };
  const admission = await f.store.admit({ principal, requestKey: 'a'.repeat(64), forceReanalysis: false, idempotencyKey: 'synthetic-persistence-audit' });
  const result = { status: 'verified', synthetic: true }; let writes = 0;
  await persistAnalysisResult({ finish: async (...args) => {
    writes++; if (writes === 1) {
      if (responseLost) await f.store.finish(...args);
      throw Object.assign(new Error('synthetic unavailable'), { code: 'unavailable' });
    }
    await f.store.finish(...args);
  } }, admission, result);
  assert.equal(writes, 2); assert.deepEqual((await f.store.read(principal, admission.jobId)).result, result);
  assert.equal((await f.store.usage(principal)).used, 1);
});
test('terminal write retries stop on permanent failure or reservation expiry without changing the refund policy', async () => {
  for (const [code, deadlineAt] of [['permission-denied', Date.now() + 60_000], ['unavailable', Date.now() - 1]]) {
    let writes = 0; const failure = Object.assign(new Error('synthetic'), { code });
    await assert.rejects(persistAnalysisResult({ finish: async () => { writes++; throw failure; } }, { deadlineAt }, {}), error => error === failure);
    assert.equal(writes, 1);
  }
});
