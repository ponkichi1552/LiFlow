/** Opt-in local timing only. Labels are fixed phases, never account or planner content. */
export async function traceStartup<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
  if (process.env.EXPO_PUBLIC_LIFLOW_STARTUP_TRACE !== '1') return work();
  const start = performance.now();
  try { return await work(); }
  finally { console.info(`[LiFlow startup] ${phase}: ${Math.round(performance.now() - start)}ms (at ${Math.round(performance.now())}ms)`); }
}
