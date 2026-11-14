import { PRIVATE_CALENDAR_REFRESH_MS } from './sync-deadline.ts';

/** No idle polling. Timers exist only to finish failed work or reconnect a terminated listener. */
export function observePrivateCalendarForeground(port: {
  assertOwner(): void | Promise<void>; configured(): Promise<boolean>;
  subscribeLocal(listener: () => void): () => void;
  subscribeConfiguration?(listener: () => void): () => void;
  watchRemote(changed: () => void, failed: () => void): () => void;
  synchronize(): Promise<unknown>; onReady?(): void | Promise<void>; now?: () => number;
}): () => void {
  const now = port.now ?? Date.now;
  let stopped = false; let remote: (() => void) | null = null; let failedAt: number | null = null;
  let checking: Promise<void> | null = null; let syncing: Promise<void> | null = null; let dirty = false; let recheck = false;
  let listenerRetry: ReturnType<typeof setTimeout> | undefined; let syncRetry: ReturnType<typeof setTimeout> | undefined;
  let listenerFailures = 0; let syncFailures = 0;
  const delay = (attempts: number) => Math.min(300_000, 30_000 * 2 ** Math.min(attempts, 4));
  function retryListener() {
    clearTimeout(listenerRetry); if (stopped) return;
    listenerRetry = setTimeout(() => { listenerRetry = undefined; failedAt = null; reconcile(); }, delay(listenerFailures++));
  }
  function retrySync() {
    clearTimeout(syncRetry); if (!stopped) syncRetry = setTimeout(() => { syncRetry = undefined; synchronize(); }, delay(syncFailures++));
  }
  function synchronize() {
    clearTimeout(syncRetry); syncRetry = undefined;
    if (stopped) return; dirty = true; if (syncing) return;
    const pending = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await port.assertOwner(); if (stopped) return;
          const result = await port.synchronize();
          if (result && typeof result === 'object' && 'kind' in result && ['pending', 'waiting', 'changed', 'error'].includes(String(result.kind))) retrySync();
          else syncFailures = 0;
        } catch { retrySync(); }
      }
    })(); syncing = pending;
    void pending.finally(() => { if (syncing === pending) { syncing = null; if (dirty && !stopped) synchronize(); } }).catch(() => {});
  }
  function reconcile() {
    const stamp = now();
    if (stopped || remote || failedAt !== null && stamp >= failedAt && stamp - failedAt < PRIVATE_CALENDAR_REFRESH_MS) return;
    if (checking) { recheck = true; return; }
    recheck = false;
    const pending = (async () => {
      await port.assertOwner(); if (stopped || !await port.configured()) return;
      await port.assertOwner(); if (stopped) return;
      void Promise.resolve().then(() => { if (!stopped) return port.onReady?.(); }).catch(() => {});
      try {
        let failed = false;
        const unsubscribe = port.watchRemote(synchronize, () => {
          failed = true;
          if (stopped) return; failedAt = now(); const old = remote; remote = null; old?.(); retryListener(); synchronize();
        });
        if (stopped || failed) unsubscribe(); else { remote = unsubscribe; failedAt = null; listenerFailures = 0; clearTimeout(listenerRetry); listenerRetry = undefined; synchronize(); }
      } catch { failedAt = now(); retryListener(); synchronize(); }
    })(); checking = pending;
    void pending.finally(() => { if (checking === pending) { checking = null; if (recheck && !stopped) reconcile(); } }).catch(() => { if (!stopped) { failedAt = now(); retryListener(); } });
  }
  const local = port.subscribeLocal(reconcile); reconcile();
  const configuration = port.subscribeConfiguration?.(() => { if (remote) synchronize(); else reconcile(); });
  return () => { stopped = true; dirty = false; clearTimeout(listenerRetry); clearTimeout(syncRetry); local(); configuration?.(); remote?.(); remote = null; };
}
