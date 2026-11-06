import { createServer } from 'node:http';
import { AccountDeviceApiError } from './service.mjs';

const paths = new Map([['/v1/restore/read', 'read'], ['/v1/restore/request', 'request'], ['/v1/restore/accept', 'accept'], ['/v1/restore/acknowledge', 'acknowledge']]);
export function createAccountDeviceHttpServer({ service, verifyIdToken, maxConcurrent = 8 }) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error('Invalid account device concurrency');
  let active = 0;
  const recent = new Map();
  function limited(identity, maximum) {
    const minute = Math.floor(Date.now() / 60000), previous = recent.get(identity), count = previous?.minute === minute ? previous.count + 1 : 1;
    if (recent.size >= 2048 && !recent.has(identity)) recent.delete(recent.keys().next().value);
    recent.set(identity, { minute, count }); return count > maximum;
  }
  const reply = (response, status, body) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...(status === 429 || status === 503 ? { 'Retry-After': '60' } : {}) });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') { reply(response, 200, { ok: true }); return; }
    const method = paths.get(request.url);
    if (!method || request.method !== 'POST') { reply(response, 404, { code: 'not_found' }); return; }
    if (active >= maxConcurrent || limited(`ip:${request.socket.remoteAddress}`, 240)) { reply(response, 429, { code: 'retry_later' }); return; }
    if (!/^application\/json(?:\s*;.*)?$/iu.test(String(request.headers['content-type'] ?? ''))) { reply(response, 415, { code: 'json_required' }); return; }
    const bearer = /^Bearer ([A-Za-z0-9._-]{1,12000})$/u.exec(String(request.headers.authorization ?? ''));
    if (!bearer) { reply(response, 401, { code: 'identity_required' }); return; }
    active++;
    try {
      let claims;
      try { claims = await verifyIdToken(bearer[1], true); } catch { throw new AccountDeviceApiError(401, 'identity_required'); }
      if (typeof claims.uid !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(claims.uid)) throw new AccountDeviceApiError(401, 'identity_required');
      if (limited(`uid:${claims.uid}`, 120)) throw new AccountDeviceApiError(429, 'retry_later');
      const actor = { uid: claims.uid, provider: claims.firebase?.sign_in_provider, authTime: claims.auth_time * 1000 };
      let length = 0; const chunks = [];
      for await (const chunk of request) {
        length += chunk.length; if (length > 256000) throw new AccountDeviceApiError(413, 'request_too_large'); chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AccountDeviceApiError(400, 'invalid_json'); }
      const result = await service[method](actor, input); reply(response, 200, result);
    } catch (error) {
      // Provider errors, request contents and OAuth tokens never enter logs or response bodies.
      const known = error instanceof AccountDeviceApiError;
      reply(response, known ? error.status : 503, { code: known ? error.code : 'retry_later' });
    } finally { active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  return server;
}
