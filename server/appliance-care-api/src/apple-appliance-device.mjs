import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyAssertion, verifyAttestation } from 'node-app-attest';
import { deviceProofRequired, deviceProofTemporary, deviceProofUnavailable } from './native-device-authorization.mjs';
import { PublicApiError, usagePeriods } from './public-access.mjs';

const APP_ID = 'jp.jphacks.tkb2633';
const standardBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const checkedBase64 = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && standardBase64.test(value);
const documentId = keyId => createHash('sha256').update(keyId).digest('hex');

export function createAppleDeviceCheck({ teamIdentifier, keyId, privateKey, now = Date.now, fetcher = fetch }) {
  if (!/^[A-Z0-9]{10}$/u.test(teamIdentifier) || !/^[A-Z0-9]{10}$/u.test(keyId)) throw new Error('Invalid Apple DeviceCheck credentials');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Invalid Apple DeviceCheck key');
  let cached;
  function token(at) {
    if (cached && at >= cached.at && at - cached.at < 5 * 60_000) return cached.value;
    const b64 = part => Buffer.from(JSON.stringify(part)).toString('base64url');
    const payload = `${b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64({ iss: teamIdentifier, iat: Math.floor(at / 1000) })}`;
    const signature = sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    cached = { at, value: `${payload}.${signature}` };
    return cached.value;
  }
  async function request(endpoint, deviceToken, values) {
    const at = now();
    try {
      const response = await fetcher(`https://api.devicecheck.apple.com/v1/${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${token(at)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ device_token: deviceToken, transaction_id: randomUUID(), timestamp: at, ...values }),
      });
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) throw deviceProofTemporary();
        throw deviceProofUnavailable();
      }
      return await response.text();
    } catch (cause) { if (cause instanceof PublicApiError) throw cause; throw deviceProofTemporary(); }
  }
  return {
    async read(deviceToken) {
      const text = await request('query_two_bits', deviceToken);
      if (text.trim() === 'Bit State Not Found') return { bit0: false, bit1: false, month: null };
      let value;
      try { value = JSON.parse(text); } catch { throw deviceProofUnavailable(); }
      if (typeof value?.bit0 !== 'boolean' || typeof value?.bit1 !== 'boolean' || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value.last_update_time)) throw deviceProofUnavailable();
      return { bit0: value.bit0, bit1: value.bit1, month: value.last_update_time };
    },
    async mark(deviceToken, previous) { await request('update_two_bits', deviceToken, { bit0: !previous.bit0, bit1: true }); },
  };
}

/** Duly attested Apple keys identify an installation. The Apple-owned bit blocks an unrecognized key during the same usage month. */
export function createAppleApplianceDevice({ firestore, teamIdentifier, deviceCheck, now = Date.now, attest = verifyAttestation, assertKey = verifyAssertion }) {
  const root = firestore.collection('applianceApi').doc('v1');
  const collection = root.collection('appleAttestations');
  const enrollmentLock = root.collection('control').doc('appleEnrollment');
  const identity = { teamIdentifier, bundleIdentifier: APP_ID };
  async function mark(ref, queryToken, updateToken, month, monthResetAt, newKey) {
    const lease = randomUUID();
    const alreadyMarked = await firestore.runTransaction(async transaction => {
      const [active, existing] = await transaction.getAll(enrollmentLock, ref);
      if (newKey && existing.exists) throw deviceProofRequired();
      if (existing.data()?.markedMonth === month) return true;
      if (active.data()?.expiresAt > now()) throw deviceProofTemporary(active.data().expiresAt);
      transaction.set(enrollmentLock, { lease, expiresAt: now() + 30_000 });
      return false;
    });
    if (alreadyMarked) return;
    const marker = await deviceCheck.read(queryToken);
    if (now() >= monthResetAt) throw deviceProofRequired();
    if (marker.bit1 && marker.month >= month) {
      await firestore.runTransaction(async transaction => {
        if ((await transaction.get(enrollmentLock)).data()?.lease === lease) transaction.delete(enrollmentLock);
      });
      throw new PublicApiError(403, 'REINSTALL_ACCOUNT_LOCKED', '以前の端末鍵を確認できないため、次の受付は翌月1日9時（日本時間）からです。',
        { retryAt: new Date(monthResetAt).toISOString() });
    }
    await firestore.runTransaction(async transaction => {
      const active = (await transaction.get(enrollmentLock)).data();
      if (active?.lease !== lease || active.expiresAt <= now()) throw deviceProofTemporary();
      transaction.update(enrollmentLock, { expiresAt: now() + 30_000 });
      if (newKey) transaction.create(ref, { publicKey: newKey, signCount: 0, expiresAt: new Date(monthResetAt + 90 * 86400_000) });
    });
    await deviceCheck.mark(updateToken, marker);
    await firestore.runTransaction(async transaction => {
      const active = (await transaction.get(enrollmentLock)).data();
      if (active?.lease !== lease || active.expiresAt <= now() || now() >= monthResetAt) throw deviceProofUnavailable();
      transaction.update(ref, { markedMonth: month, expiresAt: new Date(monthResetAt + 90 * 86400_000) });
      transaction.delete(enrollmentLock);
    });
  }
  return {
    async prepare(keyId) {
      if (!checkedBase64(keyId, 44)) throw deviceProofRequired();
      const bytes = Buffer.from(keyId, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== keyId) throw deviceProofRequired();
      const saved = (await collection.doc(documentId(keyId)).get()).data();
      return !saved ? 'attest' : saved.markedMonth === usagePeriods(now()).month ? 'assert' : 'assert-and-mark';
    },
    async verify(claims, body) {
      if (!checkedBase64(body.proof, 24_576)) throw deviceProofRequired();
      const needsMarker = claims.mode !== 'assert';
      if (needsMarker && (!checkedBase64(body.queryToken, 4096) || !checkedBase64(body.updateToken, 4096) || body.queryToken === body.updateToken)) throw deviceProofRequired();
      const payload = needsMarker ? JSON.stringify([body.challenge, body.queryToken, body.updateToken]) : body.challenge;
      const ref = collection.doc(documentId(claims.keyId));
      const { month, monthResetAt } = usagePeriods(now());
      const proof = Buffer.from(body.proof, 'base64');
      if (claims.mode === 'attest') {
        let result;
        try { result = attest({ ...identity, keyId: claims.keyId, challenge: payload, attestation: proof, allowDevelopmentEnvironment: false }); }
        catch { throw deviceProofRequired(); }
        if (result.environment !== 'production' || result.keyId !== claims.keyId || typeof result.publicKey !== 'string') throw deviceProofRequired();
        await mark(ref, body.queryToken, body.updateToken, month, monthResetAt, result.publicKey);
      } else {
        await firestore.runTransaction(async transaction => {
          const saved = (await transaction.get(ref)).data();
          if (!saved || !Number.isSafeInteger(saved.signCount) || claims.mode === 'assert' && saved.markedMonth !== month) throw deviceProofRequired();
          let result;
          try { result = assertKey({ ...identity, assertion: proof, payload, publicKey: saved.publicKey, signCount: saved.signCount }); }
          catch { throw deviceProofRequired(); }
          if (!Number.isSafeInteger(result.signCount) || result.signCount <= saved.signCount) throw deviceProofRequired();
          transaction.update(ref, { signCount: result.signCount });
        });
        if (needsMarker) await mark(ref, body.queryToken, body.updateToken, month, monthResetAt);
      }
      if (claims.expiresAt <= now() || now() >= monthResetAt) throw deviceProofRequired();
      return { deviceId: claims.keyId, installationId: claims.keyId };
    },
  };
}

export function configureAppleApplianceDevice({ firestore, env }) {
  const teamIdentifier = env.APPLIANCE_CARE_APPLE_TEAM_ID?.trim();
  const keyId = env.APPLIANCE_CARE_DEVICECHECK_KEY_ID?.trim();
  const keyFile = env.APPLIANCE_CARE_DEVICECHECK_PRIVATE_KEY_FILE?.trim();
  if (!teamIdentifier && !keyId && !keyFile) return undefined;
  if (!teamIdentifier || !keyId || !keyFile) throw new Error('Incomplete Apple App Attest and DeviceCheck configuration');
  return createAppleApplianceDevice({ firestore, teamIdentifier,
    deviceCheck: createAppleDeviceCheck({ teamIdentifier, keyId, privateKey: readFileSync(keyFile) }) });
}
