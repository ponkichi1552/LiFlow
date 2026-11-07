import type { SQLiteDatabase } from 'expo-sqlite';
import { initializeGoogleTaskCreateIntentsInside } from './google-task-create-intents.ts';
import { initializeAdaptivePersonalSchemaInside, repairLegacyAdaptiveUndoInside } from './adaptive-personal-chores.ts';
import { initializeGoogleTaskReadCacheInside } from './google-task-read-cache.ts';
import { initializePlanningInputRevisionInside } from './planning-input-revision.ts';

const INITIAL_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 29;

function assertReadableVersion(version: number) {
  if (!Number.isSafeInteger(version) || version < 0 || version > CURRENT_SCHEMA_VERSION) throw new Error('新しいバージョンで保存されたデータです。LiFlowを更新してください。');
}

const runningMigrations = new WeakMap<SQLiteDatabase, Promise<void>>();

export async function migrateLocalDatabase(database: SQLiteDatabase): Promise<void> {
  const existing = runningMigrations.get(database);
  if (existing) return existing;
  const migration = runMigration(database);
  runningMigrations.set(database, migration);
  try { await migration; }
  finally { if (runningMigrations.get(database) === migration) runningMigrations.delete(database); }
}

async function runMigration(database: SQLiteDatabase): Promise<void> {
  // Connection PRAGMAs must be outside the transaction. All schema changes and version writes commit together.
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Recheck the real version on every call, including after restore/reset. A
      // current schema needs no write transaction or repeat migration work.
      const version = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      assertReadableVersion(version?.user_version ?? 0);
      await database.execAsync('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      if (version?.user_version === CURRENT_SCHEMA_VERSION) return;
      await database.withTransactionAsync(() => migrateSchema(database));
      return;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !/SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/iu.test(error.message)) throw error;
      // Only retry the rolled-back migration, never a partially committed user operation.
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function addColumnIfMissing(database: SQLiteDatabase, table: string, column: string, declaration: string): Promise<void> {
  const columns = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

async function migrateSchema(database: SQLiteDatabase): Promise<void> {
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = versionRow?.user_version ?? 0;
  assertReadableVersion(version);
  const startingVersion = version;

  if (version < INITIAL_SCHEMA_VERSION) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS households (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS household_members (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chore_definitions (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        definition_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chore_assignments (
        chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
        PRIMARY KEY (chore_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS chore_dependencies (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        predecessor_chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        successor_chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        policy_json TEXT
      );

      CREATE TABLE IF NOT EXISTS chore_schedule_entries (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        suggested_date TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chore_completions (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        completed_at TEXT NOT NULL,
        completed_by_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
        source TEXT
      );

      CREATE TABLE IF NOT EXISTS weekly_waste_schedules (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        weekdays_json TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        change_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
    await database.execAsync(`PRAGMA user_version = ${INITIAL_SCHEMA_VERSION}`);
    version = INITIAL_SCHEMA_VERSION;
  }

  if (version < 2) {
    await addColumnIfMissing(database, 'chore_completions', 'schedule_entry_id', 'TEXT');
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS household_settings (
        household_id TEXT PRIMARY KEY NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        frequency_mode TEXT NOT NULL DEFAULT 'balanced',
        rest_days_json TEXT NOT NULL DEFAULT '[6,7]',
        heavy_daily_limit INTEGER NOT NULL DEFAULT 1,
        normal_daily_limit INTEGER NOT NULL DEFAULT 2,
        notification_hour INTEGER NOT NULL DEFAULT 9,
        notification_minute INTEGER NOT NULL DEFAULT 0,
        setup_completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chore_state (
        chore_id TEXT PRIMARY KEY NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        last_completed_date TEXT,
        last_completed_estimated INTEGER NOT NULL DEFAULT 0,
        initial_pending INTEGER NOT NULL DEFAULT 1,
        unknown_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_household_suggested
        ON chore_schedule_entries(household_id, suggested_date);
      CREATE INDEX IF NOT EXISTS idx_completions_household_completed
        ON chore_completions(household_id, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dependencies_successor
        ON chore_dependencies(successor_chore_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_schedule_entry
        ON chore_completions(schedule_entry_id);
    `);
    await database.execAsync('PRAGMA user_version = 2');
    version = 2;
  }

  if (version < 3) {
    await addColumnIfMissing(database, 'chore_state', 'initial_scheduled_date', 'TEXT');
    await database.execAsync('PRAGMA user_version = 3');
    version = 3;
  }

  if (version < 4) {
    await addColumnIfMissing(database, 'chore_completions', 'outcome', "TEXT NOT NULL DEFAULT 'completed'");
    await database.execAsync('PRAGMA user_version = 4');
    version = 4;
  }

  const settingsColumns = new Set(
    (await database.getAllAsync<{ name: string }>('PRAGMA table_info(household_settings)'))
      .map((column) => column.name),
  );
  const legacyWeatherSettings = version < 6 || !settingsColumns.has('weather_region');
  const weatherColumns = [
    ['weather_latitude', 'REAL'],
    ['weather_longitude', 'REAL'],
    ['weather_region', 'TEXT'],
    ['weather_region_name', 'TEXT'],
  ] as const;

  for (const [name, type] of weatherColumns) {
    if (!settingsColumns.has(name)) {
      await database.execAsync(`ALTER TABLE household_settings ADD COLUMN ${name} ${type}`);
    }
  }

  if (legacyWeatherSettings) {
    await database.execAsync('UPDATE household_settings SET weather_latitude = NULL, weather_longitude = NULL');
  }
  if (version < 7) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS appliances (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        manufacturer TEXT NOT NULL,
        product_name TEXT NOT NULL,
        model_number TEXT NOT NULL,
        category TEXT,
        display_name TEXT NOT NULL,
        official_product_url TEXT,
        official_manual_url TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_appliances_household
        ON appliances(household_id, display_name);

      CREATE TABLE IF NOT EXISTS hidden_waste_occurrences (
        schedule_id TEXT NOT NULL REFERENCES weekly_waste_schedules(id) ON DELETE CASCADE,
        occurrence_date TEXT NOT NULL,
        PRIMARY KEY (schedule_id, occurrence_date)
      );
    `);
    if (!settingsColumns.has('notifications_enabled')) {
      await database.execAsync('ALTER TABLE household_settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 0');
    }
    version = 7;
  }
  if (version < 8) {
    await addColumnIfMissing(database, 'chore_completions', 'scheduled_date', 'TEXT');
    await database.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_completions_household_scheduled
        ON chore_completions(household_id, scheduled_date);
      PRAGMA user_version = 8;
    `);
    version = 8;
  }
  if (version < 9) {
    await addColumnIfMissing(database, 'chore_completions', 'scheduled_window_start', 'TEXT');
    await addColumnIfMissing(database, 'chore_completions', 'scheduled_window_end', 'TEXT');
    await database.execAsync('PRAGMA user_version = 9');
    version = 9;
  }
  if (version < 10) {
    await addColumnIfMissing(database, 'chore_completions', 'previous_chore_state_json', 'TEXT');
    await database.execAsync('PRAGMA user_version = 10');
    version = 10;
  }
  if (version < 11) {
    if (!settingsColumns.has('calendar_count_colors_json')) {
      await database.execAsync(`
        ALTER TABLE household_settings ADD COLUMN calendar_count_colors_json TEXT NOT NULL
          DEFAULT '{"low":"#4AADE0","medium":"#F2A541","high":"#E45B61"}';
      `);
    }
    await database.execAsync('PRAGMA user_version = 11');
    version = 11;
  }
  if (version < 12) {
    if (!settingsColumns.has('calendar_count_display_mode')) {
      await database.execAsync(`
        ALTER TABLE household_settings ADD COLUMN calendar_count_display_mode TEXT NOT NULL DEFAULT 'bar';
      `);
    }
    await database.execAsync('PRAGMA user_version = 12');
    version = 12;
  }
  if (version < 13) {
    if (!settingsColumns.has('built_in_chore_catalog_version')) {
      await database.execAsync(`
        ALTER TABLE household_settings ADD COLUMN built_in_chore_catalog_version INTEGER NOT NULL DEFAULT 0;
      `);
    }
    await database.execAsync('PRAGMA user_version = 13');
    version = 13;
  }
  if (version < 14) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS google_sync_state (
        household_id TEXT PRIMARY KEY NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        task_list_id TEXT,
        last_attempt_at TEXT,
        last_successful_sync_at TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        last_error_code TEXT,
        last_error_at TEXT,
        updated_at TEXT NOT NULL
      );

      -- Keep remote task IDs after local schedule/chore rows are pruned so the coordinator
      -- can clean up obsolete Google Tasks on its next run instead of losing their mapping.
      CREATE TABLE IF NOT EXISTS google_task_links (
        schedule_entry_id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL,
        chore_id TEXT NOT NULL,
        google_task_list_id TEXT NOT NULL,
        google_task_id TEXT NOT NULL,
        last_synced_title TEXT,
        last_synced_due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (google_task_list_id, google_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_google_task_links_household
        ON google_task_links(household_id);
      PRAGMA user_version = 14;
    `);
    version = 14;
  }
  if (version < 15) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS calendar_availability_state (
        household_id TEXT PRIMARY KEY NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        status TEXT NOT NULL DEFAULT 'idle',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_successful_sync_at TEXT,
        next_retry_at TEXT,
        last_error_code TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendar_availability_days (
        household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        busy_minutes INTEGER NOT NULL CHECK(busy_minutes >= 0),
        time_zone TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(household_id, local_date)
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_availability_freshness
        ON calendar_availability_days(household_id, time_zone, fetched_at);
      PRAGMA user_version = 15;
    `);
    version = 15;
  }
  if (version < 16) {
    await addColumnIfMissing(database, 'google_task_links', 'last_synced_status', 'TEXT');
    await addColumnIfMissing(database, 'google_task_links', 'pending_status', 'TEXT');
    await addColumnIfMissing(database, 'google_task_links', 'pending_status_revision', 'TEXT');
    await addColumnIfMissing(database, 'household_settings', 'planner_calendar_signature', 'TEXT');
    await database.execAsync('PRAGMA user_version = 16');
    version = 16;
  }
  if (version < 17) {
    // The former waste branch used version 13 for different columns. Tolerate either lineage.
    await addColumnIfMissing(database, 'weekly_waste_schedules', 'recurrence', "TEXT NOT NULL DEFAULT 'weekly'");
    await addColumnIfMissing(database, 'weekly_waste_schedules', 'anchor_date', 'TEXT');
    await addColumnIfMissing(database, 'weekly_waste_schedules', 'monthly_day', 'INTEGER');
    await addColumnIfMissing(database, 'household_settings', 'built_in_chore_catalog_version', 'INTEGER NOT NULL DEFAULT 0');
    await database.execAsync('PRAGMA user_version = 17');
    version = 17;
  }
  if (version < 18) {
    await addColumnIfMissing(database, 'google_sync_state', 'account_subject', 'TEXT');
    await database.execAsync('PRAGMA user_version = 18');
    version = 18;
  }
  if (version < 19) {
    // Disconnecting one workspace must not revoke the native Google session used by another.
    await addColumnIfMissing(database, 'google_sync_state', 'connection_active', 'INTEGER NOT NULL DEFAULT 1');
    await database.execAsync('PRAGMA user_version = 19');
    version = 19;
  }
  if (version < 20) {
    // Personal calendar data has no shared outbox or Google linkage. Keep it
    // independent of generated schedule rows, which are routinely regenerated.
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS calendar_categories (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0)
      );
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY NOT NULL, definition_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS calendar_event_exceptions (
        event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
        anchor_date TEXT NOT NULL, override_json TEXT, revision INTEGER NOT NULL CHECK(revision > 0),
        PRIMARY KEY(event_id, anchor_date)
      );
      CREATE TABLE IF NOT EXISTS calendar_drafts (slot TEXT PRIMARY KEY NOT NULL, draft_json TEXT NOT NULL);
      PRAGMA user_version = 20;
    `);
    version = 20;
  }
  if (version < 21) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS appliance_manual_documents (
        sha256 TEXT PRIMARY KEY NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 32 AND 6291456),
        content_base64 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS appliance_shared_copies (
        group_id TEXT NOT NULL, shared_id TEXT NOT NULL, personal_id TEXT NOT NULL, source_digest TEXT NOT NULL,
        PRIMARY KEY(group_id, shared_id)
      );
      PRAGMA user_version = 21;
    `);
    version = 21;
  }
  if (version < 22) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS planner_completion_intents (
        intent_id TEXT PRIMARY KEY, target_digest TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_completions_household_chore_completed
        ON chore_completions (household_id, chore_id, completed_at DESC);
    `);
    version = 22;
  }
  if (version < 23) {
    await addColumnIfMissing(database, 'chore_completions', 'completed_local_date', 'TEXT');
    await addColumnIfMissing(database, 'chore_completions', 'completed_time_zone', 'TEXT');
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS chore_completion_actions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        completion_id TEXT NOT NULL REFERENCES chore_completions(id) ON DELETE CASCADE,
        chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('complete','undo','legacy')),
        target_sequence INTEGER, previous_action_sequence INTEGER,
        completed_at TEXT NOT NULL, completed_local_date TEXT NOT NULL, time_zone TEXT NOT NULL,
        scheduled_date TEXT, scheduled_window_start TEXT, previous_chore_state_json TEXT,
        source TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('personal','shared'))
      );
      CREATE INDEX IF NOT EXISTS idx_completion_actions_chore_sequence ON chore_completion_actions(chore_id,sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_completion_actions_completion_sequence ON chore_completion_actions(completion_id,sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_completion_actions_chore_day ON chore_completion_actions(chore_id,completed_local_date,sequence DESC);
    `);
    version = 23;
  }
  if (version < 24) {
    await initializeGoogleTaskCreateIntentsInside(database);
    version = 24;
  }
  if (version < 25) {
    await initializeAdaptivePersonalSchemaInside(database);
    await addColumnIfMissing(database, 'chore_completions', 'adaptive_operation_id', 'TEXT');
    await addColumnIfMissing(database, 'chore_completions', 'seasonal_work', 'TEXT');
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS personal_adaptive_preferences (
        household_id TEXT PRIMARY KEY NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, preferences_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_adaptive_inputs (
        household_id TEXT PRIMARY KEY NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        source_revision TEXT NOT NULL, geometry_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_seasonal_state (
        chore_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL,
        state_json TEXT NOT NULL, source_revision TEXT NOT NULL
      );
    `);
    version = 25;
  }
  if (version < 26) {
    await initializeGoogleTaskReadCacheInside(database);
    version = 26;
  }
  if (version < 27) {
    await addColumnIfMissing(database, 'household_settings', 'weather_municipality_id', 'TEXT');
    await database.execAsync(`CREATE TABLE IF NOT EXISTS private_weather_cache (
      region_id TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL, cache_json TEXT NOT NULL
    );`);
    version = 27;
  }
  if (version < 28) {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS widget_completion_generations (
      schedule_entry_id TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS widget_rejected_inputs (
      digest TEXT PRIMARY KEY NOT NULL, raw_json TEXT NOT NULL, reason TEXT NOT NULL);`);
    await initializePlanningInputRevisionInside(database);
    await initializeGoogleTaskReadCacheInside(database);
    await repairLegacyAdaptiveUndoInside(database);
    version = 28;
  }
  if (version < 29) {
    // Deleted Google/local events remain as synchronization tombstones. Display
    // reads should visit live rows, even after years of edits or account changes.
    await database.execAsync('CREATE INDEX IF NOT EXISTS idx_calendar_events_visible ON calendar_events(deleted,id)');
    version = 29;
  }
  if (startingVersion < CURRENT_SCHEMA_VERSION) {
    await database.execAsync(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
}
