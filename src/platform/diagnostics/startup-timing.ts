const timings: { phase: string; durationMs: number; atMs: number }[] = [];
let persistence: Promise<void> = Promise.resolve();
/** Preserve synchronous execution while measuring CPU work in opt-in builds. */
export function traceStartupSync<T>(phase: string, work: () => T): T {
  if (process.env.EXPO_PUBLIC_LIFLOW_STARTUP_TRACE !== '1') return work();
  const start = performance.now();
  try { return work(); }
  finally { console.info(`[LiFlow startup] ${phase}: ${Math.round(performance.now() - start)}ms (at ${Math.round(performance.now())}ms)`); }
}
/** Opt-in local timing only. Labels are fixed phases, never account or planner content. */
export async function traceStartup<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
  if (process.env.EXPO_PUBLIC_LIFLOW_STARTUP_TRACE !== '1') return work();
  const start = performance.now();
  try { return await work(); }
  finally {
    const atMs = Math.round(performance.now()); const durationMs = Math.round(performance.now() - start);
    console.info(`[LiFlow startup] ${phase}: ${durationMs}ms (at ${atMs}ms)`);
    if (/^[a-zA-Z.]{1,60}$/u.test(phase)) {
      timings.push({ phase, durationMs, atMs }); if (timings.length > 256) timings.shift();
      const content = JSON.stringify(timings);
      persistence = persistence.then(async () => {
        const { File, Paths } = await import('expo-file-system');
        const file = new File(Paths.cache, 'liflow-startup-metrics.json'); file.create({ overwrite: true }); file.write(content);
      }).catch(() => undefined);
    }
  }
}
