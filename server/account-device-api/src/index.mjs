import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createAccountDeviceService } from './service.mjs';
import { createAccountDeviceHttpServer } from './http.mjs';

try {
  const projectId = process.env.LIFLOW_FIREBASE_PROJECT_ID, port = Number(process.env.PORT ?? '8080');
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/u.test(projectId) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid runtime configuration');
  const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST, firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  const emulatorAllowed = process.env.NODE_ENV !== 'production' && projectId.startsWith('demo-')
    && [authEmulator, firestoreEmulator].every(value => /^127\.0\.0\.1:\d+$/u.test(value ?? ''));
  if (Boolean(authEmulator || firestoreEmulator) !== emulatorAllowed || projectId.startsWith('demo-') && !emulatorAllowed
    || [process.env.GCLOUD_PROJECT, process.env.GOOGLE_CLOUD_PROJECT].some(value => value && value !== projectId)) {
    throw new Error('Account device authority target is invalid');
  }
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'liflow-account-device-api');
  const firestore = getFirestore(app), auth = getAuth(app);
  const server = createAccountDeviceHttpServer({ service: createAccountDeviceService({ firestore }), verifyIdToken: (token, revoked) => auth.verifyIdToken(token, revoked) });
  server.listen(port, '0.0.0.0');
  process.once('SIGTERM', () => { server.close(() => { void firestore.terminate(); }); });
} catch {
  process.stderr.write(JSON.stringify({ event: 'account_device_service_startup_refused' }) + '\n'); process.exitCode = 1;
}
