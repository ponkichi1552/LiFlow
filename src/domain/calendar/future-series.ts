import { addDays, daysBetween } from '../scheduling/local-date.ts';
import type { LocalDate } from '../shared/types';
import { isCalendarAnchor, validateEventDraft, type CalendarEvent, type CalendarException, type EventDraft } from './events.ts';
import { rebasedCalendarExceptionDates } from './exception-slots.ts';

/** The unchanged series, beginning at the selected original occurrence slot. */
export function calendarFutureBase(series: CalendarEvent, anchor: LocalDate): EventDraft {
  if (series.recurrence === 'none' || series.birthday || !isCalendarAnchor(series, anchor)) throw new Error('変更する繰り返しの回を選び直してください。');
  // Keep the original wall clock in the editable baseline even when this
  // occurrence falls in a DST gap/fold. The submitted next series is validated
  // strictly after the user has changed the clock.
  return validateEventDraft({ ...series, startDate: anchor, endDate: addDays(anchor, daysBetween(series.startDate, series.endDate)) }, { allowInvalidWallTime: true });
}
export function splitCalendarFuture(series: CalendarEvent, anchor: LocalDate, edited: EventDraft, exceptions: readonly CalendarException[]) {
  const base = { ...calendarFutureBase(series, anchor), id: series.id, revision: series.revision };
  const next = { ...validateEventDraft(edited), id: series.id, revision: series.revision + 1 };
  if (next.birthday) throw new Error('誕生日の変更範囲を確認してください。');
  const past = anchor === series.startDate ? null : validateEventDraft({ ...series, untilDate: addDays(anchor, -1) });
  const previous = exceptions.filter(row => row.eventId === series.id && row.anchorDate < anchor && past);
  const followingSource = exceptions.filter(row => row.eventId === series.id && (row.anchorDate >= anchor || !past));
  const followingDates = rebasedCalendarExceptionDates(base, next, followingSource.map(row => row.anchorDate));
  const following = followingSource.map((row, index) => ({ ...row, originalAnchorDate: row.anchorDate,
    anchorDate: followingDates[index], detached: !isCalendarAnchor(next, followingDates[index]) }));
  if (new Set(following.map(row => row.anchorDate)).size !== following.length) throw new Error('個別変更の日付が重なります。予定を確認してください。');
  return { past, next: validateEventDraft(next), previous, following, base };
}

/** Existing shared payloads can retain detached edits after a series changes. */
export function calendarFutureSeed(value: EventDraft, anchors: readonly LocalDate[]): EventDraft {
  const event = { ...value, id: 'seed', revision: 1 };
  if (anchors.every(anchor => isCalendarAnchor(event, anchor))) return value;
  const first = [value.startDate, ...anchors].sort()[0];
  return validateEventDraft({ ...value, startDate: first, endDate: addDays(first, daysBetween(value.startDate, value.endDate)), recurrence: 'daily', customRecurrence: undefined, untilDate: null });
}
