import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { createCalendarMonthDetailStore } from './month-detail-store';
const store = createCalendarMonthDetailStore(Storage);
export function useCalendarMonthDetail() {
  return { value: useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot), select: store.select };
}
