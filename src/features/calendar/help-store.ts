export const CALENDAR_HELP_SEEN_KEY = 'liflow.calendar-help.seen.v1';
type HelpStorage = { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void };

/** One presentation flag on this device. No planner, account or network data. */
export function createCalendarHelpStore(storage: HelpStorage) {
  let initialized = false; let seen = false; let claimed = false;
  const initialize = () => {
    if (initialized) return; initialized = true;
    try { seen = storage.getItemSync(CALENDAR_HELP_SEEN_KEY) === '1'; } catch { /* Show the help without blocking the calendar. */ }
  };
  const shown = () => {
    initialize(); if (seen) return; seen = true;
    try { storage.setItemSync(CALENDAR_HELP_SEEN_KEY, '1'); } catch { /* Memory prevents a prompt loop in this session. */ }
  };
  return { shown,
    claimIntroduction() {
      initialize(); if (seen || claimed) return null; claimed = true; let active = true;
      return {
        shown() { if (!active) return; active = false; claimed = false; shown(); },
        release() { if (!active) return; active = false; claimed = false; },
      };
    },
  };
}
