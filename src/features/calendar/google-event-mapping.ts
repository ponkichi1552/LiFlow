import { validateEventDraft } from '../../domain/calendar/events.ts';
import type { EventDraft } from '../../domain/calendar/events';
import type { LocalDate } from '../../domain/shared/types';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';

const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export function googleEventDateTime(date: LocalDate, minute: number, timeZone: string): string {
  const instants = v2WallTimeCandidates({ date, hour: Math.floor(minute / 60), minute: minute % 60, timeZone });
  if (instants.length !== 1) throw new Error('予定の時刻を一意に確定できません。');
  return new Date(instants[0]).toISOString();
}
export function googleEventBody(input: EventDraft, instance = false): Record<string, unknown> {
  const value = validateEventDraft(input);
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
      : new Date(Date.parse(googleEventDateTime(addDays(value.untilDate, 1), 0, value.timeZone)) - 1000).toISOString().replaceAll(/[-:]/gu, '').replace('.000', '');
    parts.push(`UNTIL=${until}`);
  }
  body.recurrence = [`RRULE:${parts.join(';')}`]; return body;
}
