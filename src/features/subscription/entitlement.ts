import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export type SubscriptionStore = 'apple' | 'google';
export type SubscriptionStatus = 'active' | 'grace' | 'expired' | 'revoked' | 'onHold' | 'pending' | 'none';
export interface SubscriptionEntitlement {
  schemaVersion: 1; userId: string; revision: number; status: SubscriptionStatus;
  store: SubscriptionStore | null; productId: string | null; autoRenew: boolean;
  checkedAt: number; expiresAt: number; validUntil: number;
}
export interface SignedSubscriptionEntitlement { body: SubscriptionEntitlement; signature: string }
export const MAX_OFFLINE_ENTITLEMENT_MS = 24 * 60 * 60_000;
const statuses: readonly SubscriptionStatus[] = ['active', 'grace', 'expired', 'revoked', 'onHold', 'pending', 'none'];

/** A fixed, versioned wire encoding; Ed25519 itself is provided by the existing audited library. */
export function entitlementSigningText(body: SubscriptionEntitlement): string {
  return JSON.stringify(['liflow.subscription.v1', body.schemaVersion, body.userId, body.revision, body.status,
    body.store, body.productId, body.autoRenew, body.checkedAt, body.expiresAt, body.validUntil]);
}

export function verifySubscriptionEntitlement(input: unknown, options: {
  publicKey: string; userId: string; now: number; lastRevision?: number; lastCheckedAt?: number;
}): SignedSubscriptionEntitlement {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('契約情報を確認できません。');
  const signed = input as SignedSubscriptionEntitlement; const body = signed.body;
  if (!body || Object.keys(signed).sort().join() !== 'body,signature'
    || Object.keys(body).sort().join() !== 'autoRenew,checkedAt,expiresAt,productId,revision,schemaVersion,status,store,userId,validUntil'
    || body.schemaVersion !== 1 || body.userId !== options.userId || !/^[A-Za-z0-9_.:@-]{1,128}$/u.test(body.userId)
    || !Number.isSafeInteger(body.revision) || body.revision < (options.lastRevision ?? 0)
    || !statuses.includes(body.status) || ![null, 'apple', 'google'].includes(body.store)
    || !(body.productId === null || typeof body.productId === 'string' && /^[A-Za-z0-9_.-]{1,200}$/u.test(body.productId))
    || typeof body.autoRenew !== 'boolean' || ![body.checkedAt, body.expiresAt, body.validUntil, options.now].every(value => Number.isSafeInteger(value) && value >= 0)
    || body.checkedAt < (options.lastCheckedAt ?? 0) || body.checkedAt > options.now + 60_000
    || body.validUntil > body.checkedAt + MAX_OFFLINE_ENTITLEMENT_MS || body.validUntil > body.expiresAt
    || (['active', 'grace'].includes(body.status) && (!body.store || !body.productId || body.expiresAt <= body.checkedAt))
    || !/^[a-f0-9]{64}$/u.test(options.publicKey) || !/^[a-f0-9]{128}$/u.test(signed.signature)
    || !ed25519.verify(hexToBytes(signed.signature), new TextEncoder().encode(entitlementSigningText(body)), hexToBytes(options.publicKey))) {
    throw new Error('契約情報の署名・利用者・有効期限が一致しません。');
  }
  return { body: { ...body }, signature: bytesToHex(hexToBytes(signed.signature)) };
}

export function hasSubscriptionAccess(body: SubscriptionEntitlement | null, now: number): boolean {
  return Boolean(body && ['active', 'grace'].includes(body.status) && now >= body.checkedAt - 60_000
    && now < body.validUntil && now < body.expiresAt);
}
