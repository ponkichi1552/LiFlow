import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createAndroidKeyAttestation } from '../server/appliance-care-api/src/android-key-attestation.mjs';

const requireFromApi = createRequire(new URL('../server/appliance-care-api/package.json', import.meta.url));
const { BitString, Boolean: AsnBoolean, Constructed, Enumerated, Integer, OctetString, Sequence, Set: AsnSet, Utf8String } = requireFromApi('asn1js');
const { AttributeTypeAndValue, BasicConstraints, Certificate, Extension } = requireFromApi('pkijs');
const at = Date.UTC(2026, 10, 21);
const signingDigest = Buffer.alloc(32, 32);
const challenge = 'synthetic signed enrollment challenge';
const attestOid = '1.3.6.1.4.1.11129.2.1.17';
const provisioningOid = '1.3.6.1.4.1.11129.2.1.30';

const integer = value => new Integer({ value });
const enumValue = value => new Enumerated({ value });
const octets = value => new OctetString({ valueHex: value });
const sequence = (...value) => new Sequence({ value });
const set = (...value) => new AsnSet({ value });
const tag = (tagNumber, value) => new Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [value] });
const extension = (extnID, value, critical = false) => new Extension({ extnID, critical, extnValue: value.toBER(false) });
const key = () => webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

function keyDescription({ packageName = 'jp.jphacks.tkb2633', digest = signingDigest, hardwareLevel = 1, locked = true, includeDigest = true } = {}) {
  const appId = sequence(set(sequence(octets(Buffer.from(packageName)), integer(1))), set(octets(digest))).toBER(false);
  const boot = sequence(octets(Buffer.alloc(32, 17)), new AsnBoolean({ value: locked }), enumValue(0), octets(Buffer.alloc(32, 19)));
  const software = sequence(tag(709, octets(appId)));
  const hardware = sequence(tag(1, set(integer(2))), tag(2, integer(3)), tag(3, integer(256)), ...(includeDigest ? [tag(5, set(integer(4)))] : []),
    tag(10, integer(1)), tag(702, integer(0)), tag(704, boot));
  return extension(attestOid, sequence(integer(3), enumValue(hardwareLevel), integer(4), enumValue(hardwareLevel),
    octets(createHash('sha256').update(challenge).digest()), octets(Buffer.alloc(0)), software, hardware));
}

async function certificate({ serial, subjectKey, issuer, ca = false, extensions = [], expiresAt = at + 7 * 86400_000, name = `Test CA ${serial}`, subjectSerial }) {
  const cert = new Certificate();
  cert.version = 2;
  cert.serialNumber = integer(serial);
  cert.subject.typesAndValues.push(new AttributeTypeAndValue({ type: '2.5.4.3', value: new Utf8String({ value: name }) }));
  if (subjectSerial) cert.subject.typesAndValues.push(new AttributeTypeAndValue({ type: '2.5.4.5', value: new Utf8String({ value: subjectSerial }) }));
  cert.issuer = issuer?.cert.subject ?? cert.subject;
  cert.notBefore.value = new Date(at - 86400_000);
  cert.notAfter.value = new Date(expiresAt);
  await cert.subjectPublicKeyInfo.importKey(subjectKey.publicKey);
  cert.extensions = [extension('2.5.29.19', new BasicConstraints({ cA: ca }).toSchema(), true),
    extension('2.5.29.15', new BitString({ valueHex: Uint8Array.of(ca ? 0x06 : 0x80) }), true), ...extensions];
  await cert.sign(issuer?.key.privateKey ?? subjectKey.privateKey, 'SHA-256');
  return { cert, key: subjectKey, input: Buffer.from(cert.toSchema().toBER()).toString('base64') };
}

async function certificates() {
  const [rootKey, intermediateKey, leafKey] = await Promise.all([key(), key(), key()]);
  const root = await certificate({ serial: 100, subjectKey: rootKey, ca: true });
  const intermediate = await certificate({ serial: 200, subjectKey: intermediateKey, issuer: root, ca: true,
    extensions: [extension(provisioningOid, octets(Buffer.alloc(0)))] });
  const leaf = await certificate({ serial: 300, subjectKey: leafKey, issuer: intermediate, extensions: [keyDescription()] });
  return { root, intermediate, leaf, chain: [leaf.input, intermediate.input, root.input] };
}

test('Android key attestation verifies Google-rooted certificate structure and insists on a hardware-generated key for the signed app and challenge', async () => {
  const { root, intermediate, leaf, chain } = await certificates();
  const verifier = createAndroidKeyAttestation({ roots: [Buffer.from(root.input, 'base64')], signingDigests: new Set([signingDigest.toString('hex')]), now: () => at,
    fetcher: async () => Response.json({ entries: {} }, { headers: { 'cache-control': 'public, max-age=86400' } }) });
  const record = await verifier.verify(chain, challenge);
  assert.equal(record.publicKey, Buffer.from(await webcrypto.subtle.exportKey('spki', leaf.key.publicKey)).toString('base64'));
  assert.deepEqual(await verifier.verify(chain.slice(0, -1), challenge), record);
  assert.equal(await verifier.accepts(record, record.keyDigest), true);
  assert.equal(verifier.accepts(record, 'different digest'), false);
  assert.equal(Object.keys(record).includes('certificateChain'), false);
  const rejection = { code: 'DEVICE_VERIFICATION_REQUIRED' };
  await assert.rejects(verifier.verify(chain, 'second-challenge'), rejection);
  await assert.rejects(verifier.verify([chain[0], chain[2], chain[1]], challenge), rejection);
  const untrusted = createAndroidKeyAttestation({ signingDigests: new Set([signingDigest.toString('hex')]), now: () => at });
  await assert.rejects(untrusted.verify(chain, challenge), rejection);
  for (const options of [{ packageName: 'test.other.package' }, { digest: Buffer.alloc(32, 4) }, { hardwareLevel: 0 }, { locked: false }]) {
    const changed = await certificate({ serial: 300, subjectKey: leaf.key, issuer: intermediate, extensions: [keyDescription(options)] });
    await assert.rejects(verifier.verify([changed.input, ...chain.slice(1)], challenge), rejection);
  }
  const incorrectIssuer = await certificate({ serial: 400, subjectKey: intermediate.key, issuer: root, ca: true, extensions: [keyDescription()] });
  const subordinate = await certificate({ serial: 500, subjectKey: leaf.key, issuer: incorrectIssuer, extensions: [keyDescription()] });
  await assert.rejects(verifier.verify([subordinate.input, incorrectIssuer.input, root.input], challenge), rejection);
});

test('Android key attestation refreshes certificate revocation state and fails closed if the fresh list is unavailable', async () => {
  const { root, chain } = await certificates();
  let now = at;
  let status = 'valid';
  let requests = 0;
  const verifier = createAndroidKeyAttestation({ roots: [Buffer.from(root.input, 'base64')], signingDigests: new Set([signingDigest.toString('hex')]), now: () => now,
    async fetcher(url, options) {
      assert.equal(url, 'https://android.googleapis.com/attestation/status');
      assert.equal(options.redirect, 'error');
      requests++;
      if (status === 'unavailable') return new Response(null, { status: 503 });
      const entries = status === 'revoked' ? { '000c8': { status: 'REVOKED' } } : {};
      return Response.json({ entries }, { headers: { 'cache-control': 'public, max-age=10', age: '9' } });
    },
  });
  const record = await verifier.verify(chain, challenge);
  assert.deepEqual(await Promise.all([verifier.accepts(record, record.keyDigest), verifier.accepts(record, record.keyDigest)]), [true, true]);
  assert.equal(requests, 1);
  now += 1000;
  status = 'revoked';
  assert.equal(await verifier.accepts(record, record.keyDigest), false);
  await assert.rejects(verifier.verify(chain, challenge), { code: 'DEVICE_VERIFICATION_REQUIRED' });
  now += 1000;
  status = 'unavailable';
  await assert.rejects(verifier.accepts(record, record.keyDigest), { code: 'DEVICE_VERIFICATION_TEMPORARY' });
  await assert.rejects(verifier.accepts(record, record.keyDigest), { code: 'DEVICE_VERIFICATION_TEMPORARY' });
  assert.equal(requests, 3);
});

test('Android factory attestation accepts authorized legacy issuer expiry while rejecting revoked or expired remotely provisioned chains', async () => {
  const [rootKey, intermediateKey, attestationKey, leafKey] = await Promise.all([key(), key(), key(), key()]);
  const rootIdentity = { ca: true, subjectSerial: 'f92009e853b6b045', name: 'Test factory trust anchor', subjectKey: rootKey };
  const root = await certificate({ ...rootIdentity, serial: 100 });
  const oldRoot = await certificate({ ...rootIdentity, serial: 101, expiresAt: at - 1000 });
  const intermediate = await certificate({ serial: 200, issuer: root, subjectKey: intermediateKey, ca: true, subjectSerial: 'legacy-issuer', expiresAt: at - 1000 });
  const signer = await certificate({ serial: 300, issuer: intermediate, subjectKey: attestationKey, expiresAt: at - 1000 });
  const leaf = await certificate({ serial: 400, issuer: signer, subjectKey: leafKey, extensions: [keyDescription({ includeDigest: false })] });
  const chain = [leaf.input, signer.input, intermediate.input, oldRoot.input];
  const verifier = (entries = {}) => createAndroidKeyAttestation({ roots: [Buffer.from(root.input, 'base64')], signingDigests: new Set([signingDigest.toString('hex')]),
    now: () => at, fetcher: async () => Response.json({ entries }, { headers: { 'cache-control': 'public, max-age=86400' } }) });
  assert.equal((await verifier().verify(chain, challenge)).validUntil, at + 7 * 86400_000);
  const rejection = { code: 'DEVICE_VERIFICATION_REQUIRED' };
  await assert.rejects(verifier({ '12c': { status: 'SUSPENDED' } }).verify(chain, challenge), rejection);
  await assert.rejects(verifier({ '65': { status: 'REVOKED' } }).verify(chain, challenge), rejection);
  const remoteSigner = await certificate({ serial: 301, issuer: intermediate, subjectKey: attestationKey, ca: true, expiresAt: at - 1000,
    extensions: [extension(provisioningOid, octets(Buffer.alloc(0)))] });
  await assert.rejects(verifier().verify([leaf.input, remoteSigner.input, intermediate.input, root.input], challenge), rejection);
});
