import { createContext, useContext, useState } from 'react';

export interface RetainedV2Draft {
  flush(): Promise<boolean>;
  navigateAfterSave(navigate: () => void): Promise<boolean>;
  resumeNavigation(): void;
  getSnapshot(): { hasDraft: boolean; status: { phase: string } };
}
export const V2SettingsDraftCache = createContext<Map<string, RetainedV2Draft> | null>(null);

/** Virtualizing a long settings document keeps drafts while scrolling; leaving the document uses the departure policy. */
export function useRetainedV2Draft<T extends RetainedV2Draft>(key: string | undefined, create: () => T): T {
  const cache = useContext(V2SettingsDraftCache);
  const [store] = useState(() => {
    if (!cache || !key) return create();
    const existing = cache.get(key); if (existing) return existing as T;
    const value = create(); cache.set(key, value); return value;
  });
  return store;
}
