import { authenticateFirebaseUser } from './public-access.mjs';
import { SubscriptionError } from './subscription-service.mjs';

/** Mounted on the existing API listener, before AI/device admission. Buying/restoring must remain usable without AI. */
export function createSubscriptionHttp({ service, providers, verifyIdToken }) {
  const requests = new Map();
  return {
    service,
    async handle(request, response, url) {
      if (!url.pathname.startsWith('/api/subscriptions/')) return false;
      const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
      const body = async () => {
        if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) throw new SubscriptionError(415, 'INVALID_REQUEST', 'JSON形式で送信してください。');
        let length = 0; const chunks = [];
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 100_000) throw new SubscriptionError(413, 'INVALID_REQUEST', '購入情報が大きすぎます。');
          chunks.push(chunk);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString()); }
        catch { throw new SubscriptionError(400, 'INVALID_REQUEST', '購入情報の形式を確認してください。'); }
      };
      if (request.method === 'POST' && ['/api/subscriptions/notifications/apple', '/api/subscriptions/notifications/google'].includes(url.pathname)) {
        const store = url.pathname.endsWith('/apple') ? 'apple' : 'google';
        if (!providers[store]?.notification) throw new SubscriptionError(503, 'STORE_NOT_CONFIGURED', '購入確認は準備中です。');
        const purchaseId = await providers[store].notification(await body(), request.headers);
        if (purchaseId) await service.reconcile(store, purchaseId);
        send(200, { received: true }); return true;
      }
      const { uid } = await authenticateFirebaseUser(request, verifyIdToken);
      const at = Date.now();
      for (const [key, value] of requests) if (value.until <= at) requests.delete(key);
      const rate = requests.get(uid) ?? { count: 0, until: at + 60_000 };
      if ((!requests.has(uid) && requests.size >= 5000) || ++rate.count > 30) throw new SubscriptionError(429, 'RATE_LIMITED', '契約の確認が多すぎます。少し待ってから再試行してください。');
      requests.set(uid, rate);
      if (request.method === 'GET' && url.pathname === '/api/subscriptions/status') { send(200, await service.status(uid, url.searchParams.get('refresh') === 'true')); return true; }
      if (request.method === 'POST' && url.pathname === '/api/subscriptions/verify') { send(200, await service.verify(uid, await body())); return true; }
      send(404, { code: 'NOT_FOUND', message: '購入の確認先が見つかりません。' }); return true;
    },
  };
}
