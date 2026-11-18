import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types';
import { addDays, daysBetween, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { googleExpansionRange } from './personal-google-store.ts';

export type GoogleExpansionRange = { timeMin: string; timeMax: string };
export type GoogleExpansionRangeSet = readonly GoogleExpansionRange[];

function isRange(value: unknown): value is GoogleExpansionRange {
  if (!value || typeof value !== 'object') return false;
  const row = value as { timeMin?: unknown; timeMax?: unknown };
  return typeof row.timeMin === 'string' && typeof row.timeMax === 'string' && row.timeMin < row.timeMax
    && Number.isFinite(Date.parse(row.timeMin)) && Number.isFinite(Date.parse(row.timeMax));
}

/** Old databases stored one interval. New ones store a sorted disjoint set. */
export function parseGoogleExpansionRanges(value: unknown): GoogleExpansionRange[] {
  const rows = Array.isArray(value) ? value : [value];
  return normalizeGoogleExpansionRanges(rows.filter(isRange));
}

export function parseGoogleExpansionRangeQueue(value: unknown): GoogleExpansionRange[] {
  const rows = Array.isArray(value) ? value : [value];
  const result: GoogleExpansionRange[] = [];
  for (const row of rows) if (isRange(row) && !result.some(existing => existing.timeMin === row.timeMin && existing.timeMax === row.timeMax))
    result.push({ timeMin: row.timeMin, timeMax: row.timeMax });
  return result;
}

export function normalizeGoogleExpansionRanges(ranges: GoogleExpansionRangeSet): GoogleExpansionRange[] {
  const sorted = ranges.filter(isRange).map(row => ({ timeMin: row.timeMin, timeMax: row.timeMax }))
    .sort((a, b) => a.timeMin.localeCompare(b.timeMin) || a.timeMax.localeCompare(b.timeMax));
  const result: GoogleExpansionRange[] = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.timeMin <= previous.timeMax) previous.timeMax = range.timeMax > previous.timeMax ? range.timeMax : previous.timeMax;
    else result.push(range);
  }
  return result;
}

export function mergeGoogleExpansionRangeSets(a: GoogleExpansionRangeSet, b: GoogleExpansionRangeSet): GoogleExpansionRange[] {
  return normalizeGoogleExpansionRanges([...a, ...b]);
}

export function prioritizeGoogleExpansionRange(ranges: GoogleExpansionRangeSet, priority: GoogleExpansionRange | null | undefined): GoogleExpansionRange[] {
  const normalized = normalizeGoogleExpansionRanges(ranges);
  if (!priority) return normalized;
  const index = normalized.findIndex(range => range.timeMin <= priority.timeMin && range.timeMax >= priority.timeMax);
  return index <= 0 ? normalized : [normalized[index], ...normalized.slice(0, index), ...normalized.slice(index + 1)];
}

export function missingGoogleExpansionRanges(covered: GoogleExpansionRangeSet, desired: GoogleExpansionRangeSet): GoogleExpansionRange[] {
  const existing = normalizeGoogleExpansionRanges(covered);
  const missing: GoogleExpansionRange[] = [];
  for (const wanted of normalizeGoogleExpansionRanges(desired)) {
    let cursor = wanted.timeMin;
    for (const range of existing) {
      if (range.timeMax <= cursor) continue;
      if (range.timeMin >= wanted.timeMax) break;
      if (range.timeMin > cursor) missing.push({ timeMin: cursor, timeMax: range.timeMin < wanted.timeMax ? range.timeMin : wanted.timeMax });
      if (range.timeMax > cursor) cursor = range.timeMax;
      if (cursor >= wanted.timeMax) break;
    }
    if (cursor < wanted.timeMax) missing.push({ timeMin: cursor, timeMax: wanted.timeMax });
  }
  return normalizeGoogleExpansionRanges(missing);
}

export function googleExpansionRangesContain(covered: GoogleExpansionRangeSet, desired: GoogleExpansionRangeSet) {
  return missingGoogleExpansionRanges(covered, desired).length === 0;
}

/** Legacy bounding ranges longer than a year may contain unscanned gaps from the old merge behavior. */
export function storedGoogleExpansionCoverage(coveredJson: string | null | undefined, legacyRangeJson: string): GoogleExpansionRange[] {
  if (coveredJson) return parseGoogleExpansionRanges(JSON.parse(coveredJson));
  const legacy = parseGoogleExpansionRanges(JSON.parse(legacyRangeJson));
  return legacy.filter(range => {
    const start = range.timeMin.slice(0, 10) as LocalDate;
    const end = range.timeMax.slice(0, 10) as LocalDate;
    try { return daysBetween(start, end) <= 400; } catch { return false; }
  });
}

export async function desiredGoogleExpansionRanges(tx: SQLiteDatabase, subject: string, today: LocalDate): Promise<GoogleExpansionRange[]> {
  const row = await tx.getFirstAsync<{ range_json: string; current_range_json: string | null }>('SELECT range_json,current_range_json FROM calendar_google_requested_ranges WHERE subject=?', subject);
  const requested = row ? parseGoogleExpansionRanges(JSON.parse(row.range_json)) : [];
  const current = row?.current_range_json ? parseGoogleExpansionRanges(JSON.parse(row.current_range_json))[0] : undefined;
  return prioritizeGoogleExpansionRange(mergeGoogleExpansionRangeSets([googleExpansionRange(today)], requested), current);
}

/** A display request is durable but never holds navigation open or changes an event. */
export async function retainGoogleDisplayRange(tx: SQLiteDatabase, subject: string, from: LocalDate, through: LocalDate): Promise<boolean> {
  parseLocalDate(from); parseLocalDate(through);
  if (from > through || daysBetween(from, through) > 400) throw new Error('表示する期間を確認してください。');
  // UTC padding covers the earliest and latest local timezones, including multi-day instances.
  const requested = { timeMin: `${addDays(from, -2)}T00:00:00Z`, timeMax: `${addDays(through, 3)}T00:00:00Z` };
  const prior = await tx.getFirstAsync<{ range_json: string; current_range_json: string | null }>('SELECT range_json,current_range_json FROM calendar_google_requested_ranges WHERE subject=?', subject);
  const previous = prior ? parseGoogleExpansionRanges(JSON.parse(prior.range_json)) : [];
  const priorityChanged = JSON.stringify(prior?.current_range_json ? parseGoogleExpansionRanges(JSON.parse(prior.current_range_json))[0] : null) !== JSON.stringify(requested);
  const added = missingGoogleExpansionRanges(previous, [requested]).length > 0;
  if (!added && !priorityChanged) return false;
  const next = mergeGoogleExpansionRangeSets(previous, [requested]);
  await tx.runAsync(`INSERT INTO calendar_google_requested_ranges(subject,range_json,current_range_json) VALUES(?,?,?)
    ON CONFLICT(subject) DO UPDATE SET range_json=excluded.range_json,current_range_json=excluded.current_range_json`, subject, JSON.stringify(next), JSON.stringify(requested));
  // A visible-range preference also controls which missing interval is scanned
  // first. Updating it inside existing requested coverage must not schedule a
  // redundant remote sync by itself.
  return added;
}
