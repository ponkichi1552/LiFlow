import { createFirestoreRegionalWeatherStore } from './regional-store.mjs';
import { createMetWeatherService } from './met-service.mjs';

export function firebaseWeatherService(firestore, env = process.env) {
  return createMetWeatherService({ store: createFirestoreRegionalWeatherStore({ firestore }), userAgent: env.MET_WEATHER_USER_AGENT,
    onOperatorAlert: alert => process.stderr.write(JSON.stringify({ event: 'weather_operator_attention', code: alert.code,
      ...(Number.isSafeInteger(alert.httpStatus) && alert.httpStatus >= 100 && alert.httpStatus <= 599 ? { httpStatus: alert.httpStatus } : {}) }) + '\n') });
}
/** Finite scheduled job, independent of HTTP request lifetime and response CPU. */
export async function runWeatherWorkerBatch(service, { maximum = 32, signal } = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('Invalid weather worker budget');
  if (!service.configured) throw new Error('MET contact User-Agent must be configured before starting the weather worker');
  let attempted = 0;
  while (!signal?.aborted && attempted < maximum) {
    const count = await service.tick(Math.min(4, maximum - attempted)); attempted += count;
    if (!count) break;
    // The persistent global transaction remains authoritative across all jobs.
    // This local pause merely avoids busy polling its two-starts/sec gate.
    if (attempted < maximum && !signal?.aborted) await new Promise(resolve => {
      const timer = setTimeout(done, 1000);
      function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  return { attempted };
}
