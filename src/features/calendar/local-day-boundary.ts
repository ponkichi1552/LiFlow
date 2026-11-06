import moment from 'moment-timezone';
import type { LocalDate } from '../../domain/shared/types.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { v2WallTimeCandidates } from '../sharing/v2/local-time.ts';

const boundaries = new Map<string, { offsets: readonly number[]; untils: readonly number[]; days: Map<LocalDate, number> }>();

/** The same pinned tzdb as wall-clock events, including midnight gaps/folds and skipped dates. */
export function localDayBoundary(date: LocalDate, timeZone: string): number {
  const midnight = parseLocalDate(date).getTime();
  const zone = moment.tz.zone(timeZone); if (!zone) throw new RangeError('Unsupported calendar timezone');
  let cached = boundaries.get(timeZone);
  if (!cached || cached.offsets !== zone.offsets || cached.untils !== zone.untils) {
    cached = { offsets: zone.offsets, untils: zone.untils, days: new Map() }; boundaries.set(timeZone, cached);
    if (boundaries.size > 8) boundaries.delete(boundaries.keys().next().value!);
  }
  const known = cached.days.get(date); if (known !== undefined) return known;
  const candidates = v2WallTimeCandidates({ date, hour: 0, minute: 0, timeZone });
  // A date can begin at a transition instead of 00:00. A whole skipped date
  // collapses to that same transition as the following date, never a fake day.
  const civil = (instant: number) => Math.round(instant - zone.utcOffset(instant) * 60_000);
  const margin = 36 * 3600_000; const untils = zone.untils;
  let low = 0; let high = untils.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (untils[middle] < midnight - margin) low = middle + 1; else high = middle;
  }
  for (let index = low; index < untils.length && untils[index] <= midnight + margin; index++) {
    const instant = untils[index];
    if (civil(instant - 1) < midnight && civil(instant) >= midnight) candidates.push(instant);
  }
  if (!candidates.length) throw new RangeError('Cannot resolve calendar date boundary');
  const result = Math.min(...candidates);
  cached.days.set(date, result); if (cached.days.size > 1024) cached.days.delete(cached.days.keys().next().value!);
  return result;
}
