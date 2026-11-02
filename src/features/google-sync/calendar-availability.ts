import type { LocalDate } from '@/domain/shared/types';
import type { ExternalAvailabilityByDate } from '@/domain/scheduling/contracts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { parseGoogleCompletedAt } from './google-completion-policy.ts';
import { busyMinutesToBucket } from '../../domain/scheduling/calendar-penalty.ts';
import { CALENDAR_AVAILABILITY_MAX_AGE_MS, CALENDAR_REFRESH_INTERVAL_MS } from './calendar-timing.ts';

export { CALENDAR_AVAILABILITY_MAX_AGE_MS, CALENDAR_REFRESH_INTERVAL_MS, CALENDAR_RETRY_INTERVAL_MS } from './calendar-timing.ts';

/** Only changes that alter the Scheduler penalty require a new plan; freshness metadata is excluded. */
export function calendarAvailabilitySignature(availability: ExternalAvailabilityByDate | undefined): string {
  return JSON.stringify(Object.entries(availability ?? {})
    .map(([date, day]) => [date, busyMinutesToBucket(day?.busyMinutes)] as const)
    .filter(([, bucket]) => bucket > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

export const GOOGLE_CALENDAR_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
export type CalendarAvailabilityStatus = 'idle' | 'syncing' | 'retryPending' | 'permissionRequired' | 'error';

export interface CalendarAvailabilityState {
  householdId: string;
  enabled: boolean;
  status: CalendarAvailabilityStatus;
  retryCount: number;
  lastAttemptAt?: string;
  lastSuccessfulSyncAt?: string;
  nextRetryAt?: string;
  lastErrorCode?: string;
  updatedAt: string;
}

export interface CalendarAvailabilityDay {
  localDate: LocalDate;
  busyMinutes: number;
  timeZone: string;
  fetchedAt: string;
}

export interface CalendarQueryRange {
  from: LocalDate;
  through: LocalDate;
  timeMin: string;
  timeMax: string;
  timeZone: string;
}

export class CalendarPermissionRequiredError extends Error {
  constructor() {
    super('Calendar availability permission is required');
    this.name = 'CalendarPermissionRequiredError';
  }
}

export function getDeviceTimeZone(): string {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone || 'UTC';
  } catch { return 'UTC'; }
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const dayBoundaries = new WeakMap<Intl.DateTimeFormat, Map<LocalDate, number>>();
function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(timeZone, formatter);
    if (dateFormatters.size > 8) dateFormatters.delete(dateFormatters.keys().next().value!);
  }
  return formatter;
}

function formattedDate(formatter: Intl.DateTimeFormat, instant: number): LocalDate {
  const parts = formatter.formatToParts(instant);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}` as LocalDate;
}

/** First instant of a local day; date comparisons also handle 23/25-hour DST days. */
function dayStart(date: LocalDate, formatter: Intl.DateTimeFormat): number {
  const utc = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) throw new RangeError('Invalid local date');
  const known = dayBoundaries.get(formatter) ?? new Map<LocalDate, number>();
  const cached = known.get(date); if (cached !== undefined) return cached;
  let low = utc - 36 * 60 * 60 * 1000;
  let high = utc + 36 * 60 * 60 * 1000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (formattedDate(formatter, mid) < date) low = mid + 1;
    else high = mid;
  }
  known.set(date, low); if (known.size > 1024) known.delete(known.keys().next().value!);
  dayBoundaries.set(formatter, known); return low;
}

export function createCalendarQueryRange(from: LocalDate, through: LocalDate, timeZone: string): CalendarQueryRange {
  if (from > through) throw new RangeError('Invalid calendar query coverage');
  const formatter = dateFormatter(timeZone);
  return { from, through, timeZone,
    timeMin: new Date(dayStart(from, formatter)).toISOString(),
    timeMax: new Date(dayStart(addDays(through, 1), formatter)).toISOString() };
}

/** Raw intervals only exist in memory. Invalid data fails the refresh instead of inventing free time. */
export function aggregateBusyMinutes(
  busy: readonly { start: string; end: string }[], range: CalendarQueryRange, fetchedAt: string,
): CalendarAvailabilityDay[] {
  const min = Date.parse(range.timeMin);
  const max = Date.parse(range.timeMax);
  const intervals = busy.map((item) => {
    const start = parseGoogleCompletedAt(item.start);
    const end = parseGoogleCompletedAt(item.end);
    if (!start || !end || Date.parse(end) <= Date.parse(start)) throw new Error('Invalid calendar busy interval');
    return { start: Math.max(min, Date.parse(start)), end: Math.min(max, Date.parse(end)) };
  }).filter((item) => item.start < item.end).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const item of intervals) {
    const previous = merged.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  const formatter = dateFormatter(range.timeZone);
  const days: CalendarAvailabilityDay[] = [];
  let start = min;
  let intervalIndex = 0;
  for (let date = range.from; date <= range.through; date = addDays(date, 1)) {
    const end = dayStart(addDays(date, 1), formatter);
    let milliseconds = 0;
    // Both days and merged intervals are ordered. Consume each interval once,
    // retaining one that crosses midnight for the next day (including DST).
    while (intervalIndex < merged.length && merged[intervalIndex].start < end) {
      const interval = merged[intervalIndex];
      milliseconds += Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start));
      if (interval.end > end) break;
      intervalIndex += 1;
    }
    days.push({ localDate: date, busyMinutes: Math.ceil(milliseconds / 60_000), timeZone: range.timeZone, fetchedAt });
    start = end;
  }
  return days;
}

export function freshCalendarAvailability(
  state: CalendarAvailabilityState | null, days: readonly CalendarAvailabilityDay[], now: Date, timeZone: string,
): ExternalAvailabilityByDate | undefined {
  if (!state?.enabled) return undefined;
  const entries = days.filter((day) => {
    const fetched = Date.parse(day.fetchedAt);
    return day.timeZone === timeZone && Number.isFinite(fetched)
      && fetched <= now.getTime() && now.getTime() - fetched <= CALENDAR_AVAILABILITY_MAX_AGE_MS
      && Number.isInteger(day.busyMinutes) && day.busyMinutes >= 0;
  }).map((day) => [day.localDate, { busyMinutes: day.busyMinutes }] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function shouldRefreshCalendar(state: CalendarAvailabilityState | null, now: Date, force = false): boolean {
  if (!state?.enabled) return false;
  if (force) return true;
  if (state.status === 'permissionRequired' || state.status === 'error') return false;
  if (state.status === 'syncing') {
    const attempted = Date.parse(state.lastAttemptAt ?? '');
    return !Number.isFinite(attempted) || attempted > now.getTime() || attempted + 10 * 60 * 1000 <= now.getTime();
  }
  if (state.status === 'retryPending') {
    const retry = Date.parse(state.nextRetryAt ?? '');
    return !Number.isFinite(retry) || retry <= now.getTime();
  }
  const successful = Date.parse(state.lastSuccessfulSyncAt ?? '');
  return !Number.isFinite(successful) || successful > now.getTime() || successful + CALENDAR_REFRESH_INTERVAL_MS <= now.getTime();
}
