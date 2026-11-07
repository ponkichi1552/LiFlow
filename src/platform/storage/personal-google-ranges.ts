import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types';
import { addDays, daysBetween, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { googleExpansionRange } from './personal-google-store.ts';

export type GoogleExpansionRange = { timeMin: string; timeMax: string };
export function mergeGoogleExpansionRanges(a: GoogleExpansionRange, b: GoogleExpansionRange): GoogleExpansionRange {
  return { timeMin: a.timeMin < b.timeMin ? a.timeMin : b.timeMin, timeMax: a.timeMax > b.timeMax ? a.timeMax : b.timeMax };
}
export function googleRangeContains(a: GoogleExpansionRange, b: GoogleExpansionRange) { return a.timeMin <= b.timeMin && a.timeMax >= b.timeMax; }
export function missingGoogleExpansionRanges(covered: GoogleExpansionRange, desired: GoogleExpansionRange): GoogleExpansionRange[] {
  return [...(desired.timeMin < covered.timeMin ? [{ timeMin: desired.timeMin, timeMax: covered.timeMin }] : []),
    ...(desired.timeMax > covered.timeMax ? [{ timeMin: covered.timeMax, timeMax: desired.timeMax }] : [])];
}
export async function desiredGoogleExpansionRange(tx: SQLiteDatabase, subject: string, today: LocalDate): Promise<GoogleExpansionRange> {
  const row = await tx.getFirstAsync<{ range_json: string }>('SELECT range_json FROM calendar_google_requested_ranges WHERE subject=?', subject);
  const initial = googleExpansionRange(today);
  return row ? mergeGoogleExpansionRanges(initial, JSON.parse(row.range_json)) : initial;
}
/** A display request is durable but never holds navigation open or changes an event. */
export async function retainGoogleDisplayRange(tx: SQLiteDatabase, subject: string, from: LocalDate, through: LocalDate): Promise<boolean> {
  parseLocalDate(from); parseLocalDate(through);
  if (from > through || daysBetween(from, through) > 400) throw new Error('表示する期間を確認してください。');
  // UTC padding covers the earliest and latest local timezones, including multi-day instances.
  const requested = { timeMin: `${addDays(from, -2)}T00:00:00Z`, timeMax: `${addDays(through, 3)}T00:00:00Z` };
  const prior = await tx.getFirstAsync<{ range_json: string }>('SELECT range_json FROM calendar_google_requested_ranges WHERE subject=?', subject);
  const previous = prior ? JSON.parse(prior.range_json) as GoogleExpansionRange : null;
  if (previous && googleRangeContains(previous, requested)) return false;
  const next = previous ? mergeGoogleExpansionRanges(previous, requested) : requested;
  await tx.runAsync('INSERT INTO calendar_google_requested_ranges(subject,range_json) VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET range_json=excluded.range_json', subject, JSON.stringify(next));
  return true;
}
