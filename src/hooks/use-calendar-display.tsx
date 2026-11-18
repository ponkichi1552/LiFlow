import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';
import { createCalendarDisplayStore } from '../features/calendar/display-store';
let store: ReturnType<typeof createCalendarDisplayStore> | undefined;
export function useCalendarDisplay() {
  const binding = store ??= createCalendarDisplayStore();
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true; binding.enter();
    return () => { focused.current = false; binding.leave(); };
  }, [binding]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') binding.leave();
      else if (state === 'active' && focused.current) binding.enter();
    });
    return () => subscription.remove();
  }, [binding]);
  return { ...useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot), select: binding.select, openDetail: binding.openDetail };
}
