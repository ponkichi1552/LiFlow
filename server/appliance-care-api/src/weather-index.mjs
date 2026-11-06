import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { firebaseWeatherService } from './weather/firebase-runtime.mjs';
import { weatherRuntimeConfig } from './weather/runtime-config.mjs';
import { createWeatherHttpServer } from './weather-http-server.mjs';

try {
  const config = weatherRuntimeConfig();
  const app = initializeApp({ projectId: config.projectId, credential: applicationDefault() }, 'liflow-weather-http');
  const firestore = getFirestore(app, config.databaseId);
  const server = createWeatherHttpServer({ weather: firebaseWeatherService(firestore) });
  server.listen(config.port, '0.0.0.0');
  process.once('SIGTERM', () => { server.close(() => { void firestore.terminate(); }); });
} catch {
  process.stderr.write(JSON.stringify({ event: 'weather_http_startup_refused' }) + '\n'); process.exitCode = 1;
}
