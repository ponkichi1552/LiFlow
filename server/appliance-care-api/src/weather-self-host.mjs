import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { createWeatherHttpServer } from './weather-http-server.mjs';
import { identifyingMetUserAgent } from './weather/met-service.mjs';
import { createSelfHostedWeather } from './weather/sqlite-runtime.mjs';

const log = event => process.stderr.write(JSON.stringify({ event }) + '\n');
const file = process.env.LIFLOW_WEATHER_SQLITE_PATH;
const userAgent = process.env.MET_WEATHER_USER_AGENT;
const port = Number(process.env.PORT ?? 8080);
const host = process.env.LIFLOW_WEATHER_BIND_ADDRESS ?? '127.0.0.1';
const certFile = process.env.LIFLOW_WEATHER_TLS_CERT;
const keyFile = process.env.LIFLOW_WEATHER_TLS_KEY;
try {
  const loopback = host === '127.0.0.1' || host === '::1';
  const hasTls = Boolean(certFile && keyFile);
  if (!file || !isAbsolute(file) || !identifyingMetUserAgent(userAgent)
    || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || !isIP(host)
    || ((certFile || keyFile || !loopback) && (!hasTls || !isAbsolute(certFile) || !isAbsolute(keyFile)))) {
    throw new Error('Invalid self-hosted weather configuration');
  }
  const tls = hasTls ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined;
  const weather = createSelfHostedWeather({ file, userAgent,
    onError: () => log('weather_local_retry'), onOperatorAlert: () => log('weather_provider_attention') });
  const server = createWeatherHttpServer({ weather: weather.service, tls });
  server.listen(port, host);
  function stop() { server.close(() => { void weather.close(); }); }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.once('error', () => { void weather.close(); log('weather_local_listen_failed'); process.exitCode = 1; });
} catch {
  log('weather_local_startup_failed');
  process.exitCode = 1;
}
