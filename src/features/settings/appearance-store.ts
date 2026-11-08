export type AppAppearance = 'system' | 'light' | 'dark';
const storageKey = 'liflow.appearance.v1';

/** Device-only presentation preference; it never changes an account or shared data. */
export function createAppearanceStore(storage: { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void }, apply: (value: AppAppearance) => void) {
  let value: AppAppearance = 'system'; let initialized = false;
  const listeners = new Set<() => void>();
  const initialize = () => {
    if (initialized) return; initialized = true;
    try { const saved = storage.getItemSync(storageKey); if (saved === 'light' || saved === 'dark') value = saved; } catch { /* A missing preference follows this device. */ }
    apply(value);
  };
  return { initialize, getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: AppAppearance) {
      if (!['system', 'light', 'dark'].includes(next)) throw new Error('表示設定を確認してください。');
      initialize(); if (next === value) return;
      storage.setItemSync(storageKey, next);
      try { apply(next); } catch (cause) {
        try { storage.setItemSync(storageKey, value); apply(value); } catch { /* Preserve the original failure for the caller. */ }
        throw cause;
      }
      value = next; listeners.forEach(listener => listener());
    },
  };
}
