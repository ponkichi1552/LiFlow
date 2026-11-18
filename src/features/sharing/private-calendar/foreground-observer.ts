import { createDemandWorker } from '../../google-sync/demand-worker.ts';
import { PRIVATE_CALENDAR_REFRESH_MS } from './sync-deadline.ts';

interface ForegroundSyncResult { kind: string; retryAt?: number | null }

export function privateCalendarWaitRetry(retryAt?: number | null): true | { retryAt: number } {
  return typeof retryAt === 'number' && Number.isFinite(retryAt) ? { retryAt } : true;
}

/** No idle polling. Timers exist only to finish failed work or reconnect a terminated listener. */
export function observePrivateCalendarForeground(port: {
  assertOwner(): void | Promise<void>; configured(): Promise<boolean>;
  subscribeLocal(listener: () => void): () => void;
  subscribeConfiguration?(listener: () => void): () => void;
  watchRemote(changed: () => void, failed: () => void): () => void;
  synchronize(): Promise<ForegroundSyncResult | void>; onReady?(): void | Promise<void>; now?: () => number;
}): () => void {
  const now = port.now ?? Date.now;
  let stopped = false; let remote: (() => void) | null = null; let failedAt: number | null = null;
  let checking: Promise<void> | null = null; let recheck = false;
  let listenerRetry: ReturnType<typeof setTimeout> | undefined;
  let listenerFailures = 0;
  const sync = createDemandWorker({ active: () => !stopped, run: async () => {
    await port.assertOwner();
    if (stopped) return false;
    const result = await port.synchronize();
    if (result?.kind === 'waiting') return privateCalendarWaitRetry(result.retryAt);
    return result?.kind === 'pending' || result?.kind === 'changed' || result?.kind === 'error';
  } });
  const synchronize = sync.request;
  const delay = (attempts: number) => Math.min(300_000, 30_000 * 2 ** Math.min(attempts, 4));
  function retryListener() {
    clearTimeout(listenerRetry); if (stopped) return;
    listenerRetry = setTimeout(() => { listenerRetry = undefined; failedAt = null; reconcile(); }, delay(listenerFailures++));
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
  return () => { stopped = true; sync.stop(); clearTimeout(listenerRetry); local(); configuration?.(); remote?.(); remote = null; };
}
