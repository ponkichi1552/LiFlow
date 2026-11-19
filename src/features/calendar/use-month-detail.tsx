import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { createCalendarMonthDetailStore } from './month-detail-store';
const store = createCalendarMonthDetailStore(Storage);
export function useCalendarMonthDetail(binding = store) {
  return { value: useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot), select: binding.select };
}
