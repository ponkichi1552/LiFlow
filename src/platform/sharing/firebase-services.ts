import { getApps, initializeApp } from 'firebase/app';
import { getAuth, initializeAuth } from 'firebase/auth';
import type { Persistence } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import { sharingSecureVault } from './secure-store.ts';

const APPLICATION_NAME = 'liflow-sharing';
let services: ReturnType<typeof createServices> | undefined;

export function isSharingConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_FIREBASE_API_KEY && process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID
    && process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN && process.env.EXPO_PUBLIC_FIREBASE_APP_ID);
}

function createServices() {
  if (!isSharingConfigured()) throw new Error('共有グループの接続先が設定されていません。');
  const config = {
    apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
    messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  };
  const existing = getApps().find((app) => app.name === APPLICATION_NAME);
  const app = existing ?? initializeApp(config, APPLICATION_NAME);
  // A separate Firebase app never falls back to an unprotected default Auth instance.
  // Firebase's public RN entry exports this API, but its generic TypeScript entry
  // omits it. Keep the native-only boundary here rather than using private SDK paths.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nativeAuth = require('firebase/auth') as { getReactNativePersistence?: (storage: typeof sharingSecureVault) => Persistence };
  if (!nativeAuth.getReactNativePersistence) throw new Error('共有ログインにはモバイル用のFirebaseビルドが必要です。');
  let auth;
  try { auth = initializeAuth(app, { persistence: nativeAuth.getReactNativePersistence(sharingSecureVault) }); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'auth/already-initialized')) throw error;
    auth = getAuth(app);
  }
  let firestore: ReturnType<typeof initializeFirestore> | undefined;
  return { app, auth, get firestore() {
    return firestore ??= initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  } };
}

/** Personal mode does not initialize Firebase or require any account. */
export function getSharingServices() { services ??= createServices(); return services; }
