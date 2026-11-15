import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { createCalendarTitleDisplayStore } from './title-display-store';

export const calendarTitleDisplayStore = createCalendarTitleDisplayStore(Storage);
export const readCalendarTitleShortening = calendarTitleDisplayStore.getSnapshot;
export function useCalendarTitleDisplay() {
  return { value: useSyncExternalStore(calendarTitleDisplayStore.subscribe, readCalendarTitleShortening, readCalendarTitleShortening), select: calendarTitleDisplayStore.select };
}
