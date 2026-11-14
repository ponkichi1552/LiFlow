import type { SQLiteDatabase } from 'expo-sqlite';
import type { SharedDeliveryArchive } from '../../features/sharing/delivery-archive';
import { canonicalJson } from '../../features/sharing/operations.ts';

export function createPrivateDeliveryArchive(port: { ownerUserId: string; assertOwner(): void;
  exclusive<T>(owner: string, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> }): SharedDeliveryArchive<unknown> {
  const locked = <T>(work: (db: SQLiteDatabase) => Promise<T>) => port.exclusive(port.ownerUserId, async db => {
    port.assertOwner(); await db.execAsync('CREATE TABLE IF NOT EXISTS private_delivery_archive(id TEXT PRIMARY KEY NOT NULL,wire_json TEXT NOT NULL)');
    const result = await work(db); port.assertOwner(); return result;
  });
  return {
    saveEvents: async () => { throw new Error('A private delivery cannot contain group events'); },
    events: async () => null, seedPosition: async () => 0,
    saveChunk: (id, value) => locked(async db => {
      const json = canonicalJson(value); const old = await db.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM private_delivery_archive WHERE id=?', id);
      if (old && old.wire_json !== json) throw new Error('Private delivery identity collision');
      if (!old) await db.runAsync('INSERT INTO private_delivery_archive VALUES(?,?)', id, json);
    }),
    chunk: id => locked(async db => {
      const row = await db.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM private_delivery_archive WHERE id=?', id);
      if (row) return JSON.parse(row.wire_json);
      // Seed an already verified device cache without querying Google or uploading it again.
      if (id.startsWith('calendar.') && await db.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='private_calendar_cache'")) {
        const cached = await db.getFirstAsync<{ cursor_json: string; encrypted_json: string }>("SELECT cursor_json,encrypted_json FROM private_calendar_cache WHERE id='current'");
        if (cached && JSON.parse(cached.cursor_json).manifestDigest === id.slice('calendar.'.length)) {
          await db.runAsync('INSERT OR IGNORE INTO private_delivery_archive VALUES(?,?)', id, cached.encrypted_json); return JSON.parse(cached.encrypted_json);
        }
      }
      return null;
    }),
  };
}
