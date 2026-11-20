/** Bounded backoff; server hints cannot create a tight polling loop or an unbounded wait. */
export function applianceCarePollDelay(attempt: number, serverHint?: unknown): number {
  const backoff = [1000, 1500, 2000, 3000, 5000, 8000][Math.min(5, Math.max(0, Math.trunc(attempt)))];
  const hint = typeof serverHint === 'number' && Number.isFinite(serverHint) ? serverHint : 0;
  return Math.min(8000, Math.max(backoff, hint));
}

export function waitForAppliancePoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
