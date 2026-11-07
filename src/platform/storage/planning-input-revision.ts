import type { SQLiteDatabase } from 'expo-sqlite';

/** Transport metadata can change the visible calendar without changing an event row. */
export async function changePlanningInputRevisionInside(tx: SQLiteDatabase) {
  await tx.runAsync('UPDATE personal_planning_input_revision SET revision=revision+1 WHERE singleton=1');
}

/** Persistent, content-free revision shared by every connection of this file. */
export async function initializePlanningInputRevisionInside(tx: SQLiteDatabase) {
  await tx.execAsync(`CREATE TABLE IF NOT EXISTS personal_planning_input_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO personal_planning_input_revision VALUES(1,0);`);
  const tables = ['household_settings','chore_definitions','chore_completions','chore_state','chore_schedule_entries',
    'calendar_events','calendar_event_exceptions','personal_adaptive_preferences','personal_adaptive_inputs','personal_seasonal_state','private_weather_cache'];
  for (const table of tables) for (const action of ['INSERT','UPDATE','DELETE']) await tx.execAsync(`CREATE TRIGGER IF NOT EXISTS planning_${table}_${action.toLowerCase()}
    AFTER ${action} ON ${table} BEGIN UPDATE personal_planning_input_revision SET revision=revision+1 WHERE singleton=1; END;`);
}
export async function readPlanningInputRevision(database: SQLiteDatabase): Promise<number> {
  const row = await database.getFirstAsync<{ revision: number }>('SELECT revision FROM personal_planning_input_revision WHERE singleton=1');
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('本人の予定の更新状態を確認してください。');
  return row.revision;
}
