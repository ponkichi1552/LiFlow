import { analyzeApplianceCare } from './service.mjs';

export function analysisRequestKey(request) {
  return JSON.stringify([request.manual?.reference ?? 'official-manual-v1', ...['manufacturer', 'productName', 'modelNumber', 'category']
    .map((field) => (request[field] ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'))]);
}

/** Process-local, bounded reuse and admission control. No credentials or private planner data are cached. */
export function createAnalysisRunner({ dependencies, analyze = analyzeApplianceCare, now = Date.now,
  cacheTtlMs = 60 * 60_000, maxCacheEntries = 100, maxConcurrent = 3, maxPerHour = 20 } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let windowStartedAt = now();
  let startedThisHour = 0;
  const limited = () => ({ status: 'error', code: 'RATE_LIMITED',
    message: '解析の受付上限に達しました。時間をおいて再試行してください。' });

  return {
    run(request, onStage = () => {}, { bypassCache = false } = {}) {
      const key = analysisRequestKey(request);
      const timestamp = now();
      for (const [id, item] of cache) {
        if (timestamp < item.createdAt || timestamp >= item.expiresAt) cache.delete(id);
      }
      const cached = cache.get(key);
      if (!bypassCache && cached) return Promise.resolve(structuredClone(cached.result));
      const existing = inFlight.get(key);
      if (existing) {
        existing.listeners.add(onStage);
        try { onStage(existing.stage); } catch { /* progress observers cannot fail an analysis */ }
        return existing.promise.then((result) => structuredClone(result));
      }
      if (timestamp - windowStartedAt >= 60 * 60_000) { windowStartedAt = timestamp; startedThisHour = 0; }
      if (inFlight.size >= maxConcurrent || startedThisHour >= maxPerHour) return Promise.resolve(limited());
      startedThisHour += 1;
      const job = { stage: 'product_verification', listeners: new Set([onStage]), promise: null };
      const emit = (stage) => {
        job.stage = stage;
        for (const listener of job.listeners) { try { listener(stage); } catch { /* best effort */ } }
      };
      job.promise = Promise.resolve().then(() => analyze(request, dependencies, emit)).then((result) => {
        if (result.status === 'verified') {
          // The verified product/manual provenance remains in the result. Reanalysis explicitly bypasses this short-lived cache.
          cache.delete(key);
          cache.set(key, { result: structuredClone(result), createdAt: now(), expiresAt: now() + cacheTtlMs });
          while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
        }
        return result;
      }).finally(() => { inFlight.delete(key); });
      inFlight.set(key, job);
      return job.promise.then((result) => structuredClone(result));
    },
  };
}
