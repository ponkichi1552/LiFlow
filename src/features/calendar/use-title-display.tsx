import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { createCalendarTitleDisplayStore } from './title-display-store';

export const calendarTitleDisplayStore = createCalendarTitleDisplayStore(Storage);
export const readCalendarTitleShortening = calendarTitleDisplayStore.getSnapshot;
export function useCalendarTitleDisplay(binding = calendarTitleDisplayStore) {
  return { value: useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot), select: binding.select };
}
