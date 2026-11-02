import { readFileSync } from 'node:fs';
import { AppStoreServerAPIClient, SignedDataVerifier, Environment } from '@apple/app-store-server-library';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { createAppleSubscriptionProvider, createGoogleSubscriptionProvider } from './subscription-providers.mjs';
import { createFirestoreSubscriptionStore } from './firestore-subscription-store.mjs';
import { createSubscriptionService, createSubscriptionSigner } from './subscription-service.mjs';
import { createSubscriptionHttp } from './subscription-http.mjs';

export function createFirebaseSubscriptionRuntime({ firestore, auth, env = process.env }) {
  const required = name => { const value = env[name]?.trim(); if (!value) throw new Error(`Subscription configuration is required: ${name}`); return value; };
  const bundleId = 'jp.jphacks.tkb2633';
  const signer = createSubscriptionSigner(readFileSync(required('LIFLOW_SUBSCRIPTION_SIGNING_KEY_FILE')));
  const tokenKey = readFileSync(required('LIFLOW_BILLING_TOKEN_KEY_FILE'));
  const store = createFirestoreSubscriptionStore({ firestore, tokenKey });
  const providers = {};
  const appleProduct = env.LIFLOW_APPLE_SUBSCRIPTION_PRODUCT_ID?.trim();
  if (appleProduct) {
    const environment = required('LIFLOW_APPLE_STORE_ENVIRONMENT');
    if (![Environment.PRODUCTION, Environment.SANDBOX].includes(environment)) throw new Error('Invalid Apple subscription environment');
    const appleId = environment === Environment.PRODUCTION ? Number(required('LIFLOW_APPLE_APPLICATION_ID')) : undefined;
    if (appleId !== undefined && (!Number.isSafeInteger(appleId) || appleId <= 0)) throw new Error('Invalid Apple application ID');
    const roots = required('LIFLOW_APPLE_ROOT_CERTIFICATE_FILES').split(',').map(path => readFileSync(path.trim()));
    const verifier = new SignedDataVerifier(roots, true, environment, bundleId, appleId);
    const client = new AppStoreServerAPIClient(readFileSync(required('LIFLOW_APPLE_IAP_KEY_FILE'), 'utf8'),
      required('LIFLOW_APPLE_IAP_KEY_ID'), required('LIFLOW_APPLE_IAP_ISSUER_ID'), bundleId, environment);
    providers.apple = createAppleSubscriptionProvider({ client, verifier, bundleId, productId: appleProduct, environment });
  }
  const googleProduct = env.LIFLOW_GOOGLE_SUBSCRIPTION_PRODUCT_ID?.trim();
  if (googleProduct) {
    const google = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    const audience = required('LIFLOW_GOOGLE_PUBSUB_AUDIENCE'); const email = required('LIFLOW_GOOGLE_PUBSUB_SERVICE_ACCOUNT');
    const oidc = new OAuth2Client();
    providers.google = createGoogleSubscriptionProvider({ request: async options => (await google.getClient()).request(options), packageName: bundleId, productId: googleProduct,
      basePlanId: required('LIFLOW_GOOGLE_SUBSCRIPTION_BASE_PLAN_ID'), allowTestPurchases: env.LIFLOW_GOOGLE_ALLOW_TEST_PURCHASES === 'true',
      async verifyPushIdentity(header) {
        if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9._-]{1,16384}$/u.test(header)) throw new Error('Invalid store notification identity');
        const payload = (await oidc.verifyIdToken({ idToken: header.slice(7), audience })).getPayload();
        if (payload?.email !== email || payload.email_verified !== true) throw new Error('Invalid store notification identity');
      } });
  }
  if (!providers.apple && !providers.google) throw new Error('At least one real subscription verifier is required');
  const service = createSubscriptionService({ store, providers, signer });
  return createSubscriptionHttp({ service, providers, verifyIdToken: (token, revoked) => auth.verifyIdToken(token, revoked) });
}
