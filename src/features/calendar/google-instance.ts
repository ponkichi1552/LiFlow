import type { GoogleCalendarApi, GoogleCalendarEvent } from '../../platform/google-calendar/calendar-api';
import { GoogleCalendarHttpError } from '../../platform/google-calendar/calendar-api.ts';
import type { LocalDate } from '../../domain/shared/types';
import { projectCalendarEvents } from '../../domain/calendar/events.ts';
import type { EventDraft } from '../../domain/calendar/events';
import { googleEventBody } from './google-event-mapping.ts';
import { calendarImportFormatter } from './import-formatter.ts';

/** A range can contain a preceding multi-day occurrence as well as this anchor. */
export function calendarOccurrenceAt(series: EventDraft, eventId: string, anchorDate: LocalDate) {
  return projectCalendarEvents([{ ...series, id: eventId, revision: 1 }], [], anchorDate, anchorDate)
    .find(row => row.eventId === eventId && row.anchorDate === anchorDate) ?? null;
}

export function googleOriginalDate(remote: GoogleCalendarEvent, timeZone: string): string | null {
  if (remote.originalStartTime?.date) return remote.originalStartTime.date;
  const at = remote.originalStartTime?.dateTime; if (!at || !Number.isFinite(Date.parse(at))) return null;
  const parts = Object.fromEntries(calendarImportFormatter(timeZone).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** An occurrence's actual start may have moved years away from its original day. */
export async function findGoogleCalendarInstance(input: {
  api: GoogleCalendarApi; request<T>(work: () => Promise<T>): Promise<T>;
  calendarId: string; parentId: string; anchorDate: LocalDate; series?: EventDraft | null; knownId?: string;
}): Promise<GoogleCalendarEvent> {
  const zone = input.series?.timeZone ?? 'UTC';
  const matches = (row: GoogleCalendarEvent) => row.recurringEventId === input.parentId && googleOriginalDate(row, zone) === input.anchorDate;
  if (input.knownId) {
    try {
      const row = await input.request(() => input.api.get(input.calendarId, input.knownId!));
      // Restoring a deleted series gives it a new Google ID. Its former
      // exception can still exist as a tombstone under the old parent.
      // Never mutate that row: resolve the exact original start on this parent.
      if (matches(row)) return row;
    } catch (cause) { if (!(cause instanceof GoogleCalendarHttpError && [404, 410].includes(cause.status))) throw cause; }
  }
  const occurrence = input.series && calendarOccurrenceAt(input.series, input.parentId, input.anchorDate);
  const body = occurrence && googleEventBody(occurrence, true);
  const start = body?.start as GoogleCalendarEvent['start'];
  const originalStart = start?.date ?? start?.dateTime;
  if (!originalStart) throw new Error('Google側の対象回を確認できません。変更は送信待ちです。');
  let pageToken: string | undefined; const seen = new Set<string>();
  do {
    const page = await input.request(() => input.api.instances(input.calendarId, input.parentId, { originalStart, pageToken }));
    const found = page.items?.find(matches); if (found) return found;
    pageToken = page.nextPageToken;
    if (pageToken && (seen.has(pageToken) || seen.size >= 100)) throw new Error('Googleの繰り返し予定を読み直してください。');
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  throw new Error('Google側の対象回を確認できません。変更は送信待ちです。');
}
