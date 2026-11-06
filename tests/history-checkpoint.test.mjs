import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from './helpers/sqlite.mjs';
import { checkpointRetainedHistory } from '../src/platform/storage/history-checkpoint.ts';

test('a blocked WAL truncate stays durably pending and completes only after an independent old reader ends', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-history-checkpoint-')); const path = join(directory, 'synthetic.db');
  const writer = createDatabase(path); const reader = createDatabase(path);
  t.after(() => { writer.connection.close(); reader.connection.close(); rmSync(directory, { recursive: true }); });
  writer.connection.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; PRAGMA secure_delete=ON; CREATE TABLE synthetic_history(body TEXT)');
  const privateText = 'synthetic-expired-history-'.repeat(250);
  writer.connection.prepare('INSERT INTO synthetic_history VALUES(?)').run(privateText);
  writer.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  reader.connection.exec('BEGIN'); assert.equal(reader.connection.prepare('SELECT body FROM synthetic_history').get().body, privateText);
  writer.connection.exec('DELETE FROM synthetic_history');
  const first = await checkpointRetainedHistory(writer.database, 'checkpoint-test', 'a'.repeat(64));
  assert.equal(first.complete, false); assert.equal(first.busy, 1);
  assert.equal(writer.connection.prepare('SELECT pending FROM sharing_history_cleanup').get().pending, 1);
  assert.equal(writer.connection.prepare('SELECT count(*) n FROM synthetic_history').get().n, 0);
  reader.connection.exec('COMMIT');
  const retry = await checkpointRetainedHistory(writer.database, 'checkpoint-test', 'a'.repeat(64));
  assert.deepEqual(retry, { complete: true, busy: 0 });
  assert.equal(writer.connection.prepare('SELECT pending FROM sharing_history_cleanup').get().pending, 0);
  assert.equal(readFileSync(path + '-wal').includes(Buffer.from(privateText)), false, 'housekeeping can create new WAL frames but expired content is no longer present');
  let checkpointCalls = 0; const read = writer.database.getFirstAsync;
  writer.database.getFirstAsync = async (...args) => { if (args[0].startsWith('PRAGMA wal_checkpoint')) checkpointCalls++; return read(...args); };
  await checkpointRetainedHistory(writer.database, 'checkpoint-test', 'a'.repeat(64));
  assert.equal(checkpointCalls, 0, 'an unchanged completed retention marker needs no heavy repeated checkpoint');
});

test('an invalid checkpoint result never clears pending maintenance and a later retry retains its exact scope', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); const read = h.database.getFirstAsync;
  h.database.getFirstAsync = async (...args) => args[0].startsWith('PRAGMA wal_checkpoint') ? null : read(...args);
  await assert.rejects(checkpointRetainedHistory(h.database, 'checkpoint-test', 'b'.repeat(64)), /整理結果/);
  assert.equal(h.connection.prepare('SELECT pending FROM sharing_history_cleanup').get().pending, 1);
  h.database.getFirstAsync = read;
  assert.equal((await checkpointRetainedHistory(h.database, 'checkpoint-test', 'b'.repeat(64))).complete, true);
  assert.equal(h.connection.prepare('SELECT digest FROM sharing_history_cleanup').get().digest, 'b'.repeat(64));
});
