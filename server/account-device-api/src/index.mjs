import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createAccountDeviceService } from './service.mjs';
import { createAccountDeviceHttpServer } from './http.mjs';

try {
  const projectId = process.env.LIFLOW_FIREBASE_PROJECT_ID, port = Number(process.env.PORT ?? '8080');
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/u.test(projectId) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid runtime configuration');
  if (process.env.NODE_ENV === 'production' && (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('Production cannot use emulated authority');
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'liflow-account-device-api');
  const firestore = getFirestore(app), auth = getAuth(app);
  const server = createAccountDeviceHttpServer({ service: createAccountDeviceService({ firestore }), verifyIdToken: (token, revoked) => auth.verifyIdToken(token, revoked) });
  server.listen(port, '0.0.0.0');
  process.once('SIGTERM', () => { server.close(() => { void firestore.terminate(); }); });
} catch {
  process.stderr.write(JSON.stringify({ event: 'account_device_service_startup_refused' }) + '\n'); process.exitCode = 1;
}
