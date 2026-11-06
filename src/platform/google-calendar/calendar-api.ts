import { traceStartup } from '../diagnostics/startup-timing.ts';

export const GOOGLE_CALENDAR_EVENT_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] as const;
export interface GoogleCalendarListEntry { id: string; summary: string; accessRole: string; primary?: boolean; timeZone?: string; backgroundColor?: string }
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
  async function request<T>(path: string, method = 'GET', body?: unknown, etag?: string): Promise<T> {
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
      throw new GoogleCalendarHttpError(response.status, Number.isFinite(delay) ? Math.min(24 * 3600_000, Math.max(0, delay)) : 0);
    }
    if (response.status === 204) return undefined as T;
    const text = await withinSignal(() => response.text()); if (text.length > 2_000_000) throw new Error('Googleカレンダーの応答が大きすぎます。');
    await withinSignal(() => input.assertCurrent());
    try { return JSON.parse(text) as T; }
    catch { throw new Error('Googleカレンダーの応答を読み込めませんでした。変更は保持しています。'); }
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
    calendars: (pageToken?: string) => request<{ items?: GoogleCalendarListEntry[]; nextPageToken?: string }>(`users/me/calendarList?${query({ maxResults: '100', showHidden: 'true', pageToken })}`),
    events: (calendarId: string, cursor: { syncToken?: string; pageToken?: string }) => request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(`${path(calendarId)}?${query({ maxResults: '100', showDeleted: 'true', singleEvents: 'false', ...cursor })}`),
    instances: (calendarId: string, id: string, range: { timeMin?: string; timeMax?: string; originalStart?: string; pageToken?: string }) => request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string }>(`${path(calendarId)}/${encodeURIComponent(id)}/instances?${query({ maxResults: '100', showDeleted: 'true', ...range })}`),
    get: (calendarId: string, id: string) => request<GoogleCalendarEvent>(`${path(calendarId)}/${encodeURIComponent(id)}`),
    insert: (calendarId: string, value: Record<string, unknown>) => request<GoogleCalendarEvent>(`${path(calendarId)}?sendUpdates=none`, 'POST', value),
    patch: (calendarId: string, id: string, value: Record<string, unknown>, etag: string) => request<GoogleCalendarEvent>(`${path(calendarId)}/${encodeURIComponent(id)}?sendUpdates=none&conferenceDataVersion=1`, 'PATCH', value, etag),
    remove: (calendarId: string, id: string, etag: string) => request<void>(`${path(calendarId)}/${encodeURIComponent(id)}?sendUpdates=none`, 'DELETE', undefined, etag),
  };
}
export type GoogleCalendarApi = ReturnType<typeof createGoogleCalendarApi>;
