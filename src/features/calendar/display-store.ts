export type CalendarDetailView = 'day' | 'two' | 'list';
export type CalendarView = 'year' | 'month' | CalendarDetailView;
export const CALENDAR_IDLE_RESET_MS = 60_000;
const views: readonly CalendarView[] = ['year', 'month', 'day', 'two', 'list'];
const details: readonly CalendarDetailView[] = ['day', 'two', 'list'];

/** Presentation lasts for this process only. Background timers are checked again on return. */
export function createCalendarDisplayStore(now: () => number = Date.now) {
  let state: { view: CalendarView; detail: CalendarDetailView; error: string | null } = { view: 'month', detail: 'day', error: null };
  let leftAt: number | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    select(view: CalendarView) {
      if (!views.includes(view)) return;
      const detail = details.includes(view as CalendarDetailView) ? view as CalendarDetailView : state.detail;
      if (state.view === view && state.detail === detail && !state.error) return;
      state = { view, detail, error: null }; for (const listener of listeners) try { listener(); } catch { /* A closed screen cannot block other observers. */ }
    },
    leave() {
      if (leftAt !== null) return;
      leftAt = now(); clearTimeout(timer);
      timer = setTimeout(() => { if (leftAt !== null) store.select('month'); }, CALENDAR_IDLE_RESET_MS);
    },
    enter() {
      if (leftAt !== null && now() - leftAt >= CALENDAR_IDLE_RESET_MS) store.select('month');
      leftAt = null; clearTimeout(timer); timer = undefined;
    },
    dispose() { clearTimeout(timer); listeners.clear(); },
  };
  return store;
}
