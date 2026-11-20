import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createPublicApiAccess, PUBLIC_API_POLICY } from './public-access.mjs';
import { createFirestoreUsageStore } from './firestore-usage-store.mjs';
import { createFirebaseSubscriptionRuntime } from './firebase-subscription-runtime.mjs';
import { createFirestoreEntitlementReader } from './firestore-subscription-store.mjs';
import { readAnalysisQueueKeys } from './analysis-queue-input.mjs';
import { readManualUploadKeyIds, readManualUploadPrivateKeys } from './manual-upload-server.mjs';

export function createFirebasePublicRuntime(env = process.env, { worker = false } = {}) {
  const projectId = env.APPLIANCE_CARE_FIREBASE_PROJECT_ID;
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/u.test(projectId)) throw new Error('Public API Firebase project is required');
  if (env.NODE_ENV?.trim().toLowerCase() === 'production' && (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error('Production authentication cannot use an emulator');
  }
  const name = 'liflow-appliance-api';
  const app = getApps().find(value => value.name === name) ?? initializeApp({ projectId, credential: applicationDefault() }, name);
  if (app.options.projectId !== projectId) throw new Error('Public API Firebase project changed during execution');
  if (env.NODE_ENV?.trim().toLowerCase() === 'production' && env.LIFLOW_SUBSCRIPTIONS_ENABLED !== 'true') {
    throw new Error('Verified subscriptions are required for the public service');
  }
  const firestore = getFirestore(app); const auth = getAuth(app);
  const policy = { ...PUBLIC_API_POLICY };
  for (const [setting, key, maximum] of [
    ['APPLIANCE_CARE_MONTHLY_LIMIT', 'monthlyLimit', 100], ['APPLIANCE_CARE_GLOBAL_DAILY_LIMIT', 'dailyGlobalLimit', 1000],
    ['APPLIANCE_CARE_MAX_CONCURRENT', 'maxConcurrent', 10],
  ]) {
    if (env[setting] === undefined) continue;
    const value = Number(env[setting]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid public API limit: ' + setting);
    policy[key] = value;
  }
  const uploadKeyIds = worker ? [] : readManualUploadKeyIds(env);
  const analysisQueueKeys = worker ? readAnalysisQueueKeys(env) : undefined;
  const manualUploadPrivateKeys = worker ? readManualUploadPrivateKeys(env) : undefined;
  const analysisQueueReady = worker ? Boolean(analysisQueueKeys || manualUploadPrivateKeys?.size) : uploadKeyIds.length > 0;
  const store = createFirestoreUsageStore({ firestore, policy, analysisQueueKeys, manualUploadPrivateKeys });
  const billingEnabled = env.LIFLOW_SUBSCRIPTIONS_ENABLED === 'true';
  if (worker) {
    const entitlements = billingEnabled ? createFirestoreEntitlementReader({ firestore }) : null;
    return Object.freeze({ store, analysisQueueReady, entitlements, async authorizeQueuedAnalysis(uid, admittedAt) {
      const user = await auth.getUser(uid);
      if (user.disabled || !Number.isSafeInteger(admittedAt)
        || Date.parse(user.tokensValidAfterTime ?? '') > admittedAt || !entitlements) throw new Error('Queued analysis authorization expired');
      await entitlements.assertActive(uid);
    } });
  }
  const subscriptions = billingEnabled ? createFirebaseSubscriptionRuntime({ firestore, auth, env }) : undefined;
  const access = createPublicApiAccess({ verifyIdToken: (token, checkRevoked) => auth.verifyIdToken(token, checkRevoked), store, subscriptions });
  return Object.freeze({ ...access, uploadKeyIds, analysisQueueReady });
}
