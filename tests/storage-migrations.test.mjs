import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';

function sqliteAdapter() {
  const connection = new DatabaseSync(':memory:');
  return {
    connection,
    database: {
      async execAsync(sql) { connection.exec(sql); },
      async runAsync(sql, ...params) { return connection.prepare(sql).run(...params); },
      async getFirstAsync(sql, ...params) { return connection.prepare(sql).get(...params) ?? null; },
      async getAllAsync(sql, ...params) { return connection.prepare(sql).all(...params); },
      async withTransactionAsync(callback) {
        connection.exec('BEGIN');
        try { await callback(); connection.exec('COMMIT'); }
        catch (error) { connection.exec('ROLLBACK'); throw error; }
      },
    },
  };
}

test('a database from a future app version is refused before any pragma mutation migration or seed write', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    connection.exec("CREATE TABLE future_records (content TEXT); INSERT INTO future_records VALUES ('preserve'); PRAGMA user_version=10000;");
    const before = connection.serialize(); let writes = 0; const exec = database.execAsync;
    database.execAsync = async (...args) => { writes++; return exec(...args); };
    await assert.rejects(migrateLocalDatabase(database), /更新してください/);
    assert.equal(writes, 0); assert.deepEqual(connection.serialize(), before);
  } finally { connection.close(); }
});

test('completion intent deduplication schema and per-chore history index are migrated once and used without completion-time DDL', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='planner_completion_intents'").get().n, 1);
    const plan = connection.prepare('EXPLAIN QUERY PLAN SELECT id, completed_at FROM chore_completions WHERE household_id=? AND chore_id=? ORDER BY completed_at DESC').all('home', 'chore');
    assert.ok(plan.some(row => row.detail.includes('idx_completions_household_chore_completed')));
    assert.ok(!plan.some(row => /TEMP B-TREE/.test(row.detail)));
    let transactions = 0; const transact = database.withTransactionAsync;
    database.withTransactionAsync = async callback => { transactions++; return transact(callback); };
    await migrateLocalDatabase(database); assert.equal(transactions, 0);
  } finally { connection.close(); }
});

test('schema migration creates the latest local planner and Google sync schema', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 27);
    const settingsColumns = connection.prepare('PRAGMA table_info(household_settings)').all().map((column) => column.name);
    assert.equal(settingsColumns.includes('notifications_enabled'), true);
    assert.equal(settingsColumns.includes('built_in_chore_catalog_version'), true);
    const wasteColumns = connection.prepare('PRAGMA table_info(weekly_waste_schedules)').all().map((column) => column.name);
    for (const column of ['recurrence', 'anchor_date', 'monthly_day']) assert.ok(wasteColumns.includes(column));
    const applianceColumns = connection.prepare('PRAGMA table_info(appliances)').all().map((column) => column.name);
    assert.deepEqual(applianceColumns, [
      'id', 'household_id', 'manufacturer', 'product_name', 'model_number', 'category', 'display_name',
      'official_product_url', 'official_manual_url', 'analysis_json', 'created_at', 'updated_at',
    ]);
    const hiddenColumns = connection.prepare('PRAGMA table_info(hidden_waste_occurrences)').all();
    assert.equal(hiddenColumns.find((column) => column.name === 'schedule_id').pk, 1);
    assert.equal(hiddenColumns.find((column) => column.name === 'occurrence_date').pk, 2);
    const completionColumns = connection.prepare('PRAGMA table_info(chore_completions)').all().map((column) => column.name);
    assert.equal(completionColumns.includes('scheduled_date'), true);
    assert.equal(completionColumns.includes('scheduled_window_start'), true);
    assert.equal(completionColumns.includes('scheduled_window_end'), true);
    const syncStateColumns = connection.prepare('PRAGMA table_info(google_sync_state)').all().map((column) => column.name);
    assert.deepEqual(syncStateColumns, [
      'household_id', 'enabled', 'task_list_id', 'last_attempt_at', 'last_successful_sync_at', 'status',
      'retry_count', 'next_retry_at', 'last_error_code', 'last_error_at', 'updated_at', 'account_subject', 'connection_active',
    ]);
    const taskLinkColumns = connection.prepare('PRAGMA table_info(google_task_links)').all().map((column) => column.name);
    assert.deepEqual(taskLinkColumns, [
      'schedule_entry_id', 'household_id', 'chore_id', 'google_task_list_id', 'google_task_id',
      'last_synced_title', 'last_synced_due_date', 'created_at', 'updated_at',
      'last_synced_status', 'pending_status', 'pending_status_revision',
    ]);
  } finally {
    connection.close();
  }
});

test('restored recurrence migrates current v16 weekly data without erasing labels or exceptions', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`
      INSERT INTO households VALUES ('home', 'Home', '2026-10-26T00:00:00.000Z');
      INSERT INTO weekly_waste_schedules (id, household_id, label, weekdays_json) VALUES ('waste', 'home', '可燃ごみ', '[2,5]');
      INSERT INTO hidden_waste_occurrences VALUES ('waste', '2026-10-27');
      ALTER TABLE weekly_waste_schedules DROP COLUMN recurrence;
      ALTER TABLE weekly_waste_schedules DROP COLUMN anchor_date;
      ALTER TABLE weekly_waste_schedules DROP COLUMN monthly_day;
      PRAGMA user_version = 16;
    `);
    await migrateLocalDatabase(database);
    const row = connection.prepare('SELECT * FROM weekly_waste_schedules').get();
    assert.equal(row.recurrence, 'weekly');
    assert.equal(row.label, '可燃ごみ');
    assert.equal(row.weekdays_json, '[2,5]');
    assert.equal(connection.prepare('SELECT occurrence_date FROM hidden_waste_occurrences').get().occurrence_date, '2026-10-27');
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM weekly_waste_schedules').get().n, 1);
  } finally { connection.close(); }
});

test('former waste v13 schema retains biweekly/monthly data and gains the main catalog columns', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`
      INSERT INTO households VALUES ('home', 'Home', '2026-10-26T00:00:00.000Z');
      INSERT INTO weekly_waste_schedules (id, household_id, label, weekdays_json, recurrence, anchor_date)
      VALUES ('biweekly', 'home', 'びん', '[4]', 'biweekly', '2026-10-29');
      INSERT INTO weekly_waste_schedules (id, household_id, label, weekdays_json, recurrence, monthly_day)
      VALUES ('monthly', 'home', '粗大ごみ', '[]', 'monthly', 31);
      ALTER TABLE household_settings DROP COLUMN built_in_chore_catalog_version;
      PRAGMA user_version = 13;
    `);
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('SELECT anchor_date FROM weekly_waste_schedules WHERE id = ?').get('biweekly').anchor_date, '2026-10-29');
    assert.equal(connection.prepare('SELECT monthly_day FROM weekly_waste_schedules WHERE id = ?').get('monthly').monthly_day, 31);
    assert.ok(connection.prepare('PRAGMA table_info(household_settings)').all().some((column) => column.name === 'built_in_chore_catalog_version'));
  } finally { connection.close(); }
});

test('version 6 migration tolerates a notification preference column already present in an existing database', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`
      DROP INDEX IF EXISTS idx_completions_household_scheduled;
      DROP TABLE hidden_waste_occurrences;
      DROP TABLE appliances;
      ALTER TABLE chore_completions DROP COLUMN previous_chore_state_json;
      ALTER TABLE chore_completions DROP COLUMN scheduled_window_end;
      ALTER TABLE chore_completions DROP COLUMN scheduled_window_start;
      ALTER TABLE chore_completions DROP COLUMN scheduled_date;
      PRAGMA user_version = 6;
    `);

    await migrateLocalDatabase(database);

    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 27);
    const settingsColumns = connection.prepare('PRAGMA table_info(household_settings)').all();
    assert.equal(settingsColumns.filter((column) => column.name === 'notifications_enabled').length, 1);
    assert.equal(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'appliances'").get().name, 'appliances');
    const completionColumns = connection.prepare('PRAGMA table_info(chore_completions)').all().map((column) => column.name);
    assert.equal(completionColumns.filter((column) => column === 'scheduled_date').length, 1);
    assert.equal(completionColumns.includes('scheduled_window_start'), true);
    assert.equal(completionColumns.includes('scheduled_window_end'), true);
    assert.equal(completionColumns.filter((column) => column === 'previous_chore_state_json').length, 1);
  } finally {
    connection.close();
  }
});

test('Google task mappings survive local schedule and chore deletion for remote cleanup', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`
      INSERT INTO households (id, name, created_at) VALUES ('home', 'Home', '2026-10-25T00:00:00.000Z');
      INSERT INTO chore_definitions (id, household_id, name, enabled, definition_json)
      VALUES ('chore', 'home', '掃除', 1, '{}');
      INSERT INTO chore_schedule_entries
        (id, household_id, chore_id, window_start, window_end, suggested_date, status, entry_json)
      VALUES ('entry', 'home', 'chore', '2026-10-25', '2026-10-25', '2026-10-25', 'scheduled', '{}');
      INSERT INTO google_task_links
        (schedule_entry_id, household_id, chore_id, google_task_list_id, google_task_id, created_at, updated_at)
      VALUES ('entry', 'home', 'chore', 'list', 'task', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
      DELETE FROM chore_schedule_entries WHERE id = 'entry';
      DELETE FROM chore_definitions WHERE id = 'chore';
    `);
    assert.equal(connection.prepare('SELECT google_task_id FROM google_task_links WHERE schedule_entry_id = ?').get('entry').google_task_id, 'task');
  } finally {
    connection.close();
  }
});

test('failure during an old schema upgrade rolls back its DDL and version and can be retried', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    const exec = database.execAsync;
    database.execAsync = async (sql) => {
      if (sql.includes('CREATE INDEX IF NOT EXISTS idx_completions_household_completed')) throw new Error('interrupted migration');
      return exec(sql);
    };
    await assert.rejects(migrateLocalDatabase(database), /interrupted migration/);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0);
    database.execAsync = exec;
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 27);
  } finally { connection.close(); }
});

test('concurrent migrations on one connection join the same transaction', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await Promise.all([migrateLocalDatabase(database), migrateLocalDatabase(database), migrateLocalDatabase(database)]);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 27);
  } finally { connection.close(); }
});

test('a failed v16 status-column migration leaves no partially added columns', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`ALTER TABLE google_task_links DROP COLUMN last_synced_status;
      ALTER TABLE google_task_links DROP COLUMN pending_status;
      ALTER TABLE google_task_links DROP COLUMN pending_status_revision;
      ALTER TABLE household_settings DROP COLUMN planner_calendar_signature;
      PRAGMA user_version = 15;`);
    const exec = database.execAsync;
    database.execAsync = async (sql) => {
      if (sql.includes('ADD COLUMN pending_status ')) throw new Error('interrupted status migration');
      return exec(sql);
    };
    await assert.rejects(migrateLocalDatabase(database), /interrupted status migration/);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 15);
    assert.ok(!connection.prepare('PRAGMA table_info(google_task_links)').all().some((column) => column.name === 'last_synced_status'));
    database.execAsync = exec;
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 27);
  } finally { connection.close(); }
});

test('a transient SQLite busy error retries the complete migration', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    const exec = database.execAsync; let failures = 0;
    database.execAsync = async (sql) => {
      if (sql.includes('PRAGMA busy_timeout') && failures++ === 0) throw new Error('SQLITE_BUSY: database is locked');
      return exec(sql);
    };
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 27);
    assert.equal(failures, 2);
  } finally { connection.close(); }
});

test('current-schema reads avoid write transactions but a restored older version still migrates on the same handle', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database); let writes = 0; const transact = database.withTransactionAsync;
    database.withTransactionAsync = async work => { writes++; return transact(work); };
    for (let i = 0; i < 10; i++) await migrateLocalDatabase(database);
    assert.equal(writes, 0);
    connection.exec('PRAGMA user_version = 20');
    await migrateLocalDatabase(database); assert.equal(writes, 1);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 27);
    assert.equal(connection.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally { connection.close(); }
});
