import type { SQLiteDatabase } from 'expo-sqlite';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import type { VerifiedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority.ts';
import type { EncryptedPrivateCalendarCache, PrivateCalendarCacheCursor } from '../../features/sharing/private-calendar/cache-crypto.ts';
import { advancePrivateCalendarCacheCursor, MAX_PRIVATE_CALENDAR_CACHE_BYTES, openPrivateCalendarCache,
  snapshotEncryptedPrivateCalendarCache, snapshotPrivateCalendarCacheCursor, verifyPrivateCalendarCacheCiphertext } from '../../features/sharing/private-calendar/cache-crypto.ts';
import type { PrivateCalendarCryptoGateway } from '../../features/sharing/private-calendar/crypto-gateway.ts';
import { hexBytes } from '../../features/sharing/private-calendar/validation.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import type { PrivateCalendarDeliveryFailure } from '../../features/sharing/private-calendar/delivery-retry.ts';
import { assertPrivateCalendarDeliveryFailure, privateCalendarDeliveryRetry } from '../../features/sharing/private-calendar/delivery-retry.ts';
import { beginPrivateCalendarAcquisition, completePrivateCalendarAcquisition, failPrivateCalendarAcquisition, snapshotPrivateCalendarAcquisitionLease } from './private-calendar-acquisition.ts';
import type { PrivateCalendarAcquisitionLease } from './private-calendar-acquisition.ts';

export interface PrivateCalendarCacheStoragePort {
  readonly ownerUserId: string; readonly crypto: PrivateCalendarCryptoGateway;
  exclusive<T>(userId: string, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T>;
  assertOwner(userId: string): void | Promise<void>;
  /** Read the protected vault under the already-held SQL lock; never reacquire that lock here. */
  assertAuthority(authority: VerifiedPrivateCalendarAuthority, requireMain: boolean): void | Promise<void>;
}
interface CacheMetadata {
  cursor_json: string; encrypted_length: number; pending: number; attempts: number; retry_at: number | null; failure_code: string | null;
}
interface SavedCache extends CacheMetadata { encrypted_json: string }
type CacheInput = { authority: VerifiedPrivateCalendarAuthority; calendarBinding: string; accountKey: Uint8Array };
export type { PrivateCalendarDeliveryFailure } from '../../features/sharing/private-calendar/delivery-retry.ts';
const TABLE = `CREATE TABLE IF NOT EXISTS private_calendar_cache (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'current'), cursor_json TEXT NOT NULL, encrypted_json TEXT NOT NULL,
  pending INTEGER NOT NULL CHECK (pending IN (0, 1)), attempts INTEGER NOT NULL CHECK (attempts >= 0), retry_at INTEGER, failure_code TEXT
)`;
const MAX_ENVELOPE_CHARACTERS = MAX_PRIVATE_CALENDAR_CACHE_BYTES * 2 + 64 * 1024;
function savedCursor(row: CacheMetadata): PrivateCalendarCacheCursor {
  if (typeof row.cursor_json !== 'string' || row.cursor_json.length > 2048 || !Number.isSafeInteger(row.encrypted_length)
    || row.encrypted_length < 1 || row.encrypted_length > MAX_ENVELOPE_CHARACTERS || ![0, 1].includes(row.pending) || !Number.isSafeInteger(row.attempts) || row.attempts < 0
    || row.retry_at !== null && (!Number.isSafeInteger(row.retry_at) || row.retry_at < 0)
    || row.failure_code !== null && !['offline', 'temporary', 'auth', 'permission', 'unknown'].includes(row.failure_code)) throw new Error('本人用Calendarの保存形式を確認できません。');
  return snapshotPrivateCalendarCacheCursor(JSON.parse(row.cursor_json) as PrivateCalendarCacheCursor);
}
function envelope(row: SavedCache, authority: VerifiedPrivateCalendarAuthority): EncryptedPrivateCalendarCache {
  if (typeof row.encrypted_json !== 'string' || row.encrypted_json.length !== row.encrypted_length) throw new Error('本人用Calendarの保存サイズが一致しません。');
  const cursor = savedCursor(row); const owned = snapshotEncryptedPrivateCalendarCache(JSON.parse(row.encrypted_json), authority);
  const checked = advancePrivateCalendarCacheCursor(cursor, owned.manifest, authority);
  if (checked.kind !== 'duplicate') throw new Error('本人用Calendarの保存位置と暗号文が一致しません。');
  return owned;
}
function timestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 86_400_000) throw new Error('再送時刻を確認できません。');
}

/** One complete encrypted snapshot, its cursor and its delivery state commit together. No busy plaintext enters SQL. */
export function createPrivateCalendarCacheStorage(port: PrivateCalendarCacheStoragePort) {
  assertSharedIdentifier(port.ownerUserId);
  function ownerAuthority(authority: VerifiedPrivateCalendarAuthority) {
    if (authority.signed.body.ownerUserId !== port.ownerUserId) throw new Error('本人用Calendarの保存先が異なります。');
  }
  async function locked<T>(authority: VerifiedPrivateCalendarAuthority, main: boolean, work: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
    const userId = port.ownerUserId;
    ownerAuthority(authority);
    await port.assertOwner(userId);
    const result = await port.exclusive(userId, async (db) => {
      await port.assertOwner(userId); await port.assertAuthority(authority, main); await port.assertOwner(userId);
      await db.execAsync(TABLE); const value = await work(db); await port.assertOwner(userId); return value;
    });
    await port.assertOwner(userId); return result;
  }
  const columns = 'cursor_json, length(encrypted_json) AS encrypted_length, pending, attempts, retry_at, failure_code';
  const record = (db: SQLiteDatabase) => db.getFirstAsync<SavedCache>(`SELECT ${columns}, encrypted_json FROM private_calendar_cache WHERE id = ?`, 'current');
  const metadata = (db: SQLiteDatabase) => db.getFirstAsync<CacheMetadata>(`SELECT ${columns} FROM private_calendar_cache WHERE id = ?`, 'current');
  return {
    async status(authority: VerifiedPrivateCalendarAuthority) {
      return locked(authority, false, async (db) => {
        const row = await metadata(db); if (!row) return null;
        const cursor = savedCursor(row);
        return { cursor, authorityCurrent: cursor.authorityDigest === authority.digest, pending: row.pending === 1,
          attempts: row.attempts, retryAt: row.retry_at, failureCode: row.failure_code as PrivateCalendarDeliveryFailure | null };
      });
    },
    async save(encrypted: EncryptedPrivateCalendarCache, input: CacheInput & { origin: 'local' | 'remote'; acquisition?: { lease: PrivateCalendarAcquisitionLease; now(): number } }) {
      ownerAuthority(input.authority);
      if (!(input.accountKey instanceof Uint8Array) || input.accountKey.length !== 32) throw new Error('本人用Calendarの鍵が無効です。');
      assertSharedIdentifier(input.calendarBinding);
      if (!['local', 'remote'].includes(input.origin)) throw new Error('本人用Calendarの保存元を確認できません。');
      const acquisition = input.acquisition ? { lease: snapshotPrivateCalendarAcquisitionLease(input.acquisition.lease), now: input.acquisition.now } : null;
      if (acquisition && (input.origin !== 'local' || acquisition.lease.authorityDigest !== input.authority.digest)) throw new Error('Calendarの取得元が一致しません。');
      const owned = snapshotEncryptedPrivateCalendarCache(encrypted, input.authority);
      input = { ...input, accountKey: input.accountKey.slice() };
      try {
        await port.assertOwner(port.ownerUserId);
        await openPrivateCalendarCache(port.crypto, owned, input);
        return await locked(input.authority, input.origin === 'local', async (db) => {
          if (acquisition) await completePrivateCalendarAcquisition(db, acquisition.lease, acquisition.now(), sharedDocumentDigest(owned.manifest));
          const before = await metadata(db); const changed = advancePrivateCalendarCacheCursor(before ? savedCursor(before) : null, owned.manifest, input.authority);
          if (changed.kind === 'duplicate') {
            // Never requeue an already acknowledged snapshot, reset backoff, or overwrite a newer pending state.
            if (before) {
              const savedRow = await record(db); if (!savedRow) throw new Error('本人用Calendarの保存内容を確認できません。');
              const saved = envelope(savedRow, input.authority);
              if (saved.chunks.some((part) => {
                const matching = owned.chunks.find((candidate) => candidate.index === part.index)!;
                return part.salt !== matching.salt || part.nonce !== matching.nonce || part.encryptedPayload !== matching.encryptedPayload;
              })) throw new Error('保存済みCalendarの暗号文が一致しません。');
            }
            return changed;
          }
          const encoded = JSON.stringify(owned); if (encoded.length > MAX_ENVELOPE_CHARACTERS) throw new Error('本人用Calendarの保存上限です。');
          await db.runAsync(`INSERT INTO private_calendar_cache (id, cursor_json, encrypted_json, pending, attempts, retry_at, failure_code)
            VALUES ('current', ?, ?, ?, 0, NULL, NULL) ON CONFLICT(id) DO UPDATE SET cursor_json=excluded.cursor_json,
            encrypted_json=excluded.encrypted_json, pending=excluded.pending, attempts=0, retry_at=NULL, failure_code=NULL`,
          JSON.stringify(changed.cursor), encoded, input.origin === 'local' ? 1 : 0);
          return changed;
        });
      } finally { input.accountKey.fill(0); }
    },
    beginAcquisition(authority: VerifiedPrivateCalendarAuthority, options: { rangeDigest: string; now: number; force?: boolean; automatic?: boolean; randomFraction: number }) {
      const owned = { ...options }; hexBytes(owned.rangeDigest, 32); timestamp(owned.now);
      return locked(authority, true, async db => {
        const current = await metadata(db); const cursor = current ? savedCursor(current) : null;
        return beginPrivateCalendarAcquisition(db, port.crypto, { authorityDigest: authority.digest, rangeDigest: owned.rangeDigest,
          now: owned.now, force: owned.force === true, automatic: owned.automatic === true, randomFraction: owned.randomFraction,
          currentManifestDigest: cursor?.authorityDigest === authority.digest && !current!.pending ? cursor.manifestDigest : null });
      });
    },
    failAcquisition(authority: VerifiedPrivateCalendarAuthority, lease: PrivateCalendarAcquisitionLease, now: number, code: PrivateCalendarDeliveryFailure, randomFraction: number) {
      const owned = snapshotPrivateCalendarAcquisitionLease(lease); timestamp(now);
      if (owned.authorityDigest !== authority.digest) throw new Error('Calendarの取得元が一致しません。');
      return locked(authority, true, db => failPrivateCalendarAcquisition(db, owned, now, code, randomFraction));
    },
    async read(input: CacheInput) {
      ownerAuthority(input.authority);
      if (!(input.accountKey instanceof Uint8Array) || input.accountKey.length !== 32) throw new Error('本人用Calendarの鍵が無効です。');
      assertSharedIdentifier(input.calendarBinding);
      input = { ...input, accountKey: input.accountKey.slice() };
      try {
        const row = await locked(input.authority, false, record); if (!row) return null;
        const owned = envelope(row, input.authority); const cache = await openPrivateCalendarCache(port.crypto, owned, input);
        await locked(input.authority, false, async (db) => {
          const current = await metadata(db);
          if (!current || savedCursor(current).manifestDigest !== sharedDocumentDigest(owned.manifest)) throw new Error('本人用Calendarが更新されています。再読込してください。');
        });
        return cache;
      } finally { input.accountKey.fill(0); }
    },
    async pending(authority: VerifiedPrivateCalendarAuthority, now: number, options: { force?: boolean } = {}) {
      const force = options.force === true;
      timestamp(now);
      const ready = await locked(authority, true, async db => {
        const meta = await metadata(db); if (!meta) return null;
        const cursor = savedCursor(meta);
        // Retry checks need only the small metadata row. Fetch ciphertext only
        // after deciding to publish, under this same owner-checked transaction.
        if (cursor.authorityDigest !== authority.digest || !meta.pending || !force && meta.retry_at !== null && meta.retry_at > now) return null;
        const row = await record(db); if (!row) throw new Error('本人用Calendarの保存内容を確認できません。');
        return { row, cursor };
      });
      if (!ready) return null; const { row, cursor } = ready;
      const owned = await verifyPrivateCalendarCacheCiphertext(port.crypto, envelope(row, authority), authority);
      await locked(authority, true, async (db) => {
        const current = await metadata(db);
        if (!current || savedCursor(current).manifestDigest !== cursor.manifestDigest || !current.pending) throw new Error('送信待ちのCalendarが更新されています。再読込してください。');
      });
      return { encrypted: owned, manifestDigest: cursor.manifestDigest, attempts: row.attempts };
    },
    acknowledge(authority: VerifiedPrivateCalendarAuthority, manifestDigest: string) {
      hexBytes(manifestDigest, 32);
      return locked(authority, true, async (db) => {
        const row = await metadata(db); if (!row || savedCursor(row).manifestDigest !== manifestDigest || !row.pending) return false;
        if (savedCursor(row).authorityDigest !== authority.digest) throw new Error('本人用Calendarの送信元が更新されています。');
        await db.runAsync('UPDATE private_calendar_cache SET pending = 0, attempts = 0, retry_at = NULL, failure_code = NULL WHERE id = ?', 'current'); return true;
      });
    },
    fail(authority: VerifiedPrivateCalendarAuthority, manifestDigest: string, now: number, code: PrivateCalendarDeliveryFailure, randomFraction: number) {
      hexBytes(manifestDigest, 32); timestamp(now);
      assertPrivateCalendarDeliveryFailure(code); privateCalendarDeliveryRetry(0, now, randomFraction);
      return locked(authority, true, async (db) => {
        const row = await metadata(db); if (!row || savedCursor(row).manifestDigest !== manifestDigest || !row.pending) return false;
        if (savedCursor(row).authorityDigest !== authority.digest) throw new Error('本人用Calendarの送信元が更新されています。');
        const { attempts, retryAt } = privateCalendarDeliveryRetry(row.attempts, now, randomFraction);
        await db.runAsync('UPDATE private_calendar_cache SET attempts = ?, retry_at = ?, failure_code = ? WHERE id = ?', attempts, retryAt, code, 'current'); return true;
      });
    },
  };
}
