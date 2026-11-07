import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';

type ClockFormatter = { formatToParts(value: Date | number): Intl.DateTimeFormatPart[] };
const formatters = new Map<string, ClockFormatter>();

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
