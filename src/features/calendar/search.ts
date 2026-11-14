import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import type { CalendarEvent, CalendarException } from './events';
import { calendarEventsInTimeZone, isCalendarAnchor } from './events.ts';
import type { LocalDate } from '../../domain/shared/types';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { projectPrivateCalendarEvents } from './private-event-projection.ts';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja').replace(/[ァ-ヶ]/g, letter => String.fromCharCode(letter.charCodeAt(0) - 0x60));
export interface CalendarSearchEntry { key: string; text: string; draft: CalendarEditorDraft }
export interface CalendarSearchDestination { date: LocalDate; minute: number | null; choreKey?: string }
export interface CalendarSearchChore { key: string; title: string; date: LocalDate; source: 'personal' | 'shared'; minute?: number | null }
export type CalendarSearchResult = CalendarSearchEntry | CalendarSearchChore;
export function searchCalendarWithChores(index: readonly CalendarSearchEntry[], chores: readonly CalendarSearchChore[], query: string, limit = 60) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { matches: [] as CalendarSearchResult[], more: false };
  const rows: CalendarSearchResult[] = [...index.filter(row => terms.every(term => row.text.includes(term))),
    ...new Map(chores.filter(row => terms.every(term => normalize(row.title).includes(term))).map(row => [row.key, row])).values()];
  const date = (row: CalendarSearchResult) => 'draft' in row ? row.draft.value.startDate : row.date;
  rows.sort((a, b) => date(b).localeCompare(date(a)) || a.key.localeCompare(b.key));
  return { matches: rows.slice(0, limit), more: rows.length > limit };
}

/** Index only this binding's visible records, without fetching accounts or expanding recurring years. */
export function calendarSearchIndex(events: readonly CalendarEvent[], exceptions: readonly CalendarException[]): CalendarSearchEntry[] {
  const appointments = events.filter(event => !event.holiday);
  const byId = new Map(appointments.map(event => [event.id, event]));
  const rows: CalendarSearchEntry[] = appointments.map(event => ({ key: `series:${event.id}`, text: normalize(`${event.title}\n${event.location}\n${event.notes}`),
    draft: { eventId: event.id, revision: event.revision, exceptionRevision: 0, anchorDate: null, scope: 'series', value: event } }));
  for (const exception of exceptions) {
    const event = byId.get(exception.eventId); if (!event || !exception.override || !isCalendarAnchor(event, exception.anchorDate)) continue;
    const value = exception.override;
    rows.push({ key: `one:${event.id}:${exception.anchorDate}`, text: normalize(`${value.title}\n${value.location}\n${value.notes}`),
      draft: { eventId: event.id, revision: event.revision, exceptionRevision: exception.revision, anchorDate: exception.anchorDate, scope: 'one', value } });
  }
  return rows.sort((a, b) => b.draft.value.startDate.localeCompare(a.draft.value.startDate) || a.key.localeCompare(b.key));
}
export function searchCalendarIndex(index: readonly CalendarSearchEntry[], query: string, limit = 60) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean); if (!terms.length) return { matches: [], more: false };
  const matches: CalendarSearchEntry[] = [];
  for (const row of index) if (terms.every(term => row.text.includes(term))) {
    if (matches.length >= limit) return { matches, more: true }; matches.push(row);
  }
  return { matches: matches.sort((a, b) => b.draft.value.startDate.localeCompare(a.draft.value.startDate) || a.key.localeCompare(b.key)), more: false };
}

/** Resolve just the selected series, rather than expanding every search match while typing. */
export function calendarSearchSelection(draft: CalendarEditorDraft, events: readonly CalendarEvent[], exceptions: readonly CalendarException[], focus: LocalDate): CalendarEditorDraft {
  if (draft.scope === 'one' || draft.value.recurrence === 'none') return draft;
  const event = events.find(row => row.id === draft.eventId); if (!event) return draft;
  const related = exceptions.filter(row => row.eventId === event.id);
  const shift = (day: LocalDate, amount: number) => { try { return addDays(day, amount); } catch { return amount < 0 ? '1900-01-01' as LocalDate : '2199-12-31' as LocalDate; } };
  let occurrence;
  if (!event.untilDate || event.untilDate >= focus) {
    for (const days of [0, 14, 62, 366]) {
      occurrence = projectPrivateCalendarEvents([event], related, focus, shift(focus, days))[0]; if (occurrence) break;
    }
    // Leap-day and sparse custom rules can have no occurrence in the first year.
    for (let year = 1; !occurrence && year < 8; year++) {
      const from = shift(focus, year * 366); const through = shift(from, 366);
      occurrence = projectPrivateCalendarEvents([event], related, from, through)[0];
    }
  }
  if (!occurrence) {
    const through = event.untilDate && event.untilDate < focus ? event.untilDate : focus;
    occurrence = projectPrivateCalendarEvents([event], related, shift(through, -366), through).at(-1);
  }
  if (!occurrence) occurrence = projectPrivateCalendarEvents([event], related, event.startDate, event.startDate)[0];
  return occurrence ? { ...draft, anchorDate: occurrence.anchorDate, exceptionRevision: occurrence.exceptionRevision, scope: 'one',
    value: { ...occurrence, recurrence: 'none', untilDate: null } } : draft;
}

/** Search locates the visible occurrence; editing remains a separate calendar action. */
export function calendarSearchDestination(draft: CalendarEditorDraft, events: readonly CalendarEvent[], exceptions: readonly CalendarException[], focus: LocalDate, timeZone: string): CalendarSearchDestination {
  const selected = calendarSearchSelection(draft, events, exceptions, focus);
  const eventId = selected.eventId ?? 'search';
  const [visible] = calendarEventsInTimeZone([{ ...selected.value, id: eventId, eventId, anchorDate: selected.anchorDate ?? selected.value.startDate,
    eventRevision: selected.revision, exceptionRevision: selected.exceptionRevision }], timeZone);
  return { date: visible.startDate, minute: visible.allDay ? null : visible.startMinute };
}
