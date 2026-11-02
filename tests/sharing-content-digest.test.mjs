import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { sharedContentDigest } from '../src/features/sharing/content-digest.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { sharedOperationDigest } from '../src/features/sharing/replica.ts';
import { loadNativeModule } from './helpers/native-module.mjs';

function measuredDigest() {
  let calls = 0;
  const { sharedContentDigest: digest } = loadNativeModule('src/features/sharing/content-digest.ts', {
    '@noble/hashes/sha2.js': { sha256: bytes => { calls++; return sha256(bytes); } },
    '@noble/hashes/utils.js': { bytesToHex }, './operations.ts': { canonicalJson },
  });
  return { digest, calls: () => calls };
}

test('canonical serialization reuses bounded property-name checks while reading every changed value and rejecting unsafe fields', () => {
  const { canonicalJson: serialize } = loadNativeModule('src/features/sharing/operations.ts', {
    './group-clock.ts': {}, './identifier.ts': {}, './v2/payload-schema.ts': {}, './v2/date-target.ts': {},
  });
  const replace = String.prototype.replace; let checks = 0;
  String.prototype.replace = function (...args) { if (args[0] instanceof RegExp && args[0].source === '[_\\s-]') checks++; return Reflect.apply(replace, this, args); };
  try {
    for (let i = 0; i < 300; i++) {
      const value = { operationId: `check-${i}`, context: { first: i }, payload: { name: `浴室-${i}`, enabled: i % 2 === 0 } };
      assert.equal(serialize(value), `{"context":{"first":${i}},"operationId":"check-${i}","payload":{"enabled":${i % 2 === 0},"name":"浴室-${i}"}}`);
    }
    assert.ok(checks < 20, `repeated schema property names were normalized ${checks} times`);
    for (let i = 0; i < 600; i++) serialize({ [`safeField${i}`]: i });
    const evicted = checks; serialize({ operationId: 'after-bounded-eviction' }); assert.equal(checks, evicted + 1);
    const large = 'q'.repeat(300); const beforeLarge = checks;
    assert.equal(serialize({ [large]: 1 }), JSON.stringify({ [large]: 1 })); serialize({ [large]: 2 });
    assert.equal(checks, beforeLarge + 2, 'unbounded property-name strings must not remain resident');
    for (const key of ['accessToken', 'ACCESS_TOKEN', 'access-token', 'access token', 'constructor', '__proto__', 'groupKey', 'pdfBase64']) {
      for (let n = 0; n < 2; n++) assert.throws(() => serialize(JSON.parse(`{"${key}":"synthetic"}`)), /unsafe field/);
    }
    assert.throws(() => serialize({ payload: undefined }), /JSON object/);
    assert.throws(() => serialize(Array(4097).fill(null)), /array is too large/);
    assert.throws(() => serialize(Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`field${i}`, null]))), /object is too large/);
  } finally { String.prototype.replace = replace; }
});

test('content digest reuses exact canonical bytes across fresh objects but revalidates mutated and invalid values', () => {
  const { digest, calls } = measuredDigest();
  const value = { id: 'one', payload: { name: '浴室 🧹', enabled: true } };
  const first = digest(value);
  assert.equal(first, createHash('sha256').update(canonicalJson(value)).digest('hex'));
  assert.equal(digest({ payload: { enabled: true, name: '浴室 🧹' }, id: 'one' }), first); assert.equal(calls(), 1);
  value.payload.enabled = false; assert.notEqual(digest(value), first); assert.equal(calls(), 2);
  value.payload.enabled = true; assert.equal(digest(value), first); assert.equal(calls(), 2);
  assert.throws(() => digest({ ...value, accessToken: 'not-a-real-secret' }), /unsafe field/);
  assert.throws(() => digest({ ...value, invalid: undefined }), /JSON object/);
});

test('content digest bounds retained content and entry count and does not retain oversized snapshots', () => {
  const { digest, calls } = measuredDigest(); const first = { id: 'oldest' };
  digest(first);
  for (let i = 0; i < 4096; i++) digest({ id: `small-${i}` });
  const beforeEvicted = calls(); digest(first); assert.equal(calls(), beforeEvicted + 1);
  const large = { text: 'x'.repeat(1024 * 1024 + 1) };
  const beforeLarge = calls(); const expected = digest(large); assert.equal(digest(large), expected);
  assert.equal(calls(), beforeLarge + 2, 'oversized content is computed without being retained');
  const beforeKept = calls(); digest(first); assert.equal(calls(), beforeKept, 'a bypassed snapshot must not flush small useful entries');
});

test('shared document and operation digests preserve the original canonical SHA256 contract for all generated inputs', () => {
  for (let i = 0; i < 1024; i++) {
    const value = { operationId: `operation-${i}`, groupId: `group-${i % 7}`, context: { first: i, second: i % 9 },
      payload: { name: ['浴室', 'café', 'a\ud800', '🧹'][i % 4], enabled: i % 2 === 0, days: [i % 7, null, i / 3] } };
    const expected = createHash('sha256').update(canonicalJson(value)).digest('hex');
    assert.equal(sharedContentDigest(value), expected); assert.equal(sharedDocumentDigest(value), expected); assert.equal(sharedOperationDigest(value), expected);
  }
});

test('repeated retained facts and original proofs do not thrash the digest memo between adjacent repository reads', () => {
  const { digest, calls } = measuredDigest();
  const facts = Array.from({ length: 300 }, (_, index) => ({ operation: { schemaVersion: 2, operationId: `retained-${index}`,
    groupId: 'retained-workload', authorUserId: 'owner', deviceSequence: index + 1, logicalClock: index + 1,
    context: {}, payload: { name: `浴室-${index}`, enabled: index % 2 === 0 } }, authorSignature: 'a1'.repeat(64) }));
  const values = facts.flatMap(fact => [fact.operation, fact, [fact.operation, fact.authorSignature, { deviceId: 'device-owner' }]]);
  const expected = values.map(value => createHash('sha256').update(canonicalJson(value)).digest('hex'));
  assert.deepEqual(values.map(digest), expected); const first = calls();
  assert.deepEqual(values.map(value => digest(JSON.parse(JSON.stringify(value)))), expected);
  assert.equal(calls(), first, 'the normal operation/proof/digest passes must reuse previous exact bytes rather than rehash the entire retained set');
});
