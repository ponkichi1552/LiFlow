import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { patchAuthNetwork, target } = require('../scripts/patch-firestore-auth-network.cjs');
const source = readFileSync(new URL(`../node_modules/@firebase/firestore/${target}`, import.meta.url), 'utf8');
const codes = Object.fromEntries(['UNKNOWN', 'UNAVAILABLE', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'ABORTED', 'INVALID_ARGUMENT']
  .map(key => [key, key.toLowerCase().replaceAll('_', '-')]));
class FirestoreError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'FirebaseError'; }
}
const start = source.indexOf('class Datastore {}');
const end = source.indexOf('// TODO(firestorexp)', start);
assert.ok(start > 0 && end > start);
// Exercise the actual packaged RN transport on both mobile platforms. The
// injected connection is isolated: there is no real identity or network call.
const Datastore = Function('z', 'K', '__PRIVATE_toResourcePath',
  source.slice(start, end) + '\nreturn __PRIVATE_DatastoreImpl;')(codes, FirestoreError, () => 'isolated-target');

test('Firestore Auth network fix is exact, repeatable and rejects changed upstream code', () => {
  assert.equal(patchAuthNetwork(source), source, 'npm postinstall must apply the native transport fix');
  assert.throws(() => patchAuthNetwork(source + '\n// changed upstream'), /transport changed/);
  assert.throws(() => patchAuthNetwork('unknown source'), /transport changed/);
});

test('the packaged native Firebase SDK bounds offline retries and keeps its queue usable', () => {
  const child = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    fileURLToPath(new URL('./helpers/firebase-offline-sdk.mjs', import.meta.url))], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.error, undefined, 'offline credentials must not leave the SDK queue stuck');
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /INTERNAL ASSERTION/);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result, { attempts: 3, errors: ['unavailable', 'unavailable'], queueClosed: true });
});

for (const platform of ['ios', 'android']) for (const rpc of ['In', 'dn']) {
  test(`${platform} Firestore ${rpc} retries credential network failure without a token or successful result`, async () => {
    let credentials = 0, requests = 0, invalidations = 0;
    const identity = { user: platform, headers: new Map([['Authorization', 'synthetic-test-only']]) };
    const auth = { getToken: async () => {
      credentials++;
      if (credentials === 1) throw new FirestoreError('auth/network-request-failed', 'synthetic failure');
      return identity;
    }, invalidateToken: () => { invalidations++; } };
    const appCheck = { getToken: async () => null, invalidateToken: () => { invalidations++; } };
    const connection = { [rpc]: async (_name, _target, _request, token) => { requests++; assert.equal(token, identity); return { accepted: true }; } };
    const store = new Datastore(auth, appCheck, connection, {});
    await assert.rejects(store[rpc]('isolated', {}, {}), error => error.code === 'unavailable');
    assert.equal(requests, 0, 'a failed credential fetch never reaches the service');
    assert.deepEqual(await store[rpc]('isolated', {}, {}), { accepted: true });
    assert.equal(requests, 1); assert.equal(credentials, 2); assert.equal(invalidations, 0);
  });
  test(`${platform} Firestore ${rpc} preserves denied, unauthenticated and ordinary transport failures`, async () => {
    for (const code of ['permission-denied', 'unauthenticated', 'invalid-argument', 'aborted']) {
      let invalidations = 0; const error = new FirestoreError(code, 'synthetic rejection');
      const provider = { getToken: async () => null, invalidateToken: () => { invalidations++; } };
      const store = new Datastore(provider, provider, { [rpc]: async () => { throw error; } }, {});
      await assert.rejects(store[rpc]('isolated', {}, {}), actual => actual === error);
      assert.equal(invalidations, code === 'unauthenticated' ? 2 : 0);
    }
    const provider = { getToken: async () => null };
    const store = new Datastore(provider, provider, { [rpc]: async () => { throw new Error('synthetic failure'); } }, {});
    await assert.rejects(store[rpc]('isolated', {}, {}), error => error.code === 'unknown');
  });
}
