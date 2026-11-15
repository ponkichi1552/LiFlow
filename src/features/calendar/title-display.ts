import type { LocalDate } from '../../domain/shared/types';
import type { CalendarOccurrence } from './events';
import { calendarTitleLabel } from './title-datetime.ts';

/** One parsed label is shared by recurring rounds and repeated renders, with bounded memory. */
export function createCalendarTitleDisplay(format: typeof calendarTitleLabel = calendarTitleLabel) {
  const labels = new Map<string, string>();
  const label = (title: string, referenceDate: LocalDate, shorten = true) => {
    if (!shorten) return title;
    const key = `${referenceDate}\n${title}`;
    const cached = labels.get(key);
    if (cached !== undefined) return cached;
    const result = format(title, referenceDate, true);
    if (labels.size >= 512) labels.delete(labels.keys().next().value!);
    labels.set(key, result);
    return result;
  };
  return {
    label,
    occurrences(events: readonly CalendarOccurrence[], referenceDate: LocalDate, shorten = true): readonly CalendarOccurrence[] {
      let changed = false;
      const result = events.map(event => {
        const title = label(event.title, referenceDate, shorten);
        const displayTitle = title === event.title ? undefined : title;
        if (event.displayTitle === displayTitle) return event;
        changed = true;
        if (displayTitle !== undefined) return { ...event, displayTitle };
        const { displayTitle: _displayTitle, ...original } = event;
        return original;
      });
      return changed ? result : events;
    },
  };
}
export const calendarTitleDisplay = createCalendarTitleDisplay();
export function calendarDisplayedTitle(event: Pick<CalendarOccurrence, 'title' | 'displayTitle'>): string { return event.displayTitle ?? event.title; }
