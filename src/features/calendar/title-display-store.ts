export const CALENDAR_TITLE_SHORTENING_KEY = 'liflow.calendar-title-shortening.v1';

/** This device's display/export preference never writes calendar records or requests a sync. */
export function createCalendarTitleDisplayStore(storage: { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void }) {
  let value = true;
  let initialized = false;
  const listeners = new Set<() => void>();
  const read = () => {
    if (!initialized) {
      initialized = true;
      try { value = storage.getItemSync(CALENDAR_TITLE_SHORTENING_KEY) !== 'false'; }
      catch { /* An unavailable preference must not prevent opening the calendar. */ }
    }
    return value;
  };
  return {
    getSnapshot: read,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(next: boolean) {
      if (typeof next !== 'boolean') throw new Error('予定名の表示設定を確認してください。');
      if (read() === next) return;
      storage.setItemSync(CALENDAR_TITLE_SHORTENING_KEY, String(next));
      value = next;
      for (const listener of listeners) listener();
    },
  };
}
