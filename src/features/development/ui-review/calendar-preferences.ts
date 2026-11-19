import { createCalendarDisplayStore, type CalendarView } from '../../calendar/display-store';
import { CALENDAR_HELP_SEEN_KEY, createCalendarHelpStore } from '../../calendar/help-store';
import { createCalendarMonthDetailStore } from '../../calendar/month-detail-store';
import { createCalendarTitleDisplayStore } from '../../calendar/title-display-store';

export function createCalendarReviewPreferences(initialView: CalendarView) {
  const values = new Map([[CALENDAR_HELP_SEEN_KEY, '1']]);
  const storage = {
    getItemSync: (key: string) => values.get(key) ?? null,
    setItemSync: (key: string, value: string) => { values.set(key, value); },
  };
  const display = createCalendarDisplayStore();
  display.select(initialView);
  return {
    display,
    monthDetail: createCalendarMonthDetailStore(storage),
    titleDisplay: createCalendarTitleDisplayStore(storage),
    help: createCalendarHelpStore(storage),
  };
}
