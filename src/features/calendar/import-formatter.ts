import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';

type ClockFormatter = { formatToParts(value: Date | number): Intl.DateTimeFormatPart[] };
const formatters = new Map<string, ClockFormatter>();

export function googleSourceTimeZone(value: { start?: { dateTime?: string; timeZone?: string } } | null | undefined, calendarZone = 'UTC') {
  return value?.start?.dateTime ? value.start.timeZone ?? calendarZone : undefined;
}

export function googleCalendarInstant(value: { dateTime?: string; timeZone?: string } | undefined, fallbackZone = 'UTC'): number {
  const raw = value?.dateTime;
  if (!raw) return NaN;
  if (/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw)) return Date.parse(raw);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/u.exec(raw);
  if (!match || Number(match[4]) > 59) return NaN;
  try {
    const starts = v2WallTimeCandidates({ date: match[1] as LocalDate, hour: Number(match[2]), minute: Number(match[3]), timeZone: value?.timeZone ?? fallbackZone });
    return starts.length === 1 ? starts[0] + 1000 * Number(match[4]) + Number((match[5] ?? '').padEnd(3, '0').slice(0, 3)) : NaN;
  } catch { return NaN; }
}

/** Private transport formatting; bounded by zone, independent of account/event contents. */
export function calendarImportFormatter(timeZone: string, includeTime = false): ClockFormatter {
  const key = `${includeTime ? 'clock' : 'date'}:${timeZone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    pinnedClockAt(0, timeZone);
    formatter = { formatToParts(value) {
      const clock = pinnedClockAt(value, timeZone); const [year, month, day] = clock.date.split('-');
      return [{ type: 'year', value: year }, { type: 'month', value: month }, { type: 'day', value: day },
        ...(includeTime ? [{ type: 'hour' as const, value: String(Math.floor(clock.minute / 60)).padStart(2, '0') },
          { type: 'minute' as const, value: String(clock.minute % 60).padStart(2, '0') }] : [])];
    } };
    formatters.set(key, formatter);
    if (formatters.size > 16) formatters.delete(formatters.keys().next().value!);
  }
  return formatter;
}
