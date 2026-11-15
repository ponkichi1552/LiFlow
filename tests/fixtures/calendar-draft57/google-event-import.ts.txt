import type { GoogleCalendarEvent } from '../../platform/google-calendar/calendar-api';
import type { EventDraft } from '../../domain/calendar/events';
import type { LocalDate } from '../../domain/shared/types';
import { isCalendarAnchor, validateEventDraft } from '../../domain/calendar/events.ts';
import { addDays, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { calendarImportFormatter } from './import-formatter.ts';

export class GoogleEventExpansionRequired extends Error {}
const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const unsupported = () => new GoogleEventExpansionRequired('この繰り返しはGoogleの各回を取得して表示します。');

function clock(value: NonNullable<GoogleCalendarEvent['start']>, fallbackZone: string) {
  if (value.date) { parseLocalDate(value.date as LocalDate); return { date: value.date as LocalDate, minute: 0, allDay: true, zone: fallbackZone }; }
  if (!value.dateTime || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value.dateTime)) throw unsupported();
  const at = Date.parse(value.dateTime); if (!Number.isFinite(at)) throw unsupported();
  // Seconds/folds cannot be represented losslessly in the current minute editor.
  if (at % 60_000 !== 0) throw unsupported();
  const zone = value.timeZone ?? fallbackZone;
  const formatter = calendarImportFormatter(zone, true);
  const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}` as LocalDate, minute: Number(parts.hour) * 60 + Number(parts.minute), allDay: false, zone };
}

/** Accept only rules that have exactly the same expansion as LiFlow's editor.
 * Unsupported Google rules are expanded by Google; never approximate then write them back.
 */
function recurrence(lines: string[] | undefined, startDate: LocalDate, zone: string): Pick<EventDraft, 'recurrence' | 'untilDate' | 'customRecurrence'> {
  if (!lines?.length) return { recurrence: 'none', untilDate: null };
  if (lines.length !== 1 || !lines[0].startsWith('RRULE:')) throw unsupported();
  const entries = lines[0].slice(6).split(';').map(part => part.split('='));
  if (entries.some(part => part.length !== 2) || new Set(entries.map(part => part[0])).size !== entries.length) throw unsupported();
  const rule: Record<string, string> = Object.fromEntries(entries);
  if (Object.keys(rule).some(key => !['FREQ', 'INTERVAL', 'UNTIL', 'BYDAY', 'WKST'].includes(key))) throw unsupported();
  const interval = rule.INTERVAL === undefined ? 1 : Number(rule.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) throw unsupported();
  let untilDate: LocalDate | null = null;
  if (rule.UNTIL) {
    if (/^\d{8}$/u.test(rule.UNTIL)) untilDate = `${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}` as LocalDate;
    else if (/^\d{8}T\d{6}Z$/u.test(rule.UNTIL)) {
      const value = rule.UNTIL;
      const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
      const parts = Object.fromEntries(calendarImportFormatter(zone).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
      untilDate = `${parts.year}-${parts.month}-${parts.day}` as LocalDate;
      // A cutoff earlier than the occurrence's local clock needs server expansion.
      // The imported rule must not invent its last occurrence.
      const at = Date.parse(iso); if (!Number.isFinite(at)) throw unsupported();
    } else throw unsupported();
    parseLocalDate(untilDate); if (untilDate < startDate) throw unsupported();
  }
  const units = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as const;
  const unit = units[rule.FREQ as keyof typeof units];
  if (!unit || rule.WKST && !dayNames.includes(rule.WKST)) throw unsupported();
  if (rule.BYDAY) {
    if (unit === 'week') {
      const weekdays = rule.BYDAY.split(',').map(day => dayNames.indexOf(day));
      if (weekdays.some(day => day < 0) || new Set(weekdays).size !== weekdays.length || interval > 1 && rule.WKST !== 'SU') throw unsupported();
      const weekday = parseLocalDate(startDate).getUTCDay();
      if (!weekdays.includes(weekday)) throw unsupported();
      return { recurrence: 'custom', untilDate, customRecurrence: { unit: 'week', interval, weekdays: weekdays.sort((a, b) => a - b) } };
    }
    if (unit === 'month') {
      const match = /^(-1|[1-5])(SU|MO|TU|WE|TH|FR|SA)$/u.exec(rule.BYDAY); if (!match) throw unsupported();
      const date = parseLocalDate(startDate), ordinal = Number(match[1]) as -1 | 1 | 2 | 3 | 4 | 5;
      if (date.getUTCDay() !== dayNames.indexOf(match[2]) || (ordinal === -1 ? addDays(startDate, 7).slice(0, 7) === startDate.slice(0, 7) : Math.ceil(date.getUTCDate() / 7) !== ordinal)) throw unsupported();
      return { recurrence: 'custom', untilDate, customRecurrence: { unit: 'month', interval, on: 'weekday', weekday: date.getUTCDay(), ordinal } };
    }
    throw unsupported();
  }
  if (interval === 1) return { recurrence: ({ day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' } as const)[unit], untilDate };
  if (unit === 'week' && interval === 2) return { recurrence: 'biweekly', untilDate };
  return { recurrence: 'custom', untilDate, customRecurrence: unit === 'week'
    ? { unit, interval, weekdays: [parseLocalDate(startDate).getUTCDay()] }
    : unit === 'month' ? { unit, interval, on: 'date' } : { unit, interval } };
}

function importRepresentableEvent(event: GoogleCalendarEvent, categoryId: string, fallbackZone: string, instance: boolean): EventDraft {
  if (!event.start || !event.end || event.status === 'cancelled') throw unsupported();
  const start = clock(event.start, fallbackZone), end = clock(event.end, start.zone);
  if (start.allDay !== end.allDay || start.zone !== end.zone || event.eventType && !['default', 'birthday'].includes(event.eventType)) throw unsupported();
  const repeated = instance ? { recurrence: 'none' as const, untilDate: null } : recurrence(event.recurrence, start.date, start.zone);
  const value = validateEventDraft({ title: event.summary || '予定', location: event.location ?? '', notes: event.description ?? '',
    startDate: start.date, endDate: end.allDay ? addDays(end.date, -1) : end.date, allDay: start.allDay,
    startMinute: start.minute, endMinute: end.minute, timeZone: start.zone, categoryId, birthday: false, ...repeated });
  // An RFC UNTIL can end before the last local occurrence's start time.
  if (!instance && value.untilDate && event.recurrence?.[0]) {
    const match = /(?:^|;)UNTIL=(\d{8}T\d{6}Z)(?:;|$)/u.exec(event.recurrence[0].slice(6));
    if (match && !value.allDay) {
      const raw = match[1]; const at = Date.parse(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`);
      const untilClock = clock({ dateTime: new Date(at - at % 60_000).toISOString(), timeZone: value.timeZone }, value.timeZone);
      if (untilClock.minute < value.startMinute && isCalendarAnchor({ ...value, id: event.id, revision: 1 }, value.untilDate)) throw unsupported();
    }
  }
  return value;
}

export function googleImportedEvent(event: GoogleCalendarEvent, categoryId: string, fallbackZone = 'Asia/Tokyo', instance = false): EventDraft {
  try { return importRepresentableEvent(event, categoryId, fallbackZone, instance); }
  catch (cause) {
    if (cause instanceof GoogleEventExpansionRequired) throw cause;
    // The editor's length limits and ambiguous DST clocks must not stop unrelated imports.
    // Only a read-only display projection may shorten text or normalize its clock.
    throw new GoogleEventExpansionRequired('この予定はGoogleの元の内容を保持して表示します。', { cause });
  }
}
