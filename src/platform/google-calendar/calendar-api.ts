export const GOOGLE_CALENDAR_EVENT_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] as const;
export interface GoogleCalendarListEntry { id: string; summary: string; accessRole: string; timeZone?: string; backgroundColor?: string }
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
  async function request<T>(path: string, method = 'GET', body?: unknown, etag?: string): Promise<T> {
    await input.assertCurrent(); const token = await input.token(); await input.assertCurrent();
    const response = await transport(`https://www.googleapis.com/calendar/v3/${path}`, { method, signal: input.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) }, body: body ? JSON.stringify(body) : undefined });
    await input.assertCurrent();
    if (!response.ok) {
      const raw = response.headers.get('Retry-After'); const seconds = raw ? Number(raw) : 0;
      throw new GoogleCalendarHttpError(response.status, Number.isFinite(seconds) ? Math.min(24 * 3600_000, Math.max(0, seconds * 1000)) : 0);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text(); if (text.length > 2_000_000) throw new Error('Googleカレンダーの応答が大きすぎます。');
    await input.assertCurrent(); return JSON.parse(text) as T;
  }
  const path = (calendarId: string) => `calendars/${encodeURIComponent(calendarId)}/events`;
  const query = (values: Record<string, string | undefined>) => new URLSearchParams(Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined))).toString();
  return {
    calendars: (pageToken?: string) => request<{ items?: GoogleCalendarListEntry[]; nextPageToken?: string }>(`users/me/calendarList?${query({ maxResults: '100', pageToken })}`),
    events: (calendarId: string, cursor: { syncToken?: string; pageToken?: string }) => request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(`${path(calendarId)}?${query({ maxResults: '100', showDeleted: 'true', singleEvents: 'false', ...cursor })}`),
    instances: (calendarId: string, id: string, range: { timeMin: string; timeMax: string; pageToken?: string }) => request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string }>(`${path(calendarId)}/${encodeURIComponent(id)}/instances?${query({ maxResults: '100', showDeleted: 'true', ...range })}`),
    get: (calendarId: string, id: string) => request<GoogleCalendarEvent>(`${path(calendarId)}/${encodeURIComponent(id)}`),
    insert: (calendarId: string, value: Record<string, unknown>) => request<GoogleCalendarEvent>(`${path(calendarId)}?sendUpdates=none`, 'POST', value),
    patch: (calendarId: string, id: string, value: Record<string, unknown>, etag: string) => request<GoogleCalendarEvent>(`${path(calendarId)}/${encodeURIComponent(id)}?sendUpdates=none&conferenceDataVersion=1`, 'PATCH', value, etag),
    remove: (calendarId: string, id: string, etag: string) => request<void>(`${path(calendarId)}/${encodeURIComponent(id)}?sendUpdates=none`, 'DELETE', undefined, etag),
  };
}
export type GoogleCalendarApi = ReturnType<typeof createGoogleCalendarApi>;
