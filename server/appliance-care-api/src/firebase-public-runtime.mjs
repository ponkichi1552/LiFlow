import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createPublicApiAccess, PUBLIC_API_POLICY } from './public-access.mjs';
import { createFirestoreUsageStore } from './firestore-usage-store.mjs';
import { createFirebaseSubscriptionRuntime } from './firebase-subscription-runtime.mjs';

export function createFirebasePublicRuntime(env = process.env) {
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
  const subscriptions = env.LIFLOW_SUBSCRIPTIONS_ENABLED === 'true'
    ? createFirebaseSubscriptionRuntime({ firestore: getFirestore(app), auth: getAuth(app), env }) : undefined;
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
  return createPublicApiAccess({ verifyIdToken: (token, checkRevoked) => getAuth(app).verifyIdToken(token, checkRevoked),
    store: createFirestoreUsageStore({ firestore: getFirestore(app), policy }), subscriptions });
}
