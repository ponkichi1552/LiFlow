import type { SQLiteDatabase } from 'expo-sqlite';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { PrivateCalendarCryptoGateway } from '../../features/sharing/private-calendar/crypto-gateway.ts';
import { exactRecord, hexBytes } from '../../features/sharing/private-calendar/validation.ts';
import { assertPrivateCalendarDeliveryFailure, privateCalendarDeliveryRetry } from '../../features/sharing/private-calendar/delivery-retry.ts';
import type { PrivateCalendarDeliveryFailure } from '../../features/sharing/private-calendar/delivery-retry.ts';
import { PRIVATE_CALENDAR_REFRESH_MS } from '../../features/sharing/private-calendar/sync-deadline.ts';

export const PRIVATE_CALENDAR_ACQUISITION_LEASE_MS = 120_000;
export { PRIVATE_CALENDAR_REFRESH_MS } from '../../features/sharing/private-calendar/sync-deadline.ts';
export interface PrivateCalendarAcquisitionLease {
  token: string; authorityDigest: string; rangeDigest: string; startedAt: number; expiresAt: number;
}
interface AcquisitionRow {
  authority_digest: string; range_digest: string; token: string | null; started_at: number; expires_at: number | null;
  attempts: number; retry_at: number | null; failure_code: string | null; success_at: number | null; manifest_digest: string | null;
}
const table = `CREATE TABLE IF NOT EXISTS private_calendar_acquisition (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'current'), authority_digest TEXT NOT NULL, range_digest TEXT NOT NULL,
  token TEXT, started_at INTEGER NOT NULL, expires_at INTEGER, attempts INTEGER NOT NULL,
  retry_at INTEGER, failure_code TEXT, success_at INTEGER, manifest_digest TEXT
)`;
function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000 - 86_400_000) throw new Error('Calendarの取得時刻を確認できません。');
}
export function snapshotPrivateCalendarAcquisitionLease(input: PrivateCalendarAcquisitionLease) {
  exactRecord(input, ['token', 'authorityDigest', 'rangeDigest', 'startedAt', 'expiresAt']);
  const owned = { ...input }; hexBytes(owned.token, 16); hexBytes(owned.authorityDigest, 32); hexBytes(owned.rangeDigest, 32);
  timestamp(owned.startedAt); timestamp(owned.expiresAt);
  if (owned.expiresAt - owned.startedAt !== PRIVATE_CALENDAR_ACQUISITION_LEASE_MS) throw new Error('Calendarの取得処理を確認できません。');
  return owned;
}
async function read(db: SQLiteDatabase) {
  await db.execAsync(table);
  const row = await db.getFirstAsync<AcquisitionRow>("SELECT authority_digest, range_digest, token, started_at, expires_at, attempts, retry_at, failure_code, success_at, manifest_digest FROM private_calendar_acquisition WHERE id = 'current'");
  if (!row) return null;
  hexBytes(row.authority_digest, 32); hexBytes(row.range_digest, 32); timestamp(row.started_at);
  if (!Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 1_000_000) throw new Error('Calendarの取得履歴を確認できません。');
  for (const value of [row.expires_at, row.retry_at, row.success_at]) if (value !== null) timestamp(value);
  if (row.failure_code !== null) assertPrivateCalendarDeliveryFailure(row.failure_code as PrivateCalendarDeliveryFailure);
  if (row.manifest_digest !== null) hexBytes(row.manifest_digest, 32);
  if ((row.token === null) !== (row.expires_at === null) || (row.success_at === null) !== (row.manifest_digest === null)) throw new Error('Calendarの取得履歴を確認できません。');
  if (row.token !== null) snapshotPrivateCalendarAcquisitionLease({ token: row.token, authorityDigest: row.authority_digest,
    rangeDigest: row.range_digest, startedAt: row.started_at, expiresAt: row.expires_at! });
  return row;
}

/** Called only under the same owner/authority checked writer transaction as the encrypted cache. */
export async function beginPrivateCalendarAcquisition(db: SQLiteDatabase, crypto: PrivateCalendarCryptoGateway, input: {
  authorityDigest: string; rangeDigest: string; now: number; force: boolean; automatic: boolean; randomFraction: number; currentManifestDigest: string | null;
}) {
  hexBytes(input.authorityDigest, 32); hexBytes(input.rangeDigest, 32); timestamp(input.now);
  const before = await read(db);
  // The same monotonic lease cannot still be valid in a clock epoch before it
  // began. Its completion is fenced by token and start time after replacement.
  const row = before?.authority_digest === input.authorityDigest && before.started_at <= input.now ? before : null;
  // An explicit retry may bypass a failure's delay, but must not steal a running query from another VM.
  if (row?.token && row.expires_at! > input.now) return { kind: 'inProgress' as const, retryAt: row.expires_at! };
  if (row?.retry_at !== null && row?.retry_at !== undefined && row.retry_at > input.now && !input.force) return { kind: 'waiting' as const, retryAt: row.retry_at };
  if (input.automatic && !input.force && row?.success_at !== null && row?.success_at !== undefined
    && row.range_digest === input.rangeDigest && row.manifest_digest === input.currentManifestDigest && input.currentManifestDigest
    && input.now >= row.success_at && input.now - row.success_at < PRIVATE_CALENDAR_REFRESH_MS) return { kind: 'fresh' as const };
  const retry = privateCalendarDeliveryRetry(row?.attempts ?? 0, input.now, input.randomFraction);
  const token = bytesToHex(await crypto.randomBytes(16)); hexBytes(token, 16);
  const lease = snapshotPrivateCalendarAcquisitionLease({ token, authorityDigest: input.authorityDigest, rangeDigest: input.rangeDigest,
    startedAt: input.now, expiresAt: input.now + PRIVATE_CALENDAR_ACQUISITION_LEASE_MS });
  await db.runAsync(`INSERT INTO private_calendar_acquisition (id, authority_digest, range_digest, token, started_at, expires_at, attempts, retry_at, failure_code, success_at, manifest_digest)
    VALUES ('current', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL) ON CONFLICT(id) DO UPDATE SET authority_digest=excluded.authority_digest,
    range_digest=excluded.range_digest, token=excluded.token, started_at=excluded.started_at, expires_at=excluded.expires_at,
    attempts=excluded.attempts, retry_at=excluded.retry_at, failure_code=NULL, success_at=NULL, manifest_digest=NULL`,
  lease.authorityDigest, lease.rangeDigest, lease.token, lease.startedAt, lease.expiresAt, retry.attempts, Math.max(lease.expiresAt, retry.retryAt));
  return { kind: 'acquired' as const, lease };
}
function matches(row: AcquisitionRow | null, lease: PrivateCalendarAcquisitionLease) {
  return row?.authority_digest === lease.authorityDigest && row.range_digest === lease.rangeDigest && row.token === lease.token
    && row.started_at === lease.startedAt && row.expires_at === lease.expiresAt;
}
export async function completePrivateCalendarAcquisition(db: SQLiteDatabase, lease: PrivateCalendarAcquisitionLease, now: number, manifestDigest: string) {
  timestamp(now); hexBytes(manifestDigest, 32); const row = await read(db);
  if (!matches(row, lease) || now < lease.startedAt || now >= lease.expiresAt) throw new Error('Calendarの取得処理が更新または中断されました。再試行してください。');
  await db.runAsync("UPDATE private_calendar_acquisition SET token = NULL, expires_at = NULL, attempts = 0, retry_at = NULL, failure_code = NULL, success_at = ?, manifest_digest = ? WHERE id = 'current'", lease.startedAt, manifestDigest);
}
export async function failPrivateCalendarAcquisition(db: SQLiteDatabase, lease: PrivateCalendarAcquisitionLease, now: number, code: PrivateCalendarDeliveryFailure, randomFraction: number) {
  timestamp(now); assertPrivateCalendarDeliveryFailure(code); const row = await read(db);
  if (!matches(row, lease)) return false;
  const retry = privateCalendarDeliveryRetry(Math.max(0, row!.attempts - 1), now, randomFraction);
  await db.runAsync("UPDATE private_calendar_acquisition SET token = NULL, expires_at = NULL, attempts = ?, retry_at = ?, failure_code = ?, success_at = NULL, manifest_digest = NULL WHERE id = 'current'", retry.attempts, retry.retryAt, code);
  return true;
}
