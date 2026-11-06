import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { firebaseWeatherService, runWeatherWorkerBatch } from './weather/firebase-runtime.mjs';
import { weatherRuntimeConfig } from './weather/runtime-config.mjs';
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
try {
  const { projectId, databaseId } = weatherRuntimeConfig();
  const app = getApps().find(value => value.name === 'liflow-weather-worker')
    ?? initializeApp({ projectId, credential: applicationDefault() }, 'liflow-weather-worker');
  if (app.options.projectId !== projectId) throw new Error('Weather project changed');
  const firestore = getFirestore(app, databaseId);
  try {
    const result = await runWeatherWorkerBatch(firebaseWeatherService(firestore), { signal: controller.signal });
    process.stdout.write(JSON.stringify({ event: 'weather_worker_batch', ...result }) + '\n');
  } finally { await firestore.terminate(); }
} catch {
  process.stderr.write(JSON.stringify({ event: 'weather_worker_startup_refused' }) + '\n'); process.exitCode = 1;
}
