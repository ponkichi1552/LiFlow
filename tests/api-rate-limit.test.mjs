import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixedWindowRateLimit } from '../server/appliance-care-api/src/rate-limit.mjs';

test('API rate windows keep identity limits isolated and free expired capacity without extending active windows', () => {
  let clock = 0;
  const allow = createFixedWindowRateLimit({ limit: 2, maximumKeys: 2, windowMs: 100, now: () => clock });
  assert.equal(allow('a'), true); assert.equal(allow('a'), true); assert.equal(allow('a'), false);
  clock = 50; assert.equal(allow('b'), true); assert.equal(allow('c'), false);
  clock = 100; assert.equal(allow('a'), true); assert.equal(allow('c'), false);
  clock = 150; assert.equal(allow('c'), true); assert.equal(allow('a'), true); assert.equal(allow('a'), false);
  clock = 200; assert.equal(allow('b'), true); assert.equal(allow('a'), false, 'live identities retain the capacity bound');
});

test('API rate windows match a bounded reference through clock rollback expiry and repeated identities', () => {
  let clock = 0; let monotonic = 0; let random = 73;
  const model = new Map(); const allow = createFixedWindowRateLimit({ limit: 3, maximumKeys: 7, windowMs: 100, now: () => clock });
  for (let index = 0; index < 10000; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    clock += random % 31 - 10; const key = String(random % 11); monotonic = Math.max(monotonic, clock);
    for (const [id, value] of model) if (value.until <= monotonic) model.delete(id);
    const value = model.get(key); const expected = value ? value.count < 3 : model.size < 7;
    if (expected) model.set(key, { until: value?.until ?? monotonic + 100, count: (value?.count ?? 0) + 1 });
    assert.equal(allow(key), expected, `rate decision ${index}`);
  }
});
