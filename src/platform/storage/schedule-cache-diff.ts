import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChoreScheduleEntry } from '../../domain/chores/types';

/** Caller owns the planner transaction and the complete affected cache scope. */
export async function writeScheduleCacheDiffInside(database: SQLiteDatabase, householdId: string,
  previous: readonly { id: string; entry_json: string }[], entries: readonly ChoreScheduleEntry[]) {
  const old = new Map(previous.map(row => [row.id, row.entry_json]));
  const encoded = new Map(entries.map(row => [row.id, JSON.stringify(row)]));
  const removed = previous.filter(row => !encoded.has(row.id));
  if (removed.length) await database.runAsync('DELETE FROM chore_schedule_entries WHERE household_id=? AND id IN (SELECT value FROM json_each(?))',
    householdId, JSON.stringify(removed.map(row => row.id)));
  const changed = entries.filter(row => old.get(row.id) !== encoded.get(row.id));
  for (let offset = 0; offset < changed.length; offset += 100) {
    const chunk = changed.slice(offset, offset + 100);
    await database.runAsync(`INSERT INTO chore_schedule_entries(id,household_id,chore_id,window_start,window_end,suggested_date,status,entry_json)
      VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',')} ON CONFLICT(id) DO UPDATE SET window_start=excluded.window_start,
      window_end=excluded.window_end,suggested_date=excluded.suggested_date,status=excluded.status,entry_json=excluded.entry_json`,
    ...chunk.flatMap(row => [row.id, row.householdId, row.choreId, row.windowStart, row.windowEnd, row.suggestedDate, row.status, encoded.get(row.id)!]));
  }
}
export async function saveScopedScheduleCacheInside(database: SQLiteDatabase, householdId: string, choreIds: readonly string[], entries: readonly ChoreScheduleEntry[]) {
  if (!choreIds.length) return;
  const previous = await database.getAllAsync<{ id: string; entry_json: string }>(
    'SELECT id,entry_json FROM chore_schedule_entries WHERE household_id=? AND chore_id IN (SELECT value FROM json_each(?))', householdId, JSON.stringify(choreIds));
  await writeScheduleCacheDiffInside(database, householdId, previous, entries);
}
