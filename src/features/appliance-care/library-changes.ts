const listeners = new Set<() => void>();
export function subscribeApplianceLibraryChanges(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function notifyApplianceLibraryChanges(): void {
  for (const listener of listeners) try { listener(); } catch { /* Saved bytes remain durable if a view has closed. */ }
}
