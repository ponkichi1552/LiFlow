import { addDays, daysBetween, monthDates, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import { customRecurrenceDates, customRecurrenceLabel, validateCustomRecurrence } from './recurrence.ts';
import type { CustomRecurrence } from './recurrence.ts';

export type CalendarRecurrence = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
export interface EventDraft {
  title: string; location: string; notes: string; startDate: LocalDate; endDate: LocalDate;
  allDay: boolean; startMinute: number; endMinute: number; timeZone: string;
  recurrence: CalendarRecurrence; untilDate: LocalDate | null; categoryId: string; birthday: boolean;
  customRecurrence?: CustomRecurrence;
}
export interface CalendarEvent extends EventDraft { id: string; revision: number }
export interface CalendarCategory { id: string; name: string; color: string; revision: number }
export interface CalendarException { eventId: string; anchorDate: LocalDate; override: EventDraft | null; revision: number }
export interface CalendarOccurrence extends EventDraft {
  id: string; eventId: string; anchorDate: LocalDate; eventRevision: number; exceptionRevision: number;
  timeIssue?: 'gap' | 'fold'; original?: CalendarOccurrence;
}
export const RECURRENCE_LABELS: Record<CalendarRecurrence, string> = { none: '繰り返さない', daily: '毎日', weekly: '毎週', biweekly: '隔週', monthly: '毎月', yearly: '毎年', custom: 'カスタム' };
export function recurrenceLabel(value: EventDraft) { return value.recurrence === 'custom' && value.customRecurrence ? customRecurrenceLabel(value.customRecurrence, value.startDate) : RECURRENCE_LABELS[value.recurrence]; }
export const CATEGORY_PRESETS = ['#348DC2', '#8459B3', '#3D906A', '#BD7042', '#BA527D', '#71823B', '#727A91', '#BE4E4E'];
export const INITIAL_CATEGORIES: readonly CalendarCategory[] = [
  { id: 'school', name: '学校', color: '#348DC2', revision: 1 }, { id: 'work', name: '仕事', color: '#8459B3', revision: 1 },
  { id: 'personal', name: '私用', color: '#3D906A', revision: 1 }, { id: 'birthday', name: '誕生日', color: '#BA527D', revision: 1 },
];
export function calendarMonth(day: LocalDate, offset = 0): LocalDate {
  const d = parseLocalDate(day); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset);
  const value = d.toISOString().slice(0, 10) as LocalDate; parseLocalDate(value); return value;
}
export function dateInMonth(month: LocalDate, preferredDay: number): LocalDate {
  const d = parseLocalDate(month); const dates = monthDates(d.getUTCFullYear(), d.getUTCMonth());
  return dates[Math.max(0, Math.min(dates.length, preferredDay) - 1)];
}
export function newEventDraft(date: LocalDate, timeZone: string, birthday = false): EventDraft {
  return { title: '', location: '', notes: '', startDate: date, endDate: date, allDay: birthday, startMinute: 9 * 60, endMinute: 10 * 60,
    timeZone, recurrence: birthday ? 'yearly' : 'none', untilDate: null, categoryId: birthday ? 'birthday' : 'personal', birthday };
}
export function validateEventDraft(value: EventDraft): EventDraft {
  if (!value || typeof value !== 'object') throw new Error('予定の入力内容を確認してください。');
  const text = (s: unknown, max: number, required = false) => {
    if (typeof s !== 'string' || s.length > max || required && !s.trim()) throw new Error('予定名・場所・メモの長さを確認してください。'); return s.trim();
  };
  const title = text(value.title, 160, true); const location = text(value.location, 300); const notes = text(value.notes, 4000);
  parseLocalDate(value.startDate); parseLocalDate(value.endDate);
  if (value.startDate > value.endDate || daysBetween(value.startDate, value.endDate) > 366) throw new Error('終了日は開始日以降、期間は1年以内にしてください。');
  if (typeof value.allDay !== 'boolean' || typeof value.birthday !== 'boolean') throw new Error('予定の日時を確認してください。');
  if (![value.startMinute, value.endMinute].every(n => Number.isInteger(n) && n >= 0 && n < 1440)) throw new Error('開始・終了時刻を確認してください。');
  if (!Object.hasOwn(RECURRENCE_LABELS, value.recurrence) || !/^[A-Za-z0-9._-]{1,100}$/.test(value.categoryId)) throw new Error('繰り返し・分類を確認してください。');
  const custom = value.recurrence === 'custom' ? validateCustomRecurrence(value.customRecurrence) : undefined;
  if (value.untilDate !== null) { parseLocalDate(value.untilDate); if (value.untilDate < value.startDate) throw new Error('繰り返しの終了日は開始日以降にしてください。'); }
  if (value.birthday && (!value.allDay || value.recurrence !== 'yearly' || value.startDate !== value.endDate)) throw new Error('誕生日は1日・終日・毎年の予定です。');
  if (typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 100) throw new Error('予定のタイムゾーンを確認してください。');
  new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0);
  if (!value.allDay) {
    const start = v2WallTimeCandidates({ date: value.startDate, hour: Math.floor(value.startMinute / 60), minute: value.startMinute % 60, timeZone: value.timeZone });
    const end = v2WallTimeCandidates({ date: value.endDate, hour: Math.floor(value.endMinute / 60), minute: value.endMinute % 60, timeZone: value.timeZone });
    if (start.length !== 1 || end.length !== 1) throw new Error('夏時間で存在しない、または重複する時刻です。別の時刻を選んでください。');
    if (end[0] <= start[0]) throw new Error('終了は開始より後にしてください。');
  }
  return { title, location, notes, startDate: value.startDate, endDate: value.endDate, allDay: value.allDay, startMinute: value.startMinute,
    endMinute: value.endMinute, timeZone: value.timeZone, recurrence: value.recurrence, untilDate: value.untilDate, categoryId: value.categoryId, birthday: value.birthday,
    ...(custom ? { customRecurrence: custom } : {}) };
}

/** Seek into the visible range rather than expanding a series from its creation date. */
function anchors(event: CalendarEvent, from: LocalDate, through: LocalDate): LocalDate[] {
  const earliest = addDays(from, -daysBetween(event.startDate, event.endDate));
  const last = event.untilDate && event.untilDate < through ? event.untilDate : through;
  if (last < event.startDate || last < earliest) return [];
  if (event.recurrence === 'none') return [event.startDate];
  if (event.recurrence === 'custom') return customRecurrenceDates(validateCustomRecurrence(event.customRecurrence), event.startDate, earliest, last);
  const step = event.recurrence === 'daily' ? 1 : event.recurrence === 'weekly' ? 7 : event.recurrence === 'biweekly' ? 14 : 0;
  if (step) {
    const first = addDays(event.startDate, Math.max(0, Math.ceil(daysBetween(event.startDate, earliest) / step)) * step);
    const length = Math.max(0, Math.floor(daysBetween(first, last) / step) + 1);
    return Array.from({ length }, (_, i) => addDays(first, i * step));
  }
  const base = parseLocalDate(event.startDate); const start = parseLocalDate(earliest); const end = parseLocalDate(last);
  const increment = event.recurrence === 'yearly' ? 12 : 1; const baseIndex = base.getUTCFullYear() * 12 + base.getUTCMonth();
  const firstIndex = start.getUTCFullYear() * 12 + start.getUTCMonth(); const endIndex = end.getUTCFullYear() * 12 + end.getUTCMonth();
  const result: LocalDate[] = [];
  for (let i = baseIndex + Math.max(0, Math.ceil((firstIndex - baseIndex) / increment)) * increment; i <= endIndex; i += increment) {
    const dates = monthDates(Math.floor(i / 12), i % 12); const date = dates[base.getUTCDate() - 1];
    // A series on the 31st or Feb 29 does not silently move to another civil date.
    if (date && date >= event.startDate && date <= last) result.push(date);
  }
  return result;
}
export function isCalendarAnchor(event: CalendarEvent, date: LocalDate) { return anchors(event, date, date).includes(date); }
export function projectCalendarEvents(events: readonly CalendarEvent[], exceptions: readonly CalendarException[], from: LocalDate, through: LocalDate): CalendarOccurrence[] {
  parseLocalDate(from); parseLocalDate(through);
  if (from > through || daysBetween(from, through) > 370) throw new Error('表示期間は1年以内にしてください。');
  const exceptional = new Map(exceptions.map(row => [`${row.eventId}:${row.anchorDate}`, row]));
  const result: CalendarOccurrence[] = [];
  for (const event of events) {
    const dates = new Set(anchors(event, from, through));
    // A moved instance may enter this range from outside its original month.
    for (const row of exceptions) if (row.eventId === event.id && row.override && row.override.startDate <= through && row.override.endDate >= from
      && anchors(event, row.anchorDate, row.anchorDate).includes(row.anchorDate)) dates.add(row.anchorDate);
    for (const anchorDate of dates) {
      const exception = exceptional.get(`${event.id}:${anchorDate}`); if (exception && !exception.override) continue;
      const body = exception?.override ?? { ...event, startDate: anchorDate, endDate: addDays(anchorDate, daysBetween(event.startDate, event.endDate)) };
      if (body.startDate > through || body.endDate < from) continue;
      let timeIssue: CalendarOccurrence['timeIssue'];
      if (!body.allDay) {
        const lengths = [v2WallTimeCandidates({ date: body.startDate, hour: Math.floor(body.startMinute / 60), minute: body.startMinute % 60, timeZone: body.timeZone }).length,
          v2WallTimeCandidates({ date: body.endDate, hour: Math.floor(body.endMinute / 60), minute: body.endMinute % 60, timeZone: body.timeZone }).length];
        if (lengths.some(n => n !== 1)) timeIssue = lengths.includes(0) ? 'gap' : 'fold';
      }
      result.push({ ...body, id: `${event.id}:${anchorDate}`, eventId: event.id, anchorDate, eventRevision: event.revision, exceptionRevision: exception?.revision ?? 0, ...(timeIssue ? { timeIssue } : {}) });
      if (result.length > 20_000) throw new Error('表示する予定が多すぎます。期間を狭めてください。');
    }
  }
  return result.sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(b.allDay) - Number(a.allDay) || a.startMinute - b.startMinute || a.id.localeCompare(b.id));
}
/** Timed events share the display clock; untimed/all-day dates keep their original civil date. */
export function calendarEventsInTimeZone(events: readonly CalendarOccurrence[], timeZone: string): CalendarOccurrence[] {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return events.map(event => {
    if (event.allDay || event.timeIssue || event.timeZone === timeZone) return event;
    const clock = (date: LocalDate, minute: number) => {
      const at = v2WallTimeCandidates({ date, hour: Math.floor(minute / 60), minute: minute % 60, timeZone: event.timeZone })[0];
      const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
      return { date: `${parts.year}-${parts.month}-${parts.day}` as LocalDate, minute: Number(parts.hour) * 60 + Number(parts.minute) };
    };
    const start = clock(event.startDate, event.startMinute); const end = clock(event.endDate, event.endMinute);
    return { ...event, startDate: start.date, startMinute: start.minute, endDate: end.date, endMinute: end.minute, timeZone, original: event };
  });
}
export function occurrencesOnDate(events: readonly CalendarOccurrence[], date: LocalDate) {
  return events.filter(row => row.startDate <= date && (row.endDate > date || row.endDate === date && (row.allDay || row.endMinute > 0)));
}
export function minuteLabel(value: number) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
export function categoryColor(color: string, dark: boolean) {
  if (!/^#[0-9A-F]{6}$/i.test(color)) return dark ? '#A7B4C9' : '#68718B';
  return dark ? '#' + color.slice(1).match(/../g)!.map(v => Math.round(parseInt(v, 16) * .58 + 255 * .42).toString(16).padStart(2, '0')).join('') : color;
}
