import { validateEventDraft } from '../../domain/calendar/events.ts';
import type { EventDraft } from '../../domain/calendar/events';
import type { LocalDate } from '../../domain/shared/types';
import { addDays, daysBetween, monthDates, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { calendarWeekday, customRecurrenceDates } from '../../domain/calendar/recurrence.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import { localDayBoundary } from './local-day-boundary.ts';

const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export function googleEventDateTime(date: LocalDate, minute: number, timeZone: string): string {
  const instants = v2WallTimeCandidates({ date, hour: Math.floor(minute / 60), minute: minute % 60, timeZone });
  if (instants.length !== 1) throw new Error('予定の時刻を一意に確定できません。');
  return new Date(instants[0]).toISOString();
}
/** Google always includes DTSTART, even when it does not match BYDAY. */
function firstAnchor(value: EventDraft): LocalDate | null {
  const rule = value.customRecurrence;
  if (value.recurrence !== 'custom' || !rule || !['week', 'month'].includes(rule.unit) || rule.unit === 'month' && rule.on === 'date') return value.startDate;
  const base = parseLocalDate(value.startDate);
  for (let period = 0; period < 4800; period++) {
    const from = rule.unit === 'week' ? period === 0 ? value.startDate : addDays(value.startDate, -calendarWeekday(value.startDate) + period * rule.interval * 7)
      : new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + period * rule.interval, 1)).toISOString().slice(0, 10) as LocalDate;
    if (value.untilDate && from > value.untilDate) return null;
    const date = parseLocalDate(from);
    const through = rule.unit === 'week' ? addDays(from, 6) : monthDates(date.getUTCFullYear(), date.getUTCMonth()).at(-1)!;
    const first = customRecurrenceDates(rule, value.startDate, from, value.untilDate && value.untilDate < through ? value.untilDate : through)[0];
    if (first) return first;
  }
  throw new Error('繰り返しの最初の日付を確認してください。');
}
/** null means a finite rule has no occurrences; it must not create a phantom start. */
export function googleEventBody(input: EventDraft, instance = false): Record<string, unknown> | null {
  const original = validateEventDraft(input); const first = instance ? original.startDate : firstAnchor(original);
  if (!first) return null;
  const value = { ...original, startDate: first, endDate: addDays(first, daysBetween(original.startDate, original.endDate)) };
  const body: Record<string, unknown> = { summary: value.title, location: value.location, description: value.notes,
    start: value.allDay ? { date: value.startDate } : { dateTime: googleEventDateTime(value.startDate, value.startMinute, value.timeZone), timeZone: value.timeZone },
    end: value.allDay ? { date: addDays(value.endDate, 1) } : { dateTime: googleEventDateTime(value.endDate, value.endMinute, value.timeZone), timeZone: value.timeZone },
    transparency: value.birthday ? 'transparent' : 'opaque' };
  if (instance) return body;
  const rule = value.recurrence === 'custom' ? value.customRecurrence! : value.recurrence === 'none' ? null
    : { unit: ({ daily: 'day', weekly: 'week', biweekly: 'week', monthly: 'month', yearly: 'year' } as const)[value.recurrence], interval: value.recurrence === 'biweekly' ? 2 : 1 };
  if (!rule) { body.recurrence = []; return body; }
  const parts = [`FREQ=${({ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' })[rule.unit]}`, `INTERVAL=${rule.interval}`];
  if ('weekdays' in rule) parts.push(`BYDAY=${rule.weekdays.map(day => days[day]).join(',')}`, 'WKST=SU');
  if ('on' in rule && rule.on === 'weekday') parts.push(`BYDAY=${rule.ordinal}${days[rule.weekday]}`);
  if (value.untilDate) {
    const until = value.allDay ? value.untilDate.replaceAll('-', '')
      : new Date(localDayBoundary(addDays(value.untilDate, 1), value.timeZone) - 1000).toISOString().replaceAll(/[-:]/gu, '').replace('.000', '');
    parts.push(`UNTIL=${until}`);
  }
  body.recurrence = [`RRULE:${parts.join(';')}`]; return body;
}
