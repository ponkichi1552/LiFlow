import type { CalendarOccurrence } from './events';
import { newEventDraft } from './events';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock';

export interface TimedCalendarChore { id: string; name: string; start: number; end: number; onOpen(): void }
/** Display the durable chore itself, without creating a second calendar event. */
export function timedCalendarChoreEvents(rows: readonly TimedCalendarChore[], timeZone: string): CalendarOccurrence[] {
  return [...new Map(rows.map(row => [row.id, row])).values()].map(row => {
    if (![row.start, row.end].every(Number.isFinite) || row.end <= row.start) throw new Error('家事の開始・終了を確認してください。');
    const start = pinnedClockAt(row.start, timeZone); const end = pinnedClockAt(row.end, timeZone);
    const id = `chore-time:${row.id}`;
    return { ...newEventDraft(start.date, timeZone), title: row.name, startMinute: start.minute, endDate: end.date, endMinute: end.minute,
      id, eventId: id, anchorDate: start.date, eventRevision: 0, exceptionRevision: 0, categoryId: 'chore-time' };
  });
}
