import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect, usePreventRemove } from 'expo-router';
import { createAutosaveQueue } from './autosave-queue';
import { createDraftNavigation } from './draft-navigation';

/** A single retained writer also flushes a last tap before navigation/background. */
export function useSettingsAutosave<Patch extends object>(save: (patch: Patch) => Promise<unknown>) {
  const writer = useRef(save);
  useLayoutEffect(() => { writer.current = save; }, [save]);
  // The writer is invoked by an event/timer, never by the initializer.
  // eslint-disable-next-line react-hooks/refs
  const [queue] = useState(() => {
    const queue = createAutosaveQueue<Patch>({ save: patch => writer.current(patch) });
    const navigation = createDraftNavigation({ flush: queue.flush, discard: queue.discard, invalid: () => false,
      failed: () => queue.getSnapshot().phase === 'error', publish() {} });
    return { ...queue, ...navigation };
  });
  const status = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const unsettled = !['idle', 'saved'].includes(status.phase);
  const disablePrevention = usePreventRemove(unsettled, ({ repeat }) => {
    void queue.navigateAfterSave(repeat);
  });
  useFocusEffect(useCallback(() => { queue.resumeNavigation(); return () => { void queue.navigateAfterSave(() => {}); }; }, [queue]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') void queue.flush(); });
    return () => { subscription.remove(); void queue.navigateAfterSave(() => {}); };
  }, [queue]);
  return { ...queue, status, async navigate(navigate: () => void) {
    return queue.navigateAfterSave(() => { disablePrevention(); navigate(); });
  } };
}
