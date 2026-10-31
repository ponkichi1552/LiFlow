import type { SQLiteDatabase } from 'expo-sqlite';
import type { HouseholdPlannerSettings } from '../../domain/chores/types.ts';
import { parseCalendarCountColors } from '../../domain/calendar/count-colors.ts';
import type { PlannerSnapshot } from './repository.ts';
import type { SharedReplica } from '../../features/sharing/replica.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { sharedPlanningSignature } from '../../features/sharing/planning.ts';
import { migrateLocalDatabase } from './migrations.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { stagePendingGoogleTaskStatus } from './google-task-link-state.ts';

export async function assertSharedProjectionCanInitialize(database: SQLiteDatabase): Promise<void> {
  const tables = new Set((await database.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name));
  if (!tables.has('sharing_workspace_metadata')) {
    for (const table of ['households', 'chore_definitions', 'chore_completions', 'appliances', 'weekly_waste_schedules', 'google_task_links', 'google_sync_state']) {
      if (tables.has(table) && await database.getFirstAsync(`SELECT 1 FROM ${table} LIMIT 1`)) throw new Error('既存の個人DBを共有用へ変換することはできません。');
    }
  }
}

export async function initializeSharedProjection(database: SQLiteDatabase,
  scope: { userId: string; groupId: string; householdId: string }): Promise<void> {
  await assertSharedProjectionCanInitialize(database);
  await migrateLocalDatabase(database);
  await database.execAsync(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sharing_workspace_metadata (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      user_id TEXT NOT NULL, group_id TEXT NOT NULL, household_id TEXT NOT NULL,
      projection_token TEXT NOT NULL DEFAULT '', projection_day TEXT, projection_signature TEXT
    );`);
  await withIsolatedSqliteTransaction(database, async (transaction) => {
    await transaction.runAsync('INSERT OR IGNORE INTO sharing_workspace_metadata (singleton, user_id, group_id, household_id) VALUES (1, ?, ?, ?)', scope.userId, scope.groupId, scope.householdId);
    const stored = await transaction.getFirstAsync<{ user_id: string; group_id: string; household_id: string }>('SELECT user_id, group_id, household_id FROM sharing_workspace_metadata WHERE singleton = 1');
    if (stored?.user_id !== scope.userId || stored.group_id !== scope.groupId || stored.household_id !== scope.householdId) throw new Error('共有DBのアカウントまたはグループが一致しません。');
  });
}

export async function readSharedPrivateSettings(database: SQLiteDatabase, householdId: string): Promise<Partial<HouseholdPlannerSettings>> {
  const row = await database.getFirstAsync<{ notification_hour: number; notification_minute: number; notifications_enabled: number;
    calendar_count_colors_json: string | null; calendar_count_display_mode: string }>(`SELECT notification_hour, notification_minute, notifications_enabled,
      calendar_count_colors_json, calendar_count_display_mode FROM household_settings WHERE household_id = ?`, householdId);
  return row ? { notificationHour: row.notification_hour, notificationMinute: row.notification_minute, notificationsEnabled: Boolean(row.notifications_enabled),
    calendarCountColors: parseCalendarCountColors(row.calendar_count_colors_json), calendarCountDisplayMode: 'dots' } : {};
}

export function sharedProjectionToken(replica: SharedReplica, snapshot: PlannerSnapshot): string {
  return sharedDocumentDigest({ groupId: replica.groupId, frontier: replica.frontier, clock: replica.logicalClock, receipts: replica.operationIndex.length,
    pending: replica.pendingOperationIds, members: snapshot.sharing?.activeMemberIds ?? [] });
}

/** Derived rows are a compatibility cache for existing screens and private Google mappings. */
export async function persistSharedScheduleRows(database: SQLiteDatabase, snapshot: PlannerSnapshot): Promise<void> {
  const householdId = snapshot.household.id;
  const previous = new Map((await database.getAllAsync<{ id: string; entry_json: string }>('SELECT id, entry_json FROM chore_schedule_entries WHERE household_id = ?', householdId)).map((row) => [row.id, row.entry_json]));
  for (const entry of snapshot.scheduleEntries) {
    const encoded = JSON.stringify(entry); const existing = previous.get(entry.id); previous.delete(entry.id);
    if (existing === encoded) continue;
    await database.runAsync(`INSERT INTO chore_schedule_entries (id, household_id, chore_id, window_start, window_end, suggested_date, status, entry_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET window_start=excluded.window_start, window_end=excluded.window_end,
      suggested_date=excluded.suggested_date, status=excluded.status, entry_json=excluded.entry_json`, entry.id, householdId, entry.choreId,
    entry.windowStart, entry.windowEnd, entry.suggestedDate, entry.status, encoded);
  }
  for (const id of previous.keys()) await database.runAsync('DELETE FROM chore_schedule_entries WHERE household_id = ? AND id = ?', householdId, id);
}

/** Runs inside the ledger's transaction; it never creates shared operations or touches another DB. */
export async function persistSharedProjection(database: SQLiteDatabase, replica: SharedReplica, snapshot: PlannerSnapshot,
  options: { userId: string; importedGoogleOccurrenceIds?: ReadonlySet<string> }): Promise<void> {
  const meta = await database.getFirstAsync<{ user_id: string; group_id: string; household_id: string; projection_token: string; projection_day: string; projection_signature: string }>('SELECT user_id, group_id, household_id, projection_token, projection_day, projection_signature FROM sharing_workspace_metadata WHERE singleton = 1');
  const householdId = snapshot.household.id;
  if (meta?.user_id !== options.userId || meta.group_id !== replica.groupId || snapshot.sharing?.groupId !== replica.groupId || meta.household_id !== householdId) throw new Error('Projection cannot cross workspace boundaries');
  const token = sharedProjectionToken(replica, snapshot); const now = new Date().toISOString();
  const planningSignature = sharedPlanningSignature(snapshot);
  if (meta.projection_token === token && meta.projection_day === snapshot.today && meta.projection_signature === planningSignature) return;
  await database.runAsync(`INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE households.name != excluded.name`, householdId, snapshot.household.name, snapshot.household.createdAt);
  await database.runAsync(`INSERT INTO household_settings (household_id, frequency_mode, rest_days_json, heavy_daily_limit, normal_daily_limit,
    notification_hour, notification_minute, notifications_enabled, setup_completed, updated_at)
    VALUES (?, ?, ?, ?, ?, 9, 0, 0, 1, ?) ON CONFLICT(household_id) DO UPDATE SET frequency_mode=excluded.frequency_mode,
    rest_days_json=excluded.rest_days_json, heavy_daily_limit=excluded.heavy_daily_limit, normal_daily_limit=excluded.normal_daily_limit,
    setup_completed=1, updated_at=excluded.updated_at WHERE household_settings.frequency_mode != excluded.frequency_mode
      OR household_settings.rest_days_json != excluded.rest_days_json OR household_settings.heavy_daily_limit != excluded.heavy_daily_limit
      OR household_settings.normal_daily_limit != excluded.normal_daily_limit OR household_settings.setup_completed != 1`,
  householdId, snapshot.settings.frequencyMode, JSON.stringify(snapshot.settings.restDays), snapshot.settings.heavyDailyLimit, snapshot.settings.normalDailyLimit, now);
  const oldMembers = new Map((await database.getAllAsync<{ id: string; display_name: string }>('SELECT id, display_name FROM household_members WHERE household_id=?', householdId)).map((row) => [row.id, row.display_name]));
  for (const member of snapshot.members) if (oldMembers.get(member.id) !== member.displayName) await database.runAsync(`INSERT INTO household_members (id, household_id, display_name) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name`, member.id, householdId, member.displayName);
  const definitions = new Map((await database.getAllAsync<{ id: string; definition_json: string }>('SELECT id, definition_json FROM chore_definitions WHERE household_id = ?', householdId)).map((row) => [row.id, row.definition_json]));
  for (const chore of snapshot.chores) {
    const encoded = JSON.stringify(chore); const old = definitions.get(chore.id); definitions.delete(chore.id);
    if (old === encoded) continue;
    await database.runAsync(`INSERT INTO chore_definitions (id, household_id, name, enabled, definition_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, definition_json=excluded.definition_json`, chore.id, householdId, chore.name, chore.enabled ? 1 : 0, encoded);
  }
  for (const [id, encoded] of definitions) {
    const prior = JSON.parse(encoded);
    if (prior.enabled || !prior.archived) await database.runAsync('UPDATE chore_definitions SET enabled=0, definition_json=? WHERE id=?', JSON.stringify({ ...prior, enabled: false, archived: true }), id);
  }
  const oldStates = new Map((await database.getAllAsync<{ chore_id: string; last_completed_date: string | null; last_completed_estimated: number;
    initial_pending: number; initial_scheduled_date: string | null; unknown_reason: string | null }>(`SELECT s.chore_id, s.last_completed_date, s.last_completed_estimated,
      s.initial_pending, s.initial_scheduled_date, s.unknown_reason FROM chore_state s JOIN chore_definitions c ON c.id=s.chore_id WHERE c.household_id=?`, householdId))
    .map((row) => [row.chore_id, JSON.stringify([row.last_completed_date, row.last_completed_estimated, row.initial_pending, row.initial_scheduled_date, row.unknown_reason])]));
  for (const state of snapshot.states) {
    const values = [state.lastCompletedDate ?? null, state.lastCompletedEstimated ? 1 : 0, state.initialPending ? 1 : 0, state.initialScheduledDate ?? null, state.unknownReason ?? null] as const;
    if (oldStates.get(state.choreId) === JSON.stringify(values)) continue;
    await database.runAsync(`INSERT INTO chore_state (chore_id, last_completed_date, last_completed_estimated, initial_pending, initial_scheduled_date, unknown_reason)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chore_id) DO UPDATE SET last_completed_date=excluded.last_completed_date, last_completed_estimated=excluded.last_completed_estimated,
    initial_pending=excluded.initial_pending, initial_scheduled_date=excluded.initial_scheduled_date, unknown_reason=excluded.unknown_reason
    WHERE chore_state.last_completed_date IS NOT excluded.last_completed_date OR chore_state.last_completed_estimated != excluded.last_completed_estimated
      OR chore_state.initial_pending != excluded.initial_pending OR chore_state.initial_scheduled_date IS NOT excluded.initial_scheduled_date OR chore_state.unknown_reason IS NOT excluded.unknown_reason`,
  state.choreId, ...values);
  }
  const priorAssignments = new Set((await database.getAllAsync<{ chore_id: string; member_id: string }>('SELECT a.chore_id, a.member_id FROM chore_assignments a JOIN chore_definitions c ON c.id=a.chore_id WHERE c.household_id=?', householdId)).map((row) => JSON.stringify([row.chore_id, row.member_id])));
  for (const assignment of snapshot.assignments) for (const member of assignment.memberIds) {
    const key = JSON.stringify([assignment.choreId, member]);
    if (!priorAssignments.delete(key)) await database.runAsync('INSERT INTO chore_assignments (chore_id, member_id) VALUES (?, ?)', assignment.choreId, member);
  }
  for (const key of priorAssignments) { const [chore, member] = JSON.parse(key); await database.runAsync('DELETE FROM chore_assignments WHERE chore_id=? AND member_id=?', chore, member); }
  const dependencies = new Map((await database.getAllAsync<{ id: string; predecessor_chore_id: string; successor_chore_id: string; policy_json: string | null }>('SELECT id, predecessor_chore_id, successor_chore_id, policy_json FROM chore_dependencies WHERE household_id=?', householdId))
    .map((row) => [row.id, JSON.stringify([row.predecessor_chore_id, row.successor_chore_id, row.policy_json])]));
  for (const dependency of snapshot.dependencies) {
    const values = [dependency.predecessorChoreId, dependency.successorChoreId, dependency.policyData ? JSON.stringify(dependency.policyData) : null] as const;
    const old = dependencies.get(dependency.id); dependencies.delete(dependency.id);
    if (old !== JSON.stringify(values)) await database.runAsync(`INSERT INTO chore_dependencies (id, household_id, predecessor_chore_id, successor_chore_id, policy_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET predecessor_chore_id=excluded.predecessor_chore_id, successor_chore_id=excluded.successor_chore_id, policy_json=excluded.policy_json`, dependency.id, householdId, ...values);
  }
  for (const id of dependencies.keys()) await database.runAsync('DELETE FROM chore_dependencies WHERE id=?', id);
  const oldCompletions = new Map((await database.getAllAsync<{ id: string; schedule_entry_id: string; outcome: string }>('SELECT id, schedule_entry_id, outcome FROM chore_completions WHERE household_id=?', householdId)).map((row) => [row.schedule_entry_id, row]));
  for (const completion of snapshot.completions) {
    const previous = oldCompletions.get(completion.scheduleEntryId!);
    if (previous?.id === completion.id && previous.outcome === completion.outcome) continue;
    await database.runAsync(`INSERT INTO chore_completions (id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id,
      scheduled_date, scheduled_window_start, scheduled_window_end, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(schedule_entry_id) DO UPDATE SET id=excluded.id, completed_at=excluded.completed_at,
      completed_by_member_id=excluded.completed_by_member_id, outcome=excluded.outcome, scheduled_date=excluded.scheduled_date,
      scheduled_window_start=excluded.scheduled_window_start, scheduled_window_end=excluded.scheduled_window_end
      WHERE chore_completions.id != excluded.id OR chore_completions.outcome != excluded.outcome`, completion.id, householdId, completion.choreId,
    completion.completedAt, completion.completedByMemberId ?? null, options.importedGoogleOccurrenceIds?.has(completion.scheduleEntryId!) ? 'googleTasks' : 'inApp',
    completion.scheduleEntryId!, completion.scheduledDate ?? null, completion.scheduledWindowStart ?? null, completion.scheduledWindowEnd ?? null,
    completion.outcome);
    if (previous?.outcome !== completion.outcome && !options.importedGoogleOccurrenceIds?.has(completion.scheduleEntryId!)) {
      await stagePendingGoogleTaskStatus(database, completion.scheduleEntryId!, completion.outcome === 'completed' ? 'completed' : 'needsAction', `shared-status:${token}`);
    }
  }
  const oldWaste = new Set((await database.getAllAsync<{ id: string }>('SELECT id FROM weekly_waste_schedules WHERE household_id=?', householdId)).map((row) => row.id));
  for (const schedule of snapshot.wasteSchedules) {
    oldWaste.delete(schedule.id);
    await database.runAsync(`INSERT INTO weekly_waste_schedules (id, household_id, label, weekdays_json, recurrence, anchor_date, monthly_day) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, weekdays_json=excluded.weekdays_json, recurrence=excluded.recurrence, anchor_date=excluded.anchor_date, monthly_day=excluded.monthly_day
      WHERE weekly_waste_schedules.label != excluded.label OR weekly_waste_schedules.weekdays_json != excluded.weekdays_json OR weekly_waste_schedules.recurrence != excluded.recurrence
      OR weekly_waste_schedules.anchor_date IS NOT excluded.anchor_date OR weekly_waste_schedules.monthly_day IS NOT excluded.monthly_day`, schedule.id, householdId,
    schedule.label, JSON.stringify(schedule.collectionWeekdays), schedule.recurrence ?? 'weekly', schedule.anchorDate ?? null, schedule.monthlyDay ?? null);
  }
  for (const id of oldWaste) await database.runAsync('DELETE FROM weekly_waste_schedules WHERE id=?', id);
  const hidden = new Set((await database.getAllAsync<{ schedule_id: string; occurrence_date: string }>('SELECT h.schedule_id, h.occurrence_date FROM hidden_waste_occurrences h JOIN weekly_waste_schedules w ON w.id=h.schedule_id WHERE w.household_id=?', householdId)).map((row) => `${row.schedule_id}:${row.occurrence_date}`));
  for (const key of snapshot.hiddenWasteOccurrenceKeys) {
    if (hidden.delete(key)) continue;
    await database.runAsync('INSERT OR IGNORE INTO hidden_waste_occurrences (schedule_id, occurrence_date) VALUES (?, ?)', key.slice(0, -11), key.slice(-10));
  }
  for (const key of hidden) await database.runAsync('DELETE FROM hidden_waste_occurrences WHERE schedule_id=? AND occurrence_date=?', key.slice(0, -11), key.slice(-10));
  for (const appliance of snapshot.appliances) await database.runAsync(`INSERT INTO appliances
    (id, household_id, manufacturer, product_name, model_number, category, display_name, official_product_url, official_manual_url, analysis_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET manufacturer=excluded.manufacturer, product_name=excluded.product_name,
    model_number=excluded.model_number, category=excluded.category, display_name=excluded.display_name, official_product_url=excluded.official_product_url,
    official_manual_url=excluded.official_manual_url, analysis_json=excluded.analysis_json, updated_at=excluded.updated_at
    WHERE appliances.analysis_json != excluded.analysis_json OR appliances.display_name != excluded.display_name`, appliance.id, householdId, appliance.manufacturer,
  appliance.productName, appliance.modelNumber, appliance.category ?? null, appliance.displayName, appliance.officialProductUrl ?? null, appliance.officialManualUrl ?? '',
  JSON.stringify(appliance.analysis), appliance.createdAt, appliance.updatedAt);
  await persistSharedScheduleRows(database, snapshot);
  await database.runAsync('UPDATE sharing_workspace_metadata SET projection_token=?, projection_day=?, projection_signature=? WHERE singleton=1',
    token, snapshot.today!, planningSignature);
}

/** A slow read may refresh derived schedules only if no newer canonical projection has committed. */
export async function cacheSharedScheduleIfCurrent(database: SQLiteDatabase, expectedToken: string, snapshot: PlannerSnapshot): Promise<boolean> {
  return withIsolatedSqliteTransaction(database, async (transaction) => {
    const row = await transaction.getFirstAsync<{ projection_token: string; projection_signature: string | null }>('SELECT projection_token, projection_signature FROM sharing_workspace_metadata WHERE singleton=1');
    if (row?.projection_token !== expectedToken) return false;
    const signature = sharedPlanningSignature(snapshot);
    if (row.projection_signature !== signature) {
      await persistSharedScheduleRows(transaction, snapshot);
      await transaction.runAsync('UPDATE sharing_workspace_metadata SET projection_day=?, projection_signature=? WHERE singleton=1 AND projection_token=?', snapshot.today!, signature, expectedToken);
    }
    return true;
  });
}
