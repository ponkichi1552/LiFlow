import { createServer } from 'node:http';
import { createWeatherHttpHandler } from './weather/http-handler.mjs';

/** No AI, billing, account or user-data routes are mounted here. */
export function createWeatherHttpServer(options) {
  const weather = createWeatherHttpHandler(options);
  return createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8_192 }, (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cache-control', 'no-store');
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') { json(200, { status: 'ok' }); return; }
      if (await weather(request, response, url)) return;
      json(404, { code: 'not_found' });
    })().catch(() => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) response.destroy(); else json(503, { code: 'weather_unavailable' });
    });
    function json(status, value) {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
    }
  });
}
