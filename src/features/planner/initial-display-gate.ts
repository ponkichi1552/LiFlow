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
