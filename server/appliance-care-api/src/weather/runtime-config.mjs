import { identifyingMetUserAgent } from './met-service.mjs';

/** The public forecast runtime must not accidentally inherit the private DB. */
export function weatherRuntimeConfig(env = process.env) {
  const projectId = env.APPLIANCE_CARE_FIREBASE_PROJECT_ID;
  const databaseId = env.LIFLOW_WEATHER_FIRESTORE_DATABASE_ID;
  const port = Number(env.PORT ?? 8080);
  if (!/^[a-z][a-z0-9-]{4,62}$/u.test(projectId ?? '') || env.FIRESTORE_EMULATOR_HOST
    || !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/u.test(databaseId ?? '')
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !identifyingMetUserAgent(env.MET_WEATHER_USER_AGENT)) throw new Error('Weather runtime configuration is invalid');
  return Object.freeze({ projectId, databaseId, port });
}
