export type CalendarMonthDetail = 'compact' | 'standard' | 'detailed';
export const MONTH_DETAIL_KEY = 'liflow.calendar-month-detail.v1';
export const MONTH_DETAILS = [
  { value: 'compact', label: 'すっきり', caption: '予定名を1行で表示' },
  { value: 'standard', label: '標準', caption: '空きに応じて名前と時刻' },
  { value: 'detailed', label: '詳しく', caption: '日付の枠を広げて表示' },
] as const;
export function monthDetailLayout(detail: CalendarMonthDetail) {
  return detail === 'compact' ? { weeks: 6, maxEvents: 2, extra: false } : detail === 'detailed' ? { weeks: 3.5, maxEvents: 6, extra: true } : { weeks: 5, maxEvents: 4, extra: true };
}
export function createCalendarMonthDetailStore(storage: { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void }) {
  let value: CalendarMonthDetail = 'standard'; let initialized = false; const listeners = new Set<() => void>();
  const read = () => { if (!initialized) { initialized = true; try { const saved = storage.getItemSync(MONTH_DETAIL_KEY); if (MONTH_DETAILS.some(row => row.value === saved)) value = saved as CalendarMonthDetail; } catch { /* Default layout remains usable. */ } } return value; };
  return { getSnapshot: read, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(next: CalendarMonthDetail) {
      if (!MONTH_DETAILS.some(row => row.value === next)) throw new Error('月表示の詳しさを確認してください。');
      if (read() === next) return;
      storage.setItemSync(MONTH_DETAIL_KEY, next); value = next; for (const listener of listeners) listener();
    },
  };
}
