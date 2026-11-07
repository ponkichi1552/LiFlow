import type { CalendarEvent as CommonCalendarEvent, CalendarOccurrence as CommonCalendarOccurrence } from '../../domain/calendar/events.ts';
// Shared calendar value contract; no account, database or private availability state.
export * from '../../domain/calendar/events.ts';

/** Source classification belongs only to the private Google projection. */
export interface CalendarEvent extends CommonCalendarEvent { holiday?: boolean }
export interface CalendarOccurrence extends CommonCalendarOccurrence { holiday?: boolean; original?: CalendarOccurrence }
