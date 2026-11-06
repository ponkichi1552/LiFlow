import { SubscriptionError } from './subscription-service.mjs';

function invalid() { return new SubscriptionError(403, 'PURCHASE_NOT_OWNED', '購入元・商品・購入したアカウントを確認できません。'); }
function milliseconds(value) { const at = typeof value === 'number' ? value : Date.parse(value); if (!Number.isSafeInteger(at) || at < 0) throw invalid(); return at; }
function id(value) { if (typeof value !== 'string' || !/^[0-9]{1,100}$/u.test(value)) throw invalid(); return value; }

/** Uses Apple's official SignedDataVerifier and Server API client. No unverified JWS decoding grants access. */
export function createAppleSubscriptionProvider({ client, verifier, bundleId, productId, environment }) {
  function match(transaction, account) {
    if (transaction.bundleId !== bundleId || transaction.productId !== productId || transaction.environment !== environment
      || transaction.type !== 'Auto-Renewable Subscription' || transaction.inAppOwnershipType !== 'PURCHASED'
      || transaction.appAccountToken?.toLowerCase() !== account.appAccountToken.toLowerCase()) throw invalid();
  }
  async function latest(originalId, account) {
    const response = await client.getAllSubscriptionStatuses(id(originalId));
    if (response.bundleId !== bundleId || response.environment !== environment) throw invalid();
    const candidates = [];
    for (const group of response.data ?? []) for (const entry of group.lastTransactions ?? []) {
      if (entry.originalTransactionId !== originalId) continue;
      const transaction = await verifier.verifyAndDecodeTransaction(entry.signedTransactionInfo);
      match(transaction, account);
      if (id(transaction.originalTransactionId) !== originalId) throw invalid();
      const renewal = entry.signedRenewalInfo ? await verifier.verifyAndDecodeRenewalInfo(entry.signedRenewalInfo) : null;
      if (renewal && (renewal.originalTransactionId !== originalId || renewal.productId !== productId || renewal.environment !== environment)) throw invalid();
      let status = ({ 1: 'active', 2: 'expired', 3: 'onHold', 4: 'grace', 5: 'revoked' })[entry.status];
      if (!status) throw invalid();
      if (transaction.revocationDate !== undefined) status = 'revoked';
      const expiresAt = milliseconds(status === 'grace' ? renewal?.gracePeriodExpiresDate : transaction.expiresDate);
      candidates.push({ store: 'apple', purchaseId: originalId, proof: originalId, productId, status, expiresAt,
        autoRenew: renewal?.autoRenewStatus === 1, signedAt: milliseconds(transaction.signedDate) });
    }
    candidates.sort((a, b) => b.signedAt - a.signedAt);
    if (!candidates[0]) throw invalid();
    return candidates[0];
  }
  return {
    async verify(proof, account) {
      const original = await verifier.verifyAndDecodeTransaction(proof); match(original, account);
      return latest(id(original.originalTransactionId), account);
    },
    refresh: (record, account) => latest(record.purchaseId, account),
    async notification(body) {
      if (!body || Object.keys(body).join() !== 'signedPayload' || typeof body.signedPayload !== 'string' || body.signedPayload.length > 100_000) throw invalid();
      const event = await verifier.verifyAndDecodeNotification(body.signedPayload);
      if (event.data?.bundleId !== bundleId || event.data?.environment !== environment) throw invalid();
      if (event.notificationType === 'TEST') return null;
      if (!event.data?.signedTransactionInfo) throw invalid();
      const transaction = await verifier.verifyAndDecodeTransaction(event.data.signedTransactionInfo);
      if (transaction.bundleId !== bundleId || transaction.productId !== productId || transaction.environment !== environment) throw invalid();
      return id(transaction.originalTransactionId);
    },
  };
}

/** Only Google's subscriptionsv2.get response is authoritative; the mobile expiry/purchase-state is never trusted. */
export function createGoogleSubscriptionProvider({ request, packageName, productId, basePlanId, allowTestPurchases = false, verifyPushIdentity }) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  // Purchase tokens are opaque. Encode their path component; do not restrict legitimate base64 punctuation.
  function token(value) { if (typeof value !== 'string' || !/^[\x21-\x7e]{8,4096}$/u.test(value)) throw invalid(); return value; }
  async function latest(proof, account) {
    token(proof);
    const { data } = await request({ url: `${base}/purchases/subscriptionsv2/tokens/${encodeURIComponent(proof)}`, method: 'GET', timeout: 10_000 });
    if (data.testPurchase && !allowTestPurchases) throw invalid();
    if (data.externalAccountIdentifiers?.obfuscatedExternalAccountId !== account.obfuscatedAccountId) throw invalid();
    const lineItems = data.lineItems?.filter(line => line.productId === productId);
    if (lineItems?.length !== 1 || data.lineItems.length !== 1) throw invalid();
    const line = lineItems[0];
    if (!basePlanId || line.offerDetails?.basePlanId !== basePlanId) throw invalid();
    const status = ({ SUBSCRIPTION_STATE_ACTIVE: 'active', SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace',
      SUBSCRIPTION_STATE_ON_HOLD: 'onHold', SUBSCRIPTION_STATE_PAUSED: 'onHold', SUBSCRIPTION_STATE_PENDING: 'pending',
      SUBSCRIPTION_STATE_EXPIRED: 'expired', SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
      SUBSCRIPTION_STATE_CANCELED: 'active' })[data.subscriptionState];
    if (!status) throw invalid();
    if (['active', 'grace'].includes(status) && !['ACKNOWLEDGEMENT_STATE_PENDING', 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'].includes(data.acknowledgementState)) throw invalid();
    const expiresAt = line.expiryTime ? milliseconds(line.expiryTime)
      : status === 'pending' || data.subscriptionState === 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED' ? 0 : milliseconds(line.expiryTime);
    return { store: 'google', purchaseId: proof, proof, productId, status, expiresAt,
      autoRenew: line.autoRenewingPlan?.autoRenewEnabled === true,
      acknowledgementPending: data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
      ...(data.linkedPurchaseToken ? { linkedPurchaseId: token(data.linkedPurchaseToken) } : {}) };
  }
  return {
    verify: latest,
    async refresh(record, account) {
      try { return await latest(record.proof, account); }
      catch (error) {
        const reasons = error?.response?.data?.error?.errors;
        if (error?.response?.status !== 410 || !Array.isArray(reasons) || !reasons.length
          || !reasons.every(value => ['subscriptionNoLongerAvailable', 'purchaseTokenNoLongerValid'].includes(value?.reason))) throw error;
        // Only a stored, already-bound purchase can be retired. This response
        // never verifies a new token, and transient failures never remove one.
        return { ...record, status: 'expired', autoRenew: false, acknowledgementPending: false, retired: true };
      }
    },
    async acknowledge(record) {
      if (!record.acknowledgementPending) return;
      await request({ url: `${base}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token(record.proof))}:acknowledge`,
        method: 'POST', data: {}, timeout: 10_000 });
    },
    async notification(body, headers) {
      if (!verifyPushIdentity) throw new SubscriptionError(503, 'PUSH_NOT_CONFIGURED', '通知の認証が設定されていません。');
      await verifyPushIdentity(headers.authorization);
      if (typeof body?.message?.data !== 'string' || body.message.data.length > 20_000) throw invalid();
      let data; try { data = JSON.parse(Buffer.from(body.message.data, 'base64').toString()); } catch { throw invalid(); }
      if (data.packageName !== packageName) throw invalid();
      if (data.testNotification) return null;
      return token(data.subscriptionNotification?.purchaseToken);
    },
  };
}
