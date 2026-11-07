import { PRIVATE_CALENDAR_REFRESH_MS } from './sync-deadline.ts';

/** The app's existing foreground timer supplies periodic recovery; this observer never creates a timer. */
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
  function synchronize() {
    if (stopped) return; dirty = true; if (syncing) return;
    const pending = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        try { await port.assertOwner(); if (!stopped) await port.synchronize(); }
        catch { /* The runtime retains retries; this is not evidence of source/account removal. */ }
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
          if (stopped) return; failedAt = now(); const old = remote; remote = null; old?.(); synchronize();
        });
        if (stopped || failed) unsubscribe(); else { remote = unsubscribe; failedAt = null; synchronize(); }
      } catch { failedAt = now(); synchronize(); }
    })(); checking = pending;
    void pending.finally(() => { if (checking === pending) { checking = null; if (recheck && !stopped) reconcile(); } }).catch(() => {});
  }
  const local = port.subscribeLocal(reconcile); reconcile();
  const configuration = port.subscribeConfiguration?.(() => { if (remote) synchronize(); else reconcile(); });
  return () => { stopped = true; dirty = false; local(); configuration?.(); remote?.(); remote = null; };
}
