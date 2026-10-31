import { addDays, daysBetween } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import type { EventDraft } from './events.ts';

/** Move the start while retaining elapsed duration; ambiguous civil times remain validation errors. */
export function moveCalendarStart(value: EventDraft, next: { startDate?: LocalDate; startMinute?: number }): EventDraft {
  const moved = { ...value, ...next };
  const span = daysBetween(value.startDate, value.endDate);
  if (value.allDay) return { ...moved, endDate: addDays(moved.startDate, span) };
  const instant = (date: LocalDate, minute: number) => v2WallTimeCandidates({ date,
    hour: Math.floor(minute / 60), minute: minute % 60, timeZone: value.timeZone });
  const start = instant(value.startDate, value.startMinute); const end = instant(value.endDate, value.endMinute);
  const target = instant(moved.startDate, moved.startMinute);
  if (start.length === 1 && end.length === 1 && target.length === 1 && end[0] > start[0]) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(target[0] + end[0] - start[0]).map(part => [part.type, part.value]));
    return { ...moved, endDate: `${parts.year}-${parts.month}-${parts.day}` as LocalDate,
      endMinute: Number(parts.hour) * 60 + Number(parts.minute) };
  }
  const duration = span * 1440 + value.endMinute - value.startMinute;
  if (duration <= 0) return moved;
  const finish = moved.startMinute + duration;
  return { ...moved, endDate: addDays(moved.startDate, Math.floor(finish / 1440)), endMinute: finish % 1440 };
}
