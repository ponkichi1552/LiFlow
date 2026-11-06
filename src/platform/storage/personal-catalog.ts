import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChoreDefinition } from '../../domain/chores/types';
import { createPersonalChoreDefinitions, PERSONAL_CHORE_CATALOG_VERSION } from '../../domain/chores/personal-catalog.ts';

/** Adopt the new private catalogue, without a guessed old-to-new task or history mapping. Caller owns the transaction. */
export async function installPersonalCatalogInside(database: SQLiteDatabase, householdId: string, memberId: string) {
  if (!await database.isInTransactionAsync()) throw new Error('家事一覧は一括で保存してください。');
  const current = await database.getFirstAsync<{ built_in_chore_catalog_version: number }>(
    'SELECT built_in_chore_catalog_version FROM household_settings WHERE household_id=?', householdId,
  );
  if (!current) throw new Error('家事の保存先がありません。');
  if (current.built_in_chore_catalog_version >= PERSONAL_CHORE_CATALOG_VERSION) return;
  const previous = await database.getAllAsync<{ id: string; definition_json: string }>(
    'SELECT id,definition_json FROM chore_definitions WHERE household_id=?', householdId,
  );
  for (const row of previous) {
    const definition = JSON.parse(row.definition_json) as ChoreDefinition;
    if (definition.applianceId || definition.applianceCareSource || !/^(?:builtin-chore-\d{2}|chore-\d{2})$/u.test(row.id)) continue;
    // FK cascades remove the old private settings/state/history. Retain opaque
    // Google Task links until managed-obsolete reconciliation can retire them.
    await database.runAsync('DELETE FROM chore_definitions WHERE id=? AND household_id=?', row.id, householdId);
    for (const table of ['personal_adaptive_policies', 'personal_adaptive_actions', 'personal_adaptive_state',
      'personal_adaptive_plans', 'personal_adaptive_forecasts', 'personal_seasonal_state']) {
      await database.runAsync(`DELETE FROM ${table} WHERE chore_id=?`, row.id);
    }
  }
  for (const chore of createPersonalChoreDefinitions(householdId)) {
    await database.runAsync('INSERT OR IGNORE INTO chore_definitions(id,household_id,name,enabled,definition_json) VALUES(?,?,?,?,?)',
      chore.id, householdId, chore.name, Number(chore.enabled), JSON.stringify(chore));
    await database.runAsync("INSERT OR IGNORE INTO chore_state(chore_id,initial_pending,unknown_reason) VALUES(?,1,'unknown')", chore.id);
    await database.runAsync('INSERT OR IGNORE INTO chore_assignments(chore_id,member_id) VALUES(?,?)', chore.id, memberId);
  }
  await database.runAsync('DELETE FROM personal_adaptive_inputs WHERE household_id=?', householdId);
  await database.runAsync('UPDATE household_settings SET built_in_chore_catalog_version=? WHERE household_id=?',
    PERSONAL_CHORE_CATALOG_VERSION, householdId);
}
