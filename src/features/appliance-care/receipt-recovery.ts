import { createDemandWorker } from '../google-sync/demand-worker.ts';

/** Only durable pending receipts can start authentication or network work. */
export function createAnalysisReceiptRecovery(port: {
  hasPending(): Promise<boolean>; flush(): Promise<boolean | { retryAt: number }>;
  subscribe(changed: () => void): () => void; watchAccount(changed: () => void): () => void;
}) {
  let stopped = false, generation = 0;
  let worker: ReturnType<typeof createDemandWorker> | undefined; let account: (() => void) | undefined;
  const local = port.subscribe(() => worker?.request());
  function pause() { generation++; worker?.stop(); worker = undefined; account?.(); account = undefined; }
  return {
    resume() {
      if (stopped || worker) return;
      const current = ++generation; const live = () => !stopped && generation === current;
      const next = createDemandWorker({ active: live, run: async () => {
        const pending = await port.hasPending(); if (!live()) return false;
        if (!pending) { account?.(); account = undefined; return false; }
        account ??= port.watchAccount(() => next.request());
        if (!live()) return false;
        return port.flush();
      } });
      worker = next; next.request();
    },
    pause,
    stop() { stopped = true; pause(); local(); },
  };
}
