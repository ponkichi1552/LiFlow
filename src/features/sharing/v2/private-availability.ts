import { CALENDAR_AVAILABILITY_MAX_AGE_MS } from '../../google-sync/calendar-timing.ts';
import { fixedInterval, instantMilliseconds } from './date-target.ts';
import type { DateTarget, InstantRange } from './model.ts';
import { isSharedTimeZone } from '../group-clock.ts';
import { assertSharedIdentifier } from '../identifier.ts';

/** Private account data. This type is never an allowed shared-operation payload. */
export interface PrivateBusyCache {
  ownerUserId: string;
  accountGeneration: string;
  mainDeviceId: string;
  mainRevision: number;
  calendarBinding: string;
  timeZone: string;
  fetchedAt: string;
  coverage: { start: string; end: string };
  intervals: { start: string; end: string }[];
}
export type PrivateBusyBinding = Pick<PrivateBusyCache, 'ownerUserId' | 'accountGeneration' | 'mainDeviceId' | 'mainRevision' | 'calendarBinding'>;
export type CalendarConflict = { kind: 'conflict' | 'clear' } | { kind: 'unknown'; reason: 'missing' | 'binding' | 'stale' | 'coverage' | 'invalid' | 'timeNotSpecified' };

export function mergeInstantRanges(input: readonly InstantRange[]): InstantRange[] {
  const sorted = input.map((range) => {
    if (![range.start, range.end].every(Number.isFinite) || range.start >= range.end) throw new Error('無効な時間帯です。');
    return { ...range };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: InstantRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}
export function validatedPrivateBusyIntervals(cache: PrivateBusyCache): InstantRange[] {
  if (Object.keys(cache).sort().join(',') !== 'accountGeneration,calendarBinding,coverage,fetchedAt,intervals,mainDeviceId,mainRevision,ownerUserId,timeZone'
    || !isSharedTimeZone(cache.timeZone) || !Array.isArray(cache.intervals) || cache.intervals.length > 20_000
    || !Number.isSafeInteger(cache.mainRevision) || cache.mainRevision < 1) throw new Error('本人用Calendar情報を確認できません。');
  for (const name of ['ownerUserId', 'accountGeneration', 'mainDeviceId', 'calendarBinding'] as const) assertSharedIdentifier(cache[name]);
  if (Object.keys(cache.coverage).sort().join(',') !== 'end,start') throw new Error('Calendarの取得範囲が無効です。');
  const start = instantMilliseconds(cache.coverage.start); const end = instantMilliseconds(cache.coverage.end);
  if (start >= end) throw new Error('Calendarの取得範囲が無効です。');
  return mergeInstantRanges(cache.intervals.map((interval) => {
    if (Object.keys(interval).sort().join(',') !== 'end,start') throw new Error('Calendarの時間帯が無効です。');
    const from = instantMilliseconds(interval.start); const through = instantMilliseconds(interval.end);
    if (from >= through) throw new Error('Calendarの時間帯が無効です。');
    return { start: Math.max(from, start), end: Math.min(through, end) };
  }).filter((range) => range.start < range.end));
}
/** A local, account-bound check returns only the result, never the private intervals. */
export interface PrivateCalendarReading { conflict: CalendarConflict; busyMinutes: number | null }
export type PrivateCalendarAvailability = ((target: DateTarget) => PrivateCalendarReading) & { ranges?: (target: DateTarget) => InstantRange[] };

/** Local readers share interval and half-open boundary handling, without inventing an OAuth binding. */
export function createIntervalCalendarAvailability(intervals: readonly InstantRange[], coverage: InstantRange): PrivateCalendarAvailability {
  if (![coverage.start, coverage.end].every(Number.isFinite) || coverage.start >= coverage.end) throw new Error('Calendarの取得範囲が無効です。');
  const busy = mergeInstantRanges(intervals);
  const ranges = (target: DateTarget) => {
    const interval = fixedInterval(target); if (!interval) return [];
    let low = 0; let high = busy.length;
    while (low < high) { const middle = (low + high) >>> 1; if (busy[middle].end <= interval.start) low = middle + 1; else high = middle; }
    const result: InstantRange[] = [];
    for (let index = low; index < busy.length && busy[index].start < interval.end; index++) {
      result.push({ start: Math.max(busy[index].start, interval.start), end: Math.min(busy[index].end, interval.end) });
    }
    return result;
  };
  const read: PrivateCalendarAvailability = target => {
    try {
      const interval = fixedInterval(target);
      if (!interval) return { conflict: { kind: 'unknown', reason: 'timeNotSpecified' }, busyMinutes: null };
      if (coverage.start > interval.start || coverage.end < interval.end) return { conflict: { kind: 'unknown', reason: 'coverage' }, busyMinutes: null };
      const duration = ranges(target).reduce((total, part) => total + part.end - part.start, 0);
      return { conflict: { kind: duration > 0 ? 'conflict' : 'clear' }, busyMinutes: duration / 60_000 };
    } catch { return { conflict: { kind: 'unknown', reason: 'invalid' }, busyMinutes: null }; }
  };
  read.ranges = ranges; return read;
}
export function combineCalendarConflicts(first: CalendarConflict, second: CalendarConflict): CalendarConflict {
  if (first.kind === 'conflict' || second.kind === 'conflict') return { kind: 'conflict' };
  return first.kind === 'unknown' ? first : second;
}
/** Union exact private ranges when present; aggregate-only inputs use the larger count to avoid duplication. */
export function combinePrivateCalendarAvailability(first: PrivateCalendarAvailability | undefined, second: PrivateCalendarAvailability | undefined): PrivateCalendarAvailability {
  if (!first) return second ?? (() => ({ conflict: { kind: 'unknown', reason: 'missing' }, busyMinutes: null }));
  if (!second) return first;
  return target => {
    const a = first(target); const b = second(target);
    const exact = a.busyMinutes !== null && b.busyMinutes !== null && first.ranges && second.ranges
      ? mergeInstantRanges([...first.ranges(target), ...second.ranges(target)]).reduce((sum, part) => sum + (part.end - part.start) / 60_000, 0) : null;
    return { conflict: combineCalendarConflicts(a.conflict, b.conflict), busyMinutes: exact ?? (a.busyMinutes === null && b.busyMinutes === null ? null : Math.max(a.busyMinutes ?? 0, b.busyMinutes ?? 0)) };
  };
}
export function createPrivateCalendarAvailability(cache: PrivateBusyCache | null, expected: PrivateBusyBinding, now: number): (target: DateTarget) => PrivateCalendarReading {
  const unknown = (reason: Extract<CalendarConflict, { kind: 'unknown' }>['reason']) => () => ({ conflict: { kind: 'unknown' as const, reason }, busyMinutes: null });
  if (!cache) return unknown('missing');
  if (!['ownerUserId', 'accountGeneration', 'mainDeviceId', 'calendarBinding'].every((key) => typeof expected[key as keyof PrivateBusyBinding] === 'string'
    && expected[key as keyof PrivateBusyBinding] !== '') || !Number.isSafeInteger(expected.mainRevision) || expected.mainRevision < 1) return unknown('binding');
  if (Object.entries(expected).some(([key, value]) => cache[key as keyof PrivateBusyBinding] !== value)) return unknown('binding');
  try {
    const fetchedAt = instantMilliseconds(cache.fetchedAt);
    if (!Number.isFinite(now) || fetchedAt > now || now - fetchedAt > CALENDAR_AVAILABILITY_MAX_AGE_MS) return unknown('stale');
    const busy = validatedPrivateBusyIntervals(cache);
    const coverage = { start: instantMilliseconds(cache.coverage.start), end: instantMilliseconds(cache.coverage.end) };
    return createIntervalCalendarAvailability(busy, coverage);
  } catch { return unknown('invalid'); }
}
export function createPrivateCalendarReader(cache: PrivateBusyCache | null, expected: PrivateBusyBinding, now: number): (target: DateTarget) => CalendarConflict {
  const read = createPrivateCalendarAvailability(cache, expected, now); return (target) => read(target).conflict;
}
export function checkPrivateCalendarConflict(cache: PrivateBusyCache | null, expected: PrivateBusyBinding, target: DateTarget, now: number): CalendarConflict {
  return createPrivateCalendarReader(cache, expected, now)(target);
}
