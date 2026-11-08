import { daysBetween, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types';
import { assertSharedIdentifier } from '../identifier.ts';

/** Exact completion membership, without performer, timestamp, description or a retained report. */
export interface V2RotationProgress {
  choreId: string; sourceVersion: number; buckets: { index: number; bits: string }[];
}
interface ProgressEntry { choreId: string; sourceVersion: number; buckets: Map<number, bigint>; count: number }
export type V2RotationProgressIndex = Map<string, ProgressEntry>;
const counts = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
const key = (choreId: string, version: number) => JSON.stringify([choreId, version]);
const bitsCount = (bits: string) => [...bits].reduce((total, digit) => total + counts[parseInt(digit, 16)], 0);
function position(date: LocalDate) {
  parseLocalDate(date); const day = daysBetween('1970-01-01' as LocalDate, date);
  const index = Math.floor(day / 256); return { index, bit: 1n << BigInt(day - index * 256) };
}
export function validateRotationProgress(value: unknown): asserts value is V2RotationProgress[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid retained rotation progress');
  const seen = new Set<string>(); let buckets = 0;
  for (const row of value) {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'buckets,choreId,sourceVersion') throw new Error('Invalid rotation progress fields');
    assertSharedIdentifier(row.choreId);
    if (!Number.isSafeInteger(row.sourceVersion) || row.sourceVersion < 1 || !Array.isArray(row.buckets)) throw new Error('Invalid rotation progress epoch');
    const id = key(row.choreId, row.sourceVersion); if (seen.has(id)) throw new Error('Duplicate rotation progress'); seen.add(id);
    let previous = -5001;
    for (const bucket of row.buckets) {
      if (!bucket || typeof bucket !== 'object' || Object.keys(bucket).sort().join(',') !== 'bits,index'
        || !Number.isSafeInteger(bucket.index) || bucket.index <= previous || bucket.index < -5000 || bucket.index > 15000
        || typeof bucket.bits !== 'string' || !/^[0-9a-f]{64}$/u.test(bucket.bits) || /^0+$/u.test(bucket.bits)) throw new Error('Invalid rotation progress bucket');
      previous = bucket.index; if (++buckets > 8192) throw new Error('Retained rotation progress is too large');
    }
  }
}
export function rotationProgressIndex(rows: readonly V2RotationProgress[] = []): V2RotationProgressIndex {
  return new Map(rows.map(row => [key(row.choreId, row.sourceVersion), { choreId: row.choreId, sourceVersion: row.sourceVersion,
    buckets: new Map(row.buckets.map(bucket => [bucket.index, BigInt(`0x${bucket.bits}`)])), count: row.buckets.reduce((sum, bucket) => sum + bitsCount(bucket.bits), 0) }]));
}
export function markRotationCompletion(index: V2RotationProgressIndex, choreId: string, version: number, date: LocalDate) {
  const id = key(choreId, version); let entry = index.get(id);
  if (!entry) { entry = { choreId, sourceVersion: version, buckets: new Map(), count: 0 }; index.set(id, entry); }
  const positionAt = position(date); const old = entry.buckets.get(positionAt.index) ?? 0n;
  if (!(old & positionAt.bit)) { entry.buckets.set(positionAt.index, old | positionAt.bit); entry.count++; }
}
export function rotationCompletionCount(index: V2RotationProgressIndex, choreId: string, version: number, excluding: LocalDate) {
  const entry = index.get(key(choreId, version)); if (!entry) return 0;
  const at = position(excluding); return entry.count - ((entry.buckets.get(at.index) ?? 0n) & at.bit ? 1 : 0);
}
export function rotationProgressRows(index: V2RotationProgressIndex): V2RotationProgress[] {
  return [...index.values()].sort((a, b) => a.choreId < b.choreId ? -1 : a.choreId > b.choreId ? 1 : a.sourceVersion - b.sourceVersion)
    .map(entry => ({ choreId: entry.choreId, sourceVersion: entry.sourceVersion, buckets: [...entry.buckets].sort(([a], [b]) => a - b)
      .map(([index, bits]) => ({ index, bits: bits.toString(16).padStart(64, '0') })) }));
}
