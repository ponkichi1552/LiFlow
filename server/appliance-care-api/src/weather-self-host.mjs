import { isAbsolute } from 'node:path';
import { createWeatherHttpServer } from './weather-http-server.mjs';
import { identifyingMetUserAgent } from './weather/met-service.mjs';
import { createSelfHostedWeather } from './weather/sqlite-runtime.mjs';

const log = event => process.stderr.write(JSON.stringify({ event }) + '\n');
const file = process.env.LIFLOW_WEATHER_SQLITE_PATH;
const userAgent = process.env.MET_WEATHER_USER_AGENT;
const port = Number(process.env.PORT ?? 8080);
try {
  if (!file || !isAbsolute(file) || !identifyingMetUserAgent(userAgent)
    || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid self-hosted weather configuration');
  const weather = createSelfHostedWeather({ file, userAgent,
    onError: () => log('weather_local_retry'), onOperatorAlert: () => log('weather_provider_attention') });
  const server = createWeatherHttpServer({ weather: weather.service });
  server.listen(port, '127.0.0.1');
  function stop() { server.close(() => { void weather.close(); }); }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.once('error', () => { void weather.close(); log('weather_local_listen_failed'); process.exitCode = 1; });
} catch {
  log('weather_local_startup_failed');
  process.exitCode = 1;
}
