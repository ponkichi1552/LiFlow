import { traceStartup } from '../diagnostics/startup-timing.ts';
import { isGoogleETag } from '../google-http/etag.ts';
import { readGoogleResponseText } from '../google-http/bounded-body.ts';

export const GOOGLE_CALENDAR_EVENT_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] as const;
export interface GoogleCalendarListEntry { id: string; summary: string; accessRole: string; primary?: boolean; timeZone?: string; backgroundColor?: string }
/** Persist only the CalendarList fields the client uses, in stable order. */
export function normalizeGoogleCalendars(calendars: readonly GoogleCalendarListEntry[]): GoogleCalendarListEntry[] {
  return [...new Map(calendars.map(row => [row.id, row])).values()].map(row => ({ id: row.id, summary: row.summary, accessRole: row.accessRole,
    ...(row.primary ? { primary: true } : {}), ...(row.timeZone ? { timeZone: row.timeZone } : {}),
    ...(row.backgroundColor ? { backgroundColor: row.backgroundColor } : {}) })).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export const canReadGoogleCalendar = (calendar: GoogleCalendarListEntry) => ['owner', 'writer', 'writerWithoutPrivateAccess', 'reader'].includes(calendar.accessRole);
export const canWriteGoogleCalendar = (calendar: GoogleCalendarListEntry) => ['owner', 'writer', 'writerWithoutPrivateAccess'].includes(calendar.accessRole);
export interface GoogleCalendarEvent {
  id: string; etag?: string; status?: string; summary?: string; location?: string; description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string }; end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[]; recurringEventId?: string; originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
  transparency?: string; eventType?: string; extendedProperties?: { private?: Record<string, string> };
  [key: string]: unknown;
}
export class GoogleCalendarHttpError extends Error {
  status: number; retryAfterMs: number;
  constructor(status: number, retryAfterMs = 0) {
    super(status === 412 ? 'Google側でも予定が変更されています。内容を確認してください。'
      : status === 401 || status === 403 ? 'Googleカレンダーのアクセス権限を確認してください。'
        : status === 429 ? 'Googleカレンダーの利用制限に達しました。時間をおいて再試行します。' : 'Googleカレンダーと通信できませんでした。変更は保持しています。');
    this.name = 'GoogleCalendarHttpError'; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}

// Include import/edit authority and recovery evidence, without downloading
// attendees, attachments, conference details or reminder configuration.
const EVENT_FIELDS = 'id,etag,status,summary,location,description,start,end,recurrence,recurringEventId,originalStartTime,transparency,eventType,extendedProperties(private),updated,visibility,locked,htmlLink';
const EVENT_FIELDS_QUERY = `fields=${encodeURIComponent(EVENT_FIELDS)}`;

/** Tokens stay in the native caller; neither errors nor persisted records contain credentials. */
export function createGoogleCalendarApi(input: { token: () => Promise<string>; assertCurrent: () => Promise<void>; signal?: AbortSignal; fetch?: typeof fetch }) {
  const transport = input.fetch ?? fetch;
  let cancellation: Promise<void> | undefined; let cancel: (() => void) | undefined; let activeRequests = 0;
  const cancelled = () => Object.assign(new Error('Googleカレンダーの同期を中断しました。変更は保持しています。'), { name: 'AbortError' });
  async function withinSignal<T>(work: () => Promise<T>): Promise<T> {
    const signal = input.signal; if (!signal) return work();
    if (signal.aborted) throw cancelled();
    cancellation ??= new Promise<void>(resolve => { cancel = resolve; signal.addEventListener('abort', cancel, { once: true }); });
    const value = await Promise.race([work(), cancellation.then(() => { throw cancelled(); })]);
    if (signal.aborted) throw cancelled(); return value;
  }
  // The API object belongs to one bounded pass, never to a persisted account.
  // Keep every identity guard while avoiding a native credential round trip per event.
  let tokenFlight: Promise<string> | undefined;
  const accessToken = () => {
    if (!tokenFlight) {
      const pending = input.token(); tokenFlight = pending;
      void pending.catch(() => { if (tokenFlight === pending) tokenFlight = undefined; });
    }
    return tokenFlight;
  };
  async function request<T>(path: string, method = 'GET', body?: unknown, etag?: string, expectedId?: string): Promise<T> {
    if ((method === 'PATCH' || method === 'DELETE') && !isGoogleETag(etag)) throw new GoogleCalendarHttpError(400);
    activeRequests++;
    try {
    await withinSignal(() => input.assertCurrent()); const token = await withinSignal(() => traceStartup('googleCalendar.token', accessToken)); await withinSignal(() => input.assertCurrent());
    const response = await withinSignal(() => traceStartup('googleCalendar.http', () => transport(`https://www.googleapis.com/calendar/v3/${path}`, { method, signal: input.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) }, body: body ? JSON.stringify(body) : undefined })));
    await withinSignal(() => input.assertCurrent());
    if (!response.ok) {
      if (response.status === 401) tokenFlight = undefined;
      const raw = response.headers.get('Retry-After'); const seconds = raw ? Number(raw) : 0;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw ?? '') - Date.now();
      let status = response.status;
      if (status === 403) {
        try {
          const payload = JSON.parse(await withinSignal(() => readGoogleResponseText(response, input.signal, 256 * 1024)));
          if (Array.isArray(payload?.error?.errors) && payload.error.errors.some((value: { reason?: unknown }) =>
            ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(String(value?.reason)))) status = 429;
        } catch (cause) { if (input.signal?.aborted) throw cause; }
      }
      throw new GoogleCalendarHttpError(status, Number.isFinite(delay) ? Math.min(24 * 3600_000, Math.max(0, delay)) : 0);
    }
    if (response.status === 204) return undefined as T;
    const text = await withinSignal(() => readGoogleResponseText(response, input.signal)); if (text.length > 2_000_000) throw new Error('Googleカレンダーの応答が大きすぎます。');
    await withinSignal(() => input.assertCurrent());
    let value: T;
    try { value = JSON.parse(text) as T; }
    catch { throw new Error('Googleカレンダーの応答を読み込めませんでした。変更は保持しています。'); }
    if (expectedId !== undefined && (!value || typeof value !== 'object' || !('id' in value) || value.id !== expectedId)) throw new GoogleCalendarHttpError(502);
    return value;
    } finally {
      if (--activeRequests === 0) {
        if (cancel) input.signal?.removeEventListener('abort', cancel);
        cancel = undefined; cancellation = undefined;
      }
    }
  }
  const path = (calendarId: string) => `calendars/${encodeURIComponent(calendarId)}/events`;
  const query = (values: Record<string, string | undefined>) => new URLSearchParams(Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined))).toString();
  return {
    calendars: (pageToken?: string) => request<{ items?: GoogleCalendarListEntry[]; nextPageToken?: string }>(`users/me/calendarList?${query({ maxResults: '100', showHidden: 'true', pageToken, fields: 'nextPageToken,items(id,summary,accessRole,primary,timeZone,backgroundColor)' })}`),
    events: (calendarId: string, cursor: { syncToken?: string; pageToken?: string }) => request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(`${path(calendarId)}?${query({ maxResults: '100', showDeleted: 'true', singleEvents: 'false', fields: `nextPageToken,nextSyncToken,items(${EVENT_FIELDS})`, ...cursor })}`),
    instances: (calendarId: string, id: string, range: { timeMin?: string; timeMax?: string; originalStart?: string; pageToken?: string }) => request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string }>(`${path(calendarId)}/${encodeURIComponent(id)}/instances?${query({ maxResults: '100', showDeleted: 'true', fields: `nextPageToken,items(${EVENT_FIELDS})`, ...range })}`),
    get: (calendarId: string, id: string) => request<GoogleCalendarEvent>(`${path(calendarId)}/${encodeURIComponent(id)}?${EVENT_FIELDS_QUERY}`, 'GET', undefined, undefined, id),
    insert: (calendarId: string, value: Record<string, unknown>) => request<GoogleCalendarEvent>(`${path(calendarId)}?sendUpdates=none&${EVENT_FIELDS_QUERY}`, 'POST', value, undefined, typeof value.id === 'string' ? value.id : undefined),
    patch: (calendarId: string, id: string, value: Record<string, unknown>, etag: string) => request<GoogleCalendarEvent>(`${path(calendarId)}/${encodeURIComponent(id)}?sendUpdates=none&conferenceDataVersion=1&${EVENT_FIELDS_QUERY}`, 'PATCH', value, etag, id),
    remove: (calendarId: string, id: string, etag: string) => request<void>(`${path(calendarId)}/${encodeURIComponent(id)}?sendUpdates=none`, 'DELETE', undefined, etag),
  };
}
export type GoogleCalendarApi = ReturnType<typeof createGoogleCalendarApi>;
