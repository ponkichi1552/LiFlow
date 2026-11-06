import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createSecureVault } from '../src/features/sharing/secure-vault.ts';

function fixture() {
  const values = new Map(); const writes = []; let fail = () => false; let removeFailure = () => false;
  const gateway = { async get(key) { return values.get(key) ?? null; }, async set(key, value) {
    assert.ok(Buffer.byteLength(value) <= 2048); writes.push({ key, value });
    if (fail(key, value) === 'before') throw new Error('injected write failure');
    values.set(key, value);
    if (fail(key, value) === 'after') throw new Error('injected response loss');
  }, async remove(key) {
    if (removeFailure(key) === 'before') throw new Error('injected deletion failure');
    values.delete(key);
    if (removeFailure(key) === 'after') throw new Error('injected deletion response loss');
  } };
  const rng = async (length) => new Uint8Array(randomBytes(length));
  return { values, writes, gateway, rng, vault: createSecureVault(gateway, rng), setFailure: (fn) => { fail = fn; },
    setRemoveFailure: fn => { removeFailure = fn; } };
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
    if (/\.[a-f0-9]{32}\.\d+$/u.test(key)) await new Promise(resolve => releases.push(resolve));
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

test('a failed protected deletion stays unreadable and restart retries every retained chunk instead of losing its location', async () => {
  const h = fixture(); await h.vault.setItem('account', 'private credential'.repeat(400));
  h.setRemoveFailure(key => key.endsWith('.1') ? 'before' : false);
  await assert.rejects(h.vault.removeItem('account'), /deletion failure/);
  assert.equal(await createSecureVault(h.gateway, h.rng).getItem('account'), null);
  assert.ok([...h.values.keys()].some(key => key.endsWith('.1')), 'the injected failure leaves real protected bytes');
  assert.ok([...h.values.keys()].some(key => key.endsWith('.cleanup')), 'restart needs durable deletion metadata');
  h.setRemoveFailure(() => false);
  await createSecureVault(h.gateway, h.rng).removeItem('account');
  assert.equal(h.values.size, 0);
});

test('replacing a protected value keeps retryable cleanup metadata until obsolete chunks have actually been deleted', async () => {
  const h = fixture(); await h.vault.setItem('account', 'old'.repeat(1500));
  const old = JSON.parse([...h.values.entries()].find(([key]) => key.endsWith('.manifest'))[1]);
  h.setRemoveFailure(key => key.includes(`.${old.generation}.`) ? 'before' : false);
  await h.vault.setItem('account', 'current');
  assert.equal(await createSecureVault(h.gateway, h.rng).getItem('account'), 'current');
  assert.ok([...h.values.keys()].some(key => key.endsWith('.cleanup')));
  await assert.rejects(h.vault.setItem('account', 'another'), /deletion failure/);
  h.setRemoveFailure(() => false);
  const restarted = createSecureVault(h.gateway, h.rng);
  assert.equal(await restarted.getItem('account'), 'current');
  assert.ok(![...h.values.keys()].some(key => key.includes(`.${old.generation}.`) || key.endsWith('.cleanup')));
  await restarted.removeItem('account'); assert.equal(h.values.size, 0);
});

test('an interrupted new credential write retains cleanup intent when unpublished chunks cannot yet be deleted', async () => {
  const h = fixture(); await h.vault.setItem('account', 'original');
  const manifestKey = [...h.values.keys()].find(key => key.endsWith('.manifest'));
  const old = JSON.parse(h.values.get(manifestKey));
  h.setFailure(key => key.endsWith('.1') ? 'before' : false);
  h.setRemoveFailure(key => !key.includes(`.${old.generation}.`) ? 'before' : false);
  await assert.rejects(h.vault.setItem('account', 'new'.repeat(1000)), /injected write failure/);
  assert.equal(await createSecureVault(h.gateway, h.rng).getItem('account'), 'original');
  assert.ok([...h.values.keys()].some(key => key.endsWith('.cleanup')));
  h.setRemoveFailure(() => false); h.setFailure(() => false);
  assert.equal(await createSecureVault(h.gateway, h.rng).getItem('account'), 'original');
  assert.equal(h.values.size, 2, 'only the original manifest and credential remain');
});

test('protected deletion survives a lost native reply without leaving a journal or removing another account', async () => {
  const h = fixture(); await h.vault.setItem('account', 'a'.repeat(6000)); await h.vault.setItem('other', 'other');
  h.setRemoveFailure(() => 'after');
  await h.vault.removeItem('account');
  assert.equal(await h.vault.getItem('account'), null); assert.equal(await h.vault.getItem('other'), 'other');
  assert.equal(h.values.size, 2);
});

test('protected values read legacy hex after upgrade and use compact canonical base64 for subsequent saves', async () => {
  const h = fixture(); const key = 'legacy-account'; const value = '旧形式の認証情報'.repeat(100);
  const data = Buffer.from(value); const hex = data.toString('hex'); const generation = 'a'.repeat(32);
  const base = `liflow.sharing.${createHash('sha256').update(key).digest('hex')}`;
  h.values.set(`${base}.manifest`, JSON.stringify({ version: 1, generation, chunks: Math.ceil(hex.length / 1000),
    bytes: data.length, digest: createHash('sha256').update(data).digest('hex') }));
  for (let i = 0; i < Math.ceil(hex.length / 1000); i++) h.values.set(`${base}.${generation}.${i}`, hex.slice(i * 1000, (i + 1) * 1000));
  assert.equal(await h.vault.getItem(key), value);
  await h.vault.setItem(key, value);
  const info = JSON.parse(h.values.get(`${base}.manifest`));
  assert.equal(info.version, 2); assert.equal(info.chunks, Math.ceil(data.toString('base64').length / 1000));
  assert.equal(await createSecureVault(h.gateway, h.rng).getItem(key), value);
  assert.ok(![...h.values.keys()].some(item => item.includes(`.${generation}.`)));
});

test('secure vault bounds native chunk concurrency and verifies a maximum-sized value before returning it', async () => {
  const h = fixture(); let running = 0; let maximum = 0;
  const get = h.gateway.get;
  h.gateway.get = async key => {
    running++; maximum = Math.max(maximum, running);
    await new Promise(setImmediate);
    try { return await get(key); } finally { running--; }
  };
  const value = 'a'.repeat(128 * 1024); await h.vault.setItem('maximum', value);
  assert.equal(await h.vault.getItem('maximum'), value);
  assert.ok(maximum > 1 && maximum <= 4, `native reads were not bounded: ${maximum}`);
});

test('a native cleanup rejection without a reason still fails deletion and preserves retry metadata', async () => {
  const h = fixture(); await h.vault.setItem('account', 'private credential');
  const remove = h.gateway.remove;
  h.gateway.remove = async key => {
    if (key.endsWith('.0')) return Promise.reject();
    return remove(key);
  };
  await assert.rejects(h.vault.removeItem('account'));
  assert.equal(await createSecureVault(h.gateway, h.rng).getItem('account'), null);
  assert.ok([...h.values.keys()].some(key => key.endsWith('.cleanup')));
  h.gateway.remove = remove;
  await createSecureVault(h.gateway, h.rng).removeItem('account');
  assert.equal(h.values.size, 0);
});
