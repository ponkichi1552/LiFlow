import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createSignatureVerificationCache, SIGNATURE_CACHE_POLICY } from '../src/features/sharing/signature-verification-cache.ts';
import { createDeviceIdentity, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { loadNativeModule } from './helpers/native-module.mjs';

const publicKey = 'a1'.repeat(32), signature = 'b2'.repeat(64);
const text = '{"chore":"PRIVATE_SENTINEL","completed":true}';
async function storage() {
  const key = await crypto.randomBytes(32); let raw = null; let writes = 0;
  return { port: { crypto, key: async () => key, read: async () => raw, write: async next => { raw = next; writes++; } },
    raw: () => raw, replace: next => { raw = next; }, writes: () => writes };
}

test('protected signature memo restores only authenticated exact positive digests without retaining chore contents', async () => {
  const saved = await storage(); const first = createSignatureVerificationCache();
  await first.initialize(saved.port);
  assert.equal(first.has(publicKey, signature, text), false);
  first.rememberVerified(publicKey, signature, text); await first.flush();
  assert.equal(saved.writes(), 1); assert.equal(saved.raw().includes('PRIVATE_SENTINEL'), false);
  const envelope = JSON.parse(saved.raw());
  const clear = await crypto.decrypt(await saved.port.key(), Buffer.from(envelope.nonce, 'hex'), Buffer.from(envelope.ciphertext, 'hex'), new TextEncoder().encode(SIGNATURE_CACHE_POLICY));
  assert.equal(new TextDecoder().decode(clear).includes('PRIVATE_SENTINEL'), false, 'even decrypted memo contains only key/signature/digest tuples');
  const second = createSignatureVerificationCache(); await second.initialize(saved.port);
  assert.equal(second.has(publicKey, signature, text), true);
  assert.equal(second.has(publicKey, signature, text + ' '), false);
  assert.equal(second.has('c3'.repeat(32), signature, text), false);
  assert.equal(second.has(publicKey, 'd4'.repeat(64), text), false);
  await second.flush(); assert.equal(saved.writes(), 1, 'unchanged restored entries do not write during each read');
});

test('modified ciphertext wrong keys policies nonces and malformed verified rows cannot seed signature success', async () => {
  const saved = await storage(); const first = createSignatureVerificationCache(); await first.initialize(saved.port);
  first.rememberVerified(publicKey, signature, text); await first.flush();
  const raw = saved.raw(), envelope = JSON.parse(raw);
  for (const override of [{ policy: 'obsolete-verifier' }, { nonce: '00'.repeat(11) }, { ciphertext: envelope.ciphertext.slice(2) },
    { ciphertext: (envelope.ciphertext[0] === '0' ? '1' : '0') + envelope.ciphertext.slice(1) }, { unexpected: true }]) {
    const next = createSignatureVerificationCache(); await next.initialize({ ...saved.port, read: async () => JSON.stringify({ ...envelope, ...override }) });
    assert.equal(next.has(publicKey, signature, text), false);
  }
  const wrong = createSignatureVerificationCache(); await wrong.initialize({ ...saved.port, key: () => crypto.randomBytes(32) });
  assert.equal(wrong.has(publicKey, signature, text), false);
  for (const rows of [[[publicKey, signature, '00']], [[publicKey, signature, 'f0'.repeat(32), 'extra']],
    [[publicKey, signature, 'f0'.repeat(32)], [publicKey, signature, 'f0'.repeat(32)]], new Array(1025).fill([publicKey, signature, 'f0'.repeat(32)])]) {
    const nonce = await crypto.randomBytes(12);
    const ciphertext = await crypto.encrypt(await saved.port.key(), nonce, new TextEncoder().encode(JSON.stringify(rows)), new TextEncoder().encode(SIGNATURE_CACHE_POLICY));
    const next = createSignatureVerificationCache(); await next.initialize({ ...saved.port, read: async () => JSON.stringify({ policy: SIGNATURE_CACHE_POLICY, nonce: Buffer.from(nonce).toString('hex'), ciphertext: Buffer.from(ciphertext).toString('hex') }) });
    assert.equal(next.has(publicKey, signature, text), false);
  }
});

test('signature memo coalesces writes retains concurrent verified changes and bounds its restored entries', async () => {
  const saved = await storage(); const cache = createSignatureVerificationCache(); let finish;
  let block = false;
  await Promise.all([cache.initialize({ ...saved.port, write: async raw => { if (block) await new Promise(resolve => { finish = resolve; }); await saved.port.write(raw); } }), cache.initialize(saved.port)]);
  cache.rememberVerified(publicKey, signature, text); block = true; const pending = cache.flush();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const other = 'e5'.repeat(64); cache.rememberVerified(publicKey, other, 'changed'); block = false; finish(); await pending;
  const restored = createSignatureVerificationCache(); await restored.initialize(saved.port);
  assert.equal(restored.has(publicKey, signature, text), true); assert.equal(restored.has(publicKey, other, 'changed'), true);
  for (let i = 0; i < 1025; i++) cache.rememberVerified(publicKey, i.toString(16).padStart(128, '0'), `message-${i}`);
  await cache.flush();
  const bounded = createSignatureVerificationCache(); await bounded.initialize(saved.port);
  assert.equal(bounded.has(publicKey, signature, text), false);
  assert.equal(bounded.has(publicKey, (1024).toString(16).padStart(128, '0'), 'message-1024'), true);
});

test('unavailable protected storage never invents a positive verification or blocks the existing verifier', async () => {
  const cache = createSignatureVerificationCache();
  await cache.initialize({ crypto, key: async () => { throw new Error('locked'); }, read: async () => { throw new Error('unavailable'); }, write: async () => { throw new Error('full'); } });
  assert.equal(cache.has(publicKey, signature, text), false);
  cache.rememberVerified(publicKey, signature, text); await assert.doesNotReject(cache.flush());
  const fresh = createSignatureVerificationCache(); assert.equal(fresh.has(publicKey, signature, text), false);
});

test('a restored signature digest skips only the same strict proof while changed messages and revoked members still fail', async () => {
  const curves = await import('@noble/curves/ed25519.js');
  const { hkdf } = await import('@noble/hashes/hkdf.js'); const hashes = await import('@noble/hashes/sha2.js');
  const utils = await import('@noble/hashes/utils.js'); const operations = await import('../src/features/sharing/operations.ts');
  const content = await import('../src/features/sharing/content-digest.ts');
  const roster = await import('../src/features/sharing/roster.ts');
  let calls = 0;
  const verifier = memo => loadNativeModule('src/features/sharing/crypto.ts', {
    '@noble/curves/ed25519.js': { ...curves, ed25519: { ...curves.ed25519, verify: (...args) => { calls++; return curves.ed25519.verify(...args); } } },
    '@noble/hashes/hkdf.js': { hkdf }, '@noble/hashes/sha2.js': hashes, '@noble/hashes/utils.js': utils,
    './operations.ts': operations, './content-digest.ts': content, './signature-verification-cache.ts': { signatureVerificationCache: memo },
  });
  const owner = await createDeviceIdentity(crypto), member = await createDeviceIdentity(crypto);
  const value = { domain: 'memo-proof-test', payload: { enabled: true } }, signed = signSharedDocument(value, member);
  const saved = await storage(), first = createSignatureVerificationCache(); await first.initialize(saved.port);
  verifier(first).verifySharedDocument(value, signed, member); assert.equal(calls, 1); await first.flush();
  const restored = createSignatureVerificationCache(); await restored.initialize(saved.port); const next = verifier(restored);
  next.verifySharedDocument(value, signed, member); assert.equal(calls, 1, 'a fresh process may reuse authenticated byte-bound verification');
  assert.throws(() => next.verifySharedDocument({ ...value, payload: { enabled: false } }, signed, member), /signature/); assert.equal(calls, 2);
  assert.throws(() => next.verifySharedDocument(value, signed, { ...member, deviceId: owner.deviceId }), /fingerprint/);
  const initial = roster.createSharedRoster('memo-group', 'owner', owner, { schemaVersion: 2 });
  const joined = roster.approveSharedDevice(initial, owner, 'member', member);
  const removed = roster.removeSharedMember(joined, owner, 'member');
  next.verifySharedDocument(value, signed, member);
  assert.throws(() => roster.sharedAuthorIdentity(removed, 'member', member.deviceId, removed.body.keyVersion), /member|device|author|approval/i,
    'a valid old signature never establishes current membership');
});

test('signature memo policy pins the installed audited verifier version', async () => {
  const { readFileSync } = await import('node:fs');
  for (const dependency of ['curves', 'hashes']) {
    const pkg = JSON.parse(readFileSync(new URL(`../node_modules/@noble/${dependency}/package.json`, import.meta.url), 'utf8'));
    assert.ok(SIGNATURE_CACHE_POLICY.includes(`noble-${dependency}-${pkg.version}:`), 'dependency upgrades must invalidate persisted verification results');
  }
});

test('native signature memo persists through protected SQLite and vault without writing on every workspace read', async () => {
  const { createDatabase } = await import('./helpers/sqlite.mjs');
  const utils = await import('@noble/hashes/utils.js'); const isolated = await import('../src/platform/storage/isolated-transaction.ts');
  const db = createDatabase(); const vault = new Map(); let createdKeys = 0; const timers = [];
  const native = memo => loadNativeModule('src/platform/sharing/signature-verification-cache.ts', {
    '@noble/hashes/utils.js': utils,
    '../../features/sharing/signature-verification-cache.ts': { signatureVerificationCache: memo },
    './native-crypto.ts': { nativeSharingCrypto: crypto },
    './secure-store.ts': { sharingSecureVault: { getItem: async key => vault.get(key) ?? null, setItem: async (key, value) => { createdKeys++; vault.set(key, value); } } },
    '../storage/isolated-transaction.ts': isolated,
  }, { setTimeout: callback => { timers.push(callback); return timers.length; } });
  const first = createSignatureVerificationCache(), adapter = native(first);
  await Promise.all([adapter.initializeNativeSignatureCache(db.database), adapter.initializeNativeSignatureCache(db.database)]);
  assert.equal(createdKeys, 0); assert.equal(db.writes.length, 0);
  first.rememberVerified(publicKey, signature, text); first.rememberVerified(publicKey, signature, text);
  assert.equal(timers.length, 1); timers.shift()(); await first.flush();
  assert.equal(createdKeys, 1); assert.equal(db.writes.length, 1);
  const row = await db.database.getFirstAsync('SELECT encrypted_json FROM sharing_signature_memo');
  assert.equal(row.encrypted_json.includes('PRIVATE_SENTINEL'), false);
  const next = createSignatureVerificationCache(); await native(next).initializeNativeSignatureCache(db.database);
  assert.equal(next.has(publicKey, signature, text), true); await next.flush();
  assert.equal(createdKeys, 1); assert.equal(db.writes.length, 1);
  const envelope = JSON.parse(row.encrypted_json); envelope.ciphertext = (envelope.ciphertext[0] === '0' ? '1' : '0') + envelope.ciphertext.slice(1);
  await db.database.runAsync('UPDATE sharing_signature_memo SET encrypted_json=?', JSON.stringify(envelope));
  const modified = createSignatureVerificationCache(); await native(modified).initializeNativeSignatureCache(db.database);
  assert.equal(modified.has(publicKey, signature, text), false);
});

test('strict low order and noncanonical scalar rejections never become persisted verification successes', async () => {
  const curves = await import('@noble/curves/ed25519.js'); const { hkdf } = await import('@noble/hashes/hkdf.js');
  const hashes = await import('@noble/hashes/sha2.js'); const utils = await import('@noble/hashes/utils.js');
  const operations = await import('../src/features/sharing/operations.ts'); const content = await import('../src/features/sharing/content-digest.ts');
  const saved = await storage(), memo = createSignatureVerificationCache(); await memo.initialize(saved.port);
  const verifier = loadNativeModule('src/features/sharing/crypto.ts', { '@noble/curves/ed25519.js': curves, '@noble/hashes/hkdf.js': { hkdf },
    '@noble/hashes/sha2.js': hashes, '@noble/hashes/utils.js': utils, './operations.ts': operations,
    './content-digest.ts': content, './signature-verification-cache.ts': { signatureVerificationCache: memo } });
  const author = await createDeviceIdentity(crypto), value = { fixture: 'strict-verifier' };
  const encoded = new TextEncoder().encode(operations.canonicalJson(value));
  const smallOrderKey = '01' + '00'.repeat(31), forged = utils.bytesToHex(curves.ed25519.Point.BASE.toBytes()) + '01' + '00'.repeat(31);
  const badIdentity = { signingPublicKey: smallOrderKey, agreementPublicKey: author.agreementPublicKey };
  badIdentity.deviceId = 'device-' + utils.bytesToHex(hashes.sha256(new TextEncoder().encode(operations.canonicalJson(badIdentity))));
  assert.equal(curves.ed25519.verify(utils.hexToBytes(forged), encoded, utils.hexToBytes(smallOrderKey)), true, 'fixture distinguishes permissive ZIP215 from the required strict verifier');
  assert.throws(() => verifier.verifySharedDocument(value, forged, badIdentity), /signature/);
  const valid = signSharedDocument(value, author), bytes = utils.hexToBytes(valid);
  const order = curves.ed25519.Point.Fn.ORDER;
  let scalar = BigInt('0x' + Buffer.from(bytes.subarray(32)).reverse().toString('hex')) + order;
  for (let i = 32; i < 64; i++) { bytes[i] = Number(scalar & 255n); scalar >>= 8n; }
  assert.throws(() => verifier.verifySharedDocument(value, utils.bytesToHex(bytes), author), /signature/);
  await memo.flush(); assert.equal(saved.writes(), 0, 'invalid proofs cannot be persisted and later skip verification');
});
