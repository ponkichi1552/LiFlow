import { createHash, createHmac, createPublicKey, randomUUID, verify } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { deviceProofRequired, deviceProofTemporary, deviceProofUnavailable } from './native-device-authorization.mjs';
import { PublicApiError, usagePeriods } from './public-access.mjs';

const PACKAGE = 'jp.jphacks.tkb2633';
const PROPAGATION_MS = 35_000;
const androidKey = /^([a-f0-9]{64})\.([a-f0-9]{64})$/u;
const asDigest = value => typeof value === 'string' && /^[A-Za-z0-9_+/-]{43}=?$/u.test(value)
  ? Buffer.from(value, 'base64url').toString('hex') : null;

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

export function createAndroidApplianceDevice({ firestore, playIntegrity, signingDigests, secret, now = Date.now }) {
  const root = firestore.collection('applianceApi').doc('v1');
  const lock = root.collection('control').doc('androidEnrollment');
  const enrollments = root.collection('androidEnrollments');
  const pseudonym = value => createHmac('sha256', Buffer.from(secret, 'hex')).update('android-enrollment:' + value).digest('hex');
  function markers(value, challenge, keyId, issuedAt) {
    const { requestDetails, appIntegrity, deviceIntegrity, accountDetails } = value ?? {};
    const timestamp = Number(requestDetails?.timestampMillis);
    const expectedHash = createHash('sha256').update(JSON.stringify([challenge, keyId])).digest('hex');
    if (requestDetails?.requestPackageName !== PACKAGE || requestDetails.requestHash !== expectedHash
      || !Number.isSafeInteger(timestamp) || timestamp < issuedAt - 5000 || timestamp > now() + 5000
      || appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED' || appIntegrity.packageName !== PACKAGE
      || !appIntegrity.certificateSha256Digest?.some(digest => signingDigests.has(asDigest(digest)))
      || !deviceIntegrity?.deviceRecognitionVerdict?.includes('MEETS_DEVICE_INTEGRITY')
      || accountDetails?.appLicensingVerdict !== 'LICENSED') throw deviceProofRequired();
    const recall = deviceIntegrity.deviceRecall;
    if (typeof recall?.values?.bitFirst !== 'boolean') throw deviceProofUnavailable();
    const written = Number(recall.writeDates?.yyyymmFirst);
    if (recall.values.bitFirst && (!Number.isInteger(written) || written < 200001 || written % 100 < 1 || written % 100 > 12)) throw deviceProofUnavailable();
    return recall.values.bitFirst ? written : 0;
  }
  return {
    prepare(keyId) {
      if (typeof keyId !== 'string' || !androidKey.test(keyId)) throw deviceProofRequired();
      return 'prove';
    },
    async verify(claims, body) {
      if (typeof body.proof !== 'string' || body.proof.length < 32 || body.proof.length > 24_576 || !/^[A-Za-z0-9_.=-]+$/u.test(body.proof)) throw deviceProofRequired();
      const [_, deviceId, installationId] = androidKey.exec(claims.keyId);
      if (typeof body.publicKey !== 'string' || body.publicKey.length > 256 || typeof body.signature !== 'string' || body.signature.length > 160) throw deviceProofRequired();
      try {
        const keyBytes = Buffer.from(body.publicKey, 'base64');
        const key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
        const message = JSON.stringify([body.challenge, claims.keyId]);
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
          || createHash('sha256').update(body.publicKey).digest('hex') !== installationId || keyBytes.toString('base64') !== body.publicKey
          || !verify('sha256', Buffer.from(message), key, Buffer.from(body.signature, 'base64'))) throw deviceProofRequired();
      } catch { throw deviceProofRequired(); }
      const value = await playIntegrity.decode(body.proof);
      const written = markers(value, body.challenge, claims.keyId, claims.issuedAt);
      const { month, monthResetAt } = usagePeriods(now());
      const currentMonth = Number(month.replace('-', ''));
      const installation = pseudonym(`${deviceId}.${installationId}`);
      const ref = enrollments.doc(pseudonym(deviceId));
      const enrollment = await firestore.runTransaction(async transaction => {
        const [knownDocument, lockDocument] = await transaction.getAll(ref, lock);
        const known = knownDocument.data(); const active = lockDocument.data();
        const matches = known?.installation === installation && known?.month === month;
        if (matches && known.marked && written === currentMonth) return 'known';
        if (matches && known.marked && known.markedAt + PROPAGATION_MS > now()) throw deviceProofTemporary(known.markedAt + PROPAGATION_MS);
        if (matches && known.marked) throw deviceProofUnavailable();
        // A device-wide bit does not identify which pending registration wrote it.
        if (written >= currentMonth || !matches && known?.month === month) {
          throw new PublicApiError(403, 'REINSTALL_ACCOUNT_LOCKED', '以前の端末鍵を確認できないため、次の受付は翌月1日9時（日本時間）からです。',
            { retryAt: new Date(monthResetAt).toISOString() });
        }
        const at = now();
        if (at >= claims.expiresAt || at >= monthResetAt) throw deviceProofRequired();
        if (claims.mode === 'enroll') {
          if (active?.lease !== claims.lease || active.installation !== installation || active.writing || active.expiresAt <= at) throw deviceProofRequired();
          // The client obtains this second verdict only after rewarming Play Integrity under the lease.
          transaction.update(lock, { writing: true, expiresAt: at + 60_000 });
          transaction.set(ref, { installation, month, marked: false, expiresAt: new Date(monthResetAt + 90 * 86400_000) });
          return 'write';
        }
        if (active?.expiresAt > at) throw deviceProofTemporary(active.expiresAt);
        const lease = randomUUID();
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
      return { deviceId: pseudonym(deviceId), installationId: installation };
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
