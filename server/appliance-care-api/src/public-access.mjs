import { createHash } from 'node:crypto';

export const PUBLIC_API_POLICY = Object.freeze({ monthlyLimit: 5, dailyGlobalLimit: 20, maxConcurrent: 3,
  jobTimeoutMs: 10 * 60_000, retentionMs: 7 * 24 * 60 * 60_000 });

export class PublicApiError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}

/** UTC month boundaries are exactly 09:00 Japan time on the first day. The device clock is never trusted. */
export function usagePeriods(now) {
  const date = new Date(now);
  if (!Number.isSafeInteger(now) || !Number.isFinite(date.getTime())) throw new Error('Invalid server clock');
  return { month: date.toISOString().slice(0, 7), day: date.toISOString().slice(0, 10),
    monthResetAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    dayResetAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) };
}

export function publicKey(value) { return createHash('sha256').update(value).digest('hex'); }
export function publicJobId(principal, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/u.test(idempotencyKey)) {
    throw new PublicApiError(400, 'INVALID_REQUEST', '解析の受付IDを確認してください。');
  }
  // Retries share the explicit request ID. A fresh, user-initiated retry may analyze a previously failed product.
  return publicKey(JSON.stringify([principal.uid, idempotencyKey]));
}

export function publicUsage(used, now, policy = PUBLIC_API_POLICY) {
  return { limit: policy.monthlyLimit, used, remaining: Math.max(0, policy.monthlyLimit - used),
    resetsAt: new Date(usagePeriods(now).monthResetAt).toISOString() };
}

/** The verifier is the official Firebase Admin verifier, including revoked-token and disabled-user checks. */
export function createPublicApiAccess({ verifyIdToken, verifyDevice, store }) {
  if (typeof verifyIdToken !== 'function' || !store || !['admit', 'read', 'finish', 'usage'].every(key => typeof store[key] === 'function')) {
    throw new Error('Public authentication and durable quota storage are required');
  }
  return Object.freeze({ mode: 'firebase-firestore', securityReady: typeof verifyDevice === 'function', store,
    async authenticate(request) {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || header.length > 16_384 || !/^Bearer [A-Za-z0-9._~-]+$/u.test(header)) {
        throw new PublicApiError(401, 'AUTHENTICATION_REQUIRED', '家電AIの利用者認証を確認できませんでした。もう一度お試しください。');
      }
      let decoded;
      try { decoded = await verifyIdToken(header.slice(7), true); }
      catch { throw new PublicApiError(401, 'AUTHENTICATION_REQUIRED', '認証の有効期限を確認できませんでした。もう一度お試しください。'); }
      const provider = decoded?.firebase?.sign_in_provider;
      if (typeof decoded?.uid !== 'string' || !decoded.uid.length || decoded.uid.length > 128
        || !['google.com', 'apple.com'].includes(provider)) {
        throw new PublicApiError(403, 'ACCESS_DENIED', '家電AIにはGoogleまたはAppleのログインが必要です。匿名認証では利用できません。');
      }
      if (typeof verifyDevice !== 'function') throw new PublicApiError(503, 'DEVICE_VERIFICATION_UNAVAILABLE', '安全な端末確認が準備できていないため、家電AIは停止しています。');
      const proof = await verifyDevice(request, Object.freeze({ uid: decoded.uid }));
      // These identifiers must come from a verified platform provider, never from body fields or raw device headers.
      if (!proof || !/^[a-f0-9]{64}$/u.test(proof.deviceId) || typeof proof.installationId !== 'string'
        || !/^[A-Za-z0-9_.:-]{16,200}$/u.test(proof.installationId) || proof.reinstallProtection !== 'verified') {
        throw new PublicApiError(403, 'DEVICE_VERIFICATION_REQUIRED', '正規アプリと端末の継続性を確認できないため解析できません。');
      }
      return Object.freeze({ uid: decoded.uid, anonymous: false, deviceId: proof.deviceId, installationId: proof.installationId });
    },
  });
}
