/** Wake on a real signal; only unfinished work earns a bounded retry timer. */
export function createDemandWorker(input: { run(): Promise<boolean | { retryAt: number }>; active(): boolean;
  retryDelayMs?: number; maximumRetryMs?: number }) {
  let stopped = false; let running = false; let changed = false; let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const live = () => !stopped && input.active();
  const cancelRetry = () => { clearTimeout(retry); retry = undefined; };
  const execute = async () => {
    if (!live() || running) return;
    running = true; let unfinished: boolean | { retryAt: number } = true;
    try { unfinished = await input.run(); } catch { /* An existing failed operation can retry; idle time cannot start one. */ }
    finally {
      running = false;
      if (live()) {
        if (changed) { changed = false; void execute(); }
        else if (unfinished) {
          const delay = typeof unfinished === 'object' && Number.isFinite(unfinished.retryAt)
            ? Math.max(1_000, unfinished.retryAt - Date.now())
            : Math.min(input.maximumRetryMs ?? 300_000, (input.retryDelayMs ?? 30_000) * 2 ** Math.min(failures++, 8));
          retry = setTimeout(() => { retry = undefined; void execute(); }, delay);
        } else failures = 0;
      }
    }
  };
  return {
    request() { if (!live()) return; cancelRetry(); if (running) changed = true; else void execute(); },
    stop() { stopped = true; changed = false; cancelRetry(); },
  };
}
