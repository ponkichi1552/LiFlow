import type { CalendarQueryRange } from '@/features/google-sync/calendar-availability';
import { parseGoogleCompletedAt } from '@/features/google-sync/google-completion-policy';

export class CalendarFreeBusyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: string | null;
  constructor(status: number, code: string, retryAfter: string | null = null) {
    super('Calendar availability request failed');
    this.name = 'CalendarFreeBusyError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface CalendarFreeBusyClient {
  query(accessToken: string, range: CalendarQueryRange, options?: { timeoutMs?: number; maxIntervals?: number; signal?: AbortSignal }): Promise<{ start: string; end: string }[]>;
}

// The live API rejected the planner's 181-day coverage as timeRangeTooLong.
// Split transport requests only; the Scheduler horizon and atomic cache coverage stay intact.
export const FREEBUSY_QUERY_CHUNK_MS = 90 * 24 * 60 * 60 * 1000;

export function createCalendarFreeBusyClient(fetcher: typeof fetch = fetch, onRequest?: () => void): CalendarFreeBusyClient {
  const queryWindow = async (accessToken: string, range: CalendarQueryRange, deadline: number | undefined, remainingIntervals: number, signal?: AbortSignal): Promise<{ start: string; end: string }[]> => {
    if (signal?.aborted || deadline !== undefined && Date.now() >= deadline) throw new CalendarFreeBusyError(503, 'calendar_timeout');
    const controller = new AbortController();
    let rejectInterrupted!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const abort = () => { controller.abort(); rejectInterrupted(new CalendarFreeBusyError(503, 'calendar_timeout')); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(20_000, deadline === undefined ? 20_000 : Math.max(1, deadline - Date.now())));
    try {
      return await Promise.race([interrupted, (async () => {
      onRequest?.();
      const response = await fetcher('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: range.timeMin, timeMax: range.timeMax, timeZone: range.timeZone, items: [{ id: 'primary' }] }),
      });
      if (controller.signal.aborted) throw new CalendarFreeBusyError(503, 'calendar_timeout');
      const payload = await response.json().catch(() => null);
      if (controller.signal.aborted || deadline !== undefined && Date.now() >= deadline) throw new CalendarFreeBusyError(503, 'calendar_timeout');
      if (!response.ok) {
        const errors = payload?.error?.errors;
        const reasons: string[] = Array.isArray(errors) ? errors.map((item: { reason?: string }) => item?.reason ?? '') : [];
        const message = typeof payload?.error?.message === 'string' ? payload.error.message.toLowerCase() : '';
        const rangeError = /(?:time|date).*(?:range|period).*(?:too long|too large|exceed|maximum)/u.test(message)
          ? 'calendar_time_range_too_long' : /time.*range.*empty/u.test(message) ? 'calendar_time_range_empty'
            : /time.?zone/u.test(message) ? 'calendar_time_zone_invalid'
              : /primary/u.test(message) ? 'calendar_primary_invalid' : undefined;
        const rateLimited = response.status === 403 && reasons.some((reason) =>
          ['userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(reason));
        const permission = response.status === 401 || (response.status === 403 &&
          (reasons.some((reason) => ['insufficientPermissions', 'forbidden'].includes(reason)) || /insufficient.*scopes/u.test(message)));
        const code = reasons.some((reason) => ['accessNotConfigured', 'serviceDisabled'].includes(reason))
          ? 'calendar_api_not_enabled' : rateLimited ? 'calendar_rate_limited'
            : permission ? 'calendar_permission_required' : rangeError ?? `calendar_http_${response.status}`;
        throw new CalendarFreeBusyError(response.status, code, response.headers.get('Retry-After'));
      }
      for (const key of ['timeMin', 'timeMax'] as const) {
        const value = payload?.[key];
        if (value !== undefined && (typeof value !== 'string' || !parseGoogleCompletedAt(value)
          || Date.parse(value) !== Date.parse(range[key]))) throw new CalendarFreeBusyError(502, 'calendar_invalid_response');
      }
      const calendar = payload?.calendars?.primary;
      if (calendar?.errors != null && !Array.isArray(calendar.errors)) throw new CalendarFreeBusyError(502, 'calendar_invalid_response');
      if (Array.isArray(calendar?.errors) && calendar.errors.length) {
        const reasons = calendar.errors.map((item: { reason?: unknown } | null) => item?.reason);
        if (!reasons.every((reason: unknown) => typeof reason === 'string')) throw new CalendarFreeBusyError(502, 'calendar_invalid_response');
        if (reasons.includes('internalError')) throw new CalendarFreeBusyError(503, 'calendar_internal_error');
        if (reasons.includes('forbidden')) throw new CalendarFreeBusyError(403, 'calendar_permission_required');
        throw new CalendarFreeBusyError(400, 'calendar_item_error');
      }
      if (!calendar || !Array.isArray(calendar.busy)) throw new CalendarFreeBusyError(502, 'calendar_invalid_response');
      if (calendar.busy.length > remainingIntervals) throw new CalendarFreeBusyError(502, 'calendar_response_too_large');
      return calendar.busy.map((item: { start?: unknown; end?: unknown }) => {
        if (typeof item?.start !== 'string' || typeof item?.end !== 'string'
          || !parseGoogleCompletedAt(item.start) || !parseGoogleCompletedAt(item.end)
          || Date.parse(item.end) <= Date.parse(item.start)) throw new CalendarFreeBusyError(502, 'calendar_invalid_response');
        return { start: item.start, end: item.end };
      });
      })()]);
    } catch (error) {
      if (controller.signal.aborted) throw new CalendarFreeBusyError(503, 'calendar_timeout'); throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  return {
    async query(accessToken, range, options = {}) {
      const { timeoutMs, maxIntervals = Number.MAX_SAFE_INTEGER } = options;
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
        || options.maxIntervals !== undefined && (!Number.isSafeInteger(maxIntervals) || maxIntervals < 1 || maxIntervals > 1_000_000)) throw new CalendarFreeBusyError(400, 'calendar_invalid_query_options');
      const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
      const min = Date.parse(range.timeMin);
      const max = Date.parse(range.timeMax);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) throw new CalendarFreeBusyError(400, 'calendar_time_range_empty');
      if (options.signal?.aborted) throw new CalendarFreeBusyError(503, 'calendar_timeout');
      const controller = timeoutMs === undefined && !options.signal ? undefined : new AbortController();
      const abort = () => controller?.abort(); options.signal?.addEventListener('abort', abort, { once: true });
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller!.abort(), timeoutMs);
      try {
        const intervals: { start: string; end: string }[] = [];
        for (let start = min; start < max; start += FREEBUSY_QUERY_CHUNK_MS) {
          const chunk = await queryWindow(accessToken, { ...range,
            timeMin: new Date(start).toISOString(), timeMax: new Date(Math.min(max, start + FREEBUSY_QUERY_CHUNK_MS)).toISOString() }, deadline, maxIntervals - intervals.length, controller?.signal);
          if (controller?.signal.aborted || deadline !== undefined && Date.now() >= deadline) throw new CalendarFreeBusyError(503, 'calendar_timeout');
          // Function argument limits differ between JS engines. Do not spread an
          // unbounded API response into push(...), including on Hermes devices.
          for (const interval of chunk) intervals.push(interval);
        }
        if (controller?.signal.aborted || deadline !== undefined && Date.now() >= deadline) throw new CalendarFreeBusyError(503, 'calendar_timeout');
        return intervals;
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    },
  };
}
