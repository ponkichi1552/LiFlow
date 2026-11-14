import data from './japanese-holidays-data.json';
import { addDays } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types.ts';

// Cabinet Office published dates, bundled for offline display. They are not
// calendar events, availability blocks, personal settings, or sync payloads.
const years: Readonly<Record<string, Readonly<Record<string, string>>>> = data.years;
export const JAPANESE_HOLIDAY_COVERAGE = { from: `${data.from.slice(0, 4)}-01-01`, through: `${data.through.slice(0, 4)}-12-31` };
const rawName = (day: string) => years[day.slice(0, 4)]?.[day];

export function japanesePublicHoliday(day: LocalDate): string | null {
  const name = rawName(day);
  if (!name) return null;
  if (name !== '休日') return name;
  const before = rawName(addDays(day, -1)); const after = rawName(addDays(day, 1));
  return before && before !== '休日' && after && after !== '休日' ? '国民の休日' : '振替休日';
}
