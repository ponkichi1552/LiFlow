/** A local display attempt gets priority over automatic network work on cold start. */
export function createInitialDisplayGate<Scope extends object>() {
  const completed = new WeakSet<Scope>();
  const waiting = new Map<Scope, Set<(ready: boolean) => void>>();
  return {
    wait(scope: Scope) {
      if (completed.has(scope)) return { promise: Promise.resolve(true), cancel() {} };
      let finish!: (ready: boolean) => void;
      const promise = new Promise<boolean>(resolve => { finish = resolve; });
      const callbacks = waiting.get(scope) ?? new Set(); callbacks.add(finish); waiting.set(scope, callbacks);
      return { promise, cancel() { callbacks.delete(finish); if (!callbacks.size) waiting.delete(scope); finish(false); } };
    },
    complete(scope: Scope) {
      completed.add(scope); const callbacks = waiting.get(scope); waiting.delete(scope);
      for (const finish of callbacks ?? []) finish(true);
    },
  };
}

/** Give cached content a frame to paint without making session restoration depend on a visible surface. */
export function waitForInitialFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    let finished = false; let frame: number | undefined; let afterFrame: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(deadline); clearTimeout(afterFrame);
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      resolve();
    };
    // A cold deep link may have no cached screen capable of dismissing the native splash yet.
    const deadline = setTimeout(finish, 50);
    frame = requestAnimationFrame(() => {
      if (!finished) frame = requestAnimationFrame(() => { if (!finished) afterFrame = setTimeout(finish, 0); });
    });
  });
}
