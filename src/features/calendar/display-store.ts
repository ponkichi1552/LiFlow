export type CalendarDetailView = 'day' | 'two' | 'list';
export type CalendarView = 'year' | 'month' | CalendarDetailView;
export const CALENDAR_DISPLAY_KEY = 'liflow.calendar.display.v1';
const views: readonly CalendarView[] = ['year', 'month', 'day', 'two', 'list'];
const details: readonly CalendarDetailView[] = ['day', 'two', 'list'];

/** Device-only display preference, independent of personal/shared business data. */
export function createCalendarDisplayStore(storage: { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void }) {
  let state: { view: CalendarView; detail: CalendarDetailView; error: string | null } = { view: 'month', detail: 'day', error: null };
  try {
    const raw = storage.getItemSync(CALENDAR_DISPLAY_KEY); const saved = raw ? JSON.parse(raw) : null;
    if (saved?.version === 1 && views.includes(saved.view) && details.includes(saved.detail)) state = { view: 'month', detail: details.includes(saved.view) ? saved.view : saved.detail, error: null };
  } catch { state.error = 'カレンダーの表示設定を読み込めませんでした。'; }
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    select(view: CalendarView) {
      if (!views.includes(view)) return;
      const detail = details.includes(view as CalendarDetailView) ? view as CalendarDetailView : state.detail;
      if (state.view === view && state.detail === detail && !state.error) return;
      let error: string | null = null;
      try { storage.setItemSync(CALENDAR_DISPLAY_KEY, JSON.stringify({ version: 1, view, detail })); }
      catch { error = '表示形式を保存できませんでした。次回の起動時には元の表示に戻る場合があります。'; }
      state = { view, detail, error }; for (const listener of listeners) try { listener(); } catch { /* A closed view cannot block other subscribers or undo persistence. */ }
    },
  };
}
