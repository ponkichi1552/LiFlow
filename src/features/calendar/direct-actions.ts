import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { addDays, daysBetween } from '../../domain/scheduling/local-date.ts';
import { MONTH_HEADING_HEIGHT, type CalendarMonthRow } from './month-rows.ts';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import { moveCalendarStart } from './event-editing.ts';
import { isCalendarAnchor, newAppointmentValue, validateEventDraft } from './events.ts';
import type { CalendarEvent, CalendarOccurrence, EventDraft } from './events.ts';
import { calendarFutureBase } from '../../domain/calendar/future-series.ts';
import { rebasedCalendarExceptionDate } from '../../domain/calendar/exception-slots.ts';

export const CALENDAR_DRAG_HOLD_MS = 250;
export class CalendarMoveScopeRequiredError extends Error {
  readonly scope = 'one' as const;
  constructor(message: string) { super(message); this.name = 'CalendarMoveScopeRequiredError'; }
}
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
    ...(source.audience ? { audience: source.audience } : {}), ...(source.audience === 'group' ? { groupId: source.groupId, ownerScope: source.ownerScope } : {}),
    ...(source.editorCategory ? { editorCategory: { ...source.editorCategory } } : {}),
    value: { ...calendarEventValue(source.value), recurrence: 'none', untilDate: null, customRecurrence: undefined, birthday: false } };
}

export function calendarOccurrenceDraft(event: CalendarOccurrence, recurring: boolean): CalendarEditorDraft {
  const source = event.original ?? event;
  return { eventId: source.eventId, anchorDate: source.anchorDate, revision: source.eventRevision,
    // Exception bodies are single-event values even when their parent still repeats.
    exceptionRevision: source.exceptionRevision, scope: recurring || source.exceptionRevision > 0 ? 'one' : 'series',
    value: { ...calendarEventValue(source), recurrence: 'none', untilDate: null, customRecurrence: undefined } };
}

export function calendarDraftScopeValue(scope: CalendarEditorDraft['scope'], series: CalendarEvent, anchor: LocalDate, override?: EventDraft | null): EventDraft {
  if (scope === 'series') return calendarEventValue(series);
  if (scope === 'future') return calendarFutureBase(series, anchor);
  const occurrence = override ?? { ...series, startDate: anchor, endDate: addDays(anchor, daysBetween(series.startDate, series.endDate)) };
  return { ...calendarEventValue(occurrence), recurrence: 'none', untilDate: null, customRecurrence: undefined };
}

const mergeFields = [
  { label: '予定名', fields: ['title'] },
  { label: '場所', fields: ['location'] },
  { label: 'メモ', fields: ['notes'] },
  { label: '日時', fields: ['startDate', 'endDate', 'startMinute', 'endMinute', 'allDay', 'timeZone'] },
  { label: '繰り返し', fields: ['recurrence', 'untilDate', 'customRecurrence'] },
  { label: '分類', fields: ['categoryId'] },
] as const;

/** Keep related clocks and recurrence fields together when merging concurrent changes. */
export function rebaseCalendarEventInput(current: EventDraft, latest: EventDraft, base?: EventDraft) {
  const keepInput = { ...latest };
  const useLatest = { ...latest };
  const overlaps: (typeof mergeFields[number]['label'])[] = [];
  for (const { label, fields } of mergeFields) {
    const equals = (left: EventDraft, right: EventDraft) => fields.every(field => JSON.stringify(left[field]) === JSON.stringify(right[field]));
    if (equals(current, latest) || base && equals(current, base)) continue;
    const conflicted = !base || !equals(latest, base);
    if (conflicted) overlaps.push(label);
    for (const field of fields) {
      Object.assign(keepInput, { [field]: current[field] });
      if (!conflicted) Object.assign(useLatest, { [field]: current[field] });
    }
  }
  return { keepInput, useLatest, overlaps };
}

/** Compare with the saved series or occurrence so edits persist even after reopening a draft. */
export function changeCalendarDraftScope(draft: CalendarEditorDraft, scope: CalendarEditorDraft['scope'], series: CalendarEvent, override: EventDraft | null | undefined, editedFields: Set<keyof EventDraft>): CalendarEditorDraft {
  const anchor = draft.anchorDate;
  if (!anchor || draft.scope === scope) return draft;
  const previous = calendarDraftScopeValue(draft.scope, series, anchor, override);
  const next = calendarDraftScopeValue(scope, series, anchor, override), current = calendarEventValue(draft.value);
  for (const key of Object.keys({ ...previous, ...current }) as (keyof EventDraft)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(previous[key])) editedFields.add(key);
  }
  // An explicit edit can match another scope's baseline and still belongs to the draft.
  for (const key of editedFields) Object.assign(next, { [key]: current[key] });
  return { ...draft, scope, value: next };
}

export function calendarSlotDraft(day: LocalDate, minute: number, timeZone: string): CalendarEditorDraft {
  const startMinute = Math.max(0, Math.min(1435, Math.round(minute / 5) * 5));
  return { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series',
    value: moveCalendarStart(newAppointmentValue(day, timeZone), { startMinute }) };
}

export type CalendarDragColumn = { inset: number; minimum: number };

export function calendarDragTarget(start: { day: LocalDate; minute: number }, days: readonly LocalDate[], columnWidth: number,
  hourHeight: number, dx: number, dy: number, columns?: readonly CalendarDragColumn[]) {
  if (![columnWidth, hourHeight, dx, dy].every(Number.isFinite) || columnWidth <= 0 || hourHeight <= 0) return null;
  const index = days.indexOf(start.day); if (index < 0) return null;
  const targetIndex = Math.max(0, Math.min(days.length - 1, index + Math.round(dx / columnWidth)));
  const targetColumn = columns?.[targetIndex];
  const rawDelta = (dy + (columns?.[index]?.inset ?? 0) - (targetColumn?.inset ?? 0)) / hourHeight * 60;
  const minuteDelta = Math.sign(rawDelta) * Math.round(Math.abs(rawDelta) / 5) * 5;
  const movedMinute = start.minute + minuteDelta;
  const minute = minuteDelta === 0 || minuteDelta > 0 && start.minute > 1435
    ? start.minute : Math.max(0, Math.min(1435, movedMinute));
  if (targetColumn && Math.min(start.minute + rawDelta, minute) / 60 * hourHeight < targetColumn.minimum) return null;
  // Snap the gesture delta, not the saved clock. A no-op drag and a day-only
  // move must preserve imported clocks such as 09:02 exactly.
  return { day: days[targetIndex], minute };
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
  if (draft.exceptionRevision > 0) throw new CalendarMoveScopeRequiredError('個別に変更した回は「この予定だけ」で移動できます。');
  const moved = calendarMovedDraft(draft, target, displayTimeZone);
  const delta = daysBetween(draft.value.startDate, moved.value.startDate) * 1440 + moved.value.startMinute - draft.value.startMinute;
  const total = series.startMinute + delta; const dayShift = Math.floor(total / 1440);
  const value = moveCalendarStart(calendarEventValue(series), { startDate: addDays(series.startDate, dayShift), startMinute: (total % 1440 + 1440) % 1440 });
  if (value.untilDate) value.untilDate = addDays(value.untilDate, dayShift);
  const rule = value.customRecurrence;
  if (rule?.unit === 'week') {
    const shifted = (day: number) => (day + dayShift % 7 + 7) % 7;
    const start = new Date(`${series.startDate}T00:00:00Z`).getUTCDay(), nextStart = new Date(`${value.startDate}T00:00:00Z`).getUTCDay();
    const cycle = rule.interval * 7, first = (day: number, from: number) => (day - from + cycle) % cycle;
    const through = series.untilDate ? daysBetween(series.startDate, series.untilDate) : Infinity;
    // Rotating weekdays across different Sunday weeks cannot retain a multiweek phase.
    if (rule.interval > 1 && rule.weekdays.some(day => {
      const before = first(day, start), after = first(shifted(day), nextStart);
      return before !== after && Math.min(before, after) <= through;
    })) throw new CalendarMoveScopeRequiredError('この移動では繰り返しの間隔を保てません。「この予定だけ」を選んでください。');
    value.customRecurrence = { ...rule, weekdays: rule.weekdays.map(shifted).sort((a, b) => a - b) };
  }
  if (rule?.unit === 'month' && rule.on === 'weekday' && dayShift !== 0) {
    const target = new Date(`${moved.value.startDate}T00:00:00Z`);
    const day = target.getUTCDate(); const weekday = target.getUTCDay();
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const rank = Math.ceil(day / 7) as 1 | 2 | 3 | 4 | 5;
    const previousOrdinalStillFits = rule.ordinal === -1 ? day + 7 > lastDay : rank === rule.ordinal;
    const ordinal = previousOrdinalStillFits ? rule.ordinal : rank;
    // The selected occurrence, not the series' original lower-bound date,
    // identifies the ordinal weekday rule to carry through a whole-series move.
    value.customRecurrence = { ...rule, weekday, ordinal };
  }
  if (rule?.unit === 'month' && rule.on === 'dates' && dayShift) {
    const days = rule.days.map(day => day + dayShift);
    value.customRecurrence = { ...rule, days };
    // A fixed set of month days cannot express every displacement across a
    // short month. Never accept a drop that loses the occurrence being moved.
    if (days.some(day => day < 1 || day > 31) || !isCalendarAnchor({ ...value, id: series.id, revision: series.revision }, moved.value.startDate)) {
      throw new CalendarMoveScopeRequiredError('月をまたぐ複数日付の移動は「この予定だけ」を選ぶか、繰り返す日付を変更してください。');
    }
  }
  const nextSeries = { ...value, id: series.id, revision: series.revision };
  if (!isCalendarAnchor(nextSeries, moved.value.startDate)) {
    throw new CalendarMoveScopeRequiredError('移動先がこの繰り返しに含まれません。「この予定だけ」を選んでください。');
  }
  const selectedSlot = draft.anchorDate ?? draft.value.startDate;
  if (rebasedCalendarExceptionDate(series, nextSeries, selectedSlot) !== moved.value.startDate) {
    throw new CalendarMoveScopeRequiredError('移動先では個別の予定との対応を保てません。「この予定だけ」を選んでください。');
  }
  try { validateEventDraft(value); }
  catch { throw new CalendarMoveScopeRequiredError('この移動では繰り返しの日時を保てません。'); }
  return { ...draft, scope: 'series' as const, anchorDate: null, exceptionRevision: 0, value };
}

/** Use the selected original slot as the future series origin, retaining individual edits. */
export function calendarFutureMovedDraft(draft: CalendarEditorDraft, series: CalendarEvent, target: CalendarDropTarget, displayTimeZone: string): CalendarEditorDraft {
  if (!draft.anchorDate) throw new Error('変更する繰り返しの回を選び直してください。');
  const base = { ...calendarFutureBase(series, draft.anchorDate), id: series.id, revision: series.revision };
  const moved = calendarSeriesMovedDraft(draft, base, target, displayTimeZone);
  return { ...moved, scope: 'future', anchorDate: draft.anchorDate, exceptionRevision: draft.exceptionRevision };
}
