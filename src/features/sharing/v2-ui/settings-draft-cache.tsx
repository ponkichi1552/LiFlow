import { createContext, useContext, useState } from 'react';

export interface RetainedV2Draft {
  flush(): Promise<boolean>;
  getSnapshot(): { hasDraft: boolean; status: { phase: string } };
}
export const V2SettingsDraftCache = createContext<Map<string, RetainedV2Draft> | null>(null);

/** Virtualizing a long settings document must never discard a failed or unfinished draft. */
export function useRetainedV2Draft<T extends RetainedV2Draft>(key: string | undefined, create: () => T): T {
  const cache = useContext(V2SettingsDraftCache);
  const [store] = useState(() => {
    if (!cache || !key) return create();
    const existing = cache.get(key); if (existing) return existing as T;
    const value = create(); cache.set(key, value); return value;
  });
  return store;
}
