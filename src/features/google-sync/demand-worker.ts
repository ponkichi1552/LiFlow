const MAX_TIMEOUT_MS = 2_147_483_647;

/** Wake on a real signal; only unfinished work earns a bounded retry timer. */
export function createDemandWorker(input: { run(): Promise<boolean | { retryAt: number }>; active(): boolean;
  retryDelayMs?: number; maximumRetryMs?: number }) {
  let stopped = false; let running = false; let changed = false; let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const live = () => !stopped && input.active();
  const cancelRetry = () => { clearTimeout(retry); retry = undefined; };
  function waitUntil(retryAt: number) {
    // A saved timestamp can be more than one timer away after the wall clock moves backwards.
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, retryAt - Date.now()));
    retry = setTimeout(() => {
      retry = undefined;
      if (!live()) return;
      if (Date.now() < retryAt) waitUntil(retryAt);
      else void execute();
    }, delay);
  }
  const execute = async () => {
    if (!live() || running) return;
    running = true; let unfinished: boolean | { retryAt: number } = true;
    try { unfinished = await input.run(); } catch { /* An existing failed operation can retry; idle time cannot start one. */ }
    finally {
      running = false;
      if (live()) {
        if (changed) { changed = false; void execute(); }
        else if (typeof unfinished === 'object' && Number.isFinite(unfinished.retryAt)) waitUntil(unfinished.retryAt);
        else if (unfinished) {
          const delay = Math.min(input.maximumRetryMs ?? 300_000, (input.retryDelayMs ?? 30_000) * 2 ** Math.min(failures++, 8));
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
