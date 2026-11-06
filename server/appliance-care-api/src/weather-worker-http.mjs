import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { firebaseWeatherService } from './weather/firebase-runtime.mjs';
import { weatherRuntimeConfig } from './weather/runtime-config.mjs';
import { createWeatherWorkerHttpServer } from './weather/worker-http-handler.mjs';

// Deploy this entry only as an IAM-protected Cloud Run service. The scheduled
// request stays open until its finite batch ends; no post-response CPU is used.
const controller = new AbortController();
try {
  const config = weatherRuntimeConfig();
  const app = initializeApp({ projectId: config.projectId, credential: applicationDefault() }, 'liflow-weather-scheduled');
  const firestore = getFirestore(app, config.databaseId);
  const server = createWeatherWorkerHttpServer({ service: firebaseWeatherService(firestore), signal: controller.signal });
  server.listen(config.port, '0.0.0.0');
  process.once('SIGTERM', () => { controller.abort(); server.close(() => { void firestore.terminate(); }); });
} catch {
  process.stderr.write(JSON.stringify({ event: 'weather_worker_startup_refused' }) + '\n'); process.exitCode = 1;
}
