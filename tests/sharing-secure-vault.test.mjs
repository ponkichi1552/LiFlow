import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createSecureVault } from '../src/features/sharing/secure-vault.ts';

function fixture() {
  const values = new Map(); const writes = []; let fail = () => false;
  const gateway = { async get(key) { return values.get(key) ?? null; }, async set(key, value) {
    assert.ok(Buffer.byteLength(value) <= 2048); writes.push({ key, value });
    if (fail(key, value) === 'before') throw new Error('injected write failure');
    values.set(key, value);
    if (fail(key, value) === 'after') throw new Error('injected response loss');
  }, async remove(key) { values.delete(key); } };
  const rng = async (length) => new Uint8Array(randomBytes(length));
  return { values, writes, gateway, rng, vault: createSecureVault(gateway, rng), setFailure: (fn) => { fail = fn; } };
}

test('large Firebase credentials remain entirely in protected chunks, survive restart and never exceed native value limits', async () => {
  const h = fixture(); const value = JSON.stringify({ refreshCredential: 'synthetic-'.repeat(3000), name: '利用者' });
  await h.vault.setItem('firebase:authUser:synthetic-app', value);
  const restarted = createSecureVault(h.gateway, h.rng);
  assert.equal(await restarted.getItem('firebase:authUser:synthetic-app'), value);
  assert.ok(h.values.size > 2); assert.ok(h.writes.every(({ key }) => !key.includes('authUser')));
  await restarted.removeItem('firebase:authUser:synthetic-app');
  assert.equal(await restarted.getItem('firebase:authUser:synthetic-app'), null); assert.equal(h.values.size, 0);
});

test('an interrupted secure-store update preserves the previous complete value and removes only unpublished new chunks', async () => {
  const h = fixture(); await h.vault.setItem('account', 'original credentials'); const original = new Map(h.values);
  h.setFailure((key) => key.endsWith('.1') ? 'before' : false);
  await assert.rejects(h.vault.setItem('account', 'replacement'.repeat(1000)), /injected/);
  assert.equal(await h.vault.getItem('account'), 'original credentials'); assert.deepEqual(h.values, original);
});

test('a lost manifest response never deletes chunks already referenced by a successfully committed manifest', async () => {
  const h = fixture(); await h.vault.setItem('account', 'old');
  h.setFailure((key) => key.endsWith('.manifest') ? 'after' : false);
  await h.vault.setItem('account', 'new'.repeat(1000));
  assert.equal(await h.vault.getItem('account'), 'new'.repeat(1000));
});

test('secure-store reads reject missing or corrupted chunks instead of silently replacing an account or device identity', async () => {
  const h = fixture(); await h.vault.setItem('identity', 'private synthetic identity');
  const chunk = [...h.values.keys()].find((key) => !key.endsWith('.manifest'));
  const saved = h.values.get(chunk); h.values.delete(chunk);
  await assert.rejects(h.vault.getItem('identity'), /incomplete/);
  h.values.set(chunk, saved.replace(/^../u, saved.startsWith('00') ? 'ff' : '00'));
  await assert.rejects(h.vault.getItem('identity'), /integrity/);
});

test('protected credential chunks are read concurrently after their committed manifest without skipping missing-chunk verification', async () => {
  const h = fixture(); const value = 'credential'.repeat(300); await h.vault.setItem('account', value);
  const get = h.gateway.get; const releases = [];
  h.gateway.get = async key => {
    if (!key.endsWith('.manifest')) await new Promise(resolve => releases.push(resolve));
    return get(key);
  };
  const pending = createSecureVault(h.gateway, h.rng).getItem('account');
  for (let i = 0; i < 10 && releases.length < 2; i++) await Promise.resolve();
  assert.ok(releases.length > 1, 'native reads must not wait one chunk at a time');
  releases.forEach(resolve => resolve()); assert.equal(await pending, value);
});

test('concurrent secure-store writes are serialized and account namespaces remain independent', async () => {
  const h = fixture();
  await Promise.all([h.vault.setItem('user-a', 'first'), h.vault.setItem('user-a', 'second'), h.vault.setItem('user-b', 'other')]);
  assert.equal(await h.vault.getItem('user-a'), 'second'); assert.equal(await h.vault.getItem('user-b'), 'other');
  await h.vault.removeItem('user-a'); assert.equal(await h.vault.getItem('user-b'), 'other');
  await h.vault.setItem('empty', ''); assert.equal(await h.vault.getItem('empty'), '');
});
