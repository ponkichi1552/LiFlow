import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { newSubscriptionAccount, SubscriptionError, subscriptionUserId, subscriptionHash } from './subscription-service.mjs';

/** Admin SDK only. Neither clients nor shared-group members can write these collections. */
export function createFirestoreSubscriptionStore({ firestore, tokenKey }) {
  if (!Buffer.isBuffer(tokenKey) || tokenKey.length !== 32) throw new Error('A separate 32-byte billing token-encryption key is required');
  const accounts = firestore.collection('billingAccounts'); const purchases = firestore.collection('billingPurchases');
  const entitlements = firestore.collection('billingEntitlements');
  function encrypt(key, value) {
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', tokenKey, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(key)); const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { nonce: nonce.toString('base64'), bytes: bytes.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  function decrypt(key, value) {
    if (!value || typeof value.nonce !== 'string' || typeof value.tag !== 'string' || typeof value.bytes !== 'string') throw new Error('Invalid encrypted purchase proof');
    const nonce = Buffer.from(value.nonce, 'base64'); const tag = Buffer.from(value.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted purchase proof');
    const cipher = createDecipheriv('aes-256-gcm', tokenKey, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(key)); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.bytes, 'base64')), cipher.final()]).toString());
  }
  return {
    async ready() {
      const config = (await firestore.collection('serviceConfiguration').doc('billing').get()).data();
      if (config?.enforced !== true) throw new Error('Paid Firestore access must be enabled before public startup');
    },
    async begin(userId) {
      const ref = accounts.doc(subscriptionUserId(userId));
      return firestore.runTransaction(async tx => {
        const saved = (await tx.get(ref)).data(); const account = saved ?? newSubscriptionAccount(userId);
        if (account.userId !== userId || !Number.isSafeInteger(account.generation) || !Number.isSafeInteger(account.revision)) throw new Error('Invalid subscription account');
        const generation = account.generation + 1;
        tx.set(ref, { ...account, generation }); return { account, generation };
      });
    },
    async purchases(userId) {
      const account = (await accounts.doc(subscriptionUserId(userId)).get()).data();
      if (!account) return [];
      if (!Array.isArray(account.purchaseKeys) || account.purchaseKeys.length > 8) throw new Error('Invalid purchase index');
      const snapshots = account.purchaseKeys.length ? await firestore.getAll(...account.purchaseKeys.map(key => purchases.doc(key))) : [];
      return snapshots.map(snapshot => {
        const record = snapshot.data(); if (!record || record.userId !== userId) throw new Error('Invalid purchase owner');
        return { ...decrypt(snapshot.id, record.encryptedProof), key: snapshot.id };
      });
    },
    async commit(userId, generation, records, entitlement, at) {
      const accountRef = accounts.doc(subscriptionUserId(userId));
      return firestore.runTransaction(async tx => {
        const account = (await tx.get(accountRef)).data();
        if (!account || account.generation !== generation) throw new SubscriptionError(409, 'SUBSCRIPTION_RETRY_REQUIRED', '契約の確認が更新されました。もう一度確認してください。');
        const keys = new Set(records.flatMap(record => [record.key, ...(record.linkedPurchaseId ? [`${record.store}-${subscriptionHash(record.linkedPurchaseId)}`] : [])]));
        const old = keys.size ? await tx.getAll(...[...keys].map(key => purchases.doc(key))) : [];
        if (old.some(snapshot => snapshot.exists && snapshot.data().userId !== userId)) {
          throw new SubscriptionError(409, 'PURCHASE_ALREADY_BOUND', 'この購入は別のLiFlowアカウントに紐づいています。購入時のアカウントでログインしてください。');
        }
        const linked = new Set(records.filter(record => record.linkedPurchaseId).map(record => `${record.store}-${subscriptionHash(record.linkedPurchaseId)}`));
        const current = records.filter(record => !linked.has(record.key));
        // Remove only old pointers. Permanent purchase ownership records still prevent token reuse by another UID.
        const nextKeys = current.filter(record => !['expired', 'revoked'].includes(record.status) || record.expiresAt > at - 60 * 24 * 60 * 60_000).map(record => record.key);
        if (nextKeys.length > 8) throw new SubscriptionError(409, 'SUBSCRIPTION_REVIEW_REQUIRED', '契約の確認が必要です。');
        const body = entitlement(at, current);
        if (body.revision !== account.revision + 1) throw new Error('Invalid subscription revision');
        for (const record of records) tx.set(purchases.doc(record.key), { userId, store: record.store,
          encryptedProof: encrypt(record.key, record), updatedAt: at });
        tx.set(accountRef, { ...account, revision: body.revision, purchaseKeys: nextKeys });
        tx.set(entitlements.doc(userId), body);
        return body;
      });
    },
    async entitlement(userId) { return (await entitlements.doc(subscriptionUserId(userId)).get()).data() ?? null; },
    async account(userId) { return (await accounts.doc(subscriptionUserId(userId)).get()).data() ?? null; },
    async owner(key) { return (await purchases.doc(key).get()).data()?.userId ?? null; },
  };
}
