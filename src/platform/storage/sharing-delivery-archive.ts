import type { SQLiteDatabase } from 'expo-sqlite';
import type { SharedDeliveryArchive } from '../../features/sharing/delivery-archive';
import type { SharedCloudEvent } from '../../features/sharing/cloud-contract';
import type { EncryptedSharedSnapshotChunk } from '../../features/sharing/crypto';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';

/** Opaque, already signed/encrypted wire records. This never stores a server backup or private key. */
export async function createSharedDeliveryArchive(database: SQLiteDatabase, groupId: string,
  serialized: <T>(work: () => Promise<T>) => Promise<T>, assertCurrent: () => void): Promise<SharedDeliveryArchive> {
  await serialized(async () => {
    assertCurrent(); await database.execAsync(`CREATE TABLE IF NOT EXISTS sharing_delivery_archive (
      group_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,wire_json TEXT NOT NULL,
      PRIMARY KEY(group_id,kind,id));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_delivery_sequence ON sharing_delivery_archive(group_id,sequence) WHERE kind='event';`);
  });
  const read = <T>(work: () => Promise<T>) => serialized(async () => { assertCurrent(); const value = await work(); assertCurrent(); return value; });
  return {
    saveEvents: events => read(() => withIsolatedSqliteTransaction(database, async transaction => {
      for (const event of events) {
        if (event.envelope.groupId !== groupId || !Number.isSafeInteger(event.uploadSequence) || event.uploadSequence < 1) throw new Error('Delivery archive scope differs');
        const json = canonicalJson(event);
        const previous = await transaction.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND id=?', groupId, 'event', event.operationId);
        if (previous && previous.wire_json !== json) throw new Error('Immutable delivery archive collision');
        if (!previous) await transaction.runAsync('INSERT INTO sharing_delivery_archive VALUES(?,?,?,?,?)', groupId, 'event', event.operationId, event.uploadSequence, json);
      }
      assertCurrent();
    })),
    events: (after, through) => read(async () => {
      if (![after, through].every(Number.isSafeInteger) || after < 0 || through < after || through - after > 100) throw new Error('Invalid delivery recovery range');
      const rows = await database.getAllAsync<{ sequence: number; wire_json: string }>('SELECT sequence,wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND sequence>? AND sequence<=? ORDER BY sequence', groupId, 'event', after, through);
      if (rows.length !== through - after || rows.some((row, index) => row.sequence !== after + index + 1)) return null;
      return rows.map(row => JSON.parse(row.wire_json)) as SharedCloudEvent[];
    }),
    saveChunk: (id, chunk) => read(async () => {
      const json = canonicalJson(chunk);
      const previous = await database.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND id=?', groupId, 'chunk', id);
      if (previous && previous.wire_json !== json) throw new Error('Immutable snapshot archive collision');
      if (!previous) await database.runAsync('INSERT INTO sharing_delivery_archive VALUES(?,?,?,?,?)', groupId, 'chunk', id, 0, json);
    }),
    chunk: id => read(async () => {
      const row = await database.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND id=?', groupId, 'chunk', id);
      return row ? JSON.parse(row.wire_json) as EncryptedSharedSnapshotChunk : null;
    }),
    seedPosition: floor => read(async () => {
      const rows = await database.getAllAsync<{ sequence: number }>('SELECT sequence FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND sequence>? ORDER BY sequence', groupId, 'event', floor);
      let next = floor; for (const row of rows) { if (row.sequence !== next + 1) break; next++; } return next;
    }),
  };
}
