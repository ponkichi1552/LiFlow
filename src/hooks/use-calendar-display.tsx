import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { createCalendarDisplayStore } from '../features/calendar/display-store';
let store: ReturnType<typeof createCalendarDisplayStore> | undefined;
export function useCalendarDisplay() {
  const binding = store ??= createCalendarDisplayStore(Storage);
  return { ...useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot), select: binding.select };
}
