import type { SQLiteDatabase } from 'expo-sqlite';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../../features/sharing/crypto.ts';
import { sharedDocumentDigest, validateDevicePublicIdentity, validateDeviceSecretIdentity, verifySharedDocument } from '../../features/sharing/crypto.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import type { SignedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority.ts';
import { createPrivateCalendarRoot, snapshotPrivateCalendarAuthority, verifyPrivateCalendarRoot } from '../../features/sharing/private-calendar/authority.ts';
import type { ProtectedPrivateCalendarDeviceState } from '../../features/sharing/private-calendar/secret-store.ts';
import { hexBytes } from '../../features/sharing/private-calendar/validation.ts';

export interface PrivateCalendarRootSetupIntent {
  readonly digest: string; readonly signed: SignedPrivateCalendarAuthority; readonly status: 'pending' | 'ready';
}
export interface PrivateCalendarRootSetupPort {
  readonly ownerUserId: string; readonly crypto: SharingCryptoGateway;
  exclusive<T>(userId: string, work: (db: SQLiteDatabase) => Promise<T>): Promise<T>;
  assertOwner(userId: string): void | Promise<void>;
  /** Reads the protected vault without reacquiring the SQL lock. */
  readProtected(): Promise<ProtectedPrivateCalendarDeviceState>;
}
interface Row { schema_version: number; intent_digest: string; authority_json: string; status: string }
const TABLE = `CREATE TABLE IF NOT EXISTS private_calendar_root_setup (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'root'), schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  intent_digest TEXT NOT NULL, authority_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'ready'))
)`;

/** A prepared public root survives a lost reply or process termination before its trust pin/key is committed. */
export function createPrivateCalendarRootSetupStorage(port: PrivateCalendarRootSetupPort) {
  assertSharedIdentifier(port.ownerUserId);
  function decode(row: Row, state: ProtectedPrivateCalendarDeviceState): PrivateCalendarRootSetupIntent {
    if (row.schema_version !== 1 || !['pending', 'ready'].includes(row.status) || typeof row.authority_json !== 'string' || row.authority_json.length > 16_000) throw new Error('本人端末の初回設定を確認できません。');
    hexBytes(row.intent_digest, 32); const signed = snapshotPrivateCalendarAuthority(JSON.parse(row.authority_json));
    const root = verifyPrivateCalendarRoot(signed, { ownerUserId: port.ownerUserId, accountGeneration: signed.body.accountGeneration, rootDigest: row.intent_digest });
    if (root.signed.body.signerDeviceId !== state.identity.deviceId) throw new Error('初回設定を準備した本人端末の鍵が異なります。復旧を確認してください。');
    verifySharedDocument(root.signed.body, root.signed.signature, state.identity);
    if (state.authority && state.authority.anchor.rootDigest !== root.digest || row.status === 'ready' && !state.authority) throw new Error('以前の本人端末の設定があります。自動で置換せず復旧を確認してください。');
    return Object.freeze({ digest: root.digest, signed: root.signed, status: row.status as 'pending' | 'ready' });
  }
  async function locked<T>(work: (db: SQLiteDatabase, state: ProtectedPrivateCalendarDeviceState) => Promise<T>): Promise<T> {
    await port.assertOwner(port.ownerUserId);
    const result = await port.exclusive(port.ownerUserId, async (db) => {
      await port.assertOwner(port.ownerUserId); const state = await port.readProtected(); await port.assertOwner(port.ownerUserId);
      await db.execAsync(TABLE); const value = await work(db, state); await port.assertOwner(port.ownerUserId); return value;
    });
    await port.assertOwner(port.ownerUserId); return result;
  }
  const record = (db: SQLiteDatabase) => db.getFirstAsync<Row>('SELECT schema_version, intent_digest, authority_json, status FROM private_calendar_root_setup WHERE id = ?', 'root');
  return {
    read() { return locked(async (db, state) => { const row = await record(db); return row ? decode(row, state) : null; }); },
    async prepare(identity: DeviceSecretIdentity) {
      identity = validateDeviceSecretIdentity(identity);
      return locked(async (db, state) => {
        if (canonicalJson(validateDevicePublicIdentity(identity)) !== canonicalJson(state.identity)) throw new Error('初回設定の本人端末が変わりました。');
        const row = await record(db); if (row) return decode(row, state);
        if (state.authority || state.hasStoredKeys) throw new Error('本人端末の設定が既にあります。既存の設定を確認してください。');
        const table = await db.getFirstAsync('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', 'private_calendar_cache');
        if (table && await db.getFirstAsync('SELECT id FROM private_calendar_cache LIMIT 1')) throw new Error('以前の本人用データがあります。鍵の復旧を確認してください。');
        const root = await createPrivateCalendarRoot(port.crypto, port.ownerUserId, identity); const json = canonicalJson(root.signed);
        if (json.length > 16_000 || sharedDocumentDigest(root.signed) !== root.digest) throw new Error('本人端末の初回設定を保存できません。');
        await db.runAsync("INSERT INTO private_calendar_root_setup (id, schema_version, intent_digest, authority_json, status) VALUES ('root', 1, ?, ?, 'pending')", root.digest, json);
        return Object.freeze({ digest: root.digest, signed: root.signed, status: 'pending' as const });
      });
    },
    markReady(digest: string) {
      hexBytes(digest, 32);
      return locked(async (db, state) => {
        const row = await record(db); if (!row || row.intent_digest !== digest) return false;
        const intent = decode(row, state); if (intent.status === 'ready') return true;
        if (state.authority?.anchor.rootDigest !== digest || !state.hasCurrentKey) return false;
        await db.runAsync("UPDATE private_calendar_root_setup SET status = 'ready' WHERE id = ? AND intent_digest = ?", 'root', digest); return true;
      });
    },
    /** Public, unaccepted proposal only. Protected trust, keys and cached ciphertext are never removed. */
    discardUnaccepted(digest: string) {
      hexBytes(digest, 32);
      return locked(async (db, state) => {
        const row = await record(db); if (!row || row.intent_digest !== digest) return false;
        const intent = decode(row, state);
        if (intent.status !== 'pending' || state.authority || state.hasStoredKeys) return false;
        const table = await db.getFirstAsync('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', 'private_calendar_cache');
        if (table && await db.getFirstAsync('SELECT id FROM private_calendar_cache LIMIT 1')) return false;
        const deleted = await db.runAsync("DELETE FROM private_calendar_root_setup WHERE id = 'root' AND intent_digest = ? AND status = 'pending'", digest);
        return deleted.changes === 1;
      });
    },
  };
}
