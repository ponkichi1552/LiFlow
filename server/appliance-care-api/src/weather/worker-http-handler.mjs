import { createServer } from 'node:http';
import { runWeatherWorkerBatch } from './firebase-runtime.mjs';

/** This server requires Cloud Run invoker IAM; it is never the public endpoint. */
export function createWeatherWorkerHttpServer({ service, signal, runBatch = runWeatherWorkerBatch }) {
  let working = false;
  return createServer({ requestTimeout: 180_000, headersTimeout: 10_000, maxHeaderSize: 8_192 }, (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'POST' || request.url !== '/internal/weather/run') { response.writeHead(404); response.end(); return; }
    if (working || signal?.aborted) { response.writeHead(409); response.end(); return; }
    working = true;
    void runBatch(service, { maximum: 32, signal }).then(result => {
      process.stdout.write(JSON.stringify({ event: 'weather_worker_batch', ...result }) + '\n');
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    }, () => {
      process.stderr.write(JSON.stringify({ event: 'weather_worker_batch_failed' }) + '\n');
      response.writeHead(503); response.end();
    }).finally(() => { working = false; });
  });
}
