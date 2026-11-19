import type { CalendarEvent as CommonCalendarEvent, CalendarOccurrence as CommonCalendarOccurrence } from '../../domain/calendar/events.ts';
import { newEventDraft } from '../../domain/calendar/events.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
// Shared calendar value contract; no account, database or private availability state.
export * from '../../domain/calendar/events.ts';
export const UNCATEGORIZED_CALENDAR_CATEGORY = { id: 'uncategorized', name: '未分類', color: '#718299', revision: 1 } as const;

export function newAppointmentValue(date: LocalDate, timeZone: string) {
  return { ...newEventDraft(date, timeZone), categoryId: UNCATEGORIZED_CALENDAR_CATEGORY.id };
}

/** Source classification belongs only to the private Google projection. */
export interface CalendarEvent extends CommonCalendarEvent { holiday?: boolean }
export interface CalendarOccurrence extends CommonCalendarOccurrence {
  holiday?: boolean; original?: CalendarOccurrence;
  /** Ephemeral presentation only. Saved and editable titles remain verbatim. */
  displayTitle?: string;
}
