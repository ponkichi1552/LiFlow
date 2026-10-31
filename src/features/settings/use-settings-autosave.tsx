import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect, usePreventRemove } from 'expo-router';
import { createAutosaveQueue } from './autosave-queue';

/** A single retained writer also flushes a last tap before navigation/background. */
export function useSettingsAutosave<Patch extends object>(save: (patch: Patch) => Promise<unknown>) {
  const writer = useRef(save);
  useLayoutEffect(() => { writer.current = save; }, [save]);
  // The writer is invoked by an event/timer, never by the initializer.
  // eslint-disable-next-line react-hooks/refs
  const [queue] = useState(() => createAutosaveQueue<Patch>({ save: patch => writer.current(patch) }));
  const status = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const leaving = useRef(false);
  const unsettled = !['idle', 'saved'].includes(status.phase);
  const disablePrevention = usePreventRemove(unsettled, ({ repeat }) => {
    if (leaving.current) return;
    leaving.current = true;
    void queue.flush().then(ok => { leaving.current = false; if (ok) repeat(); });
  });
  useFocusEffect(useCallback(() => { leaving.current = false; return () => { void queue.flush(); }; }, [queue]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') void queue.flush(); });
    return () => { subscription.remove(); void queue.flush(); };
  }, [queue]);
  return { ...queue, status, async navigate(navigate: () => void) {
    if (leaving.current) return;
    leaving.current = true;
    const ok = await queue.flush(); leaving.current = false;
    if (ok) { disablePrevention(); navigate(); }
  } };
}
