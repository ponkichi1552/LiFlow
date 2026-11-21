import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PublicApiError, usagePeriods } from './public-access.mjs';

const CHALLENGE_MS = 120_000;
const GRANT_MS = 12 * 60_000;
export const deviceProofRequired = () => new PublicApiError(403, 'DEVICE_VERIFICATION_REQUIRED', '正規アプリと端末を確認できません。アプリを開き直してお試しください。');
export const deviceProofUnavailable = () => new PublicApiError(503, 'DEVICE_VERIFICATION_UNAVAILABLE', '端末を確認できませんでした。時間をおいてお試しください。');
export const deviceProofTemporary = (retryAt = Date.now() + 15_000) => new PublicApiError(503, 'DEVICE_VERIFICATION_TEMPORARY',
  '端末の確認に時間がかかっています。少し待ってお試しください。', { retryAt: new Date(retryAt).toISOString() });

export function createNativeDeviceAuthorization({ secret, providers, now = Date.now }) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/u.test(secret)) throw new Error('Invalid appliance device authorization key');
  const key = Buffer.from(secret, 'hex');
  const sign = (kind, data) => createHmac('sha256', key).update(kind + '.' + data).digest();
  const encode = (kind, claims) => {
    const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${data}.${sign(kind, data).toString('base64url')}`;
  };
  const decode = (kind, input, uid) => {
    if (typeof input !== 'string' || input.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(input)) throw deviceProofRequired();
    const [data, signature] = input.split('.');
    if (!timingSafeEqual(sign(kind, data), Buffer.from(signature, 'base64url'))) throw deviceProofRequired();
    let claims;
    try { claims = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw deviceProofRequired(); }
    if (claims?.sub !== uid || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now()
      || !Object.hasOwn(providers, claims.platform)) throw deviceProofRequired();
    return claims;
  };
  const pseudonym = (platform, id) => createHash('sha256').update(JSON.stringify(['liflow-appliance', platform, id])).digest('hex');
  function newChallenge(uid, platform, keyId, mode, admissionId, lease) {
    const issuedAt = now();
    const expiresAt = Math.min(issuedAt + CHALLENGE_MS, usagePeriods(issuedAt).monthResetAt);
    const challenge = encode('challenge', { sub: uid, platform, keyId, mode, admissionId, lease, issuedAt, nonce: randomBytes(32).toString('base64url'), expiresAt });
    return { challenge, mode };
  }
  return Object.freeze({
    async challenge({ uid }, input) {
      const { platform, keyId, admissionId } = input ?? {};
      if (typeof platform !== 'string' || !Object.hasOwn(providers, platform)) throw deviceProofUnavailable();
      if (admissionId !== undefined && (typeof admissionId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/u.test(admissionId))) throw deviceProofRequired();
      const mode = await providers[platform].prepare(keyId);
      return newChallenge(uid, platform, keyId, mode, admissionId);
    },
    async grant({ uid }, body) {
      if (!body || typeof body !== 'object') throw deviceProofRequired();
      const claims = decode('challenge', body.challenge, uid);
      const proof = await providers[claims.platform].verify(claims, body);
      const at = now();
      if (!proof || claims.expiresAt <= at) throw deviceProofRequired();
      if (proof.enrollmentLease) return newChallenge(uid, claims.platform, claims.keyId, 'enroll', claims.admissionId, proof.enrollmentLease);
      const ttlMs = Math.min(GRANT_MS, usagePeriods(at).monthResetAt - at);
      const installationId = pseudonym(claims.platform + '/install', proof.installationId);
      const deviceId = pseudonym(claims.platform, proof.deviceId);
      return { grant: encode('grant', { sub: uid, platform: claims.platform, installationId, deviceId,
        admissionId: claims.admissionId, expiresAt: at + ttlMs }), ttlMs };
    },
    verifyDevice(request, { uid }) {
      const claims = decode('grant', request.headers['x-liflow-device-grant'], uid);
      if (request.method === 'POST' && (!claims.admissionId || request.headers['x-idempotency-key'] !== claims.admissionId)) throw deviceProofRequired();
      return { installationId: claims.installationId, deviceId: claims.deviceId, reinstallProtection: 'verified', deviceVerifiedUntil: claims.expiresAt };
    },
  });
}
