import type { LocalDate } from '../../domain/shared/types';
import type { InstantSpan } from '../../domain/scheduling/adaptive/placement';
import type { PrivateBusyBinding, PrivateBusyCache, PrivateCalendarAvailability } from '../sharing/v2/private-availability';
import { createPrivateCalendarAvailability } from '../sharing/v2/private-availability.ts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { createCalendarQueryRange } from '../google-sync/calendar-availability.ts';

/** Local-only input. Neither intervals nor account bindings belong in a group operation. */
export interface PrivateBusyPlacementInput {
  ownerUserId: string;
  connected: boolean;
  cache: PrivateBusyCache | null;
  binding: PrivateBusyBinding | null;
}

/** Preserve exact busy intervals; missing/stale coverage cannot authorize an invented free slot. */
export function privateBusyPlacement(input: PrivateBusyPlacementInput | undefined, ownerUserId: string | null,
  from: LocalDate, through: LocalDate, timeZone: string, now: number): { busy: InstantSpan[]; opaqueDates: LocalDate[] } {
  if (!input) return { busy: [], opaqueDates: [] };
  if (!ownerUserId || input.ownerUserId !== ownerUserId || input.cache && input.cache.ownerUserId !== ownerUserId
    || input.binding && input.binding.ownerUserId !== ownerUserId) throw new Error('本人のCalendar情報を確認してください。');
  if (!input.connected) return { busy: [], opaqueDates: [] };
  const read: PrivateCalendarAvailability | null = input.binding ? createPrivateCalendarAvailability(input.cache, input.binding, now) : null;
  const opaqueDates: LocalDate[] = [];
  const target = (start: string, end: string) => ({ precision: 'interval' as const, start, end });
  for (let date = from; date <= through; date = addDays(date, 1)) {
    const range = createCalendarQueryRange(date, date, timeZone);
    if (!read || read(target(range.timeMin, range.timeMax)).conflict.kind === 'unknown') opaqueDates.push(date);
  }
  const range = createCalendarQueryRange(from, through, timeZone);
  return { busy: read?.ranges?.(target(range.timeMin, range.timeMax)) ?? [], opaqueDates };
}
