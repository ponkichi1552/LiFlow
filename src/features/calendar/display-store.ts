export type CalendarDetailView = 'day' | 'two' | 'three' | 'week' | 'list';
export type CalendarView = 'year' | 'month' | CalendarDetailView;
export const CALENDAR_IDLE_RESET_MS = 60_000;
const views: readonly CalendarView[] = ['year', 'month', 'day', 'two', 'three', 'week', 'list'];
const details: readonly CalendarDetailView[] = ['day', 'two', 'three', 'week', 'list'];

/** Presentation lasts for this process only. Background timers are checked again on return. */
export function createCalendarDisplayStore(now: () => number = Date.now) {
  let state: { view: CalendarView; detail: CalendarDetailView; error: string | null } = { view: 'month', detail: 'day', error: null };
  let leftAt: number | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const cancelAwayReset = () => { leftAt = null; clearTimeout(timer); timer = undefined; };
  const store = {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    select(view: CalendarView) {
      if (!views.includes(view)) return;
      const detail = details.includes(view as CalendarDetailView) ? view as CalendarDetailView : state.detail;
      if (state.view === view && state.detail === detail && !state.error) return;
      state = { view, detail, error: null }; for (const listener of listeners) try { listener(); } catch { /* A closed screen cannot block other observers. */ }
    },
    openDetail(view: CalendarDetailView) {
      if (!details.includes(view)) return;
      // A notification can open the calendar before AppState reports foregrounding.
      cancelAwayReset();
      store.select(view);
    },
    leave() {
      if (leftAt !== null) return;
      leftAt = now(); clearTimeout(timer);
      timer = setTimeout(() => { if (leftAt !== null) store.select('month'); }, CALENDAR_IDLE_RESET_MS);
    },
    enter() {
      if (leftAt !== null && now() - leftAt >= CALENDAR_IDLE_RESET_MS) store.select('month');
      cancelAwayReset();
    },
    dispose() { clearTimeout(timer); listeners.clear(); },
  };
  return store;
}
