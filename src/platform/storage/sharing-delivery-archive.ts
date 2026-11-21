import type { SQLiteDatabase } from 'expo-sqlite';
import type { SharedDeliveryArchive } from '../../features/sharing/delivery-archive';
import type { SharedCloudEvent } from '../../features/sharing/cloud-contract';
import type { EncryptedSharedSnapshotChunk } from '../../features/sharing/crypto';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';

/** Applied, authenticated wire records. Legacy archive rows are candidates until their original proofs are rechecked. */
export async function createSharedDeliveryArchive(database: SQLiteDatabase, groupId: string,
  serialized: <T>(work: () => Promise<T>) => Promise<T>, assertCurrent: () => void): Promise<SharedDeliveryArchive> {
  await serialized(async () => {
    assertCurrent(); await database.execAsync(`CREATE TABLE IF NOT EXISTS sharing_delivery_archive (
      group_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,wire_json TEXT NOT NULL,
      PRIMARY KEY(group_id,kind,id));
      CREATE TABLE IF NOT EXISTS sharing_delivery_archive_boundary (group_id TEXT PRIMARY KEY, through_sequence INTEGER NOT NULL, key_version INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_delivery_sequence ON sharing_delivery_archive(group_id,sequence) WHERE kind='event';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_delivery_applied_sequence ON sharing_delivery_archive(group_id,sequence) WHERE kind='applied-event';`);
  });
  const read = <T>(work: () => Promise<T>) => serialized(async () => { assertCurrent(); const value = await work(); assertCurrent(); return value; });
  const events = (kind: 'event' | 'applied-event', after: number, through: number) => read(async () => {
    if (![after, through].every(Number.isSafeInteger) || after < 0 || through < after || through - after > 100) throw new Error('Invalid delivery recovery range');
    const rows = await database.getAllAsync<{ sequence: number; wire_json: string }>('SELECT sequence,wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND sequence>? AND sequence<=? ORDER BY sequence', groupId, kind, after, through);
    const gap = rows.findIndex((row, index) => row.sequence !== after + index + 1);
    const prefix = gap < 0 ? rows : rows.slice(0, gap);
    if (kind === 'applied-event' ? prefix.length !== through - after : !prefix.length) return null;
    return prefix.map(row => JSON.parse(row.wire_json)) as SharedCloudEvent[];
  });
  return {
    saveEvents: events => read(() => withIsolatedSqliteTransaction(database, async transaction => {
      const marker = await transaction.getFirstAsync<{ through_sequence: number }>('SELECT through_sequence FROM sharing_delivery_archive_boundary WHERE group_id=?', groupId);
      for (const event of events) {
        if (event.envelope.groupId !== groupId || !Number.isSafeInteger(event.uploadSequence) || event.uploadSequence < 1) throw new Error('Delivery archive scope differs');
        // New peer recovery may replay removed rows. The previously retained
        // event remains available; a pruned event cannot reenter the archive.
        if (event.uploadSequence <= (marker?.through_sequence ?? 0) && !await transaction.getFirstAsync(`SELECT 1 FROM sharing_snapshot_state saved,
          json_each(saved.snapshot_json,'$.facts') fact WHERE saved.group_id=? AND json_extract(fact.value,'$.operation.operationId')=? LIMIT 1`, groupId, event.operationId)) continue;
        const json = canonicalJson(event);
        const previous = await transaction.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND id=?', groupId, 'applied-event', event.operationId);
        if (previous && previous.wire_json !== json) throw new Error('Immutable delivery archive collision');
        if (!previous) {
          await transaction.runAsync('INSERT INTO sharing_delivery_archive VALUES(?,?,?,?,?)', groupId, 'applied-event', event.operationId, event.uploadSequence, json);
          await transaction.runAsync("DELETE FROM sharing_delivery_archive WHERE group_id=? AND kind='event' AND sequence=?", groupId, event.uploadSequence);
        }
      }
      assertCurrent();
    })),
    events: (after, through) => events('applied-event', after, through),
    legacyEvents: (after, through) => events('event', after, through),
    saveChunk: (id, chunk) => read(() => withIsolatedSqliteTransaction(database, async transaction => {
      if (chunk.groupId !== groupId) throw new Error('Delivery archive scope differs');
      const boundary = await transaction.getFirstAsync<{ key_version: number }>('SELECT key_version FROM sharing_delivery_archive_boundary WHERE group_id=?', groupId);
      if (boundary && chunk.keyVersion <= boundary.key_version) return;
      const json = canonicalJson(chunk);
      const previous = await transaction.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND id=?', groupId, 'chunk', id);
      if (previous && previous.wire_json !== json) throw new Error('Immutable snapshot archive collision');
      if (!previous) await transaction.runAsync('INSERT INTO sharing_delivery_archive VALUES(?,?,?,?,?)', groupId, 'chunk', id, 0, json);
      assertCurrent();
    })),
    chunk: id => read(async () => {
      const row = await database.getFirstAsync<{ wire_json: string }>('SELECT wire_json FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND id=?', groupId, 'chunk', id);
      return row ? JSON.parse(row.wire_json) as EncryptedSharedSnapshotChunk : null;
    }),
    seedPosition: floor => read(async () => {
      const rows = await database.getAllAsync<{ sequence: number }>('SELECT sequence FROM sharing_delivery_archive WHERE group_id=? AND kind=? AND sequence>? ORDER BY sequence', groupId, 'applied-event', floor);
      let next = floor; for (const row of rows) { if (row.sequence !== next + 1) break; next++; } return next;
    }),
  };
}
