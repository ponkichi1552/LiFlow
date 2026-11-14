import type { CalendarEvent, CalendarException } from './events';
import { calendarEventsInTimeZone, isCalendarAnchor } from './events.ts';
import type { LocalDate } from '../../domain/shared/types';
import { projectPrivateCalendarEvents } from './private-event-projection.ts';
import { addDays, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import { calendarReminderMinutes, type CalendarReminderSettings } from './reminder-preferences.ts';
import type { LocalNotificationRequest } from '../notifications/contracts';
import { sharedDocumentDigest } from '../sharing/crypto.ts';

export const CALENDAR_NOTIFICATION_PREFIX = 'liflow-calendar:';
export interface CalendarNotificationSource { scope: string; events: readonly CalendarEvent[]; exceptions: readonly CalendarException[] }
/** Explicit opt-in only. Conflicting/DST-ambiguous occurrences cannot produce a guessed reminder. */
export function calendarNotificationRequests(settings: CalendarReminderSettings, sources: readonly CalendarNotificationSource[], now = Date.now()): LocalNotificationRequest[] {
  if (!settings.enabled) return [];
  const result: LocalNotificationRequest[] = [];
  for (const source of sources) {
    const selected = new Set(settings.rules.filter(rule => rule.scope === source.scope && rule.minutes !== null).map(rule => rule.eventId));
    for (const event of source.events) {
      if (!selected.has(event.id) || event.holiday || event.birthday) continue;
      const today = pinnedClockAt(now, event.timeZone).date;
      const rows = projectPrivateCalendarEvents([event], source.exceptions.filter(row => row.eventId === event.id), today, addDays(today, 61));
      for (const row of rows) {
        const minutes = calendarReminderMinutes(settings, source.scope, row.eventId, row.anchorDate);
        if (minutes === null || row.timeIssue) continue;
        const start = v2WallTimeCandidates({ date: row.startDate, hour: row.allDay ? 0 : Math.floor(row.startMinute / 60), minute: row.allDay ? 0 : row.startMinute % 60, timeZone: row.timeZone });
        if (start.length !== 1) continue;
        const at = start[0] - minutes * 60_000;
        if (at <= now) continue;
        result.push({ key: `${CALENDAR_NOTIFICATION_PREFIX}${sharedDocumentDigest([source.scope, row.eventId, row.anchorDate])}`, title: row.title,
          body: minutes === 0 ? '予定の開始時刻です' : minutes === 1440 ? '明日の予定です' : `${minutes === 60 ? '1時間' : `${minutes}分`}後に始まります`,
          fireAt: new Date(at).toISOString() as LocalNotificationRequest['fireAt'],
          data: { kind: 'calendar-event', scope: source.scope, eventId: row.eventId, anchorDate: row.anchorDate, date: row.startDate, minute: row.allDay ? -1 : row.startMinute } });
      }
    }
  }
  // Leave capacity for independent housework notices, then let the shared native queue enforce its actual limit.
  return result.sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt) || a.key.localeCompare(b.key)).slice(0, 32);
}

/** A tap resolves against the current source, never an account or title supplied by notification metadata. */
export function calendarNotificationDestination(data: unknown, sources: readonly CalendarNotificationSource[], timeZone: string) {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.kind !== 'calendar-event' || typeof value.scope !== 'string' || typeof value.eventId !== 'string' || typeof value.anchorDate !== 'string') return null;
  try { parseLocalDate(value.anchorDate as LocalDate); } catch { return null; }
  const source = sources.find(source => source.scope === value.scope);
  const event = source?.events.find(event => event.id === value.eventId && !event.holiday);
  if (!source || !event) return null;
  const anchor = value.anchorDate as LocalDate;
  const exception = source.exceptions.find(row => row.eventId === event.id && row.anchorDate === anchor);
  if (exception ? !exception.override : !isCalendarAnchor(event, anchor)) return null;
  const date = exception?.override?.startDate ?? anchor;
  const row = projectPrivateCalendarEvents([event], source.exceptions, date, date).find(row => row.anchorDate === anchor);
  if (!row) return null;
  const [visible] = calendarEventsInTimeZone([row], timeZone);
  return { date: visible.startDate, minute: visible.allDay ? null : visible.startMinute };
}
