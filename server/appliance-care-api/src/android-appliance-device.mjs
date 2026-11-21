import { createHash, createHmac, createPublicKey, randomUUID, verify } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { ANDROID_APPLIANCE_PACKAGE as PACKAGE, createAndroidKeyAttestation } from './android-key-attestation.mjs';
import { deviceProofRequired, deviceProofTemporary, deviceProofUnavailable } from './native-device-authorization.mjs';
import { PublicApiError, usagePeriods } from './public-access.mjs';

const PROPAGATION_MS = 35_000;
const androidKey = /^([a-f0-9]{64})\.([a-f0-9]{64})$/u;
const keyDigest = /^[a-f0-9]{64}$/u;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const asDigest = value => typeof value === 'string' && /^[A-Za-z0-9_+/-]{43}=?$/u.test(value)
  ? Buffer.from(value, 'base64url').toString('hex') : null;

function verifySignature(publicKey, signature, message, digest) {
  if (typeof publicKey !== 'string' || publicKey.length > 256 || typeof signature !== 'string' || signature.length > 160) throw deviceProofRequired();
  try {
    const keyBytes = Buffer.from(publicKey, 'base64');
    const signatureBytes = Buffer.from(signature, 'base64');
    const key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || sha256(publicKey) !== digest || keyBytes.toString('base64') !== publicKey || signatureBytes.toString('base64') !== signature
      || !verify('sha256', message, key, signatureBytes)) throw deviceProofRequired();
  } catch { throw deviceProofRequired(); }
}

export function createPlayIntegrityTransport({ auth, fetcher = fetch }) {
  async function call(path, data) {
    try {
      const token = await auth.getAccessToken();
      if (!token) throw deviceProofUnavailable();
      const response = await fetcher(`https://playintegrity.googleapis.com/v1/${PACKAGE}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429 || response.status >= 500) throw deviceProofTemporary();
        throw deviceProofUnavailable();
      }
      if (path === ':decodeIntegrityToken') return (await response.json()).tokenPayloadExternal;
      await response.body?.cancel();
    } catch (cause) { if (cause instanceof PublicApiError) throw cause; throw deviceProofTemporary(); }
  }
  return {
    decode: integrity_token => call(':decodeIntegrityToken', { integrity_token }),
    mark: integrityToken => call('/deviceRecall:write', { integrityToken, newValues: { bitFirst: true } }),
  };
}

export function createAndroidApplianceDevice({ firestore, playIntegrity, signingDigests, secret, now = Date.now,
  keyAttestation = createAndroidKeyAttestation({ signingDigests, now }) }) {
  const root = firestore.collection('applianceApi').doc('v1');
  const lock = root.collection('control').doc('androidEnrollment');
  const enrollments = root.collection('androidEnrollments');
  const attestations = root.collection('androidAttestations');
  const pseudonym = value => createHmac('sha256', Buffer.from(secret, 'hex')).update('android-enrollment:' + value).digest('hex');
  function markers(value, expectedHash, issuedAt, attestedDigests) {
    const { requestDetails, appIntegrity, deviceIntegrity, accountDetails } = value ?? {};
    const timestamp = Number(requestDetails?.timestampMillis);
    if (requestDetails?.requestPackageName !== PACKAGE || requestDetails.requestHash !== expectedHash
      || !Number.isSafeInteger(timestamp) || timestamp < issuedAt - 5000 || timestamp > now() + 5000
      || appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED' || appIntegrity.packageName !== PACKAGE
      || !Array.isArray(appIntegrity.certificateSha256Digest)
      || !appIntegrity.certificateSha256Digest.some(digest => attestedDigests.includes(asDigest(digest)))
      || !Array.isArray(deviceIntegrity?.deviceRecognitionVerdict) || !deviceIntegrity.deviceRecognitionVerdict.includes('MEETS_DEVICE_INTEGRITY')
      || accountDetails?.appLicensingVerdict !== 'LICENSED') throw deviceProofRequired();
    const recall = deviceIntegrity.deviceRecall;
    if (typeof recall?.values?.bitFirst !== 'boolean') throw deviceProofUnavailable();
    const written = Number(recall.writeDates?.yyyymmFirst);
    if (recall.values.bitFirst && (!Number.isInteger(written) || written < 200001 || written % 100 < 1 || written % 100 > 12)) throw deviceProofUnavailable();
    return recall.values.bitFirst ? written : 0;
  }
  return {
    async prepare(keyId, { hardwareKeyId } = {}) {
      if (typeof keyId !== 'string' || !androidKey.test(keyId)) throw deviceProofRequired();
      if (hardwareKeyId === undefined) return 'attest';
      if (typeof hardwareKeyId !== 'string' || !keyDigest.test(hardwareKeyId)) throw deviceProofRequired();
      const stored = (await attestations.doc(pseudonym(keyId)).get()).data();
      return await keyAttestation.accepts(stored, hardwareKeyId) ? 'prove' : 'attest';
    },
    async verify(claims, body) {
      if (typeof body.proof !== 'string' || body.proof.length < 32 || body.proof.length > 24_576 || !/^[A-Za-z0-9_.=-]+$/u.test(body.proof)) throw deviceProofRequired();
      const { hardwareKeyId } = body;
      if (typeof hardwareKeyId !== 'string' || !keyDigest.test(hardwareKeyId) || !['attest', 'prove', 'enroll'].includes(claims.mode)) throw deviceProofRequired();
      const [_, deviceId, installationId] = androidKey.exec(claims.keyId);
      // Keep the continuity key and quota identity stable when an attested key expires or is renewed.
      const message = Buffer.from(JSON.stringify([body.challenge, claims.keyId, hardwareKeyId]));
      verifySignature(body.publicKey, body.signature, message, installationId);
      const installation = pseudonym(claims.keyId);
      const attestationRef = attestations.doc(installation);
      const isAttesting = claims.mode === 'attest';
      const hardware = isAttesting ? await keyAttestation.verify(body.certificateChain, body.challenge) : (await attestationRef.get()).data();
      if (!hardware || (!isAttesting && (body.certificateChain !== undefined || !await keyAttestation.accepts(hardware, hardwareKeyId)))) throw deviceProofRequired();
      verifySignature(hardware.publicKey, body.hardwareSignature, message, hardwareKeyId);
      const value = await playIntegrity.decode(body.proof);
      const written = markers(value, sha256(message), claims.issuedAt, hardware.attestedDigests);
      const { month, monthResetAt } = usagePeriods(now());
      const currentMonth = Number(month.replace('-', ''));
      const ref = enrollments.doc(pseudonym(deviceId));
      const enrollment = await firestore.runTransaction(async transaction => {
        const [knownDocument, currentAttestation] = await transaction.getAll(ref, attestationRef);
        const known = knownDocument.data();
        const at = now();
        if (at >= claims.expiresAt || at >= monthResetAt || at >= hardware.validUntil
          || (!isAttesting && currentAttestation.data()?.keyDigest !== hardwareKeyId)) throw deviceProofRequired();
        const matches = known?.installation === installation && known?.month === month;
        if (matches && known.marked && written === currentMonth) {
          if (isAttesting) transaction.set(attestationRef, { ...hardware, expiresAt: new Date(hardware.validUntil) });
          return 'known';
        }
        if (matches && known.marked && known.markedAt + PROPAGATION_MS > now()) throw deviceProofTemporary(known.markedAt + PROPAGATION_MS);
        if (matches && known.marked) throw deviceProofUnavailable();
        // A device-wide bit does not identify which pending registration wrote it.
        if (written >= currentMonth || !matches && known?.month === month) {
          throw new PublicApiError(403, 'REINSTALL_ACCOUNT_LOCKED', '以前の端末鍵を確認できないため、次の受付は翌月1日9時（日本時間）からです。',
            { retryAt: new Date(monthResetAt).toISOString() });
        }
        const active = (await transaction.get(lock)).data();
        if (claims.mode === 'enroll') {
          if (active?.lease !== claims.lease || active.installation !== installation || active.writing || active.expiresAt <= at) throw deviceProofRequired();
          // The client obtains this second verdict only after rewarming Play Integrity under the lease.
          transaction.update(lock, { writing: true, expiresAt: at + 60_000 });
          transaction.set(ref, { installation, month, marked: false, expiresAt: new Date(monthResetAt + 90 * 86400_000) });
          return 'write';
        }
        if (active?.expiresAt > at) throw deviceProofTemporary(active.expiresAt);
        const lease = randomUUID();
        if (isAttesting) transaction.set(attestationRef, { ...hardware, expiresAt: new Date(hardware.validUntil) });
        transaction.set(lock, { lease, installation, writing: false, expiresAt: at + 45_000 });
        return { enrollmentLease: lease };
      });
      if (typeof enrollment === 'object') return enrollment;
      if (enrollment === 'write') {
        await playIntegrity.mark(body.proof);
        await firestore.runTransaction(async transaction => {
          const active = (await transaction.get(lock)).data();
          if (active?.lease !== claims.lease || active.expiresAt <= now() || now() >= monthResetAt) throw deviceProofUnavailable();
          transaction.update(ref, { marked: true, markedAt: now() });
          transaction.update(lock, { expiresAt: now() + PROPAGATION_MS });
        });
      }
      return { deviceId: pseudonym(deviceId), installationId: installation, validUntil: hardware.validUntil };
    },
  };
}

export function configureAndroidApplianceDevice({ firestore, env }) {
  const configured = env.APPLIANCE_CARE_ANDROID_PLAY_CERT_SHA256?.trim();
  if (!configured) return undefined;
  const values = configured.split(',').map(value => value.trim().toLowerCase());
  if (values.some(value => !/^[a-f0-9]{64}$/u.test(value))) throw new Error('Invalid Google Play signing certificate');
  const secret = env.APPLIANCE_CARE_ANDROID_DEVICE_ID_KEY;
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret)) throw new Error('Android device identities require a separate stable pseudonym key');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/playintegrity'] });
  return createAndroidApplianceDevice({ firestore, playIntegrity: createPlayIntegrityTransport({ auth }), signingDigests: new Set(values),
    secret });
}
