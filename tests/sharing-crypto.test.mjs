import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { sharingTestCrypto as gateway } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, decryptSharedOperation, decryptAuthenticatedSharedOperation, encryptSharedOperation,
  signSharedOperation, verifyAuthenticatedSharedOperation, unwrapGroupKey, wrapGroupKey,
  validateDevicePublicIdentity } from '../src/features/sharing/crypto.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { createSignatureVerificationCache } from '../src/features/sharing/signature-verification-cache.ts';

function operation(identity, overrides = {}) {
  return { schemaVersion: 1, operationId: 'operation-1', groupId: 'group-test', authorUserId: 'user-a',
    authorDeviceId: identity.deviceId, deviceSequence: 1, logicalClock: 1, context: {}, keyVersion: 1,
    entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: '秘密の家事 🧹', enabled: true }, ...overrides };
}

test('shared authenticated encryption round trips Japanese data without exposing entity names or payloads', async () => {
  const identity = await createDeviceIdentity(gateway); const key = await gateway.randomBytes(32); const op = operation(identity);
  const envelope = await encryptSharedOperation(gateway, op, key, identity);
  const encoded = JSON.stringify(envelope);
  assert.equal(encoded.includes('秘密'), false); assert.equal(encoded.includes('floor'), false);
  assert.equal(envelope.nonce.length, 24); assert.equal(envelope.salt.length, 64);
  assert.deepEqual(await decryptSharedOperation(gateway, envelope, key, identity, 'group-test', 1), op);
  const { signature, ...signed } = envelope;
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(identity.signingPublicKey, 'hex')]), format: 'der', type: 'spki' });
  assert.equal(nodeVerify(null, Buffer.from(canonicalJson(signed)), publicKey, Buffer.from(signature, 'hex')), true);
});

test('tampered ciphertext, metadata, group, author, nonce, signature and key version fail closed', async () => {
  const identity = await createDeviceIdentity(gateway); const other = await createDeviceIdentity(gateway);
  const key = await gateway.randomBytes(32); const envelope = await encryptSharedOperation(gateway, operation(identity), key, identity);
  const flip = (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
  for (const changed of [ { encryptedPayload: flip(envelope.encryptedPayload) }, { groupId: 'different' },
    { authorUserId: 'user-other' }, { operationId: 'other-operation' }, { nonce: flip(envelope.nonce) },
    { salt: flip(envelope.salt) }, { signature: flip(envelope.signature) }, { keyVersion: 2 },
    { logicalClock: 2 }, { suite: 'unknown' }, { plaintext: 'unexpected' } ]) {
    await assert.rejects(decryptSharedOperation(gateway, { ...envelope, ...changed }, key, identity, 'group-test', 1));
  }
  await assert.rejects(decryptSharedOperation(gateway, envelope, key, other, 'group-test', 1));
  await assert.rejects(decryptSharedOperation(gateway, envelope, await gateway.randomBytes(32), identity, 'group-test', 1));
  await assert.rejects(decryptSharedOperation(gateway, envelope, key, identity, 'group-test', 2));
});

test('the same content encrypted twice gets separate nonce and message keys while a saved retry envelope remains reusable', async () => {
  const identity = await createDeviceIdentity(gateway); const key = await gateway.randomBytes(32);
  const a = await encryptSharedOperation(gateway, operation(identity), key, identity);
  const b = await encryptSharedOperation(gateway, operation(identity), key, identity);
  assert.notEqual(a.nonce, b.nonce); assert.notEqual(a.salt, b.salt); assert.notEqual(a.encryptedPayload, b.encryptedPayload);
  const retry = JSON.parse(JSON.stringify(a));
  assert.deepEqual(await decryptSharedOperation(gateway, retry, key, identity, 'group-test', 1), operation(identity));
});

test('group key wrapping binds the authenticated sender, approved recipient, group and epoch', async () => {
  const sender = await createDeviceIdentity(gateway); const recipient = await createDeviceIdentity(gateway);
  const outsider = await createDeviceIdentity(gateway); const key = await gateway.randomBytes(32);
  const wrapped = await wrapGroupKey(gateway, 'group-test', 2, key, sender, recipient, 'user-b');
  assert.deepEqual(await unwrapGroupKey(gateway, wrapped, recipient, 'user-b', sender, 'group-test', 2), key);
  assert.equal(JSON.stringify(wrapped).includes(Buffer.from(key).toString('hex')), false);
  await assert.rejects(unwrapGroupKey(gateway, wrapped, outsider, 'user-b', sender, 'group-test', 2));
  await assert.rejects(unwrapGroupKey(gateway, wrapped, recipient, 'wrong-user', sender, 'group-test', 2));
  await assert.rejects(unwrapGroupKey(gateway, wrapped, recipient, 'user-b', outsider, 'group-test', 2));
  await assert.rejects(unwrapGroupKey(gateway, wrapped, recipient, 'user-b', sender, 'wrong-group', 2));
  await assert.rejects(unwrapGroupKey(gateway, wrapped, recipient, 'user-b', sender, 'group-test', 1));
  await assert.rejects(unwrapGroupKey(gateway, { ...wrapped, encryptedKey: '0'.repeat(96) }, recipient, 'user-b', sender, 'group-test', 2));
});

test('public key substitutions cannot keep the same pinned device fingerprint', async () => {
  const a = await createDeviceIdentity(gateway); const b = await createDeviceIdentity(gateway);
  assert.throws(() => validateDevicePublicIdentity({ ...a, signingPublicKey: b.signingPublicKey }), /fingerprint/);
  await assert.rejects(encryptSharedOperation(gateway, operation(a), await gateway.randomBytes(32), b), /identity mismatch/);
});

test('a snapshot preserves the original author proof and its owner cannot forge another members completion', async () => {
  const author = await createDeviceIdentity(gateway); const snapshotOwner = await createDeviceIdentity(gateway);
  const fact = signSharedOperation(operation(author), author);
  assert.deepEqual(verifyAuthenticatedSharedOperation(fact, author, 'group-test'), fact);
  assert.throws(() => verifyAuthenticatedSharedOperation({ ...fact,
    operation: { ...fact.operation, payload: { name: 'forged' } } }, author, 'group-test'), /signature/);
  assert.throws(() => verifyAuthenticatedSharedOperation(fact, snapshotOwner, 'group-test'), /identity mismatch/);
  assert.throws(() => signSharedOperation(fact.operation, snapshotOwner), /identity mismatch/);
});

test('key rotation reencrypts an unsent operation without changing its identity, causality or author signature', async () => {
  const author = await createDeviceIdentity(gateway); const original = operation(author);
  const firstKey = await gateway.randomBytes(32); const secondKey = await gateway.randomBytes(32);
  const first = await encryptSharedOperation(gateway, original, firstKey, author);
  const rotated = await encryptSharedOperation(gateway, original, secondKey, author, 2);
  assert.equal(first.operationId, rotated.operationId); assert.equal(rotated.keyVersion, 2);
  const a = await decryptAuthenticatedSharedOperation(gateway, first, firstKey, author, 'group-test', 1);
  const b = await decryptAuthenticatedSharedOperation(gateway, rotated, secondKey, author, 'group-test', 2);
  assert.deepEqual(a, b); assert.equal(b.operation.keyVersion, 1);
  await assert.rejects(decryptSharedOperation(gateway, rotated, firstKey, author, 'group-test', 2));
  await assert.rejects(encryptSharedOperation(gateway, { ...original, keyVersion: 2 }, firstKey, author, 1), /older group key/);
});

test('cryptographic creation rejects unavailable or short randomness instead of using an insecure fallback', async () => {
  await assert.rejects(createDeviceIdentity({ ...gateway, randomBytes: async () => new Uint8Array(1) }), /random source/);
  await assert.rejects(createDeviceIdentity({ ...gateway, randomBytes: async () => { throw new Error('unavailable'); } }), /unavailable/);
});


test('signature verification reuses only an identical authenticated message and still rejects changed data identities and invalid encodings', async () => {
  const { loadNativeModule } = await import('./helpers/native-module.mjs');
  const { ed25519, x25519 } = await import('@noble/curves/ed25519.js');
  const { hkdf } = await import('@noble/hashes/hkdf.js'); const { sha256 } = await import('@noble/hashes/sha2.js');
  const utils = await import('@noble/hashes/utils.js'); const operations = await import('../src/features/sharing/operations.ts');
  let checks = 0; let largeHashes = 0;
  const measuredHash = bytes => { if (bytes.length > 1024) largeHashes++; return sha256(bytes); };
  const memo = loadNativeModule('src/features/sharing/signature-verification-cache.ts', { '@noble/hashes/sha2.js': { sha256: measuredHash }, '@noble/hashes/utils.js': utils });
  const content = loadNativeModule('src/features/sharing/content-digest.ts', { '@noble/hashes/sha2.js': { sha256: measuredHash }, '@noble/hashes/utils.js': utils, './operations.ts': operations });
  const crypto = loadNativeModule('src/features/sharing/crypto.ts', {
    '@noble/curves/ed25519.js': { ed25519: { ...ed25519, verify: (...args) => { checks++; return ed25519.verify(...args); } }, x25519 },
    '@noble/hashes/hkdf.js': { hkdf }, '@noble/hashes/sha2.js': { sha256: measuredHash }, '@noble/hashes/utils.js': utils, './operations.ts': operations, './content-digest.ts': content,
    './signature-verification-cache.ts': { signatureVerificationCache: memo.createSignatureVerificationCache() },
  });
  const author = await createDeviceIdentity(gateway); const other = await createDeviceIdentity(gateway);
  const value = { groupId: 'signature-cache-test', body: { enabled: true, name: '浴室'.repeat(1024) } };
  const signed = crypto.signSharedDocument(value, author);
  crypto.verifySharedDocument(value, signed, author); crypto.verifySharedDocument(JSON.parse(JSON.stringify(value)), signed, author);
  assert.equal(checks, 1, 'equal content from a fresh SQLite read must not redo the same signature arithmetic');
  assert.equal(largeHashes, 1, 'the protected digest is computed only for the initial success; the identical in-memory lookup must not hash the payload again');
  value.body.enabled = false;
  assert.throws(() => crypto.verifySharedDocument(value, signed, author), /signature/);
  assert.throws(() => crypto.verifySharedDocument(value, signed, author), /signature/);
  assert.equal(checks, 3, 'failed checks must not become successful cache entries');
  value.body.enabled = true;
  assert.throws(() => crypto.verifySharedDocument(value, signed, { ...author, deviceId: other.deviceId }), /fingerprint/);
  assert.throws(() => crypto.verifySharedDocument(value, signed, other), /signature/);
  assert.throws(() => crypto.verifySharedDocument(value, signed.toUpperCase(), author), /encoding/);
  assert.throws(() => crypto.verifySharedDocument({ ...value, groupId: 'other-group' }, signed, author), /signature/);
  crypto.verifySharedDocument(value, signed, author); assert.equal(checks, 5);
});

test('signature verification cache evicts old successes and never turns a read result into membership authority', async () => {
  const { loadNativeModule } = await import('./helpers/native-module.mjs');
  const { ed25519, x25519 } = await import('@noble/curves/ed25519.js'); const { hkdf } = await import('@noble/hashes/hkdf.js');
  const { sha256 } = await import('@noble/hashes/sha2.js'); const utils = await import('@noble/hashes/utils.js');
  const operations = await import('../src/features/sharing/operations.ts'); let checks = 0;
  const crypto = loadNativeModule('src/features/sharing/crypto.ts', {
    '@noble/curves/ed25519.js': { ed25519: { ...ed25519, verify: (...args) => { checks++; return ed25519.verify(...args); } }, x25519 },
    '@noble/hashes/hkdf.js': { hkdf }, '@noble/hashes/sha2.js': { sha256 }, '@noble/hashes/utils.js': utils, './operations.ts': operations, './content-digest.ts': await import('../src/features/sharing/content-digest.ts'),
    './signature-verification-cache.ts': { signatureVerificationCache: createSignatureVerificationCache() },
  });
  const author = await createDeviceIdentity(gateway);
  const values = Array.from({ length: 1025 }, (_, index) => ({ groupId: 'bounded-signatures', index }));
  const signatures = values.map(value => crypto.signSharedDocument(value, author));
  values.forEach((value, index) => crypto.verifySharedDocument(value, signatures[index], author));
  assert.equal(checks, values.length);
  crypto.verifySharedDocument(values[0], signatures[0], author); assert.equal(checks, values.length + 1, 'the oldest signature is verified again after eviction');
  const unauthorized = { ...author, agreementPublicKey: '00'.repeat(32) };
  assert.throws(() => crypto.verifySharedDocument(values[0], signatures[0], unauthorized), /fingerprint/);
});

test('signature verification binds the validated identity before inspecting caller-owned signed content', async () => {
  const { signSharedDocument, verifySharedDocument } = await import('../src/features/sharing/crypto.ts');
  const author = await createDeviceIdentity(gateway); const other = await createDeviceIdentity(gateway);
  const value = { groupId: 'signature-identity-snapshot', body: { name: '浴室' } };
  const signature = signSharedDocument(value, other); verifySharedDocument(value, signature, other);
  const selected = { ...author };
  const changing = { groupId: value.groupId, get body() { Object.assign(selected, other); return value.body; } };
  assert.throws(() => verifySharedDocument(changing, signature, selected), /signature/,
    'looking at a payload must not swap the already-validated signing identity or select another cached signer');
});
