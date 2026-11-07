import type { LocalDate, Weekday } from '../../domain/shared/types';
import type { CalendarEvent, CalendarException } from '../../domain/calendar/events';
import type { AdaptivePlacementDay, InstantSpan } from '../../domain/scheduling/adaptive/placement';
import { unionInstantSpans } from '../../domain/scheduling/adaptive/placement.ts';
import { addDays, daysBetween, parseLocalDate, weekdayOf } from '../../domain/scheduling/local-date.ts';
import { localCalendarIntervals } from '../calendar/local-availability.ts';
import { createCalendarQueryRange } from '../google-sync/calendar-availability.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';
import type { MetForecast } from '../../../server/appliance-care-api/src/weather/forecast.mjs';

export interface AdaptiveAllowedBand { startMinute: number; endMinute: number }
export interface AdaptiveDayOverride {
  date: LocalDate; holiday?: boolean; maximumMinutes?: number; allowedBands?: readonly AdaptiveAllowedBand[];
}
export interface AdaptiveLocalPreferences {
  restDays: readonly Weekday[]; heavyLimit: number; normalLimit: number; maximumMinutes?: number;
  allowedBands: readonly (AdaptiveAllowedBand & { weekday: Weekday })[];
  dayOverrides: readonly AdaptiveDayOverride[];
}
const checkMinutes = (value: number | undefined) => value === undefined || Number.isFinite(value) && value >= 0;
function checkedBands(bands: readonly AdaptiveAllowedBand[]) {
  if (!Array.isArray(bands) || bands.length > 56 || bands.some(band => !Number.isSafeInteger(band.startMinute)
    || !Number.isSafeInteger(band.endMinute) || band.startMinute < 0 || band.endMinute > 1440 || band.startMinute >= band.endMinute)) throw new Error('家事の実施可能時間帯を確認してください。');
  return bands;
}

/** Private, offline-capable geometry; it never sends calendar contents or requires a login. */
export function prepareAdaptivePlacementInput(input: {
  from: LocalDate; through: LocalDate; timeZone: string; preferences: AdaptiveLocalPreferences;
  events: readonly CalendarEvent[]; exceptions: readonly CalendarException[]; busy?: readonly InstantSpan[];
  weatherForecast?: MetForecast;
  fingerprint(value: unknown): string;
}) {
  parseLocalDate(input.from); parseLocalDate(input.through);
  if (input.from > input.through || daysBetween(input.from, input.through) > 366) throw new Error('家事を配置する期間を確認してください。');
  const own = input.preferences;
  if (!Array.isArray(own.restDays) || own.restDays.length > 7 || own.restDays.some(day => !Number.isSafeInteger(day) || day < 1 || day > 7)
    || !Number.isSafeInteger(own.heavyLimit) || own.heavyLimit < 0 || !Number.isSafeInteger(own.normalLimit) || own.normalLimit < 0
    || !checkMinutes(own.maximumMinutes) || !Array.isArray(own.dayOverrides) || own.dayOverrides.length > 3660) throw new Error('休日と日別の家事設定を確認してください。');
  checkedBands(own.allowedBands);
  const weekdayBands = new Map<Weekday, AdaptiveAllowedBand[]>();
  for (const band of own.allowedBands) {
    if (!Number.isSafeInteger(band.weekday) || band.weekday < 1 || band.weekday > 7) throw new Error('時間帯の曜日を確認してください。');
    weekdayBands.set(band.weekday, [...(weekdayBands.get(band.weekday) ?? []), band]);
  }
  const overrides = new Map<LocalDate, AdaptiveDayOverride>();
  for (const day of own.dayOverrides) {
    parseLocalDate(day.date);
    if (overrides.has(day.date) || day.holiday !== undefined && typeof day.holiday !== 'boolean' || !checkMinutes(day.maximumMinutes)) throw new Error('日別の休日・時間設定を確認してください。');
    if (day.allowedBands !== undefined) checkedBands(day.allowedBands); overrides.set(day.date, day);
  }
  const days: AdaptivePlacementDay[] = []; const unresolvedDates: LocalDate[] = [];
  for (let date = input.from; date <= input.through; date = addDays(date, 1)) {
    const range = createCalendarQueryRange(date, date, input.timeZone);
    const bounds = { start: Date.parse(range.timeMin), end: Date.parse(range.timeMax) };
    if (bounds.start >= bounds.end) { unresolvedDates.push(date); continue; }
    const override = overrides.get(date); const weekday = weekdayOf(date);
    const holiday = override?.holiday ?? own.restDays.includes(weekday);
    // An explicit empty day override forbids work. An unconfigured holiday alone
    // receives the agreed 09–19 fallback; unknown weekdays never receive fake hours.
    const bands = override?.allowedBands ?? weekdayBands.get(weekday) ?? (holiday ? [{ startMinute: 540, endMinute: 1140 }] : []);
    const allowed: InstantSpan[] = []; let unresolved = false;
    for (const band of bands) {
      const at = (value: number) => v2WallTimeCandidates({ date: value === 1440 ? addDays(date, 1) : date,
        hour: value === 1440 ? 0 : Math.floor(value / 60), minute: value % 60, timeZone: input.timeZone });
      const start = at(band.startMinute); const end = at(band.endMinute);
      if (start.length !== 1 || end.length !== 1 || start[0] >= end[0]) { unresolved = true; break; }
      allowed.push({ start: start[0], end: end[0] });
    }
    if (unresolved) unresolvedDates.push(date);
    days.push({ date, bounds, allowed: unresolved ? [] : unionInstantSpans(allowed), holiday,
      maximumMinutes: override?.maximumMinutes ?? own.maximumMinutes, heavyLimit: own.heavyLimit, normalLimit: own.normalLimit });
  }
  const busy = unionInstantSpans([...localCalendarIntervals(input.events, input.exceptions, input.from, input.through, input.timeZone), ...(input.busy ?? [])]);
  const holidaysConfigured = own.restDays.length > 0 || days.some(day => day.holiday);
  // Exact intervals, not daily totals: moving an equally long event can invalidate a slot.
  const revision = input.fingerprint(['adaptive-input-v1', input.timeZone, days, busy, holidaysConfigured]);
  return { days, busy, holidaysConfigured, unresolvedDates, revision, ...(input.weatherForecast ? { weatherForecast: input.weatherForecast } : {}) };
}
