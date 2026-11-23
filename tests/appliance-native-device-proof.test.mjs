import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createAppleApplianceDevice } from '../server/appliance-care-api/src/apple-appliance-device.mjs';
import { createAndroidApplianceDevice } from '../server/appliance-care-api/src/android-appliance-device.mjs';
import { createNativeDeviceAuthorization } from '../server/appliance-care-api/src/native-device-authorization.mjs';
import { createPublicApiAccess, usagePeriods } from '../server/appliance-care-api/src/public-access.mjs';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { publicStoreFixture } from './helpers/appliance-public-store.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';

const syntheticSecret = Buffer.alloc(32, 71).toString('hex');
const asBase64 = value => Buffer.from(String(value)).toString('base64');
const originalKey = Buffer.alloc(32, 11).toString('base64');
const replacementKey = Buffer.alloc(32, 12).toString('base64');

test('analysis polling reuses an unexpired device grant only for its exact account endpoint and admission', async t => {
  const baseUrl = 'https://analysis.example.invalid';
  const challenges = [];
  let monotonic = 0;
  let assertions = 0;
  t.mock.method(performance, 'now', () => monotonic);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/challenge')) {
      const { admissionId } = JSON.parse(options.body);
      challenges.push([url, options.headers.authorization, admissionId]);
      return Response.json({ challenge: `synthetic-${challenges.length}`, mode: 'assert' });
    }
    assert.ok(url.endsWith('/grant'));
    return Response.json({ grant: `grant-${assertions}.${'x'.repeat(43)}`, ttlMs: 60_000 });
  });
  const { applianceDeviceGrant } = loadNativeModule('src/platform/appliance-care/device-proof.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    expo: { requireOptionalNativeModule: () => ({}) },
    'expo-application': {}, 'expo-crypto': {},
    'expo-secure-store': { getItemAsync: async () => 'synthetic-key' },
    '@expo/app-integrity': { isSupported: true, async generateAssertionAsync() { return `assertion-${++assertions}`; } },
  });
  const obtain = (admissionId, owner = 'one', url = baseUrl) => applianceDeviceGrant(url, owner, `Bearer ${owner}`, admissionId);
  const [first, duplicate] = await Promise.all([obtain('analysis-a'), obtain('analysis-a')]);
  assert.equal(duplicate, first);
  assert.notEqual(await obtain('analysis-b'), first);
  assert.notEqual(await obtain(undefined), first, 'account binding requires its own unbound grant');
  monotonic = 44_999;
  assert.equal(await obtain('analysis-a'), first);
  assert.equal(challenges.length, 3);
  monotonic++;
  const refreshed = await obtain('analysis-a');
  assert.notEqual(refreshed, first);
  assert.notEqual(await obtain('analysis-a', 'two'), refreshed);
  assert.notEqual(await obtain('analysis-a', 'one', 'https://other.example.invalid'), refreshed);
  assert.notEqual(await obtain('analysis-a'), refreshed, 'switching scope drops the prior grant');
  assert.equal(challenges.length, 7);
});

test('native Apple proof keeps the lower account-device quota after an account switch and blocks a missing key until the next month', async () => {
  let at = Date.UTC(2026, 10, 21);
  const now = () => at;
  const fixture = publicStoreFixture({ now });
  const device = { bit0: false, bit1: false, month: null };
  const queryToken = asBase64('vendor-query-token'); const updateToken = asBase64('vendor-update-token');
  const ios = createAppleApplianceDevice({ firestore: fixture.firestore, now, teamIdentifier: 'DEMO123456', deviceCheck: {
    read: async token => { assert.equal(token, queryToken); return { ...device }; },
    mark: async (token, previous) => { assert.equal(token, updateToken); device.bit0 = !previous.bit0; device.bit1 = true; device.month = usagePeriods(now()).month; },
  }, attest: ({ keyId, allowDevelopmentEnvironment, challenge, bundleIdentifier }) => {
    assert.equal(bundleIdentifier, 'b166a1b2cdc2f.v1ed948b4df18');
    assert.equal(allowDevelopmentEnvironment, false);
    assert.deepEqual(JSON.parse(challenge).slice(1), [queryToken, updateToken]);
    return { environment: 'production', keyId, publicKey: 'verified synthetic public key' };
  }, assertKey: ({ assertion, signCount, bundleIdentifier }) => {
    assert.equal(bundleIdentifier, 'b166a1b2cdc2f.v1ed948b4df18');
    const fresh = Number(assertion.toString());
    if (fresh <= signCount) throw new Error('replayed assertion');
    return { signCount: fresh };
  } });
  const auth = createNativeDeviceAuthorization({ now, secret: syntheticSecret, providers: { ios } });
  const a = { uid: 'account-a' }; const b = { uid: 'account-b' };
  async function issue(identity, keyId, assertion = 1) {
    const { challenge } = await auth.challenge(identity, { platform: 'ios', keyId });
    return auth.grant(identity, { challenge, proof: asBase64(assertion), queryToken, updateToken });
  }
  const proof = (identity, grant) => ({ ...auth.verifyDevice({ headers: { 'x-liflow-device-grant': grant } }, identity), uid: identity.uid, anonymous: false });
  const first = proof(a, (await issue(a, originalKey)).grant);
  for (let index = 0; index < 3; index++) {
    const job = await fixture.store.admit({ principal: first, requestKey: `manual-${index}`, idempotencyKey: `synthetic-app-proof-request-${index}` });
    await fixture.store.finish(job, { status: 'not_found', message: '検査用の結果' });
  }
  const bGrant = await issue(b, originalKey, 2);
  assert.throws(() => proof(a, bGrant.grant), { code: 'DEVICE_VERIFICATION_REQUIRED' });
  assert.equal((await fixture.store.usage(proof(b, bGrant.grant))).remaining, 2);
  await assert.rejects(issue(b, originalKey, 2), { code: 'DEVICE_VERIFICATION_REQUIRED' });
  await assert.rejects(issue(b, replacementKey), { code: 'REINSTALL_ACCOUNT_LOCKED' });
  at = Date.UTC(2026, 11, 1) - 100;
  const oldPrincipal = proof(b, (await issue(b, originalKey, 3)).grant);
  at = Date.UTC(2026, 11, 1);
  await assert.rejects(fixture.store.admit({ principal: oldPrincipal, requestKey: 'new-month', idempotencyKey: 'proof-crossed-the-month-cutoff' }),
    { code: 'DEVICE_VERIFICATION_TEMPORARY' });
  assert.throws(() => proof(b, bGrant.grant), { code: 'DEVICE_VERIFICATION_REQUIRED' });
  assert.equal((await fixture.store.usage(proof(b, (await issue(b, replacementKey)).grant))).remaining, 5);
});

test('public app proof binds the vendor challenge to its account and gives an upload grant only to the exact admission', async t => {
  const fixture = publicStoreFixture();
  const nativeDevice = createNativeDeviceAuthorization({ secret: syntheticSecret, providers: { ios: {
    prepare: () => 'assert', verify: (_claims, body) => body.proof === 'valid-test-assertion' ? { deviceId: 'test-device', installationId: 'test-installation' } : null,
  } } });
  const access = createPublicApiAccess({ store: fixture.store, verifyDevice: nativeDevice.verifyDevice,
    verifyIdToken: async token => ({ uid: token, firebase: { sign_in_provider: 'google.com' } }) });
  const server = createApplianceCareHttpServer({ publicAccess: { ...access, nativeDevice } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/appliance-care`;
  const headers = { authorization: 'Bearer test-user-a', 'content-type': 'application/json' };
  const post = (path, body, values = headers) => fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: values });
  assert.equal((await fetch(base + '/usage', { headers })).status, 403);
  const id = 'synthetic-admission-for-real-path';
  const prepared = await post('/device/challenge', { platform: 'ios', keyId: 'synthetic-proof-key', admissionId: id });
  assert.equal(prepared.status, 200);
  const { challenge } = await prepared.json();
  const response = { challenge, proof: 'valid-test-assertion' };
  assert.equal((await post('/device/grant', response, { ...headers, authorization: 'Bearer test-user-b' })).status, 403);
  assert.equal((await post('/device/grant', { ...response, proof: 'unsigned stale clone' })).status, 403);
  const result = await post('/device/grant', response);
  assert.equal(result.status, 200);
  const { grant } = await result.json();
  const signed = { ...headers, 'x-liflow-device-grant': grant };
  const usage = await fetch(base + '/usage', { headers: signed });
  assert.equal((await usage.json()).usage.remaining, 5);
  assert.equal((await post('/jobs', {}, { ...signed, 'x-idempotency-key': 'synthetic-different-admission' })).status, 403);
  assert.equal((await post('/jobs', {}, { ...signed, 'x-idempotency-key': id })).status, 400);
  assert.equal((await fetch(base + '/usage', { headers: { ...signed, 'x-liflow-device-grant': grant.slice(1) } })).status, 403);
});

test('Android requires Play-signed app, evaluated Device Recall and a fresh exclusive enrollment before issuing a device grant', async () => {
  let at = Date.UTC(2026, 10, 21);
  const now = () => at;
  const fixture = publicStoreFixture({ now });
  const cert = Buffer.alloc(32, 36);
  const certDigest = cert.toString('hex');
  const proofs = new Map(); const attestations = new Map(); let written = 0; let marks = 0;
  const android = createAndroidApplianceDevice({ firestore: fixture.firestore, now, secret: syntheticSecret, signingDigests: new Set([cert.toString('hex')]),
    playIntegrity: { decode: async token => proofs.get(token), mark: async () => { written = Number(usagePeriods(now()).month.replace('-', '')); marks++; } },
    keyAttestation: {
      async verify(chain, challenge) {
        const key = attestations.get(challenge);
        assert.deepEqual(chain, ['synthetic certificate']);
        return { keyDigest: key.digest, publicKey: key.publicKey, attestedDigests: [certDigest], validUntil: now() + 3600_000 };
      },
      accepts: (record, digest) => record?.keyDigest === digest && record.validUntil > now(),
    },
  });
  const auth = createNativeDeviceAuthorization({ now, secret: syntheticSecret, providers: { android } });
  const signingKeys = new Map();
  function signingPair() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    return { ...pair, publicKey, digest: createHash('sha256').update(publicKey).digest('hex') };
  }
  function installation(device) {
    const continuity = signingPair();
    const keyId = `${device}.${continuity.digest}`;
    signingKeys.set(keyId, { continuity, hardware: signingPair() });
    return keyId;
  }
  const key = installation('ab'.repeat(32));
  const secondDevice = installation('ef'.repeat(32));
  const reinstalled = installation('ab'.repeat(32));
  const owner = { uid: 'account-a' };
  const other = { uid: 'account-b' };
  const get = (keyId, identity = owner) => auth.challenge(identity, { platform: 'android', keyId, hardwareKeyId: signingKeys.get(keyId).hardware.digest });
  function submit({ challenge, mode }, overrides, identity = owner, mutateBody) {
    const proof = `synthetic-android-play-integrity-${proofs.size}`;
    const { keyId } = JSON.parse(Buffer.from(challenge.split('.')[0], 'base64url'));
    const { continuity, hardware } = signingKeys.get(keyId);
    const message = Buffer.from(JSON.stringify([challenge, keyId, hardware.digest]));
    const payload = { requestDetails: { requestPackageName: 'jp.jphacks.tkb2633', requestHash: createHash('sha256').update(message).digest('hex'), timestampMillis: String(at) },
      appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: 'jp.jphacks.tkb2633', certificateSha256Digest: [cert.toString('base64url')] },
      deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'], deviceRecall: { values: { bitFirst: Boolean(written) }, writeDates: written ? { yyyymmFirst: written } : {} } },
      accountDetails: { appLicensingVerdict: 'LICENSED' } };
    overrides?.(payload);
    proofs.set(proof, payload);
    const body = { challenge, proof, publicKey: continuity.publicKey, hardwareKeyId: hardware.digest,
      signature: sign('sha256', message, continuity.privateKey).toString('base64'),
      hardwareSignature: sign('sha256', message, hardware.privateKey).toString('base64') };
    if (mode === 'attest') {
      attestations.set(challenge, hardware);
      body.certificateChain = ['synthetic certificate'];
    }
    mutateBody?.(body);
    return auth.grant(identity, body);
  }
  assert.equal((await get(key)).mode, 'attest');
  await assert.rejects(submit(await get(key), verdict => { verdict.appIntegrity.certificateSha256Digest = ['wrong']; }), { code: 'DEVICE_VERIFICATION_REQUIRED' });
  await assert.rejects(submit(await get(key), verdict => { verdict.deviceIntegrity.deviceRecall = {}; }), { code: 'DEVICE_VERIFICATION_UNAVAILABLE' });
  const lease = await submit(await get(key));
  assert.equal(lease.mode, 'enroll');
  await assert.rejects(submit(await get(secondDevice)), { code: 'DEVICE_VERIFICATION_TEMPORARY' });
  const first = await submit(lease);
  assert.ok(first.grant);
  assert.equal(marks, 1);
  assert.equal((await get(key)).mode, 'prove');
  await assert.rejects(submit(await get(key), undefined, owner, body => { body.hardwareSignature = body.signature; }), { code: 'DEVICE_VERIFICATION_REQUIRED' });
  assert.ok((await submit(await get(key))).grant);
  await assert.rejects(submit(await get(key), verdict => { verdict.deviceIntegrity.deviceRecall = { values: { bitFirst: false } }; }),
    { code: 'DEVICE_VERIFICATION_TEMPORARY' });
  at += 36_000;
  await assert.rejects(submit(await get(reinstalled, other), undefined, other), { code: 'REINSTALL_ACCOUNT_LOCKED' });
  await assert.rejects(submit(await get(secondDevice)), { code: 'REINSTALL_ACCOUNT_LOCKED' });

  const principal = (identity, grant) => ({ ...auth.verifyDevice({ headers: { 'x-liflow-device-grant': grant } }, identity), uid: identity.uid, anonymous: false });
  const firstPrincipal = principal(owner, first.grant);
  for (let index = 0; index < 3; index++) {
    const job = await fixture.store.admit({ principal: firstPrincipal, requestKey: `android-manual-${index}`, idempotencyKey: `synthetic-proof-and-quota-${index}` });
    await fixture.store.finish(job, { status: 'not_found', message: '検査用の結果' });
  }
  const otherGrant = await submit(await get(key, other), undefined, other);
  assert.equal((await fixture.store.usage(principal(other, otherGrant.grant))).remaining, 2);
  at += 3600_000;
  assert.equal((await get(key, other)).mode, 'attest');
  signingKeys.get(key).hardware = signingPair();
  const renewed = await submit(await get(key, other), undefined, other);
  const renewedPrincipal = principal(other, renewed.grant);
  assert.equal(renewedPrincipal.installationId, firstPrincipal.installationId);
  assert.equal((await fixture.store.usage(renewedPrincipal)).remaining, 2);
  assert.equal(marks, 1);
  at = Date.UTC(2026, 11, 1);
  const nextMonthLease = await submit(await get(reinstalled, other), undefined, other);
  const nextMonth = await submit(nextMonthLease, undefined, other);
  assert.equal((await fixture.store.usage(principal(other, nextMonth.grant))).remaining, 5);
});
