import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { minuteLabel } from './events.ts';

/** Only explicit user-entered clocks are supplied here, never automatic work slots. */
export function calendarChoreTimeLabel(span: { start: number; end: number } | undefined, timeZone: string): string | undefined {
  if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end) || span.end <= span.start) return undefined;
  const start = pinnedClockAt(span.start, timeZone); const end = pinnedClockAt(span.end, timeZone);
  const endDay = end.date === start.date ? '' : end.date === addDays(start.date, 1) ? '翌日 ' : `${Number(end.date.slice(5, 7))}/${Number(end.date.slice(8))} `;
  return `${minuteLabel(start.minute)}–${endDay}${minuteLabel(end.minute)}`;
}
