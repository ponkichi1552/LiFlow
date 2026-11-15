import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { addDays, daysBetween } from '../../domain/scheduling/local-date.ts';
import { MONTH_HEADING_HEIGHT, type CalendarMonthRow } from './month-rows.ts';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import { moveCalendarStart } from './event-editing.ts';
import { newEventDraft } from './events.ts';
import type { CalendarEvent, CalendarOccurrence, EventDraft } from './events.ts';
import { calendarFutureBase } from '../../domain/calendar/future-series.ts';

export const CALENDAR_DRAG_HOLD_MS = 250;
export type CalendarDropTarget = { day: LocalDate; minute: number };
export interface CalendarMonthViewport { x: number; y: number; width: number; height: number }

/** Resolve real month cells, including split boundary weeks and the current scroll offset. */
export function calendarMonthDragTarget(event: Pick<CalendarOccurrence, 'startDate' | 'startMinute'>, cellDay: LocalDate,
  rows: readonly CalendarMonthRow[], viewport: CalendarMonthViewport | null, offset: number, x: number, y: number): CalendarDropTarget | null {
  if (!viewport || ![viewport.x, viewport.y, viewport.width, viewport.height, offset, x, y].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0 || x < viewport.x || x >= viewport.x + viewport.width || y < viewport.y || y >= viewport.y + viewport.height) return null;
  const contentY = y - viewport.y + offset;
  let low = 0; let high = rows.length - 1;
  while (low <= high) {
    const index = (low + high) >>> 1; const row = rows[index];
    if (contentY < row.offset) high = index - 1;
    else if (contentY >= row.offset + row.height) low = index + 1;
    else {
      if (row.monthStartColumn !== null && contentY < row.offset + MONTH_HEADING_HEIGHT) return null;
      const target = row.days[Math.floor((x - viewport.x) / viewport.width * 7)];
      return target ? { day: addDays(event.startDate, daysBetween(cellDay, target)), minute: event.startMinute } : null;
    }
  }
  return null;
}

/** Copy only form fields; source IDs, Google links and shared submission proofs never follow a copy. */
export function calendarEventValue(value: EventDraft): EventDraft {
  return { title: value.title, location: value.location, notes: value.notes, startDate: value.startDate, endDate: value.endDate,
    startMinute: value.startMinute, endMinute: value.endMinute, allDay: value.allDay, timeZone: value.timeZone,
    recurrence: value.recurrence, untilDate: value.untilDate, categoryId: value.categoryId, birthday: value.birthday,
    ...(value.customRecurrence ? { customRecurrence: JSON.parse(JSON.stringify(value.customRecurrence)) } : {}) };
}

export function duplicateCalendarDraft(source: CalendarEditorDraft): CalendarEditorDraft {
  return { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series',
    ...(source.audience ? { audience: source.audience } : {}), ...(source.audience === 'group' ? { groupId: source.groupId } : {}),
    ...(source.editorCategory ? { editorCategory: { ...source.editorCategory } } : {}),
    value: { ...calendarEventValue(source.value), recurrence: 'none', untilDate: null, customRecurrence: undefined, birthday: false } };
}

export function calendarOccurrenceDraft(event: CalendarOccurrence, recurring: boolean): CalendarEditorDraft {
  const source = event.original ?? event;
  return { eventId: source.eventId, anchorDate: source.anchorDate, revision: source.eventRevision,
    // Exception bodies are single-event values even when their parent still repeats.
    exceptionRevision: source.exceptionRevision, scope: recurring ? 'one' : 'series',
    value: { ...calendarEventValue(source), recurrence: 'none', untilDate: null, customRecurrence: undefined } };
}

export function calendarSlotDraft(day: LocalDate, minute: number, timeZone: string): CalendarEditorDraft {
  const startMinute = Math.max(0, Math.min(1435, Math.round(minute / 5) * 5));
  return { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series',
    value: moveCalendarStart(newEventDraft(day, timeZone), { startMinute }) };
}

export function calendarDragTarget(start: { day: LocalDate; minute: number }, days: readonly LocalDate[], columnWidth: number,
  hourHeight: number, dx: number, dy: number) {
  if (![columnWidth, hourHeight, dx, dy].every(Number.isFinite) || columnWidth <= 0 || hourHeight <= 0) return null;
  const index = days.indexOf(start.day); if (index < 0) return null;
  return { day: days[Math.max(0, Math.min(days.length - 1, index + Math.round(dx / columnWidth)))],
    minute: Math.max(0, Math.min(1435, Math.round((start.minute + dy / hourHeight * 60) / 5) * 5)) };
}

/** Convert the displayed drop point back to the source zone before preserving its real duration. */
export function calendarMovedDraft(draft: CalendarEditorDraft, target: { day: LocalDate; minute: number }, displayTimeZone: string) {
  if (draft.value.allDay) return { ...draft, value: moveCalendarStart(draft.value, { startDate: target.day }) };
  const candidates = v2WallTimeCandidates({ date: target.day, hour: Math.floor(target.minute / 60), minute: target.minute % 60, timeZone: displayTimeZone });
  if (candidates.length !== 1) throw new Error('この時刻は夏時間で重複するか存在しません。別の時刻へ移動してください。');
  const source = pinnedClockAt(candidates[0], draft.value.timeZone);
  return { ...draft, value: moveCalendarStart(draft.value, { startDate: source.date, startMinute: source.minute }) };
}

/** Apply the selected occurrence's displacement to its parent, retaining the repeating rule. */
export function calendarSeriesMovedDraft(draft: CalendarEditorDraft, series: CalendarEvent, target: CalendarDropTarget, displayTimeZone: string) {
  const moved = calendarMovedDraft(draft, target, displayTimeZone);
  const delta = daysBetween(draft.value.startDate, moved.value.startDate) * 1440 + moved.value.startMinute - draft.value.startMinute;
  const total = series.startMinute + delta; const dayShift = Math.floor(total / 1440);
  const value = moveCalendarStart(calendarEventValue(series), { startDate: addDays(series.startDate, dayShift), startMinute: (total % 1440 + 1440) % 1440 });
  if (value.untilDate) value.untilDate = addDays(value.untilDate, dayShift);
  const rule = value.customRecurrence;
  if (rule?.unit === 'week') value.customRecurrence = { ...rule, weekdays: rule.weekdays.map(day => (day + dayShift % 7 + 7) % 7).sort((a, b) => a - b) };
  if (rule?.unit === 'month' && rule.on === 'weekday') value.customRecurrence = { ...rule, weekday: new Date(`${value.startDate}T00:00:00Z`).getUTCDay(),
    ordinal: rule.ordinal === -1 ? -1 : Math.min(5, Math.ceil(Number(value.startDate.slice(-2)) / 7)) as 1 | 2 | 3 | 4 | 5 };
  return { ...draft, scope: 'series' as const, anchorDate: null, exceptionRevision: 0, value };
}

/** Use the selected original slot as the future series origin, retaining individual edits. */
export function calendarFutureMovedDraft(draft: CalendarEditorDraft, series: CalendarEvent, target: CalendarDropTarget, displayTimeZone: string): CalendarEditorDraft {
  if (!draft.anchorDate) throw new Error('変更する繰り返しの回を選び直してください。');
  const base = { ...calendarFutureBase(series, draft.anchorDate), id: series.id, revision: series.revision };
  const moved = calendarSeriesMovedDraft(draft, base, target, displayTimeZone);
  return { ...moved, scope: 'future', anchorDate: draft.anchorDate, exceptionRevision: draft.exceptionRevision };
}
