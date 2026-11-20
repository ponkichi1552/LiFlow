import { createHash, randomUUID, sign, createPrivateKey, createPublicKey } from 'node:crypto';

const WINDOW_MS = 24 * 60 * 60_000;
const statusOrder = ['active', 'grace', 'pending', 'onHold', 'revoked', 'expired', 'none'];
export class SubscriptionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const subscriptionHash = value => createHash('sha256').update(value).digest('hex');
export function subscriptionUserId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/u.test(value)) throw new SubscriptionError(403, 'SUBSCRIPTION_ACCOUNT_INVALID', '契約するアカウントを確認してください。');
  return value;
}
export function assertSubscriptionEntitlement(saved, userId, at) {
  if (saved?.schemaVersion !== 1 || saved.userId !== userId || !['active', 'grace'].includes(saved.status)
    || !Number.isSafeInteger(saved.expiresAt) || !Number.isSafeInteger(saved.validUntil)
    || saved.expiresAt <= at || saved.validUntil <= at) {
    throw new SubscriptionError(402, 'SUBSCRIPTION_REQUIRED', '有効なLiFlowの契約が必要です。');
  }
}
export function subscriptionSigningText(body) {
  return JSON.stringify(['liflow.subscription.v1', body.schemaVersion, body.userId, body.revision, body.status,
    body.store, body.productId, body.autoRenew, body.checkedAt, body.expiresAt, body.validUntil]);
}
export function createSubscriptionSigner(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Subscription signing requires an Ed25519 private key');
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  return { publicKey: Buffer.from(publicKey.x, 'base64url').toString('hex'),
    sign: body => ({ body, signature: sign(null, Buffer.from(subscriptionSigningText(body)), key).toString('hex') }) };
}
function chosenEntitlement(userId, records, revision, now) {
  const normalized = records.map(record => ({ ...record,
    status: ['active', 'grace'].includes(record.status) && (record.expiresAt <= now || record.verifiedAt + WINDOW_MS <= now) ? 'expired' : record.status }));
  const priority = status => ['active', 'grace'].includes(status) ? 0 : statusOrder.indexOf(status);
  normalized.sort((a, b) => priority(a.status) - priority(b.status) || b.expiresAt - a.expiresAt || a.key.localeCompare(b.key));
  const best = normalized[0]; const active = best && ['active', 'grace'].includes(best.status);
  return { schemaVersion: 1, userId, revision, status: best?.status ?? 'none', store: best?.store ?? null,
    productId: best?.productId ?? null, autoRenew: Boolean(best?.autoRenew), checkedAt: now,
    expiresAt: best?.expiresAt ?? 0, validUntil: active ? Math.min(best.expiresAt, (best.verifiedAt ?? now) + WINDOW_MS) : 0 };
}
export const displacesPreviousPurchase = (record, at) => record.linkedPurchaseId
  && ['active', 'grace'].includes(record.status) && record.expiresAt > at;

/** Store verification precedes any grant. The durable store owns identity binding and concurrent commits. */
export function createSubscriptionService({ store, providers, signer, now = Date.now }) {
  if (!store || !signer || !providers) throw new Error('Subscription verification is not configured');
  const pendingNotices = new Map();
  const check = record => {
    if (!record || !['apple', 'google'].includes(record.store) || typeof record.purchaseId !== 'string'
      || !record.purchaseId.length || record.purchaseId.length > 4096 || !statusOrder.includes(record.status)
      || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0
      || typeof record.productId !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/u.test(record.productId)
      || typeof record.autoRenew !== 'boolean' || record.retired === true && !['expired', 'revoked'].includes(record.status)) throw new SubscriptionError(502, 'STORE_RESPONSE_INVALID', 'ストアの契約状態を確認できませんでした。');
    return { ...record, key: `${record.store}-${subscriptionHash(record.purchaseId)}` };
  };
  async function refresh(userId, evidence, verifying = false, claimedAcknowledgement, onlyKey) {
    subscriptionUserId(userId);
    if (verifying && (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || !['apple', 'google'].includes(evidence.store) || typeof evidence.proof !== 'string'
      || evidence.proof.length < 8 || evidence.proof.length > 32_768 || Object.keys(evidence).sort().join() !== 'proof,store')) {
      throw new SubscriptionError(400, 'INVALID_PURCHASE', '購入情報を確認してください。');
    }
    if (verifying && !providers[evidence.store]) throw new SubscriptionError(503, 'STORE_NOT_CONFIGURED', 'このストアでの購入はまだ準備中です。');
    const attempt = await store.begin(userId);
    const existing = await store.purchases(userId);
    if (existing.length > 8) throw new SubscriptionError(409, 'SUBSCRIPTION_REVIEW_REQUIRED', '契約の確認が必要です。');
    const verified = [];
    const checkedKeys = new Set();
    let failure;
    let submittedKey;
    const writeVerified = record => {
      const saved = { ...check(record), verifiedAt: now() };
      verified.push(saved); checkedKeys.add(saved.key);
      return saved.key;
    };
    if (evidence) {
      submittedKey = writeVerified(await providers[evidence.store].verify(evidence.proof, attempt.account));
    }
    for (const current of existing) {
      if (verified.some(record => record.key === current.key)) continue;
      // A previously authoritative terminal Google purchase is not queryable
      // after 60 days. Retire its refresh pointer, never its ownership binding.
      if (current.store === 'google' && ['expired', 'revoked'].includes(current.status)
        && current.expiresAt < now() - 60 * 86400_000) {
        writeVerified({ ...current, retired: true, autoRenew: false }); continue;
      }
      if (!onlyKey || onlyKey === current.key) {
        try {
          if (!providers[current.store]) throw new SubscriptionError(503, 'STORE_NOT_CONFIGURED', '契約の確認先が設定されていません。');
          writeVerified(await providers[current.store].refresh(current, attempt.account)); continue;
        } catch (error) { failure ??= error; }
      }
      if (current.verifiedAt !== undefined) verified.push(current);
      else {
        // Legacy records have authority only for the time window already issued to this account.
        const cached = await store.entitlement(userId);
        verified.push({ ...current, verifiedAt: cached?.store === current.store && Number.isSafeInteger(cached.validUntil)
          ? Math.min(cached.validUntil - WINDOW_MS, now()) : now() - WINDOW_MS });
      }
    }
    if (failure && !checkedKeys.size) throw failure;
    const committed = await store.commit(userId, attempt.generation, verified, (at, current = verified) =>
      chosenEntitlement(userId, current, attempt.account.revision + 1, at), now());
    // Do not finish an unverified/pending purchase. A failed acknowledgement is retried from the saved purchase.
    const replaced = new Set(verified.filter(record => displacesPreviousPurchase(record, now())).map(record => `${record.store}-${subscriptionHash(record.linkedPurchaseId)}`));
    for (const record of verified) if (checkedKeys.has(record.key) && ['active', 'grace'].includes(record.status) && record.expiresAt > now() && !replaced.has(record.key)) {
      if (record.store === 'google' && record.acknowledgementPending === true) {
        const claim = claimedAcknowledgement?.key === record.key ? claimedAcknowledgement : await store.claimAcknowledgement(record.key, now());
        if (!claim || !await store.ownsAcknowledgement(claim)) continue;
        try {
          await providers.google.acknowledge(record);
          await store.finishAcknowledgement(claim, true, now());
        } catch (error) {
          await store.finishAcknowledgement(claim, false, now());
          throw error;
        }
      } else if (record.store !== 'google' || record.acknowledgementPending !== false) await providers[record.store].acknowledge?.(record);
    }
    if (submittedKey) {
      const pending = await store.pendingNotification?.(submittedKey, now());
      if (pending) {
        const result = await refresh(userId, undefined, false, undefined, submittedKey);
        await store.settleNotification(submittedKey, pending, now()); return result;
      }
    }
    return { entitlement: signer.sign(committed), account: {
      appAccountToken: attempt.account.appAccountToken, obfuscatedAccountId: attempt.account.obfuscatedAccountId,
    } };
  }
  return {
    ready: () => store.ready?.(),
    async status(userId, force = false) {
      subscriptionUserId(userId);
      const cached = await store.entitlement(userId); const account = cached ? await store.account(userId) : null;
      // Reading a recent authoritative record never extends its offline deadline or hides a newer stored revocation.
      if (!force && cached && account && cached.userId === userId && cached.checkedAt <= now()
        && now() - cached.checkedAt < 5 * 60_000 && (!['active', 'grace'].includes(cached.status) || cached.validUntil > now())) {
        return { entitlement: signer.sign(cached), account: { appAccountToken: account.appAccountToken, obfuscatedAccountId: account.obfuscatedAccountId } };
      }
      return refresh(userId);
    },
    refresh: userId => refresh(userId), verify: (userId, evidence) => refresh(userId, evidence, true),
    /** Bounded, restartable server job. No client reconnect or in-process timer is required. */
    async retryAcknowledgements({ limit = 10, budgetMs = 90_000 } = {}) {
      if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 120_000) throw new Error('Invalid acknowledgement budget');
      const started = now(); const result = { completed: 0, deferred: 0, failed: 0, overdue: 0 };
      for (const key of await store.dueAcknowledgements(started, limit)) {
        if (now() - started >= budgetMs) break;
        const claim = await store.claimAcknowledgement(key, now());
        if (!claim) { result.deferred++; continue; }
        // This is an observation deadline, not evidence of a purchase time or permission to grant access.
        if (now() - claim.firstQueuedAt >= 48 * 60 * 60_000) result.overdue++;
        try {
          await refresh(claim.userId, undefined, false, claim, claim.key);
          result.completed++;
        } catch {
          await store.finishAcknowledgement(claim, false, now());
          result.failed++;
        }
      }
      if (now() - started < budgetMs) await store.pruneNotifications?.(now());
      return result;
    },
    async assertActive(userId) {
      const saved = await store.entitlement(subscriptionUserId(userId));
      assertSubscriptionEntitlement(saved, userId, now());
    },
    async reconcile(storeName, purchaseId, event) {
      const key = `${storeName}-${subscriptionHash(purchaseId)}`;
      const id = event ? `${key}:${event}` : key;
      const existing = pendingNotices.get(id); if (existing) return existing;
      const work = (async () => {
        const notice = event && store.recordNotification ? await store.recordNotification(key, event, now()) : null;
        if (event && store.recordNotification && !notice) return;
        const owner = await store.owner(key);
        if (owner) {
          await refresh(owner, undefined, false, undefined, key);
          if (notice) await store.settleNotification(key, notice, now());
        }
      })();
      pendingNotices.set(id, work);
      try { return await work; }
      finally { pendingNotices.delete(id); }
    },
  };
}

export function newSubscriptionAccount(userId, revision = 0) {
  return { userId, revision, generation: 0, appAccountToken: randomUUID(),
    obfuscatedAccountId: subscriptionHash(`liflow.subscription.account.v1:${userId}`), purchaseKeys: [] };
}
