import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect, usePreventRemove } from 'expo-router';
import type { AutosaveState } from '../../settings/autosave-queue';
import { V2SettingsDraftCache } from './settings-draft-cache';

/** Common leave/background handling for both cadence and text/choice editors. */
export function useV2DraftLifecycle<Snapshot extends { removalAllowed: boolean; hasDraft: boolean; status: AutosaveState }>(store: {
  subscribe: (listener: () => void) => () => void; getSnapshot: () => Snapshot; flush: () => Promise<boolean>;
  resumeNavigation: () => void; navigateAfterSave: (navigate: () => void) => Promise<boolean>;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const cache = useContext(V2SettingsDraftCache);
  useFocusEffect(useCallback(() => { store.resumeNavigation(); return () => { if (cache) void store.flush(); else void store.navigateAfterSave(() => {}); }; }, [store, cache]));
  const disablePrevention = usePreventRemove(!snapshot.removalAllowed && (snapshot.hasDraft || snapshot.status.phase === 'saving' || snapshot.status.phase === 'pending'),
    ({ repeat }) => { void store.navigateAfterSave(repeat); });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') void store.flush(); });
    return () => { subscription.remove(); if (cache) void store.flush(); else void store.navigateAfterSave(() => {}); };
  }, [store, cache]);
  return { snapshot, navigateAfterSave: (navigate: () => void) => store.navigateAfterSave(() => { disablePrevention(); navigate(); }) };
}
