import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import type { CalendarEvent, CalendarException, CalendarOccurrence } from './events';
import { calendarEventAnchors, calendarEventsInTimeZone, calendarMonth, compareOccurrences, isCalendarAnchor } from './events.ts';
import type { LocalDate } from '../../domain/shared/types';
import { addDays, daysBetween, localDateFromDate } from '../../domain/scheduling/local-date.ts';
import { normalizeSearchText, searchTerms } from '../../domain/search/normalized-search.ts';
import { projectPrivateCalendarEvents } from './private-event-projection.ts';
import { calendarTitleDisplay } from './title-display.ts';

const normalize = normalizeSearchText;
export interface CalendarSearchEntry { key: string; text: string; draft: CalendarEditorDraft }
export interface CalendarSearchDestination { date: LocalDate; minute: number | null; anchorDate?: LocalDate; choreKey?: string; timedChoreId?: string }
export interface CalendarSearchChore { key: string; title: string; date: LocalDate; source: 'personal' | 'shared'; minute?: number | null; timedChoreId?: string }
export type CalendarSearchResult = CalendarSearchEntry | CalendarSearchChore;
export function searchCalendarWithChores(index: readonly CalendarSearchEntry[], chores: readonly CalendarSearchChore[], query: string, limit = 60, focus: LocalDate = localDateFromDate(new Date())) {
  const terms = searchTerms(query);
  if (!terms.length) return { matches: [] as CalendarSearchResult[], more: false };
  const rows: CalendarSearchResult[] = [...index.filter(row => terms.every(term => row.text.includes(term))),
    ...new Map(chores.filter(row => terms.every(term => normalize(row.title).includes(term))).map(row => [row.key, row])).values()];
  const date = (row: CalendarSearchResult) => {
    if (!('draft' in row)) return row.date;
    const value = row.draft.value;
    // An active series represents its nearby round. Expanding it is deferred
    // until selection, so typing never projects years of recurring calendars.
    if (row.draft.scope === 'series' && value.recurrence !== 'none' && value.startDate <= focus) return value.untilDate && value.untilDate < focus ? value.untilDate : focus;
    return value.startDate;
  };
  const at = Date.parse(focus);
  const ranked = rows.map(row => { const day = date(row); return { row, day, distance: Math.abs(Date.parse(day) - at) }; });
  ranked.sort((a, b) => a.distance - b.distance || b.day.localeCompare(a.day) || a.row.key.localeCompare(b.row.key));
  return { matches: ranked.slice(0, limit).map(value => value.row), more: ranked.length > limit };
}

/** Index only this binding's visible records, without fetching accounts or expanding recurring years. */
export function calendarSearchIndex(events: readonly CalendarEvent[], exceptions: readonly CalendarException[], referenceDate: LocalDate = localDateFromDate(new Date())): CalendarSearchEntry[] {
  const appointments = events.filter(event => !event.holiday);
  const byId = new Map(appointments.map(event => [event.id, event]));
  const cancelled = new Map<string, Set<LocalDate>>();
  for (const exception of exceptions) if (!exception.override) {
    const dates = cancelled.get(exception.eventId) ?? new Set<LocalDate>();
    dates.add(exception.anchorDate);
    cancelled.set(exception.eventId, dates);
  }
  const text = (value: CalendarEvent | CalendarEditorDraft['value']) => normalize(`${value.title}\n${calendarTitleDisplay.label(value.title, referenceDate)}\n${value.location}\n${value.notes}`);
  const visibleSeries = appointments.filter(event => {
    const hidden = cancelled.get(event.id);
    if (!hidden || event.recurrence !== 'none' && !event.untilDate) return true;
    if (!hidden.has(event.startDate) && isCalendarAnchor(event, event.startDate)) return true;
    return seekSearchOccurrence(event, event.startDate, 1, anchor => hidden.has(anchor) ? undefined : true);
  });
  const rows: CalendarSearchEntry[] = visibleSeries.map(event => ({ key: `series:${event.id}`, text: text(event),
    draft: { eventId: event.id, revision: event.revision, exceptionRevision: 0, anchorDate: null, scope: 'series', value: event } }));
  for (const exception of exceptions) {
    const event = byId.get(exception.eventId); if (!event || !exception.override || !exception.detached && !isCalendarAnchor(event, exception.anchorDate)) continue;
    const value = exception.override;
    rows.push({ key: `one:${event.id}:${exception.anchorDate}`, text: text(value),
      draft: { eventId: event.id, revision: event.revision, exceptionRevision: exception.revision, anchorDate: exception.anchorDate, scope: 'one', value } });
  }
  return rows.sort((a, b) => b.draft.value.startDate.localeCompare(a.draft.value.startDate) || a.key.localeCompare(b.key));
}
export function searchCalendarIndex(index: readonly CalendarSearchEntry[], query: string, limit = 60) {
  const terms = searchTerms(query); if (!terms.length) return { matches: [], more: false };
  const matches: CalendarSearchEntry[] = [];
  for (const row of index) if (terms.every(term => row.text.includes(term))) {
    if (matches.length >= limit) return { matches, more: true }; matches.push(row);
  }
  return { matches: matches.sort((a, b) => b.draft.value.startDate.localeCompare(a.draft.value.startDate) || a.key.localeCompare(b.key)), more: false };
}

const firstDate = '0100-01-01' as LocalDate;
const lastDate = '9999-12-31' as LocalDate;
const earlier = (a: LocalDate, b: LocalDate) => a < b ? a : b;
const later = (a: LocalDate, b: LocalDate) => a > b ? a : b;
function boundedShift(day: LocalDate, amount: number) {
  const next = addDays(day, amount);
  return next.startsWith('+') ? lastDate : later(firstDate, next);
}
const monthIndex = (date: LocalDate) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
type SearchOccurrence = { source: CalendarOccurrence; visible: CalendarOccurrence };

function seekSearchOccurrence<T>(event: CalendarEvent, start: LocalDate, direction: 1 | -1, get: (date: LocalDate) => T | undefined) {
  const upper = event.recurrence === 'none' ? event.startDate : event.untilDate ?? lastDate;
  const recurrence = event.recurrence === 'custom' ? event.customRecurrence : undefined;
  const months = recurrence?.unit === 'year' ? recurrence.interval * 12 : recurrence?.unit === 'month' ? recurrence.interval : 0;
  const origin = monthIndex(event.startDate);
  // Seeking anchors needs the rule and its phase, independently of its duration.
  const anchorsOnly = { ...event, endDate: event.startDate };
  let cursor = direction === 1 ? later(start, event.startDate) : earlier(start, upper);
  while (cursor >= event.startDate && cursor <= upper) {
    let from = direction === 1 ? cursor : later(event.startDate, boundedShift(cursor, -365));
    let through = direction === -1 ? cursor : earlier(upper, boundedShift(cursor, 365));
    if (months > 12) {
      const position = monthIndex(cursor);
      const cycle = (position - origin) / months;
      const index = origin + (direction === 1 ? Math.ceil(cycle) : Math.floor(cycle)) * months;
      if (index < origin || index > monthIndex(upper)) break;
      const first = calendarMonth(event.startDate, index - origin);
      const end = first === '9999-12-01' ? lastDate : addDays(calendarMonth(first, 1), -1);
      from = direction === 1 ? later(first, cursor) : later(first, event.startDate);
      through = direction === -1 ? earlier(end, cursor) : earlier(end, upper);
    }
    if (from <= through) {
      const anchors = calendarEventAnchors(anchorsOnly, from, through);
      if (direction === -1) anchors.reverse();
      for (const anchor of anchors) {
        const occurrence = get(anchor);
        if (occurrence) return occurrence;
      }
    }
    if (through >= upper && direction === 1 || from <= event.startDate && direction === -1) break;
    cursor = addDays(direction === 1 ? through : from, direction);
  }
}

function resolveSearchOccurrence(draft: CalendarEditorDraft, events: readonly CalendarEvent[], exceptions: readonly CalendarException[], focus: LocalDate,
  displayTimeZone?: string): SearchOccurrence | undefined {
  const event = events.find(row => row.id === draft.eventId && !row.holiday);
  if (!event) return undefined;
  const related = exceptions.filter(row => row.eventId === event.id);
  const duration = daysBetween(event.startDate, event.endDate);
  const occurrence = (anchorDate: LocalDate, exception?: CalendarException) => {
    const value = exception?.override ?? { ...event, startDate: anchorDate, endDate: addDays(anchorDate, duration) };
    const [projected] = projectPrivateCalendarEvents([{ ...value, id: event.id, revision: event.revision, recurrence: 'none', untilDate: null }], [], value.startDate, value.startDate);
    const source = { ...projected, id: `${event.id}:${anchorDate}`, anchorDate, exceptionRevision: exception?.revision ?? 0 };
    return { source, visible: calendarEventsInTimeZone([source], displayTimeZone ?? event.timeZone)[0] };
  };
  const validOverride = (row: CalendarException) => row.override && (row.detached || isCalendarAnchor(event, row.anchorDate));
  if (draft.scope === 'one') {
    const selected = related.find(row => row.anchorDate === draft.anchorDate);
    return selected && validOverride(selected) ? occurrence(selected.anchorDate, selected) : undefined;
  }
  const onOrAfter = (candidate: SearchOccurrence) => candidate.visible.endDate > focus || candidate.visible.endDate === focus
    && (candidate.visible.allDay || candidate.visible.endMinute > 0);
  const byStart = (a: SearchOccurrence, b: SearchOccurrence) => compareOccurrences(a.visible, b.visible);
  const overrides = related.filter(validOverride).map(row => occurrence(row.anchorDate, row)).sort(byStart);
  const skipped = new Set(related.map(row => row.anchorDate));
  const normal = (future: boolean) => (anchor: LocalDate) => {
    if (skipped.has(anchor)) return undefined;
    const row = occurrence(anchor);
    return onOrAfter(row) === future ? row : undefined;
  };
  const padding = !event.allDay && displayTimeZone && displayTimeZone !== event.timeZone ? 2 : 0;
  const nextNormal = seekSearchOccurrence(event, boundedShift(focus, -duration - padding), 1, normal(true));
  const nextOverride = overrides.find(onOrAfter);
  if (nextNormal && nextOverride) return byStart(nextNormal, nextOverride) <= 0 ? nextNormal : nextOverride;
  if (nextNormal || nextOverride) return nextNormal ?? nextOverride;
  const previousNormal = seekSearchOccurrence(event, boundedShift(focus, padding), -1, normal(false));
  const previousOverride = overrides.at(-1);
  if (previousNormal && previousOverride) return byStart(previousNormal, previousOverride) >= 0 ? previousNormal : previousOverride;
  return previousNormal ?? previousOverride;
}

/** Resolve only the selected series, with the same stable anchor as the displayed card. */
export function calendarSearchSelection(draft: CalendarEditorDraft, events: readonly CalendarEvent[], exceptions: readonly CalendarException[], focus: LocalDate): CalendarEditorDraft | null {
  const selected = resolveSearchOccurrence(draft, events, exceptions, focus)?.source;
  return selected ? { ...draft, anchorDate: selected.anchorDate, exceptionRevision: selected.exceptionRevision, scope: 'one', value: selected } : null;
}

/** Search locates the visible occurrence; editing remains a separate calendar action. */
export function calendarSearchDestination(draft: CalendarEditorDraft, events: readonly CalendarEvent[], exceptions: readonly CalendarException[], focus: LocalDate, timeZone: string): CalendarSearchDestination {
  const selected = resolveSearchOccurrence(draft, events, exceptions, focus, timeZone);
  if (!selected) throw new Error('表示できる予定がありません。');
  return { date: selected.visible.startDate, minute: selected.visible.allDay ? null : selected.visible.startMinute, anchorDate: selected.source.anchorDate };
}
