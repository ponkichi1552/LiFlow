/** One caller budget includes queueing, credentials and all HTTP pages. A joining worker may shorten it. */
export function createGoogleOperationBudget(milliseconds: number, now: () => number = Date.now) {
  const validate = (value: number) => { if (!Number.isSafeInteger(value) || value < 1 || value > 110_000) throw new Error('Google同期の時間枠を確認してください。'); };
  validate(milliseconds); let highWater = now();
  if (!Number.isFinite(highWater)) throw new Error('Google同期の時計を確認してください。');
  let deadline = highWater + milliseconds; let expired = false; let closed = false; let timer: ReturnType<typeof setTimeout>;
  let notify!: () => void; const expiration = new Promise<void>(resolve => { notify = resolve; }); const controller = new AbortController(); const cleanup = new Set<() => void>();
  const expire = () => { if (closed || expired) return; expired = true; controller.abort(); notify(); };
  const clock = () => { const value = now(); if (!Number.isFinite(value)) { expire(); return highWater; } highWater = Math.max(highWater, value); return highWater; };
  const remaining = () => { const value = deadline - clock(); if (expired || closed || value < 1) { expire(); throw Object.assign(new Error('Google同期の時間を超えました。送信待ちは保持しています。'), { name: 'AbortError', code: 'timeout' }); } return value; };
  timer = setTimeout(expire, milliseconds);
  return { expiration, signal: controller.signal, remaining, assert: () => { remaining(); }, cancel: expire,
    shrink(milliseconds: number) { validate(milliseconds); const next = clock() + milliseconds; if (next < deadline) { deadline = next; clearTimeout(timer); timer = setTimeout(expire, Math.max(0, next - clock())); } },
    onClose(work: () => void) { if (closed) work(); else cleanup.add(work); },
    close() { closed = true; clearTimeout(timer); for (const work of cleanup) work(); cleanup.clear(); },
  };
}
export type GoogleOperationBudget = ReturnType<typeof createGoogleOperationBudget>;

/** An ignored native abort cannot keep credential/HTTP waits alive after their caller's deadline. */
export async function withinGoogleOperationBudget<T>(budget: GoogleOperationBudget, work: () => Promise<T>): Promise<T> {
  budget.assert();
  const value = await Promise.race([work(), budget.expiration.then(() => {
    throw Object.assign(new Error('Google同期の時間を超えました。'), { name: 'AbortError', code: 'timeout' });
  })]);
  budget.assert(); return value;
}
