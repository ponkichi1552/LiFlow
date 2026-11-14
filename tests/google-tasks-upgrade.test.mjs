import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';
import { createGoogleTaskCreateJournal } from '../src/platform/storage/google-task-create-intents.ts';

function fixture() {
  const connection = new DatabaseSync(':memory:');
  const database = {
    async execAsync(sql) { connection.exec(sql); },
    async runAsync(sql, ...args) { return connection.prepare(sql).run(...args); },
    async getFirstAsync(sql, ...args) { return connection.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return connection.prepare(sql).all(...args); },
    async withTransactionAsync(work) {
      connection.exec('BEGIN');
      try { const value = await work(); connection.exec('COMMIT'); return value; }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
  };
  const journal = createGoogleTaskCreateJournal(work => database.withTransactionAsync(() => work(database)),
    () => 'one-attempt', () => new Date('2026-11-12T00:00:00Z'));
  const scope = { accountSubject: 'account', taskListId: 'existing-list' };
  const identity = { ...scope, occurrenceMarker: 'unchanged-round' };
  return { connection, database, journal, scope, identity };
}

for (const hasResults of [false, true]) test(`upgrading an existing v29 Tasks connection with result table=${hasResults} preserves reservations and recovers the durable journal`, async () => {
  const h = fixture();
  try {
    await migrateLocalDatabase(h.database);
    h.connection.exec(`INSERT INTO households VALUES('local-household','existing-home','2026-11-01T00:00:00Z');
      INSERT INTO google_sync_state(household_id,enabled,task_list_id,status,retry_count,last_error_code,updated_at,account_subject,connection_active)
        VALUES('local-household',1,'existing-list','error',0,'err_internal_sqlite_error','2026-11-12T00:00:00Z','account',1);
      INSERT INTO google_task_links(schedule_entry_id,household_id,chore_id,google_task_list_id,google_task_id,created_at,updated_at)
        VALUES('saved-round','local-household','saved-chore','existing-list','saved-task','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');`);
    const intent = await h.journal.reserve(h.identity);
    assert.ok(intent);
    if (hasResults) await h.journal.received([{ intent, kind: 'created', taskId: 'already-created' }]);
    else h.connection.exec('DROP TABLE private_google_task_create_results');
    h.connection.exec('PRAGMA user_version=29');
    const saved = ['households','google_sync_state','google_task_links','private_google_task_create_intents']
      .map(table => [table, h.connection.prepare(`SELECT * FROM ${table}`).all()]);
    if (!hasResults) await assert.rejects(h.journal.pending(h.scope), /no such table: private_google_task_create_results/);
    await migrateLocalDatabase(h.database);
    assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version, 31);
    for (const [table, rows] of saved) assert.deepEqual(h.connection.prepare(`SELECT * FROM ${table}`).all(), rows);
    const pending = await h.journal.pending(h.scope);
    assert.deepEqual(pending, hasResults ? [{ intent, kind: 'created', taskId: 'already-created' }] : []);
    if (hasResults) {
      await h.journal.linked(intent, 'already-created', intent);
      await h.journal.settled(pending);
      assert.deepEqual(await h.journal.pending(h.scope), []);
      assert.equal((await h.journal.read(h.identity)).taskId, 'already-created');
    } else assert.equal(await h.journal.reserve(h.identity), null, 'an uncertain old insert must not be issued twice');
    let transactions = 0; const transact = h.database.withTransactionAsync;
    h.database.withTransactionAsync = async work => { transactions++; return transact(work); };
    await migrateLocalDatabase(h.database); assert.equal(transactions, 0);
    assert.equal(h.connection.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { h.connection.close(); }
});

test('the v29 Tasks journal upgrade rolls back on failure and a retry creates the missing result table without losing an uncertain insert', async () => {
  const h = fixture();
  try {
    await migrateLocalDatabase(h.database);
    const intent = await h.journal.reserve(h.identity);
    h.connection.exec('DROP TABLE private_google_task_create_results; PRAGMA user_version=29');
    const exec = h.database.execAsync;
    h.database.execAsync = async sql => {
      await exec(sql);
      if (sql.includes('CREATE TABLE IF NOT EXISTS private_google_task_create_results')) throw new Error('interrupted journal upgrade');
    };
    await assert.rejects(migrateLocalDatabase(h.database), /interrupted journal upgrade/);
    assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version, 29);
    assert.equal(h.connection.prepare("SELECT name FROM sqlite_master WHERE name='private_google_task_create_results'").get(), undefined);
    assert.deepEqual((await h.journal.read(h.identity)).intent, intent);
    h.database.execAsync = exec; await migrateLocalDatabase(h.database);
    assert.deepEqual(await h.journal.pending(h.scope), []);
    assert.equal(await h.journal.reserve(h.identity), null);
  } finally { h.connection.close(); }
});
