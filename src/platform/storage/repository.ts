import type { SQLiteDatabase } from 'expo-sqlite';

import { createHouseholdChoreDefinitions } from '@/domain/chores/catalog';
import { upgradeBuiltInScheduleDefaults } from '@/domain/chores/catalog-upgrade';
import { validateChoreToggle } from '@/domain/chores/chore-groups';
import { applyChoreSettingsPatch } from '@/domain/chores/settings-patch';
import type { ChoreSettingsPatch } from '@/domain/chores/settings-patch';
import type {
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
  ChoreState,
  FrequencyMode,
  HouseholdPlannerSettings,
} from '@/domain/chores/types';
import { parseCalendarCountColors } from '@/domain/calendar/count-colors';
import { completionCycleDate, completionWasRecordedBeforeWindow } from '@/domain/scheduling/completion-matching';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import { dateTaskRevision } from '@/domain/scheduling/date-task-reference';
import type { PersonalDateTaskCommand } from '@/domain/scheduling/date-task-reference';
import type { ScheduleGenerationInput } from '@/domain/scheduling/contracts';
import { generateHouseworkScheduleResult, wouldCreateDependencyCycle } from '@/domain/scheduling/engine';
import { addDays, localDateFromDate, parseLocalDate } from '@/domain/scheduling/local-date';
import type { CalendarCountColors, CalendarCountDisplayMode, EntityId, Household, HouseholdMember, LocalDate, WeatherLocation, Weekday } from '@/domain/shared/types';
import type { WasteRecurrence, WasteScheduleInput, WeeklyWasteSchedule } from '@/features/waste/contracts';
import { mergeWasteScheduleEdits, normalizeWasteSchedule } from '@/features/waste/schedule-policy';
import type { GoogleSyncEntry, GoogleSyncState, GoogleTaskCompletion, GoogleTaskLink, GoogleTaskStatus, GoogleTaskStatusChange } from '@/features/google-sync/contracts';
import { googleTaskImportAction, parseGoogleCompletedAt } from '@/features/google-sync/google-completion-policy';
import type { GoogleSyncStatus } from '@/features/google-sync/sync-policy';
import { GoogleAccountMismatchError } from '@/features/google-sync/account-binding';
import { generateWeeklyCollectionDates } from '@/features/waste/weekly-scheduler';
import { splitWasteOccurrencesByVisibility } from '@/features/waste/occurrence-visibility';
import type { Appliance, ApplianceCareAnalysisDraft } from '@/features/appliance-care/contracts';
import { applianceDisplayName } from '@/features/appliance-care/display-name';
import type { ApprovedApplianceCareTask, ApplianceCareProductIdentity } from '@/features/appliance-care/to-chore-definition';
import { planReviewedApplianceSave } from '@/features/appliance-care/persistence-policy';
import type { WeatherScheduleOutcome } from '@/features/weather/optimize-laundry-schedule';
import { optimizeLaundryScheduleForWeather } from '@/features/weather/optimize-laundry-schedule';
import { WEATHER_FORECAST_CACHE_TTL_MS } from '@/features/weather/contracts';
import { migrateLocalDatabase } from '@/platform/storage/migrations';
import type { CalendarAvailabilityDay, CalendarAvailabilityState, CalendarQueryRange } from '@/features/google-sync/calendar-availability';
import { CALENDAR_AVAILABILITY_MAX_AGE_MS, calendarAvailabilitySignature, freshCalendarAvailability, getDeviceTimeZone } from '@/features/google-sync/calendar-availability';
import { sharedRepositoryAdapter } from './shared-repository-adapter';
import type { SharedRepositoryMutation } from './shared-repository-adapter';
import { stagePendingGoogleTaskStatus } from './google-task-link-state';
import { commonChoreLinks, sharedMirrorEntryId, parseSharedMirrorEntryId } from '../../features/planner/common-chore-links.ts';
import type { CommonCompletionSource } from '../../features/planner/common-chore-links';
import { readCalendarEventRows } from './calendar-event-rows';
import { combineCalendarAvailability, localCalendarAvailability } from '../../features/calendar/local-availability';
import { notifyGooglePlannerChanges } from '../../features/google-sync/planner-change-events';

export const LOCAL_HOUSEHOLD_ID = 'local-household';
export const LOCAL_MEMBER_ID = 'local-member';
const BUILT_IN_CHORE_CATALOG_VERSION = 3;

export function plannerGenerationRange(today: LocalDate) {
  return { from: today, through: addDays(today, 180) };
}

const initializedHouseholds = new WeakSet<SQLiteDatabase>();
const operationTails = new WeakMap<SQLiteDatabase, Promise<unknown>>();
const plannerVersions = new WeakMap<SQLiteDatabase, number>();
const snapshotVersions = new WeakMap<PlannerSnapshot, number>();
type WeatherOptimizer = typeof optimizeLaundryScheduleForWeather;
interface WeatherAssessment {
  result: PlannerSnapshot;
  baseSchedule: ChoreScheduleEntry[];
  optimize: WeatherOptimizer;
  context: string;
  assessedAt: number;
  expiresAt: number;
}
const weatherAssessments = new WeakMap<PlannerSnapshot, WeatherAssessment>();
const pendingWeather = new WeakMap<PlannerSnapshot, {
  optimize: WeatherOptimizer; context: string; promise: ReturnType<WeatherOptimizer>;
}>();
const cachedPlannerSnapshots = new WeakMap<SQLiteDatabase, {
  snapshot: PlannerSnapshot; today: LocalDate; timeZone: string; savedAt: number; expiresAt: number;
}>();

/** Pure cache read. Recalculation stays explicit at the caller when inputs, date, timezone or freshness changed. */
export function readCachedPlannerSnapshot(database: SQLiteDatabase, now = new Date()): PlannerSnapshot | null {
  if (sharedRepositoryAdapter(database)) return null;
  const cached = cachedPlannerSnapshots.get(database);
  if (!cached || cached.today !== localDateFromDate(now) || cached.timeZone !== getDeviceTimeZone()
    || now.getTime() < cached.savedAt || now.getTime() > cached.expiresAt
    || snapshotVersions.get(cached.snapshot) !== (plannerVersions.get(database) ?? 0)) return null;
  return cached.snapshot;
}
/** Local event edits invalidate recommendations without uploading their private contents. */
export function invalidateLocalCalendarPlan(database: SQLiteDatabase) {
  plannerVersions.set(database, (plannerVersions.get(database) ?? 0) + 1); cachedPlannerSnapshots.delete(database);
  notifyGooglePlannerChanges();
}

function runDatabaseOperation<T>(database: SQLiteDatabase, operation: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(database) ?? Promise.resolve();
  const pending = previous.then(operation, operation);
  const tail = pending.then(() => undefined, () => undefined);
  operationTails.set(database, tail);
  void tail.then(() => {
    if (operationTails.get(database) === tail) operationTails.delete(database);
  });
  return pending;
}

function serializePlannerOperation<Args extends unknown[], Result>(
  operation: (database: SQLiteDatabase, ...args: Args) => Promise<Result>,
  sharedMutation?: SharedRepositoryMutation,
): (database: SQLiteDatabase, ...args: Args) => Promise<Result> {
  return (database, ...args) => runDatabaseOperation(database, () => {
    plannerVersions.set(database, (plannerVersions.get(database) ?? 0) + 1);
    const adapter = sharedMutation ? sharedRepositoryAdapter(database) : undefined;
    if (adapter) return adapter.mutate(sharedMutation!, args) as Promise<Result>;
    return operation(database, ...args);
  });
}

function serializeDatabaseOperation<Args extends unknown[], Result>(
  operation: (database: SQLiteDatabase, ...args: Args) => Promise<Result>,
  sharedMutation?: SharedRepositoryMutation,
): (database: SQLiteDatabase, ...args: Args) => Promise<Result> {
  return (database, ...args) => runDatabaseOperation(database, () => {
    const adapter = sharedMutation ? sharedRepositoryAdapter(database) : undefined;
    if (adapter) {
      plannerVersions.set(database, (plannerVersions.get(database) ?? 0) + 1);
      return adapter.mutate(sharedMutation!, args) as Promise<Result>;
    }
    return operation(database, ...args);
  });
}

export function withPlannerDatabaseOperation<T>(database: SQLiteDatabase, work: () => Promise<T>): Promise<T> {
  return runDatabaseOperation(database, work);
}
export async function drainPlannerDatabaseOperations(database: SQLiteDatabase): Promise<void> { await operationTails.get(database); }

export interface PlannerSnapshot {
  /** Shared mode uses one civil date/timezone across all devices. Personal snapshots omit these fields. */
  today?: LocalDate;
  timeZone?: string;
  sharing?: { groupId: string; activeMemberIds: string[]; issues: { entityType: string; entityId: string; fields: string[]; kind: string }[] };
  household: Household;
  settings: HouseholdPlannerSettings;
  chores: ChoreDefinition[];
  appliances: Appliance[];
  states: ChoreState[];
  members: HouseholdMember[];
  assignments: { choreId: EntityId; memberIds: EntityId[] }[];
  dependencies: ChoreDependency[];
  scheduleEntries: ChoreScheduleEntry[];
  completions: ChoreCompletion[];
  wasteSchedules: WeeklyWasteSchedule[];
  upcomingWasteDates: ReturnType<typeof generateWeeklyCollectionDates>;
  hiddenWasteDates: ReturnType<typeof generateWeeklyCollectionDates>;
  /** Includes dates outside the upcoming list so month navigation can respect manual exceptions. */
  hiddenWasteOccurrenceKeys: string[];
  weatherOutcome: WeatherScheduleOutcome;
  weatherAdjustmentCount: number;
  externalAvailabilityByDate?: ScheduleGenerationInput['externalAvailabilityByDate'];
}

export interface ApplianceCareReviewContext {
  appliance: Appliance;
  chores: ChoreDefinition[];
}

interface HouseholdRow {
  id: string;
  name: string;
  created_at: string;
}

interface SettingsRow {
  frequency_mode: FrequencyMode;
  rest_days_json: string;
  heavy_daily_limit: number;
  normal_daily_limit: number;
  notification_hour: number;
  notification_minute: number;
  notifications_enabled: number;
  setup_completed: number;
  weather_region: string | null;
  weather_region_name: string | null;
  weather_latitude: number | null;
  weather_longitude: number | null;
  calendar_count_colors_json: string;
  calendar_count_display_mode: string;
  planner_calendar_signature: string | null;
}

interface DefinitionRow {
  id: string;
  enabled: number;
  definition_json: string;
}

interface StateRow {
  chore_id: string;
  last_completed_date: string | null;
  last_completed_estimated: number;
  initial_pending: number;
  initial_scheduled_date: string | null;
  unknown_reason: 'unknown' | 'skipped' | null;
}

interface CompletionRow {
  id: string;
  household_id: string;
  chore_id: string;
  completed_at: string;
  completed_by_member_id: string | null;
  outcome: ChoreCompletion['outcome'];
  source: ChoreCompletion['source'] | null;
  schedule_entry_id: string | null;
  scheduled_date: string | null;
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
}

function completionFromRow(row: CompletionRow): ChoreCompletion {
  return {
    id: row.id, householdId: row.household_id, choreId: row.chore_id, completedAt: row.completed_at,
    completedByMemberId: row.completed_by_member_id ?? undefined, outcome: row.outcome, source: row.source ?? undefined,
    scheduleEntryId: row.schedule_entry_id ?? undefined,
    scheduledDate: (row.scheduled_date ?? undefined) as LocalDate | undefined,
    scheduledWindowStart: (row.scheduled_window_start ?? undefined) as LocalDate | undefined,
    scheduledWindowEnd: (row.scheduled_window_end ?? undefined) as LocalDate | undefined,
    ...(row.source === 'googleTasks' ? { estimatedDate: false } : {}),
  };
}

interface ScheduleEntryRow {
  entry_json: string;
}

interface DependencyRow {
  id: string;
  predecessor_chore_id: string;
  successor_chore_id: string;
  policy_json: string | null;
}

interface MemberRow {
  id: string;
  household_id: string;
  display_name: string;
}

interface AssignmentRow {
  chore_id: string;
  member_id: string;
}

interface WasteRow {
  id: string;
  household_id: string;
  label: string;
  weekdays_json: string;
  recurrence: WasteRecurrence;
  anchor_date: string | null;
  monthly_day: number | null;
}

interface ApplianceRow {
  id: string;
  household_id: string;
  manufacturer: string;
  product_name: string;
  model_number: string;
  category: string | null;
  display_name: string;
  official_product_url: string | null;
  official_manual_url: string;
  analysis_json: string;
  created_at: string;
  updated_at: string;
}

interface HiddenWasteRow {
  schedule_id: string;
  occurrence_date: string;
}

async function initializeLocalDatabaseImpl(database: SQLiteDatabase): Promise<void> {
  await migrateLocalDatabase(database);
  await ensureLocalHouseholdImpl(database);
}

async function ensureLocalHouseholdImpl(database: SQLiteDatabase): Promise<void> {
  if (sharedRepositoryAdapter(database)) return;
  if (initializedHouseholds.has(database)) return;
  if (await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sharing_workspace_metadata'")) {
    throw new Error('共有DBはアカウントとグループを確認してから開いてください。');
  }
  const now = new Date().toISOString();
  const definitions = createHouseholdChoreDefinitions(LOCAL_HOUSEHOLD_ID);
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'INSERT OR IGNORE INTO households (id, name, created_at) VALUES (?, ?, ?)',
      LOCAL_HOUSEHOLD_ID, 'わが家', now,
    );
    await database.runAsync(
      'INSERT OR IGNORE INTO household_members (id, household_id, display_name) VALUES (?, ?, ?)',
      LOCAL_MEMBER_ID, LOCAL_HOUSEHOLD_ID, '自分',
    );
    await database.runAsync(
      `INSERT OR IGNORE INTO household_settings
       (household_id, frequency_mode, rest_days_json, heavy_daily_limit, normal_daily_limit,
        notification_hour, notification_minute, setup_completed, updated_at)
       VALUES (?, 'balanced', '[6,7]', 1, 2, 9, 0, 0, ?)`,
      LOCAL_HOUSEHOLD_ID, now,
    );

    const catalogVersionRow = await database.getFirstAsync<{ built_in_chore_catalog_version: number }>(
      'SELECT built_in_chore_catalog_version FROM household_settings WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
    );
    const previousCatalogVersion = catalogVersionRow?.built_in_chore_catalog_version ?? 0;
    if (previousCatalogVersion < BUILT_IN_CHORE_CATALOG_VERSION) {
      const legacyBuiltIns = await database.getAllAsync<{ id: string; definition_json: string }>(
        `SELECT id, definition_json FROM chore_definitions
         WHERE household_id = ? AND id GLOB 'chore-[0-9][0-9]'`, LOCAL_HOUSEHOLD_ID,
      );
      for (const row of legacyBuiltIns) {
        const legacy = JSON.parse(row.definition_json) as ChoreDefinition;
        const archived = { ...legacy, archived: true, enabled: false };
        await database.runAsync(
          'UPDATE chore_definitions SET enabled = 0, definition_json = ? WHERE id = ?',
          JSON.stringify(archived), row.id,
        );
        await database.runAsync('DELETE FROM chore_schedule_entries WHERE chore_id = ?', row.id);
      }

      for (const definition of definitions) {
        const existing = await database.getFirstAsync<{ enabled: number; definition_json: string }>(
          'SELECT enabled, definition_json FROM chore_definitions WHERE id = ?', definition.id,
        );
        if (existing) {
          const stored = JSON.parse(existing.definition_json) as ChoreDefinition;
          const upgrade = previousCatalogVersion < 3
            ? upgradeBuiltInScheduleDefaults(stored, definition)
            : { definition: stored, scheduleChanged: false };
          // Refresh the guide and untouched defaults; user-selected values and overrides stay intact.
          const updated: ChoreDefinition = {
            ...upgrade.definition,
            name: definition.name,
            category: definition.category,
            description: definition.description,
            locationOrAppliance: definition.locationOrAppliance,
            estimatedMinutes: definition.estimatedMinutes,
            instructions: definition.instructions,
            procedureSections: definition.procedureSections,
            tools: definition.tools,
            cautions: definition.cautions,
            trivia: definition.trivia,
            sourceNotes: definition.sourceNotes,
            schedulingNotes: definition.schedulingNotes,
            enabled: Boolean(existing.enabled),
          };
          await database.runAsync(
            'UPDATE chore_definitions SET name = ?, definition_json = ? WHERE id = ?',
            updated.name, JSON.stringify(updated), definition.id,
          );
          if (upgrade.scheduleChanged) {
            // Cached windows belong to the old defaults. History and cycle anchors are kept separately.
            await database.runAsync('DELETE FROM chore_schedule_entries WHERE chore_id = ?', definition.id);
          }
        }
        await database.runAsync(
          'INSERT OR IGNORE INTO chore_definitions (id, household_id, name, enabled, definition_json) VALUES (?, ?, ?, 1, ?)',
          definition.id, definition.householdId, definition.name, JSON.stringify(definition),
        );
        await database.runAsync(
          'INSERT OR IGNORE INTO chore_state (chore_id, initial_pending, unknown_reason) VALUES (?, 1, ?)',
          definition.id, 'skipped',
        );
        await database.runAsync(
          'INSERT OR IGNORE INTO chore_assignments (chore_id, member_id) VALUES (?, ?)',
          definition.id, LOCAL_MEMBER_ID,
        );
      }
      if (previousCatalogVersion < 2) await repairFutureCompletionStates(database);
      await database.runAsync(
        'UPDATE household_settings SET built_in_chore_catalog_version = ? WHERE household_id = ?',
        BUILT_IN_CHORE_CATALOG_VERSION, LOCAL_HOUSEHOLD_ID,
      );
    }
  });
  initializedHouseholds.add(database);
}

async function loadApplianceCareReviewContextImpl(
  database: SQLiteDatabase,
  applianceId: EntityId,
): Promise<ApplianceCareReviewContext | null> {
  const row = await database.getFirstAsync<ApplianceRow>(
    `SELECT id, household_id, manufacturer, product_name, model_number, category, display_name,
     official_product_url, official_manual_url, analysis_json, created_at, updated_at
     FROM appliances WHERE id = ? AND household_id = ?`, applianceId, LOCAL_HOUSEHOLD_ID,
  );
  if (!row) return null;
  const definitionRows = await database.getAllAsync<DefinitionRow>(
    'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
  );
  return {
    appliance: {
      id: row.id,
      householdId: row.household_id,
      manufacturer: row.manufacturer,
      productName: row.product_name,
      modelNumber: row.model_number,
      ...(row.category ? { category: row.category } : {}),
      displayName: applianceDisplayName({ manufacturer: row.manufacturer, productName: row.product_name, modelNumber: row.model_number }, row.display_name),
      ...(row.official_product_url ? { officialProductUrl: row.official_product_url } : {}),
      officialManualUrl: row.official_manual_url,
      analysis: JSON.parse(row.analysis_json) as ApplianceCareAnalysisDraft,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    chores: definitionRows.map((definitionRow) => ({
      ...(JSON.parse(definitionRow.definition_json) as ChoreDefinition),
      id: definitionRow.id,
      enabled: Boolean(definitionRow.enabled),
    })).filter((chore) => chore.applianceId === applianceId || (!chore.applianceId
      && chore.applianceCareSource?.manufacturer === row.manufacturer
      && chore.applianceCareSource.productName === row.product_name
      && chore.applianceCareSource.modelNumber === row.model_number)),
  };
}

async function loadPlannerSnapshotImpl(
  database: SQLiteDatabase,
  today = localDateFromDate(new Date()),
  calendarNow = new Date(),
  timeZone = getDeviceTimeZone(),
): Promise<PlannerSnapshot> {
  const shared = sharedRepositoryAdapter(database);
  if (shared) return shared.readSnapshot(calendarNow);
  await ensureLocalHouseholdImpl(database);
  const householdRow = await database.getFirstAsync<HouseholdRow>(
    'SELECT id, name, created_at FROM households WHERE id = ?', LOCAL_HOUSEHOLD_ID,
  );
  const settingsRow = await database.getFirstAsync<SettingsRow>(
    `SELECT frequency_mode, rest_days_json, heavy_daily_limit, normal_daily_limit,
            notification_hour, notification_minute, notifications_enabled, setup_completed, weather_region, weather_region_name,
            weather_latitude, weather_longitude, calendar_count_colors_json, calendar_count_display_mode, planner_calendar_signature
     FROM household_settings WHERE household_id = ?`, LOCAL_HOUSEHOLD_ID,
  );
  if (!householdRow || !settingsRow) throw new Error('Local household could not be initialized');

  const [definitionRows, stateRows, memberRows, assignmentRows, dependencyRows, completionRows, scheduleEntryRows, wasteRows, applianceRows, hiddenWasteRows] = await Promise.all([
    database.getAllAsync<DefinitionRow>(
      'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ? ORDER BY name', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<StateRow>(
      `SELECT s.chore_id, s.last_completed_date, s.last_completed_estimated, s.initial_pending,
              s.initial_scheduled_date, s.unknown_reason
       FROM chore_state s JOIN chore_definitions d ON d.id = s.chore_id WHERE d.household_id = ?`, LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<MemberRow>(
      'SELECT id, household_id, display_name FROM household_members WHERE household_id = ? ORDER BY display_name', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<AssignmentRow>(
      `SELECT a.chore_id, a.member_id FROM chore_assignments a
       JOIN chore_definitions d ON d.id = a.chore_id WHERE d.household_id = ?`, LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<DependencyRow>(
      'SELECT id, predecessor_chore_id, successor_chore_id, policy_json FROM chore_dependencies WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<CompletionRow>(
      `SELECT id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id,
              scheduled_date, scheduled_window_start, scheduled_window_end, outcome
       FROM chore_completions WHERE household_id = ? ORDER BY completed_at DESC`, LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<ScheduleEntryRow>(
      'SELECT entry_json FROM chore_schedule_entries WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<WasteRow>(
      'SELECT id, household_id, label, weekdays_json, recurrence, anchor_date, monthly_day FROM weekly_waste_schedules WHERE household_id = ? ORDER BY label', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<ApplianceRow>(
      `SELECT id, household_id, manufacturer, product_name, model_number, category, display_name,
       official_product_url, official_manual_url, analysis_json, created_at, updated_at
       FROM appliances WHERE household_id = ? ORDER BY display_name`, LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<HiddenWasteRow>(
      `SELECT h.schedule_id, h.occurrence_date FROM hidden_waste_occurrences h
       JOIN weekly_waste_schedules w ON w.id = h.schedule_id WHERE w.household_id = ?`, LOCAL_HOUSEHOLD_ID,
    ),
  ]);

  const household: Household = {
    id: householdRow.id,
    name: householdRow.name,
    createdAt: householdRow.created_at,
  };
  const settings: HouseholdPlannerSettings = {
    householdId: householdRow.id,
    frequencyMode: settingsRow.frequency_mode,
    restDays: parseJson<number[]>(settingsRow.rest_days_json, [6, 7]),
    heavyDailyLimit: settingsRow.heavy_daily_limit,
    normalDailyLimit: settingsRow.normal_daily_limit,
    notificationHour: settingsRow.notification_hour,
    notificationMinute: settingsRow.notification_minute,
    notificationsEnabled: Boolean(settingsRow.notifications_enabled),
    setupCompleted: Boolean(settingsRow.setup_completed),
    calendarCountColors: parseCalendarCountColors(settingsRow.calendar_count_colors_json),
    calendarCountDisplayMode: 'dots',
    weatherLocation: settingsRow.weather_region !== null
      && settingsRow.weather_region_name !== null
      && settingsRow.weather_latitude !== null
      && settingsRow.weather_longitude !== null
      ? {
        region: settingsRow.weather_region,
        displayName: settingsRow.weather_region_name,
        latitude: settingsRow.weather_latitude,
        longitude: settingsRow.weather_longitude,
      }
      : undefined,
  };
  const chores = definitionRows.map((row) => ({
    ...(JSON.parse(row.definition_json) as ChoreDefinition),
    enabled: Boolean(row.enabled),
  }));
  let states = stateRows.map((row): ChoreState => ({
    choreId: row.chore_id,
    lastCompletedDate: (row.last_completed_date ?? undefined) as LocalDate | undefined,
    lastCompletedEstimated: Boolean(row.last_completed_estimated),
    initialPending: Boolean(row.initial_pending),
    initialScheduledDate: (row.initial_scheduled_date ?? undefined) as LocalDate | undefined,
    unknownReason: row.unknown_reason ?? undefined,
  }));
  const members = memberRows.map((row): HouseholdMember => ({
    id: row.id,
    householdId: row.household_id,
    displayName: row.display_name,
  }));
  const assignmentMap = new Map<EntityId, EntityId[]>();
  for (const assignment of assignmentRows) {
    assignmentMap.set(assignment.chore_id, [...(assignmentMap.get(assignment.chore_id) ?? []), assignment.member_id]);
  }
  const assignments = [...assignmentMap].map(([choreId, memberIds]) => ({ choreId, memberIds }));
  const dependencies: ChoreDependency[] = dependencyRows.map((row) => ({
    id: row.id,
    predecessorChoreId: row.predecessor_chore_id,
    successorChoreId: row.successor_chore_id,
    policyData: row.policy_json ? parseJson(row.policy_json, undefined) : undefined,
  }));
  const completions = completionRows.map(completionFromRow);
  const previousScheduleEntries = scheduleEntryRows
    .map((row) => parseJson<ChoreScheduleEntry | undefined>(row.entry_json, undefined))
    .filter((entry): entry is ChoreScheduleEntry => Boolean(entry?.id && entry.choreId));
  const wasteSchedules = wasteRows.map((row): WeeklyWasteSchedule => ({
    id: row.id,
    householdId: row.household_id,
    label: row.label,
    collectionWeekdays: parseJson<Weekday[]>(row.weekdays_json, []),
    recurrence: row.recurrence,
    anchorDate: (row.anchor_date ?? undefined) as LocalDate | undefined,
    monthlyDay: row.monthly_day ?? undefined,
  }));
  const appliances = applianceRows.map((row): Appliance => ({
    id: row.id,
    householdId: row.household_id,
    manufacturer: row.manufacturer,
    productName: row.product_name,
    modelNumber: row.model_number,
    ...(row.category ? { category: row.category } : {}),
    displayName: applianceDisplayName({ manufacturer: row.manufacturer, productName: row.product_name, modelNumber: row.model_number }, row.display_name),
    ...(row.official_product_url ? { officialProductUrl: row.official_product_url } : {}),
    officialManualUrl: row.official_manual_url,
    analysis: JSON.parse(row.analysis_json) as ApplianceCareAnalysisDraft,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  let scheduleEntries: ChoreScheduleEntry[] = [];
  const weatherOutcome: WeatherScheduleOutcome = settings.weatherLocation ? 'current' : 'disabled';
  const weatherAdjustmentCount = 0;
  // Availability is optional: corrupt/unavailable cache never prevents normal planning or completion.
  const googleAvailability = await getFreshCalendarAvailabilityDaysImpl(database, calendarNow, timeZone)
    .catch(() => undefined);
  const localAvailability = await readCalendarEventRows(database).then(({ events, exceptions }) => localCalendarAvailability(events, exceptions, today, addDays(today, 180), timeZone)).catch(() => undefined);
  const externalAvailabilityByDate = combineCalendarAvailability(googleAvailability, localAvailability);
  if (settings.setupCompleted) {
    // Repair records made by the old enable path, which left an unknown first date non-pending.
    const statesById = new Map(states.map((state) => [state.choreId, state]));
    for (const chore of chores.filter((item) => item.enabled && !item.archived)) {
      const state = statesById.get(chore.id);
      const previousInitial = previousScheduleEntries.find((entry) => entry.id === `${chore.id}:initial` && entry.choreId === chore.id);
      if (state?.lastCompletedDate || (state?.initialPending && (state.initialScheduledDate || !previousInitial))
        || completions.some((item) => item.choreId === chore.id && item.outcome === 'completed' && completionCycleDate(item) <= today)) continue;
      const repaired: ChoreState = { choreId: chore.id, lastCompletedDate: undefined, initialScheduledDate: state?.initialScheduledDate ?? previousInitial?.suggestedDate,
        initialPending: true, lastCompletedEstimated: false, unknownReason: state?.unknownReason ?? 'unknown' };
      await restoreChoreState(database, chore.id, repaired);
      statesById.set(chore.id, repaired);
    }
    states = [...statesById.values()];
    const input: ScheduleGenerationInput = {
      householdId: household.id,
      ...plannerGenerationRange(today),
      today,
      chores,
      states,
      assignments,
      dependencies,
      completions,
      previousScheduleEntries,
      externalAvailabilityByDate,
      settings: {
        frequencyMode: settings.frequencyMode,
        restDays: settings.restDays as Weekday[],
        loadLimits: {
          heavyDailyLimit: settings.heavyDailyLimit,
          normalDailyLimit: settings.normalDailyLimit,
        },
      },
    };
    const scheduleResult = generateHouseworkScheduleResult(input);
    scheduleEntries = scheduleResult.entries;
    const stateById = new Map(states.map((state) => [state.choreId, state]));
    const missingInitialDates = scheduleEntries.filter((entry) => entry.id === `${entry.choreId}:initial`
      && stateById.get(entry.choreId)?.initialPending && !stateById.get(entry.choreId)?.initialScheduledDate);
    await replaceGeneratedSchedule(database, household.id, scheduleEntries, scheduleResult.simulatedCompletions, missingInitialDates);
    const initialDates = new Map(scheduleEntries.filter((entry) => entry.id === `${entry.choreId}:initial`)
      .map((entry) => [entry.choreId, entry.suggestedDate]));
    states = states.map((state) => state.initialPending && !state.initialScheduledDate && initialDates.has(state.choreId)
      ? { ...state, initialScheduledDate: initialDates.get(state.choreId) } : state);
    const calendarSignature = calendarAvailabilitySignature(externalAvailabilityByDate);
    if (settingsRow.planner_calendar_signature !== calendarSignature) {
      await database.runAsync('UPDATE household_settings SET planner_calendar_signature = ? WHERE household_id = ?',
        calendarSignature, household.id);
    }
    if (scheduleResult.simulatedCompletions.length > 0) {
      const simulatedDateByChore = new Map(scheduleResult.simulatedCompletions.map(({ choreId, date }) => [choreId, date]));
      states = states.map((state) => {
        const date = simulatedDateByChore.get(state.choreId);
        if (!date || (state.lastCompletedDate && date <= state.lastCompletedDate)) return state;
        return {
          ...state,
          lastCompletedDate: date,
          lastCompletedEstimated: true,
          initialPending: false,
          initialScheduledDate: undefined,
          unknownReason: undefined,
        };
      });
    }
  }

  const generatedWasteDates = wasteSchedules.flatMap((schedule) =>
    generateWeeklyCollectionDates(schedule, today, addDays(today, 35)),
  );
  const hiddenOccurrenceKeys = new Set(hiddenWasteRows.map((row) => `${row.schedule_id}:${row.occurrence_date}`));
  const { visible: upcomingWasteDates, hidden: hiddenWasteDates } = splitWasteOccurrencesByVisibility(generatedWasteDates, hiddenOccurrenceKeys);

  const snapshot: PlannerSnapshot = {
    household,
    settings,
    chores,
    appliances,
    states,
    members,
    assignments,
    dependencies,
    scheduleEntries,
    completions,
    wasteSchedules,
    upcomingWasteDates,
    hiddenWasteDates,
    hiddenWasteOccurrenceKeys: [...hiddenOccurrenceKeys],
    weatherOutcome,
    weatherAdjustmentCount,
    externalAvailabilityByDate,
  };
  snapshotVersions.set(snapshot, plannerVersions.get(database) ?? 0);
  const calendarState = googleAvailability ? await loadCalendarAvailabilityStateImpl(database) : null;
  const fetchedAt = calendarState?.lastSuccessfulSyncAt ? Date.parse(calendarState.lastSuccessfulSyncAt) : NaN;
  cachedPlannerSnapshots.set(database, { snapshot, today, timeZone,
    savedAt: calendarNow.getTime(), expiresAt: googleAvailability
      ? Number.isFinite(fetchedAt) ? fetchedAt + CALENDAR_AVAILABILITY_MAX_AGE_MS : calendarNow.getTime()
      : Infinity });
  return snapshot;
}

/** Applies weather after the normal snapshot is ready, so forecast latency never blocks offline screens. */
export async function applyWeatherToPlannerSnapshot(
  database: SQLiteDatabase,
  snapshot: PlannerSnapshot,
  canCommit: () => boolean = () => true,
  optimize = optimizeLaundryScheduleForWeather,
  clock: () => Date = () => new Date(),
): Promise<PlannerSnapshot | null> {
  if (!snapshot.settings.setupCompleted || !snapshot.settings.weatherLocation) {
    if (snapshot.weatherOutcome === 'disabled' && snapshot.weatherAdjustmentCount === 0) return snapshot;
    return { ...snapshot, weatherOutcome: 'disabled', weatherAdjustmentCount: 0 };
  }

  const version = snapshotVersions.get(snapshot) ?? plannerVersions.get(database) ?? 0;
  const now = clock();
  const today = localDateFromDate(now);
  const context = `${today}:${getDeviceTimeZone()}`;
  const prior = weatherAssessments.get(snapshot);
  const reusable = (assessment: WeatherAssessment | undefined, instant: Date) => {
    const cached = cachedPlannerSnapshots.get(database);
    return assessment && assessment.optimize === optimize
      && assessment.context === `${localDateFromDate(instant)}:${getDeviceTimeZone()}`
      && instant.getTime() >= assessment.assessedAt && instant.getTime() < assessment.expiresAt
      && snapshotVersions.get(assessment.result) === (plannerVersions.get(database) ?? 0)
      && (!cached || (cached.snapshot === snapshot || cached.snapshot === assessment.result)
        && cached.today === today && cached.timeZone === getDeviceTimeZone() && instant.getTime() <= cached.expiresAt);
  };
  if (!canCommit()) return null;
  if (reusable(prior, now)) return prior!.result;
  const currentCache = cachedPlannerSnapshots.get(database);
  if (version !== (plannerVersions.get(database) ?? 0)
    || (currentCache && (currentCache.snapshot !== snapshot || currentCache.today !== today
      || currentCache.timeZone !== getDeviceTimeZone() || now.getTime() > currentCache.expiresAt))) return null;
  const baseSchedule = prior?.baseSchedule ?? snapshot.scheduleEntries;
  const input = {
    householdId: snapshot.household.id,
    today,
    location: snapshot.settings.weatherLocation,
    chores: snapshot.chores,
    completions: snapshot.completions,
    dependencies: snapshot.dependencies,
    settings: {
      frequencyMode: snapshot.settings.frequencyMode,
      restDays: snapshot.settings.restDays as Weekday[],
      loadLimits: {
        heavyDailyLimit: snapshot.settings.heavyDailyLimit,
        normalDailyLimit: snapshot.settings.normalDailyLimit,
      },
    },
    schedule: baseSchedule,
    externalAvailabilityByDate: snapshot.externalAvailabilityByDate,
  };
  let pending = pendingWeather.get(snapshot);
  if (!pending || pending.optimize !== optimize || pending.context !== context) {
    const promise = Promise.resolve().then(() => optimize(input)).finally(() => {
      if (pendingWeather.get(snapshot)?.promise === promise) pendingWeather.delete(snapshot);
    });
    pending = { optimize, context, promise };
    pendingWeather.set(snapshot, pending);
  }
  const weatherResult = await pending.promise;

  return runDatabaseOperation(database, async () => {
    const finishedAt = clock();
    if (!canCommit() || context !== `${localDateFromDate(finishedAt)}:${getDeviceTimeZone()}`) return null;
    const existing = weatherAssessments.get(snapshot);
    if (reusable(existing, finishedAt)) return existing!.result;
    const cached = cachedPlannerSnapshots.get(database);
    if (version !== (plannerVersions.get(database) ?? 0) || (cached && cached.snapshot !== snapshot)
      || (cached && (cached.today !== today || cached.timeZone !== getDeviceTimeZone() || finishedAt.getTime() > cached.expiresAt))) return null;
    const changed = JSON.stringify(weatherResult.schedule) !== JSON.stringify(snapshot.scheduleEntries);
    if (changed) await replaceGeneratedSchedule(database, snapshot.household.id, weatherResult.schedule);
    const result: PlannerSnapshot = !changed && weatherResult.outcome === snapshot.weatherOutcome
      && weatherResult.adjustmentCount === snapshot.weatherAdjustmentCount ? snapshot : {
      ...snapshot,
      scheduleEntries: weatherResult.schedule,
      weatherOutcome: weatherResult.outcome,
      weatherAdjustmentCount: weatherResult.adjustmentCount,
    };
    const nextVersion = version + (changed ? 1 : 0);
    plannerVersions.set(database, nextVersion);
    snapshotVersions.set(result, nextVersion);
    const assessment: WeatherAssessment = { result, baseSchedule, optimize, context, assessedAt: finishedAt.getTime(),
      expiresAt: finishedAt.getTime() + (weatherResult.outcome === 'unavailable' ? 60_000 : WEATHER_FORECAST_CACHE_TTL_MS) };
    weatherAssessments.set(snapshot, assessment);
    weatherAssessments.set(result, assessment);
    if (cached?.snapshot === snapshot) cachedPlannerSnapshots.set(database, { ...cached, snapshot: result });
    return result;
  });
}

async function replaceGeneratedSchedule(
  database: SQLiteDatabase,
  householdId: EntityId,
  entries: readonly ChoreScheduleEntry[],
  simulatedCompletions: readonly { choreId: EntityId; date: LocalDate }[] = [],
  missingInitialDates: readonly Pick<ChoreScheduleEntry, 'choreId' | 'suggestedDate'>[] = [],
): Promise<void> {
  const previous = await database.getAllAsync<{ id: string; entry_json: string }>(
    'SELECT id, entry_json FROM chore_schedule_entries WHERE household_id = ?', householdId,
  );
  const previousById = new Map(previous.map((row) => [row.id, row.entry_json]));
  const nextById = new Map(entries.map((entry) => [entry.id, JSON.stringify(entry)]));
  const removed = previous.filter((row) => !nextById.has(row.id));
  const changed = entries.filter((entry) => previousById.get(entry.id) !== nextById.get(entry.id));
  if (removed.length === 0 && changed.length === 0 && simulatedCompletions.length === 0 && missingInitialDates.length === 0) return;

  await database.withTransactionAsync(async () => {
    for (const row of removed) {
      await database.runAsync('DELETE FROM chore_schedule_entries WHERE household_id = ? AND id = ?', householdId, row.id);
    }
    for (const entry of changed) {
      await database.runAsync(
        `INSERT INTO chore_schedule_entries
         (id, household_id, chore_id, window_start, window_end, suggested_date, status, entry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start,
         window_end = excluded.window_end, suggested_date = excluded.suggested_date,
         status = excluded.status, entry_json = excluded.entry_json`,
        entry.id, entry.householdId, entry.choreId, entry.windowStart, entry.windowEnd,
        entry.suggestedDate, entry.status, nextById.get(entry.id)!,
      );
    }
    for (const entry of missingInitialDates) {
      await database.runAsync(
        `UPDATE chore_state SET initial_scheduled_date = ?
         WHERE chore_id = ? AND initial_pending = 1 AND initial_scheduled_date IS NULL`,
        entry.suggestedDate, entry.choreId,
      );
    }
    for (const { choreId, date } of simulatedCompletions) {
      await database.runAsync(
        `UPDATE chore_state SET last_completed_date = ?, last_completed_estimated = 1,
         initial_pending = 0, initial_scheduled_date = NULL, unknown_reason = NULL
         WHERE chore_id = ? AND (last_completed_date IS NULL OR last_completed_date < ?)`,
        date, choreId, date,
      );
    }
  });
}

export interface SetupSubmission {
  frequencyMode: FrequencyMode;
  restDays: Weekday[];
  notificationsEnabled?: boolean;
  enabledChoreIds: EntityId[];
  previousDates: Record<EntityId, { date?: LocalDate; estimated?: boolean; unknownReason?: 'unknown' | 'skipped' }>;
  weatherLocation: WeatherLocation | null;
  wasteSchedules?: readonly WasteScheduleInput[];
}

async function completeFirstSetupImpl(database: SQLiteDatabase, submission: SetupSubmission): Promise<void> {
  const wasteSchedules = (submission.wasteSchedules ?? []).map(normalizeWasteSchedule);
  if (submission.weatherLocation) {
    const { region, displayName, latitude, longitude } = submission.weatherLocation;
    if (region.trim().length < 2 || region.trim().length > 120
      || displayName.trim().length < 2 || displayName.trim().length > 200
      || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new RangeError('天気を調べる地域を候補から選んでください');
    }
  }
  const enabled = new Set(submission.enabledChoreIds);
  const definitions = await database.getAllAsync<DefinitionRow>(
    'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
  );
  const now = new Date().toISOString();

  await database.withTransactionAsync(async () => {
    await database.runAsync(
      `UPDATE household_settings SET frequency_mode = ?, rest_days_json = ?, notifications_enabled = ?, setup_completed = 1,
       weather_region = ?, weather_region_name = ?, weather_latitude = ?, weather_longitude = ?, updated_at = ?
       WHERE household_id = ?`,
      submission.frequencyMode, JSON.stringify(submission.restDays), submission.notificationsEnabled ? 1 : 0,
      submission.weatherLocation?.region.trim() ?? null,
      submission.weatherLocation?.displayName.trim() ?? null,
      submission.weatherLocation ? Math.round(submission.weatherLocation.latitude * 100) / 100 : null,
      submission.weatherLocation ? Math.round(submission.weatherLocation.longitude * 100) / 100 : null,
      now, LOCAL_HOUSEHOLD_ID,
    );
    for (const row of definitions) {
      const isEnabled = enabled.has(row.id);
      const definition = { ...(JSON.parse(row.definition_json) as ChoreDefinition), enabled: isEnabled };
      await database.runAsync(
        'UPDATE chore_definitions SET enabled = ?, definition_json = ? WHERE id = ?',
        isEnabled ? 1 : 0, JSON.stringify(definition), row.id,
      );
      const previous = submission.previousDates[row.id] ?? { unknownReason: 'skipped' as const };
      await database.runAsync(
        `INSERT INTO chore_state
         (chore_id, last_completed_date, last_completed_estimated, initial_pending, initial_scheduled_date, unknown_reason)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(chore_id) DO UPDATE SET last_completed_date = excluded.last_completed_date,
         last_completed_estimated = excluded.last_completed_estimated, initial_pending = excluded.initial_pending,
         initial_scheduled_date = NULL, unknown_reason = excluded.unknown_reason`,
        row.id, previous.date ?? null, previous.estimated ? 1 : 0,
        !previous.date ? 1 : 0, !previous.date ? previous.unknownReason ?? 'unknown' : null,
      );
    }
    for (const schedule of wasteSchedules) await saveWeeklyWasteScheduleImpl(database, schedule);
  });
}

async function updatePlannerSettingsImpl(
  database: SQLiteDatabase,
  settings: Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>,
  _displayedBase?: Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>,
): Promise<void> {
  if (!['frequent', 'balanced', 'relaxed'].includes(settings.frequencyMode)
    || settings.restDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || !Number.isInteger(settings.heavyDailyLimit) || settings.heavyDailyLimit < 1 || settings.heavyDailyLimit > 10
    || !Number.isInteger(settings.normalDailyLimit) || settings.normalDailyLimit < 1 || settings.normalDailyLimit > 20) {
    throw new RangeError('頻度・休日と、重い家事1〜10件・普通の家事1〜20件の上限を確認してください。');
  }
  await database.runAsync(
    `UPDATE household_settings SET frequency_mode = ?, rest_days_json = ?, heavy_daily_limit = ?,
     normal_daily_limit = ?, updated_at = ? WHERE household_id = ?`,
    settings.frequencyMode, JSON.stringify(settings.restDays), settings.heavyDailyLimit,
    settings.normalDailyLimit, new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
  );
}

async function updateCalendarCountDisplayImpl(
  database: SQLiteDatabase,
  settings: { colors: CalendarCountColors; displayMode: CalendarCountDisplayMode },
): Promise<void> {
  const validColors = [settings.colors.low, settings.colors.medium, settings.colors.high];
  if (validColors.some((color) => !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new RangeError('カレンダーの色を選び直してください。');
  }
  if (settings.displayMode !== 'dots') {
    throw new RangeError('カレンダーの表示方法を選び直してください。');
  }
  await database.runAsync(
    'UPDATE household_settings SET calendar_count_colors_json = ?, calendar_count_display_mode = ?, updated_at = ? WHERE household_id = ?',
    JSON.stringify(settings.colors), settings.displayMode, new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
  );
}

async function setNotificationsEnabledImpl(database: SQLiteDatabase, enabled: boolean): Promise<void> {
  await database.runAsync(
    'UPDATE household_settings SET notifications_enabled = ?, updated_at = ? WHERE household_id = ?',
    enabled ? 1 : 0, new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
  );
}

async function saveWeatherLocationImpl(
  database: SQLiteDatabase,
  location: WeatherLocation,
): Promise<void> {
  const region = location.region.trim();
  const displayName = location.displayName.trim();
  if (region.length < 2 || region.length > 120 || displayName.length < 2 || displayName.length > 200) {
    throw new RangeError('地域名は2〜120文字で入力してください');
  }
  if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90
    || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
    throw new RangeError('地域の座標が正しくありません');
  }
  const latitude = Math.round(location.latitude * 100) / 100;
  const longitude = Math.round(location.longitude * 100) / 100;
  await database.runAsync(
    `UPDATE household_settings SET weather_region = ?, weather_region_name = ?, weather_latitude = ?, weather_longitude = ?, updated_at = ?
     WHERE household_id = ?`,
    region, displayName, latitude, longitude, new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
  );
}

async function clearWeatherLocationImpl(database: SQLiteDatabase): Promise<void> {
  await database.runAsync(
    `UPDATE household_settings SET weather_region = NULL, weather_region_name = NULL,
     weather_latitude = NULL, weather_longitude = NULL, updated_at = ?
     WHERE household_id = ?`,
    new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
  );
}

async function updateChoreSettingsImpl(database: SQLiteDatabase, choreId: EntityId, patch: ChoreSettingsPatch, _displayedBase?: ChoreDefinition): Promise<boolean> {
  const row = await database.getFirstAsync<{ enabled: number; definition_json: string }>(
    'SELECT enabled, definition_json FROM chore_definitions WHERE id = ? AND household_id = ?', choreId, LOCAL_HOUSEHOLD_ID,
  );
  if (!row) throw new Error('家事が見つかりません。');
  const current = { ...JSON.parse(row.definition_json) as ChoreDefinition, enabled: Boolean(row.enabled) };
  if (current.archived) throw new Error('この家事は現在の家事一覧から削除されています。');
  const updated = applyChoreSettingsPatch(current, patch);
  if (choreScheduleSignature(current) === choreScheduleSignature(updated)) return false;
  await updateChoreDefinitionImpl(database, updated);
  plannerVersions.set(database, (plannerVersions.get(database) ?? 0) + 1);
  return true;
}

async function updateChoreDefinitionImpl(
  database: SQLiteDatabase,
  definition: ChoreDefinition,
): Promise<void> {
  if (definition.archived) throw new Error('この家事は現在の家事一覧から削除されています。');
  const previous = await database.getFirstAsync<{ enabled: number; definition_json: string }>(
    'SELECT enabled, definition_json FROM chore_definitions WHERE id = ? AND household_id = ?', definition.id, LOCAL_HOUSEHOLD_ID,
  );
  if (!previous) throw new Error('Chore not found');
  if (definition.enabled && definition.requiresCycleSelection) throw new Error('周期を設定してから有効にしてください。');
  const scheduleChanged = choreScheduleSignature(JSON.parse(previous.definition_json) as ChoreDefinition)
    !== choreScheduleSignature(definition);
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'UPDATE chore_definitions SET name = ?, enabled = ?, definition_json = ? WHERE id = ?',
      definition.name, definition.enabled ? 1 : 0, JSON.stringify(definition), definition.id,
    );
    // Cached overdue periods otherwise retain the old width after a scheduling setting is edited.
    if (scheduleChanged) await database.runAsync('DELETE FROM chore_schedule_entries WHERE chore_id = ?', definition.id);
    if (definition.enabled && !previous.enabled) {
      // Re-enabling an unstarted chore creates a new first plan from today; real completion history is retained.
      await database.runAsync(`UPDATE chore_state SET initial_pending = 1, initial_scheduled_date = NULL,
        unknown_reason = COALESCE(unknown_reason, 'unknown') WHERE chore_id = ? AND last_completed_date IS NULL`, definition.id);
    }
  });
}

function choreScheduleSignature(chore: ChoreDefinition): string {
  return JSON.stringify([
    chore.enabled, chore.load, chore.everyday, chore.requiresCycleSelection,
    chore.frequencyDaysByMode.frequent, chore.frequencyDaysByMode.balanced, chore.frequencyDaysByMode.relaxed,
    chore.recommendedCycleDays, chore.userIntervalDays, chore.manufacturerRecommendedIntervalDays,
    chore.windowRadiusDays, chore.maxShiftDays, chore.holidayPriority, chore.laundryDryingPreference,
  ]);
}

export interface SaveReviewedApplianceResult {
  applianceId: EntityId;
  scheduledTaskCount: number;
  duplicateTaskCount: number;
  noCycleTaskCount: number;
}

async function saveReviewedApplianceCareImpl(
  database: SQLiteDatabase,
  product: Omit<ApplianceCareProductIdentity, 'applianceId'> & { applianceId?: EntityId },
  analysis: ApplianceCareAnalysisDraft,
  approvedTasks: readonly ApprovedApplianceCareTask[],
): Promise<SaveReviewedApplianceResult> {
  await ensureLocalHouseholdImpl(database);
  const applianceId = product.applianceId ?? createId('appliance');
  const existing = await database.getFirstAsync<{ created_at: string; manufacturer: string; product_name: string; model_number: string }>(
    'SELECT created_at, manufacturer, product_name, model_number FROM appliances WHERE id=? AND household_id=?', applianceId, LOCAL_HOUSEHOLD_ID);
  const rows = await database.getAllAsync<DefinitionRow>('SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
  const plan = planReviewedApplianceSave({ householdId: LOCAL_HOUSEHOLD_ID, applianceId, now: new Date().toISOString(), product, analysis, approvedTasks,
    ...(existing ? { existingAppliance: { createdAt: existing.created_at, manufacturer: existing.manufacturer, productName: existing.product_name, modelNumber: existing.model_number } } : {}),
    allChores: rows.map((row) => ({ ...JSON.parse(row.definition_json) as ChoreDefinition, id: row.id, enabled: Boolean(row.enabled) })),
    newChoreId: () => createId('appliance-care') });
  await database.withTransactionAsync(async () => {
    const appliance = plan.appliance;
    await database.runAsync(`INSERT INTO appliances (id, household_id, manufacturer, product_name, model_number, category, display_name,
      official_product_url, official_manual_url, analysis_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET manufacturer=excluded.manufacturer, product_name=excluded.product_name, model_number=excluded.model_number,
      category=excluded.category, display_name=excluded.display_name, official_product_url=excluded.official_product_url,
      official_manual_url=excluded.official_manual_url, analysis_json=excluded.analysis_json, updated_at=excluded.updated_at`, appliance.id, appliance.householdId,
      appliance.manufacturer, appliance.productName, appliance.modelNumber, appliance.category ?? null, appliance.displayName,
      appliance.officialProductUrl ?? null, appliance.officialManualUrl, JSON.stringify(appliance.analysis), appliance.createdAt, appliance.updatedAt);
    for (const chore of plan.definitions) {
      await database.runAsync(`INSERT INTO chore_definitions (id, household_id, name, enabled, definition_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, definition_json=excluded.definition_json`,
        chore.id, chore.householdId, chore.name, chore.enabled ? 1 : 0, JSON.stringify(chore));
      if (plan.newChoreIds.has(chore.id)) {
        await database.runAsync('INSERT INTO chore_state (chore_id, initial_pending, unknown_reason) VALUES (?, 1, ?)', chore.id, 'skipped');
        await database.runAsync('INSERT INTO chore_assignments (chore_id, member_id) VALUES (?, ?)', chore.id, LOCAL_MEMBER_ID);
      }
    }
  });
  return plan.result;
}

async function setChoreEnabledImpl(database: SQLiteDatabase, choreId: EntityId, enabled: boolean): Promise<void> {
  const row = await database.getFirstAsync<{ definition_json: string }>(
    'SELECT definition_json FROM chore_definitions WHERE id = ?', choreId,
  );
  if (!row) throw new Error('Chore not found');
  const definition = { ...(JSON.parse(row.definition_json) as ChoreDefinition), enabled };
  if (definition.archived) throw new Error('この家事は現在の家事一覧から削除されています。');
  if (enabled && definition.requiresCycleSelection) {
    throw new Error('メーカー指定の周期がありません。周期を設定してから有効にしてください。');
  }
  await updateChoreDefinitionImpl(database, definition);
}

async function setChoresEnabledImpl(database: SQLiteDatabase, choreIds: string[], enabled: boolean): Promise<void> {
  validateChoreToggle(choreIds, enabled);
  // Validate the complete group before writing. Unknown appliance cycles must never be invented.
  await database.withTransactionAsync(async () => {
    const changes: { chore: ChoreDefinition; wasEnabled: boolean }[] = [];
    for (const id of choreIds) {
      const row = await database.getFirstAsync<DefinitionRow>('SELECT id, enabled, definition_json FROM chore_definitions WHERE id = ? AND household_id = ?', id, LOCAL_HOUSEHOLD_ID);
      if (!row) throw new Error('家事が見つかりません。最新の一覧を読み直してください。');
      const chore = { ...JSON.parse(row.definition_json) as ChoreDefinition, enabled };
      if (chore.archived) throw new Error('削除済みの家事は変更できません。');
      if (enabled && chore.requiresCycleSelection) throw new Error(`「${chore.name}」の周期を設定してから有効にしてください。`);
      if (Boolean(row.enabled) !== enabled) changes.push({ chore, wasEnabled: Boolean(row.enabled) });
    }
    for (const { chore } of changes) {
      await database.runAsync('UPDATE chore_definitions SET enabled = ?, definition_json = ? WHERE id = ? AND household_id = ?', enabled ? 1 : 0, JSON.stringify(chore), chore.id, LOCAL_HOUSEHOLD_ID);
      await database.runAsync('DELETE FROM chore_schedule_entries WHERE chore_id = ?', chore.id);
      if (enabled) await database.runAsync(`UPDATE chore_state SET initial_pending = 1, initial_scheduled_date = NULL,
        unknown_reason = COALESCE(unknown_reason, 'unknown') WHERE chore_id = ? AND last_completed_date IS NULL`, chore.id);
    }
  });
}

async function completeChoreImpl(
  database: SQLiteDatabase,
  entry: ChoreScheduleEntry,
  memberId?: EntityId,
  source: NonNullable<ChoreCompletion['source']> = 'inApp',
): Promise<boolean> {
  if (!await isActiveChoreEntry(database, entry)) return false;
  let inserted = false;
  await database.withTransactionAsync(async () => {
    inserted = await persistChoreCompletion(database, entry, new Date().toISOString(), source, memberId);
  });
  return inserted;
}

/** Capture the exact saved fact in the same transaction, for the short-lived Undo action. */
async function completeChoreWithReceiptImpl(database: SQLiteDatabase, entry: ChoreScheduleEntry, assertAccess?: () => void | Promise<void>): Promise<ChoreCompletion | undefined> {
  await assertAccess?.();
  let receipt: ChoreCompletion | undefined;
  await database.withTransactionAsync(async () => {
    await assertAccess?.();
    if (!await isActiveChoreEntry(database, entry)) return;
    if (!await persistChoreCompletion(database, entry, new Date().toISOString(), 'inApp')) return;
    const row = await database.getFirstAsync<CompletionRow>('SELECT * FROM chore_completions WHERE schedule_entry_id = ?', entry.id);
    if (row) receipt = completionFromRow(row);
    await assertAccess?.();
  });
  return receipt;
}

async function undoCompletionReceiptImpl(database: SQLiteDatabase, receipt: ChoreCompletion, assertAccess?: () => void | Promise<void>): Promise<boolean> {
  await assertAccess?.();
  let changed = false;
  await database.withTransactionAsync(async () => {
    await assertAccess?.();
    const row = await database.getFirstAsync<CompletionRow>('SELECT * FROM chore_completions WHERE id = ?', receipt.id);
    if (!row || row.household_id !== LOCAL_HOUSEHOLD_ID || row.household_id !== receipt.householdId
      || row.chore_id !== receipt.choreId || row.schedule_entry_id !== receipt.scheduleEntryId
      || row.completed_at !== receipt.completedAt || row.source !== receipt.source || row.outcome !== 'completed') return;
    changed = await undoCompletionInTransaction(database, receipt.id, 'inApp', localDateFromDate(new Date()));
    await assertAccess?.();
  });
  return changed;
}

/** Overlay access must never initialize or mutate a v1/v2 group connection. */
async function assertPersonalPlannerDatabase(database: SQLiteDatabase): Promise<void> {
  if (sharedRepositoryAdapter(database) || await database.getFirstAsync(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sharing_workspace_metadata', 'sharing_v2_binding') LIMIT 1",
  )) throw new Error('個人の保存先を確認できません。個人モードを開き直してください。');
  const household = await database.getFirstAsync<{ id: string }>('SELECT id FROM households WHERE id = ?', LOCAL_HOUSEHOLD_ID);
  if (!household) throw new Error('個人の家事を読み込んでから再試行してください。');
}

/** Replayed canonical group facts converge locally without copying private definitions into shared events. */
async function mirrorSharedChoreCompletionsImpl(database: SQLiteDatabase, input: CommonCompletionSource,
  assertAccess: () => void | Promise<void>): Promise<number> {
  await assertAccess(); await assertPersonalPlannerDatabase(database);
  let changed = 0;
  await database.withTransactionAsync(async () => {
    await assertAccess();
    const rows = await database.getAllAsync<DefinitionRow>('SELECT id,enabled,definition_json FROM chore_definitions WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
    const personal = rows.map(row => ({ ...JSON.parse(row.definition_json) as ChoreDefinition, enabled: Boolean(row.enabled) }));
    const ids = new Set(personal.map(chore => chore.id));
    const links = commonChoreLinks(personal, input.chores);
    const existing = await database.getAllAsync<{ id: string; chore_id: string; schedule_entry_id: string; outcome: ChoreCompletion['outcome'] }>(
      "SELECT id,chore_id,schedule_entry_id,outcome FROM chore_completions WHERE household_id=? AND schedule_entry_id LIKE 'shared-home:%'", LOCAL_HOUSEHOLD_ID);
    // Existing mirrors remain addressable for explicit undo even after a rename or disable.
    for (const row of existing) {
      const key = parseSharedMirrorEntryId(row.schedule_entry_id);
      if (key?.groupId === input.groupId && key.personalChoreId === row.chore_id && ids.has(row.chore_id)
        && !links.some(link => link.personalChoreId === row.chore_id && link.sharedChoreId === key.sharedChoreId)) links.push(key);
    }
    const known = new Map(existing.map(row => [row.schedule_entry_id, row]));
    const bySharedChore = new Map<string, typeof links>();
    for (const link of links) { const values = bySharedChore.get(link.sharedChoreId) ?? []; values.push(link); bySharedChore.set(link.sharedChoreId, values); }
    for (const fact of [...input.completions].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || a.id.localeCompare(b.id))) {
      if (!fact.scheduleEntryId) continue;
      if (!Number.isFinite(Date.parse(fact.completedAt))) throw new Error('共有家事の実施日時を確認してください。');
      for (const date of [fact.scheduledDate, fact.scheduledWindowStart, fact.scheduledWindowEnd]) if (date) parseLocalDate(date);
      for (const link of bySharedChore.get(fact.choreId) ?? []) {
        const entryId = sharedMirrorEntryId(input.groupId, fact.choreId, fact.scheduleEntryId, link.personalChoreId);
        const stored = known.get(entryId);
        if (fact.outcome === 'completed') {
          if (stored?.outcome === 'completed') continue;
          if (await persistChoreCompletion(database, { id: entryId, householdId: LOCAL_HOUSEHOLD_ID, choreId: link.personalChoreId,
            suggestedDate: fact.scheduledDate, windowStart: fact.scheduledWindowStart, windowEnd: fact.scheduledWindowEnd }, fact.completedAt, 'inApp')) changed++;
        } else if (stored?.outcome === 'completed' && await undoCompletionInTransaction(database, stored.id, 'inApp', localDateFromDate(new Date()))) changed++;
      }
    }
    await assertAccess();
  });
  if (changed) plannerVersions.set(database, (plannerVersions.get(database) ?? 0) + 1);
  return changed;
}

async function readPersonalPlannerOverlaySnapshotImpl(database: SQLiteDatabase, now = new Date()) {
  await assertPersonalPlannerDatabase(database);
  const today = localDateFromDate(now); const timeZone = getDeviceTimeZone();
  const snapshot = readCachedPlannerSnapshot(database, now) ?? await loadPlannerSnapshotImpl(database, today, now, timeZone);
  return { snapshot, today, timeZone };
}

/** Copy selection needs definitions and the selected frequency only; never load history or generate schedules here. */
async function readPersonalChoreCopySourceImpl(database: SQLiteDatabase, ids?: readonly string[]) {
  const selected = ids ? [...ids] : undefined;
  if (selected && (!selected.length || selected.length > 20 || new Set(selected).size !== selected.length
    || selected.some(id => typeof id !== 'string' || !id.length || id.length > 512 || id.includes('\0')))) throw new Error('コピーする個人家事を選び直してください。');
  let result!: { householdId: string; frequencyMode: FrequencyMode; chores: ChoreDefinition[] };
  await database.withTransactionAsync(async () => {
    await assertPersonalPlannerDatabase(database);
    const settings = await database.getFirstAsync<{ frequency_mode: FrequencyMode }>('SELECT frequency_mode FROM household_settings WHERE household_id = ?', LOCAL_HOUSEHOLD_ID);
    if (!settings || !['frequent', 'balanced', 'relaxed'].includes(settings.frequency_mode)) throw new Error('個人家事の頻度設定を確認してください。');
    const rows = await database.getAllAsync<DefinitionRow>(`SELECT id,enabled,definition_json FROM chore_definitions WHERE household_id = ?${selected ? ` AND id IN (${selected.map(() => '?').join(',')})` : ''} ORDER BY name`, LOCAL_HOUSEHOLD_ID, ...(selected ?? []));
    const chores = rows.map(row => {
      const chore = JSON.parse(row.definition_json) as ChoreDefinition;
      if (!chore || chore.id !== row.id || chore.householdId !== LOCAL_HOUSEHOLD_ID || ![0, 1].includes(row.enabled)
        || typeof chore.name !== 'string') throw new Error('個人家事の保存形式を確認してください。');
      return { ...chore, enabled: Boolean(row.enabled) };
    });
    result = { householdId: LOCAL_HOUSEHOLD_ID, frequencyMode: settings.frequency_mode, chores };
  });
  return result;
}

/** Re-select inside the personal queue and transaction; a stale UI can never target a new occurrence. */
async function setPersonalDateTaskCompletedImpl(database: SQLiteDatabase, command: PersonalDateTaskCommand,
  assertAccess: () => void | Promise<void>): Promise<boolean> {
  parseLocalDate(command.date);
  if (![0, 3].includes(command.graceDays) || typeof command.completed !== 'boolean' || typeof command.revision !== 'string'
    || !command.choreId) throw new Error('表示した個人家事を選び直してください。');
  await assertAccess(); await assertPersonalPlannerDatabase(database);
  let changed = false;
  await database.withTransactionAsync(async () => {
    const row = await database.getFirstAsync<DefinitionRow>(
      'SELECT id, enabled, definition_json FROM chore_definitions WHERE id = ? AND household_id = ?', command.choreId, LOCAL_HOUSEHOLD_ID,
    );
    if (!row?.enabled) throw new Error('この個人家事は変更されています。表示を更新してください。');
    const chore = { ...JSON.parse(row.definition_json) as ChoreDefinition, enabled: Boolean(row.enabled) };
    const entries = (await database.getAllAsync<ScheduleEntryRow>(
      'SELECT entry_json FROM chore_schedule_entries WHERE chore_id = ? AND household_id = ?', command.choreId, LOCAL_HOUSEHOLD_ID,
    )).map((entry) => JSON.parse(entry.entry_json) as ChoreScheduleEntry);
    if (chore.id !== command.choreId || chore.householdId !== LOCAL_HOUSEHOLD_ID
      || entries.some((entry) => entry.householdId !== LOCAL_HOUSEHOLD_ID || entry.choreId !== command.choreId)) {
      throw new Error('個人の家事と保存先を確認できません。表示を更新してください。');
    }
    const completions = (await database.getAllAsync<CompletionRow>(
      `SELECT id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id,
       scheduled_date, scheduled_window_start, scheduled_window_end, outcome FROM chore_completions
       WHERE chore_id = ? AND household_id = ? ORDER BY completed_at DESC`, command.choreId, LOCAL_HOUSEHOLD_ID,
    )).map(completionFromRow);
    const task = selectDateTasks(entries, completions, command.date, command.graceDays, [chore])[0];
    if (!task || dateTaskRevision(task) !== command.revision) throw new Error('個人家事の状態が変わっています。表示を更新して選び直してください。');
    await assertAccess();
    if (task.completed === command.completed) return;
    if (command.completed && task.entry && await isActiveChoreEntry(database, task.entry)) changed = await persistChoreCompletion(database, task.entry, new Date().toISOString(), 'inApp');
    else if (!command.completed && task.completion) changed = await undoCompletionInTransaction(database, task.completion.id, 'inApp', localDateFromDate(new Date()));
  });
  return changed;
}

async function isActiveChoreEntry(database: SQLiteDatabase, entry: ChoreScheduleEntry): Promise<boolean> {
  if (entry.householdId !== LOCAL_HOUSEHOLD_ID) return false;
  if (entry.status === 'initialPending' && !entry.id.endsWith(':initial')) return false;
  const active = await database.getFirstAsync<{ enabled: number }>(
    'SELECT enabled FROM chore_definitions WHERE id = ? AND household_id = ?', entry.choreId, LOCAL_HOUSEHOLD_ID,
  );
  return Boolean(active?.enabled);
}

type CompletionTarget = Pick<ChoreScheduleEntry, 'id' | 'householdId' | 'choreId'>
  & Partial<Pick<ChoreScheduleEntry, 'suggestedDate' | 'windowStart' | 'windowEnd'>>;

/** Shared by app/widget completion and Google import, inside the caller's transaction. */
async function persistChoreCompletion(
  database: SQLiteDatabase,
  entry: CompletionTarget,
  completedAt: string,
  source: NonNullable<ChoreCompletion['source']>,
  memberId?: EntityId,
): Promise<boolean> {
  const completedDate = localDateFromDate(new Date(completedAt));
  const previousStateRow = await database.getFirstAsync<StateRow>(
    `SELECT chore_id, last_completed_date, last_completed_estimated, initial_pending,
     initial_scheduled_date, unknown_reason FROM chore_state WHERE chore_id = ?`, entry.choreId,
  );
  const previousState: ChoreState | null = previousStateRow ? {
    choreId: previousStateRow.chore_id,
    lastCompletedDate: (previousStateRow.last_completed_date ?? undefined) as LocalDate | undefined,
    lastCompletedEstimated: Boolean(previousStateRow.last_completed_estimated),
    initialPending: Boolean(previousStateRow.initial_pending),
    initialScheduledDate: (previousStateRow.initial_scheduled_date ?? undefined) as LocalDate | undefined,
    unknownReason: previousStateRow.unknown_reason ?? undefined,
  } : null;
  const previousStateJson = JSON.stringify(previousState);
  const existing = await database.getFirstAsync<{ id: string; outcome: ChoreCompletion['outcome'] }>(
    'SELECT id, outcome FROM chore_completions WHERE schedule_entry_id = ?', entry.id,
  );
  if (existing?.outcome === 'completed') return false;
  if (existing) {
    await database.runAsync(
      `UPDATE chore_completions SET outcome = 'completed', completed_at = ?,
       completed_by_member_id = ?, source = ?, scheduled_date = ?,
       scheduled_window_start = ?, scheduled_window_end = ?, previous_chore_state_json = ? WHERE id = ?`,
      completedAt, memberId ?? null, source, entry.suggestedDate ?? null, entry.windowStart ?? null, entry.windowEnd ?? null,
      previousStateJson, existing.id,
    );
  } else {
    await database.runAsync(
      `INSERT INTO chore_completions
       (id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id,
        scheduled_date, scheduled_window_start, scheduled_window_end, outcome, previous_chore_state_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
      createId('completion'), entry.householdId, entry.choreId, completedAt, memberId ?? null, source,
      entry.id, entry.suggestedDate ?? null, entry.windowStart ?? null, entry.windowEnd ?? null, previousStateJson,
    );
  }
  if (source !== 'googleTasks') await markPendingGoogleStatus(database, entry.id, 'completed');
  // Historical Google completions must not move a newer local completion backwards.
  // Future checkmarks retain their actual timestamp but take effect on their scheduled day.
  const windowStart = entry.windowStart ?? entry.suggestedDate;
  if ((!windowStart || completedDate >= windowStart)
    && (!previousState?.lastCompletedDate || completedDate >= previousState.lastCompletedDate)) {
    await database.runAsync(
      `INSERT INTO chore_state (chore_id, last_completed_date, last_completed_estimated, initial_pending, unknown_reason)
       VALUES (?, ?, 0, 0, NULL)
       ON CONFLICT(chore_id) DO UPDATE SET last_completed_date = excluded.last_completed_date,
       last_completed_estimated = 0, initial_pending = 0, initial_scheduled_date = NULL, unknown_reason = NULL`,
      entry.choreId, completedDate,
    );
  }
  return true;
}

async function importGoogleTaskCompletionsImpl(
  database: SQLiteDatabase,
  completions: readonly GoogleTaskCompletion[],
  today: LocalDate = localDateFromDate(new Date()),
  calendarNow = new Date(),
): Promise<number> {
  return importGoogleTaskChangesImpl(database, completions.map((item) => ({ ...item, status: 'completed' })), today, calendarNow);
}

async function importGoogleTaskChangesImpl(
  database: SQLiteDatabase,
  changes: readonly GoogleTaskStatusChange[],
  today: LocalDate = localDateFromDate(new Date()),
  calendarNow = new Date(),
): Promise<number> {
  const links = await listGoogleTaskLinksImpl(database, LOCAL_HOUSEHOLD_ID);
  const linksByTask = new Map(links.map((link) => [JSON.stringify([link.googleTaskListId, link.googleTaskId]), link]));
  const targets: { entry: CompletionTarget; change: GoogleTaskStatusChange }[] = [];
  const seenEntries = new Set<string>();
  // Capture every mapped occurrence before saving any completion or regenerating schedules.
  for (const completion of changes) {
    const completedAt = completion.status === 'completed' ? parseGoogleCompletedAt(completion.completedAt) : undefined;
    const link = linksByTask.get(JSON.stringify([completion.googleTaskListId, completion.googleTaskId]));
    if ((completion.status === 'completed' && !completedAt) || !link || link.scheduleEntryId !== completion.scheduleEntryId || seenEntries.has(link.scheduleEntryId)) continue;
    const row = await database.getFirstAsync<{ entry_json: string | null }>(
      `SELECT s.entry_json FROM chore_definitions d
       LEFT JOIN chore_schedule_entries s ON s.id = ? AND s.chore_id = d.id AND s.household_id = d.household_id
       WHERE d.id = ? AND d.household_id = ?`,
      link.scheduleEntryId, link.choreId, LOCAL_HOUSEHOLD_ID,
    );
    if (!row) continue;
    const saved = row.entry_json ? parseJson<ChoreScheduleEntry | null>(row.entry_json, null) : null;
    const entry: CompletionTarget = saved?.id === link.scheduleEntryId && saved.choreId === link.choreId && saved.householdId === link.householdId
      ? saved
      : { id: link.scheduleEntryId, householdId: link.householdId, choreId: link.choreId, suggestedDate: link.lastSyncedDueDate };
    targets.push({ entry, change: completion.status === 'completed' ? { ...completion, completedAt: completedAt! } : completion });
    seenEntries.add(link.scheduleEntryId);
  }
  if (!targets.length) return 0;
  targets.sort((left, right) => (left.change.status === 'completed' ? Date.parse(left.change.completedAt) : 0)
    - (right.change.status === 'completed' ? Date.parse(right.change.completedAt) : 0));
  let imported = 0;
  await database.withTransactionAsync(async () => {
    for (const { entry, change } of targets) {
      // Recheck inside the same transaction as the import. A local action during network I/O wins.
      const currentLink = await database.getFirstAsync<{ last_synced_status: string | null; pending_status: string | null }>(
        `SELECT last_synced_status, pending_status FROM google_task_links
         WHERE schedule_entry_id = ? AND google_task_list_id = ? AND google_task_id = ?`,
        entry.id, change.googleTaskListId, change.googleTaskId,
      );
      if (!currentLink || currentLink.pending_status) continue;
      const current = await database.getFirstAsync<{ id: string; outcome: string }>(
        'SELECT id, outcome FROM chore_completions WHERE schedule_entry_id = ?', entry.id,
      );
      const action = googleTaskImportAction({ pendingStatus: currentLink.pending_status, lastSyncedStatus: currentLink.last_synced_status }, current?.outcome, change.status);
      if (action === 'complete' && change.status === 'completed') {
        if (await persistChoreCompletion(database, entry, change.completedAt, 'googleTasks')) imported += 1;
      } else if (action === 'undo') {
        if (await undoCompletionInTransaction(database, current!.id, 'googleTasks', today)) imported += 1;
      }
    }
  });
  // Also run after a duplicate-only retry: an earlier process may have stopped after commit.
  await loadPlannerSnapshotImpl(database, today, calendarNow);
  return imported;
}

async function markPendingGoogleStatus(database: SQLiteDatabase, scheduleEntryId: string, status: GoogleTaskStatus): Promise<void> {
  await stagePendingGoogleTaskStatus(database, scheduleEntryId, status, createId('google-status'));
}

async function hasPendingGoogleTaskChangesImpl(
  database: SQLiteDatabase, lastSuccessfulSyncAt?: string, householdId = LOCAL_HOUSEHOLD_ID,
): Promise<boolean> {
  const row = await database.getFirstAsync<{ pending: number }>(
    `SELECT EXISTS(SELECT 1 FROM google_task_links WHERE household_id = ? AND pending_status IS NOT NULL)
       OR EXISTS(SELECT 1 FROM chore_completions WHERE household_id = ? AND source = 'widget'
         AND outcome = 'completed' AND completed_at > ?) AS pending`,
    householdId, householdId, lastSuccessfulSyncAt ?? '',
  );
  return Boolean(row?.pending);
}

async function undoCompletedChoreImpl(database: SQLiteDatabase, completionId: EntityId, assertAccess?: () => void | Promise<void>): Promise<boolean> {
  await assertAccess?.();
  let undone = false;
  await database.withTransactionAsync(async () => {
    await assertAccess?.();
    undone = await undoCompletionInTransaction(database, completionId, 'inApp', localDateFromDate(new Date()));
    await assertAccess?.();
  });
  return undone;
}

async function undoCompletionInTransaction(
  database: SQLiteDatabase, completionId: EntityId, source: 'inApp' | 'googleTasks', today: LocalDate,
): Promise<boolean> {
  const completion = await database.getFirstAsync<{
    sequence: number;
    chore_id: string;
    outcome: ChoreCompletion['outcome'];
    schedule_entry_id: string | null;
    scheduled_date: string | null;
    scheduled_window_start: string | null;
    completed_at: string;
    previous_chore_state_json: string | null;
  }>(
    `SELECT rowid AS sequence, chore_id, outcome, schedule_entry_id, scheduled_date,
     scheduled_window_start, completed_at, previous_chore_state_json
     FROM chore_completions WHERE id = ?`, completionId,
  );
  if (!completion || completion.outcome !== 'completed') return false;

  await database.runAsync(
    `UPDATE chore_completions SET outcome = 'incomplete',
     completed_by_member_id = NULL, source = ?
     WHERE id = ?`,
    source, completionId,
  );
  if (source !== 'googleTasks' && completion.schedule_entry_id) {
    await markPendingGoogleStatus(database, completion.schedule_entry_id, 'needsAction');
  }
  const completionDate = completionCycleDate({
    completedAt: completion.completed_at,
    scheduledDate: (completion.scheduled_date ?? undefined) as LocalDate | undefined,
    scheduledWindowStart: (completion.scheduled_window_start ?? undefined) as LocalDate | undefined,
  });
  if (completionDate > today) {
    return true;
  }
  const history = await database.getAllAsync<{
    sequence: number;
    outcome: ChoreCompletion['outcome'];
    completed_at: string;
    scheduled_date: string | null;
    scheduled_window_start: string | null;
    previous_chore_state_json: string | null;
  }>(
    `SELECT rowid AS sequence, outcome, completed_at, scheduled_date, scheduled_window_start,
     previous_chore_state_json FROM chore_completions
     WHERE chore_id = ? ORDER BY completed_at DESC, rowid DESC`, completion.chore_id,
  );
  const datedHistory = history.map((row) => ({
    ...row,
    cycleDate: completionCycleDate({
      completedAt: row.completed_at,
      scheduledDate: (row.scheduled_date ?? undefined) as LocalDate | undefined,
      scheduledWindowStart: (row.scheduled_window_start ?? undefined) as LocalDate | undefined,
    }),
  }));
  const latestRemaining = datedHistory
    .filter((row) => row.outcome === 'completed' && row.cycleDate <= today)
    .sort((left, right) => right.cycleDate.localeCompare(left.cycleDate))[0];
  if (completion.previous_chore_state_json !== null) {
    let previousState = JSON.parse(completion.previous_chore_state_json) as ChoreState | null;
    let beforeSequence = completion.sequence;
    // A saved prior state may itself point at a completion that was undone earlier.
    while (previousState?.lastCompletedDate) {
      const previousDate = previousState.lastCompletedDate;
      const undonePrevious = datedHistory.find((row) => row.sequence < beforeSequence
        && row.outcome === 'incomplete' && row.previous_chore_state_json !== null
        && row.cycleDate === previousDate);
      if (!undonePrevious) break;
      previousState = JSON.parse(undonePrevious.previous_chore_state_json!) as ChoreState | null;
      beforeSequence = undonePrevious.sequence;
    }
    const remainingDate = latestRemaining?.cycleDate;
    if (remainingDate && (!previousState?.lastCompletedDate || remainingDate >= previousState.lastCompletedDate)) {
      previousState = { choreId: completion.chore_id, lastCompletedDate: remainingDate, lastCompletedEstimated: false, initialPending: false };
    }
    await restoreChoreState(database, completion.chore_id, previousState);
  } else if (latestRemaining) {
    await restoreChoreState(database, completion.chore_id, {
      choreId: completion.chore_id,
      lastCompletedDate: latestRemaining.cycleDate,
      lastCompletedEstimated: false,
      initialPending: false,
    });
  } else {
    await restoreLegacyChoreState(database, completion.chore_id, completion.schedule_entry_id, completion.scheduled_date);
  }
  return true;
}

async function restoreChoreState(database: SQLiteDatabase, choreId: EntityId, state: ChoreState | null): Promise<void> {
  if (!state) {
    await database.runAsync('DELETE FROM chore_state WHERE chore_id = ?', choreId);
    return;
  }
  await database.runAsync(
    `INSERT INTO chore_state
     (chore_id, last_completed_date, last_completed_estimated, initial_pending, initial_scheduled_date, unknown_reason)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chore_id) DO UPDATE SET last_completed_date = excluded.last_completed_date,
     last_completed_estimated = excluded.last_completed_estimated, initial_pending = excluded.initial_pending,
     initial_scheduled_date = excluded.initial_scheduled_date, unknown_reason = excluded.unknown_reason`,
    choreId, state.lastCompletedDate ?? null, state.lastCompletedEstimated ? 1 : 0,
    state.initialPending ? 1 : 0, state.initialScheduledDate ?? null, state.unknownReason ?? null,
  );
}

/** Repair the state written by older versions when a future occurrence was checked early. */
async function repairFutureCompletionStates(database: SQLiteDatabase): Promise<void> {
  const today = localDateFromDate(new Date());
  const rows = await database.getAllAsync<{
    chore_id: string;
    completed_at: string;
    scheduled_date: string | null;
    scheduled_window_start: string | null;
    previous_chore_state_json: string | null;
  }>(
    `SELECT chore_id, completed_at, scheduled_date, scheduled_window_start, previous_chore_state_json
     FROM chore_completions WHERE outcome = 'completed' ORDER BY completed_at DESC, rowid DESC`,
  );
  const historyByChore = new Map<string, typeof rows>();
  for (const row of rows) {
    const history = historyByChore.get(row.chore_id) ?? [];
    history.push(row);
    historyByChore.set(row.chore_id, history);
  }
  const isFutureRecord = (row: (typeof rows)[number]) => {
    const timing = {
      completedAt: row.completed_at,
      scheduledDate: (row.scheduled_date ?? undefined) as LocalDate | undefined,
      scheduledWindowStart: (row.scheduled_window_start ?? undefined) as LocalDate | undefined,
    };
    return completionWasRecordedBeforeWindow(timing) && completionCycleDate(timing) > today;
  };
  for (const [choreId, history] of historyByChore) {
    const latest = history[0];
    if (!isFutureRecord(latest) || latest.previous_chore_state_json === null) continue;
    const state = await database.getFirstAsync<StateRow>(
      `SELECT chore_id, last_completed_date, last_completed_estimated, initial_pending,
       initial_scheduled_date, unknown_reason FROM chore_state WHERE chore_id = ?`, choreId,
    );
    if (!state || state.initial_pending || state.last_completed_estimated
      || state.last_completed_date !== localDateFromDate(new Date(latest.completed_at))) continue;

    let previousState = JSON.parse(latest.previous_chore_state_json) as ChoreState | null;
    let beforeIndex = 1;
    while (previousState?.lastCompletedDate) {
      const previousDate = previousState.lastCompletedDate;
      const index = history.findIndex((row, rowIndex) => rowIndex >= beforeIndex
        && localDateFromDate(new Date(row.completed_at)) === previousDate);
      const previous = history[index];
      if (!previous || !isFutureRecord(previous) || previous.previous_chore_state_json === null) break;
      previousState = JSON.parse(previous.previous_chore_state_json) as ChoreState | null;
      beforeIndex = index + 1;
    }
    await restoreChoreState(database, choreId, previousState);
  }
}

async function restoreLegacyChoreState(
  database: SQLiteDatabase,
  choreId: EntityId,
  scheduleEntryId: string | null,
  scheduledDate: string | null,
): Promise<void> {
  if (scheduleEntryId?.endsWith(':initial')) {
    await restoreChoreState(database, choreId, {
      choreId,
      lastCompletedEstimated: false,
      initialPending: true,
      initialScheduledDate: (scheduledDate ?? undefined) as LocalDate | undefined,
    });
    return;
  }

  const cycleBaseDate = scheduleEntryId?.match(/:(\d{4}-\d{2}-\d{2})$/)?.[1] as LocalDate | undefined;
  if (cycleBaseDate) {
    const config = await database.getFirstAsync<{ definition_json: string; frequency_mode: FrequencyMode }>(
      `SELECT d.definition_json, s.frequency_mode FROM chore_definitions d
       JOIN household_settings s ON s.household_id = ? WHERE d.id = ?`,
      LOCAL_HOUSEHOLD_ID, choreId,
    );
    if (config) {
      const chore = JSON.parse(config.definition_json) as ChoreDefinition;
      const cycleDays = chore.userIntervalDays
        ?? chore.recommendedCycleDays
        ?? chore.manufacturerRecommendedIntervalDays
        ?? chore.frequencyDaysByMode[config.frequency_mode];
      if (Number.isInteger(cycleDays) && cycleDays > 0) {
        await restoreChoreState(database, choreId, {
          choreId,
          lastCompletedDate: addDays(cycleBaseDate, -cycleDays),
          lastCompletedEstimated: false,
          initialPending: false,
        });
        return;
      }
    }
  }

  await restoreChoreState(database, choreId, {
    choreId,
    lastCompletedEstimated: false,
    initialPending: true,
    initialScheduledDate: (scheduledDate ?? undefined) as LocalDate | undefined,
  });
}

async function recordIncompleteChoreImpl(
  database: SQLiteDatabase,
  entry: ChoreScheduleEntry,
  memberId?: EntityId,
): Promise<boolean> {
  if (!await isActiveChoreEntry(database, entry)) return false;
  let recorded = false;
  const recordedAt = new Date().toISOString();
  await database.withTransactionAsync(async () => {
    const existing = await database.getFirstAsync<{ id: string; outcome: ChoreCompletion['outcome'] }>(
      'SELECT id, outcome FROM chore_completions WHERE schedule_entry_id = ?', entry.id,
    );
    if (existing?.outcome === 'completed') return;
    if (existing) {
      await database.runAsync(
        `UPDATE chore_completions SET outcome = 'incomplete', completed_at = ?,
         completed_by_member_id = ?, source = 'inApp', scheduled_date = ?,
         scheduled_window_start = ?, scheduled_window_end = ? WHERE id = ?`,
        recordedAt, memberId ?? null, entry.suggestedDate, entry.windowStart, entry.windowEnd, existing.id,
      );
    } else {
      await database.runAsync(
        `INSERT INTO chore_completions
         (id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id,
          scheduled_date, scheduled_window_start, scheduled_window_end, outcome)
         VALUES (?, ?, ?, ?, ?, 'inApp', ?, ?, ?, ?, 'incomplete')`,
        createId('completion'), entry.householdId, entry.choreId, recordedAt, memberId ?? null,
        entry.id, entry.suggestedDate, entry.windowStart, entry.windowEnd,
      );
    }
    recorded = true;
    await markPendingGoogleStatus(database, entry.id, 'needsAction');
  });
  return recorded;
}

async function setChoreAssignmentsImpl(
  database: SQLiteDatabase,
  choreId: EntityId,
  memberIds: readonly EntityId[],
): Promise<void> {
  await database.withTransactionAsync(async () => {
    await database.runAsync('DELETE FROM chore_assignments WHERE chore_id = ?', choreId);
    for (const memberId of new Set(memberIds)) {
      await database.runAsync(
        'INSERT OR IGNORE INTO chore_assignments (chore_id, member_id) VALUES (?, ?)', choreId, memberId,
      );
    }
  });
}

async function addHouseholdMemberImpl(database: SQLiteDatabase, displayName: string): Promise<EntityId> {
  const normalized = displayName.trim();
  if (!normalized) throw new Error('メンバー名を入力してください');
  const id = createId('member');
  await database.runAsync(
    'INSERT INTO household_members (id, household_id, display_name) VALUES (?, ?, ?)',
    id, LOCAL_HOUSEHOLD_ID, normalized,
  );
  return id;
}

async function replaceChoreDependenciesImpl(
  database: SQLiteDatabase,
  successorChoreId: EntityId,
  predecessorChoreIds: readonly EntityId[],
): Promise<void> {
  const existing = await database.getAllAsync<DependencyRow>(
    'SELECT id, predecessor_chore_id, successor_chore_id, policy_json FROM chore_dependencies WHERE household_id = ?',
    LOCAL_HOUSEHOLD_ID,
  );
  const dependencies: ChoreDependency[] = existing.map((row) => ({
    id: row.id,
    predecessorChoreId: row.predecessor_chore_id,
    successorChoreId: row.successor_chore_id,
  }));
  const nextIds = [...new Set(predecessorChoreIds)];
  const retained = dependencies.filter((item) => item.successorChoreId !== successorChoreId);
  const proposed = [...retained];
  for (const predecessorId of nextIds) {
    if (wouldCreateDependencyCycle(proposed, predecessorId, successorChoreId)) {
      throw new Error('家事の依存関係が循環するため保存できません');
    }
    proposed.push({
      id: `proposed-${predecessorId}`,
      predecessorChoreId: predecessorId,
      successorChoreId,
    });
  }

  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'DELETE FROM chore_dependencies WHERE household_id = ? AND successor_chore_id = ?',
      LOCAL_HOUSEHOLD_ID, successorChoreId,
    );
    for (const predecessorId of nextIds) {
      await database.runAsync(
        `INSERT INTO chore_dependencies (id, household_id, predecessor_chore_id, successor_chore_id)
         VALUES (?, ?, ?, ?)`,
        createId('dependency'), LOCAL_HOUSEHOLD_ID, predecessorId, successorChoreId,
      );
    }
  });
}

async function saveWeeklyWasteScheduleImpl(
  database: SQLiteDatabase,
  schedule: WasteScheduleInput,
  base?: WasteScheduleInput,
): Promise<void> {
  let normalized = normalizeWasteSchedule(schedule);
  if (base) {
    const row = await database.getFirstAsync<{ label: string; weekdays_json: string; recurrence: WasteRecurrence; anchor_date: LocalDate | null; monthly_day: number | null }>(
      'SELECT label, weekdays_json, recurrence, anchor_date, monthly_day FROM weekly_waste_schedules WHERE id=? AND household_id=?', schedule.id ?? '', LOCAL_HOUSEHOLD_ID);
    if (!row) throw new Error('ゴミ収集日が見つかりません。');
    normalized = mergeWasteScheduleEdits({ id: schedule.id, label: row.label, collectionWeekdays: JSON.parse(row.weekdays_json), recurrence: row.recurrence,
      ...(row.anchor_date ? { anchorDate: row.anchor_date } : {}), ...(row.monthly_day ? { monthlyDay: row.monthly_day } : {}) }, normalized, base);
  }
  const id = schedule.id ?? createId('waste');
  await database.runAsync(
    `INSERT INTO weekly_waste_schedules (id, household_id, label, weekdays_json, recurrence, anchor_date, monthly_day)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, weekdays_json = excluded.weekdays_json,
       recurrence = excluded.recurrence, anchor_date = excluded.anchor_date, monthly_day = excluded.monthly_day`,
    id, LOCAL_HOUSEHOLD_ID, normalized.label, JSON.stringify(normalized.collectionWeekdays), normalized.recurrence,
    normalized.anchorDate ?? null, normalized.monthlyDay ?? null,
  );
}

async function setWasteOccurrenceHiddenImpl(
  database: SQLiteDatabase,
  scheduleId: EntityId,
  occurrenceDate: LocalDate,
  hidden: boolean,
): Promise<void> {
  parseLocalDate(occurrenceDate);
  if (hidden) {
    await database.runAsync(
      'INSERT OR IGNORE INTO hidden_waste_occurrences (schedule_id, occurrence_date) VALUES (?, ?)',
      scheduleId, occurrenceDate,
    );
  } else {
    await database.runAsync(
      'DELETE FROM hidden_waste_occurrences WHERE schedule_id = ? AND occurrence_date = ?',
      scheduleId, occurrenceDate,
    );
  }
}

export interface WasteDeletionReceipt { token: string; label: string }
async function initializeWasteTrash(database: SQLiteDatabase) {
  if (sharedRepositoryAdapter(database)) throw new Error('個人のゴミ収集日は個人の保存先で操作してください。');
  await database.execAsync('CREATE TABLE IF NOT EXISTS deleted_waste_schedules(token TEXT PRIMARY KEY, household_id TEXT NOT NULL, schedule_id TEXT NOT NULL, label TEXT NOT NULL, value_json TEXT NOT NULL, hidden_json TEXT NOT NULL, deleted_at TEXT NOT NULL)');
}
async function deleteWeeklyWasteScheduleImpl(database: SQLiteDatabase, scheduleId: EntityId): Promise<WasteDeletionReceipt | null> {
  await initializeWasteTrash(database); let receipt: WasteDeletionReceipt | null = null;
  await database.withTransactionAsync(async () => {
    const row = await database.getFirstAsync<{ id: string; household_id: string; label: string; weekdays_json: string; recurrence: string; anchor_date: string | null; monthly_day: number | null }>('SELECT * FROM weekly_waste_schedules WHERE id=? AND household_id=?', scheduleId, LOCAL_HOUSEHOLD_ID);
    if (!row) return;
    const hidden = await database.getAllAsync<{ occurrence_date: LocalDate }>('SELECT occurrence_date FROM hidden_waste_occurrences WHERE schedule_id=?', scheduleId);
    const token = createId('waste-delete');
    await database.runAsync('INSERT INTO deleted_waste_schedules VALUES(?,?,?,?,?,?,?)', token, LOCAL_HOUSEHOLD_ID, scheduleId, row.label, JSON.stringify(row), JSON.stringify(hidden.map(item => item.occurrence_date)), new Date().toISOString());
    await database.runAsync('DELETE FROM weekly_waste_schedules WHERE id=? AND household_id=?', scheduleId, LOCAL_HOUSEHOLD_ID);
    receipt = { token, label: row.label };
  }); return receipt;
}
async function restoreDeletedWasteScheduleImpl(database: SQLiteDatabase, token: string): Promise<void> {
  await initializeWasteTrash(database);
  await database.withTransactionAsync(async () => {
    const saved = await database.getFirstAsync<{ schedule_id: string; value_json: string; hidden_json: string }>('SELECT * FROM deleted_waste_schedules WHERE token=? AND household_id=?', token, LOCAL_HOUSEHOLD_ID);
    if (!saved) throw new Error('復元する収集日が見つかりません。');
    if (await database.getFirstAsync('SELECT id FROM weekly_waste_schedules WHERE id=?', saved.schedule_id)) throw new Error('同じ収集日が既にあります。現在の内容を保持しています。');
    const row = JSON.parse(saved.value_json);
    const value = normalizeWasteSchedule({ label: row.label, collectionWeekdays: JSON.parse(row.weekdays_json), recurrence: row.recurrence, ...(row.anchor_date ? { anchorDate: row.anchor_date } : {}), ...(row.monthly_day ? { monthlyDay: row.monthly_day } : {}) });
    if (row.id !== saved.schedule_id || row.household_id !== LOCAL_HOUSEHOLD_ID) throw new Error('復元する保存先が一致しません。');
    await database.runAsync('INSERT INTO weekly_waste_schedules(id,household_id,label,weekdays_json,recurrence,anchor_date,monthly_day) VALUES(?,?,?,?,?,?,?)', saved.schedule_id, LOCAL_HOUSEHOLD_ID, value.label, JSON.stringify(value.collectionWeekdays), value.recurrence, value.anchorDate ?? null, value.monthlyDay ?? null);
    for (const date of JSON.parse(saved.hidden_json)) { parseLocalDate(date); await database.runAsync('INSERT INTO hidden_waste_occurrences(schedule_id,occurrence_date) VALUES(?,?)', saved.schedule_id, date); }
    await database.runAsync('DELETE FROM deleted_waste_schedules WHERE token=? AND household_id=?', token, LOCAL_HOUSEHOLD_ID);
  });
}
async function listDeletedWasteSchedulesImpl(database: SQLiteDatabase): Promise<WasteDeletionReceipt[]> {
  await initializeWasteTrash(database); return database.getAllAsync<WasteDeletionReceipt>('SELECT token,label FROM deleted_waste_schedules WHERE household_id=? ORDER BY deleted_at DESC LIMIT 100', LOCAL_HOUSEHOLD_ID);
}

async function loadGoogleSyncStateImpl(
  database: SQLiteDatabase,
  householdId: EntityId = LOCAL_HOUSEHOLD_ID,
): Promise<GoogleSyncState | null> {
  const row = await database.getFirstAsync<{
    household_id: string;
    enabled: number;
    task_list_id: string | null;
    account_subject: string | null;
    connection_active: number;
    last_attempt_at: string | null;
    last_successful_sync_at: string | null;
    status: string;
    retry_count: number;
    next_retry_at: string | null;
    last_error_code: string | null;
    last_error_at: string | null;
    updated_at: string;
  }>(
    `SELECT household_id, enabled, task_list_id, account_subject, connection_active, last_attempt_at, last_successful_sync_at,
     status, retry_count, next_retry_at, last_error_code, last_error_at, updated_at
     FROM google_sync_state WHERE household_id = ?`,
    householdId,
  );
  if (!row) return null;
  return {
    householdId: row.household_id,
    enabled: Boolean(row.enabled),
    ...(!row.connection_active ? { disconnected: true } : {}),
    ...(row.task_list_id ? { taskListId: row.task_list_id } : {}),
    ...(row.account_subject ? { accountSubject: row.account_subject } : {}),
    ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
    ...(row.last_successful_sync_at ? { lastSuccessfulSyncAt: row.last_successful_sync_at } : {}),
    status: normalizeGoogleSyncStatus(row.status),
    retryCount: row.retry_count,
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_at ? { lastErrorAt: row.last_error_at } : {}),
    updatedAt: row.updated_at,
  };
}

async function saveGoogleSyncStateImpl(database: SQLiteDatabase, state: GoogleSyncState): Promise<void> {
  if (state.enabled && state.disconnected) throw new Error('Googleと再接続してから同期を有効にしてください。');
  if (state.accountSubject !== undefined && (typeof state.accountSubject !== 'string' || !state.accountSubject || state.accountSubject.length > 512)) {
    throw new GoogleAccountMismatchError();
  }
  const result = await database.runAsync(
    `INSERT INTO google_sync_state
     (household_id, enabled, task_list_id, last_attempt_at, last_successful_sync_at, status,
      retry_count, next_retry_at, last_error_code, last_error_at, updated_at, account_subject, connection_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(household_id) DO UPDATE SET enabled = excluded.enabled,
     task_list_id = excluded.task_list_id, last_attempt_at = excluded.last_attempt_at,
     last_successful_sync_at = excluded.last_successful_sync_at, status = excluded.status,
     retry_count = excluded.retry_count, next_retry_at = excluded.next_retry_at,
     last_error_code = excluded.last_error_code, last_error_at = excluded.last_error_at,
     updated_at = excluded.updated_at, connection_active = excluded.connection_active,
     account_subject = COALESCE(google_sync_state.account_subject, excluded.account_subject)
     WHERE excluded.account_subject IS NULL OR google_sync_state.account_subject IS NULL
       OR google_sync_state.account_subject = excluded.account_subject`,
    state.householdId,
    state.enabled ? 1 : 0,
    state.taskListId ?? null,
    state.lastAttemptAt ?? null,
    state.lastSuccessfulSyncAt ?? null,
    state.status,
    state.retryCount,
    state.nextRetryAt ?? null,
    state.lastErrorCode ?? null,
    state.lastErrorAt ?? null,
    state.updatedAt,
    state.accountSubject ?? null,
    state.disconnected ? 0 : 1,
  );
  if (state.accountSubject && result.changes === 0) throw new GoogleAccountMismatchError();
}

async function bindGoogleSyncAccountImpl(database: SQLiteDatabase, subject: string, householdId = LOCAL_HOUSEHOLD_ID): Promise<void> {
  if (typeof subject !== 'string' || !subject || subject.length > 512) throw new GoogleAccountMismatchError();
  const current = await loadGoogleSyncStateImpl(database, householdId);
  await saveGoogleSyncStateImpl(database, { ...(current ?? { householdId, enabled: false, status: 'idle', retryCount: 0,
    updatedAt: new Date().toISOString() }), accountSubject: subject });
}

async function listEntriesForGoogleSyncImpl(
  database: SQLiteDatabase,
  today: LocalDate,
  householdId: EntityId = LOCAL_HOUSEHOLD_ID,
): Promise<GoogleSyncEntry[]> {
  const rows = await database.getAllAsync<{
    entry_json: string;
    definition_json: string;
    completed_at: string | null;
    outcome: string | null;
  }>(
    `SELECT s.entry_json, d.definition_json, c.outcome,
       CASE WHEN c.outcome = 'completed' THEN c.completed_at END AS completed_at
     FROM chore_schedule_entries s
     JOIN chore_definitions d ON d.id = s.chore_id
     LEFT JOIN chore_completions c ON c.schedule_entry_id = s.id
     WHERE s.household_id = ? AND d.enabled = 1`,
    householdId,
  );
  const entries = rows.flatMap((row) => {
    const entry = parseJson<ChoreScheduleEntry | null>(row.entry_json, null);
    const chore = parseJson<ChoreDefinition | null>(row.definition_json, null);
    if (!entry || !chore || entry.status === 'initialPending') return [];
    if (entry.suggestedDate < today && entry.status !== 'overdue' && !row.completed_at) return [];
    return [{ entry, choreName: chore.name, ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.outcome === 'incomplete' ? { locallyIncomplete: true } : {}) }];
  });

  // Completed occurrences can disappear when the planner regenerates its schedule.
  // Keep linked completion records in the sync input so app-side completion reaches
  // Google before obsolete-link cleanup can remove the mapping.
  const linkedCompletions = await database.getAllAsync<{
    schedule_entry_id: string;
    household_id: string;
    chore_id: string;
    chore_name: string;
    completed_at: string;
    outcome: string;
    scheduled_date: string | null;
    scheduled_window_start: string | null;
    scheduled_window_end: string | null;
  }>(
    `SELECT c.schedule_entry_id, c.household_id, c.chore_id, d.name AS chore_name,
       c.completed_at, c.outcome, c.scheduled_date, c.scheduled_window_start, c.scheduled_window_end
     FROM chore_completions c
     JOIN google_task_links l ON l.schedule_entry_id = c.schedule_entry_id
     JOIN chore_definitions d ON d.id = c.chore_id
     WHERE c.household_id = ? AND (c.outcome = 'completed' OR l.pending_status = 'needsAction'
       OR (c.outcome = 'incomplete' AND (l.last_synced_status IS NULL OR l.last_synced_status = 'completed')))
       AND c.schedule_entry_id IS NOT NULL
     GROUP BY c.schedule_entry_id
     ORDER BY MAX(c.completed_at) DESC`,
    householdId,
  );
  const knownEntryIds = new Set(entries.map(({ entry }) => entry.id));
  for (const row of linkedCompletions) {
    if (knownEntryIds.has(row.schedule_entry_id)) continue;
    const scheduledDate = (row.scheduled_date ?? localDateFromDate(new Date(row.completed_at))) as LocalDate;
    const entry: ChoreScheduleEntry = {
      id: row.schedule_entry_id,
      householdId: row.household_id,
      choreId: row.chore_id,
      cycleBaseDate: scheduledDate,
      windowStart: (row.scheduled_window_start ?? scheduledDate) as LocalDate,
      windowEnd: (row.scheduled_window_end ?? scheduledDate) as LocalDate,
      suggestedDate: scheduledDate,
      status: 'scheduled',
      assignedMemberIds: [],
    };
    entries.push({ entry, choreName: row.chore_name,
      ...(row.outcome === 'completed' ? { completedAt: row.completed_at } : { locallyIncomplete: true }) });
  }
  return entries;
}

async function listGoogleTaskLinksImpl(
  database: SQLiteDatabase,
  householdId: EntityId = LOCAL_HOUSEHOLD_ID,
): Promise<GoogleTaskLink[]> {
  const rows = await database.getAllAsync<{
    schedule_entry_id: string;
    household_id: string;
    chore_id: string;
    google_task_list_id: string;
    google_task_id: string;
    last_synced_title: string | null;
    last_synced_due_date: string | null;
    last_synced_status: GoogleTaskStatus | null;
    pending_status: GoogleTaskStatus | null;
    pending_status_revision: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT schedule_entry_id, household_id, chore_id, google_task_list_id, google_task_id,
     last_synced_title, last_synced_due_date, last_synced_status, pending_status, pending_status_revision, created_at, updated_at
     FROM google_task_links WHERE household_id = ?`,
    householdId,
  );
  return rows.map((row) => ({
    scheduleEntryId: row.schedule_entry_id,
    householdId: row.household_id,
    choreId: row.chore_id,
    googleTaskListId: row.google_task_list_id,
    googleTaskId: row.google_task_id,
    ...(row.last_synced_title ? { lastSyncedTitle: row.last_synced_title } : {}),
    ...(row.last_synced_due_date ? { lastSyncedDueDate: row.last_synced_due_date as LocalDate } : {}),
    ...(row.last_synced_status ? { lastSyncedStatus: row.last_synced_status } : {}),
    ...(row.pending_status ? { pendingStatus: row.pending_status } : {}),
    ...(row.pending_status_revision ? { pendingStatusRevision: row.pending_status_revision } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function upsertGoogleTaskLinkImpl(database: SQLiteDatabase, link: GoogleTaskLink): Promise<void> {
  await database.runAsync(
    `INSERT INTO google_task_links
     (schedule_entry_id, household_id, chore_id, google_task_list_id, google_task_id,
      last_synced_title, last_synced_due_date, created_at, updated_at, last_synced_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(schedule_entry_id) DO UPDATE SET household_id = excluded.household_id,
     chore_id = excluded.chore_id, google_task_list_id = excluded.google_task_list_id,
     google_task_id = excluded.google_task_id, last_synced_title = excluded.last_synced_title,
     last_synced_due_date = excluded.last_synced_due_date, updated_at = excluded.updated_at,
     last_synced_status = CASE WHEN google_task_links.google_task_id = excluded.google_task_id
       AND google_task_links.google_task_list_id = excluded.google_task_list_id
       THEN google_task_links.last_synced_status ELSE NULL END`,
    link.scheduleEntryId,
    link.householdId,
    link.choreId,
    link.googleTaskListId,
    link.googleTaskId,
    link.lastSyncedTitle ?? null,
    link.lastSyncedDueDate ?? null,
    link.createdAt,
    link.updatedAt,
    link.lastSyncedStatus ?? null,
  );
}

async function acknowledgeGoogleTaskStatusImpl(database: SQLiteDatabase, link: GoogleTaskLink, status: GoogleTaskStatus): Promise<void> {
  await database.runAsync(
    `UPDATE google_task_links SET last_synced_status = ?,
     pending_status = CASE WHEN COALESCE(pending_status_revision, '') = ? THEN NULL ELSE pending_status END,
     pending_status_revision = CASE WHEN COALESCE(pending_status_revision, '') = ? THEN NULL ELSE pending_status_revision END
     WHERE schedule_entry_id = ? AND google_task_list_id = ? AND google_task_id = ?`,
    status, link.pendingStatusRevision ?? '', link.pendingStatusRevision ?? '',
    link.scheduleEntryId, link.googleTaskListId, link.googleTaskId,
  );
}

async function deleteGoogleTaskLinkImpl(database: SQLiteDatabase, scheduleEntryId: EntityId): Promise<void> {
  await database.runAsync('DELETE FROM google_task_links WHERE schedule_entry_id = ?', scheduleEntryId);
}

function normalizeGoogleSyncStatus(status: string): GoogleSyncStatus {
  return status === 'syncing' || status === 'retryPending' || status === 'authRequired' || status === 'error'
    ? status
    : 'idle';
}

export function nextInitialDateChoice(today: LocalDate, choice: 'today' | 'week' | 'month' | 'unknown'):
  { date?: LocalDate; estimated?: boolean; unknownReason?: 'unknown' | 'skipped' } {
  if (choice === 'today') return { date: today };
  if (choice === 'week') return { date: addDays(today, -7), estimated: true };
  if (choice === 'month') return { date: addDays(today, -30), estimated: true };
  return { unknownReason: 'unknown' };
}

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function loadCalendarAvailabilityStateImpl(
  database: SQLiteDatabase, householdId = LOCAL_HOUSEHOLD_ID,
): Promise<CalendarAvailabilityState | null> {
  const row = await database.getFirstAsync<{
    household_id: string; enabled: number; status: CalendarAvailabilityState['status']; retry_count: number;
    last_attempt_at: string | null; last_successful_sync_at: string | null; next_retry_at: string | null;
    last_error_code: string | null; updated_at: string;
  }>('SELECT * FROM calendar_availability_state WHERE household_id = ?', householdId);
  return row ? { householdId: row.household_id, enabled: Boolean(row.enabled), status: row.status,
    retryCount: row.retry_count, lastAttemptAt: row.last_attempt_at ?? undefined,
    lastSuccessfulSyncAt: row.last_successful_sync_at ?? undefined, nextRetryAt: row.next_retry_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined, updatedAt: row.updated_at } : null;
}

async function saveCalendarAvailabilityStateImpl(database: SQLiteDatabase, state: CalendarAvailabilityState): Promise<void> {
  await database.runAsync(
    `INSERT INTO calendar_availability_state
     (household_id, enabled, status, retry_count, last_attempt_at, last_successful_sync_at, next_retry_at, last_error_code, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(household_id) DO UPDATE SET enabled=excluded.enabled, status=excluded.status,
     retry_count=excluded.retry_count, last_attempt_at=excluded.last_attempt_at,
     last_successful_sync_at=excluded.last_successful_sync_at, next_retry_at=excluded.next_retry_at,
     last_error_code=excluded.last_error_code, updated_at=excluded.updated_at`,
    state.householdId, state.enabled ? 1 : 0, state.status, state.retryCount, state.lastAttemptAt ?? null,
    state.lastSuccessfulSyncAt ?? null, state.nextRetryAt ?? null, state.lastErrorCode ?? null, state.updatedAt,
  );
}

async function setCalendarAvailabilityEnabledImpl(database: SQLiteDatabase, enabled: boolean, now = new Date()): Promise<void> {
  const previous = await loadCalendarAvailabilityStateImpl(database);
  await database.withTransactionAsync(async () => {
    await saveCalendarAvailabilityStateImpl(database, {
      ...previous, householdId: LOCAL_HOUSEHOLD_ID, enabled, status: 'idle', retryCount: 0,
      nextRetryAt: undefined, lastErrorCode: undefined, updatedAt: now.toISOString(),
    });
    if (!enabled) await database.runAsync('DELETE FROM calendar_availability_days WHERE household_id = ?', LOCAL_HOUSEHOLD_ID);
  });
}

async function listCalendarAvailabilityDaysImpl(database: SQLiteDatabase, householdId = LOCAL_HOUSEHOLD_ID): Promise<CalendarAvailabilityDay[]> {
  const rows = await database.getAllAsync<{ local_date: LocalDate; busy_minutes: number; time_zone: string; fetched_at: string }>(
    'SELECT local_date, busy_minutes, time_zone, fetched_at FROM calendar_availability_days WHERE household_id = ? ORDER BY local_date', householdId,
  );
  return rows.map((row) => ({ localDate: row.local_date, busyMinutes: row.busy_minutes, timeZone: row.time_zone, fetchedAt: row.fetched_at }));
}

async function getFreshCalendarAvailabilityDaysImpl(database: SQLiteDatabase, now = new Date(), timeZone = getDeviceTimeZone()) {
  const state = await loadCalendarAvailabilityStateImpl(database);
  if (!state?.enabled) return undefined;
  return freshCalendarAvailability(state, await listCalendarAvailabilityDaysImpl(database), now, timeZone);
}

async function readCalendarPlanningSignaturesImpl(database: SQLiteDatabase, now = new Date(), timeZone = getDeviceTimeZone()) {
  const row = await database.getFirstAsync<{ planner_calendar_signature: string | null }>(
    'SELECT planner_calendar_signature FROM household_settings WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
  );
  const available = await getFreshCalendarAvailabilityDaysImpl(database, now, timeZone);
  return { current: calendarAvailabilitySignature(available), applied: row?.planner_calendar_signature ?? null };
}

async function hasFreshCalendarCoverageImpl(database: SQLiteDatabase, range: CalendarQueryRange, now = new Date()): Promise<boolean> {
  const available = await getFreshCalendarAvailabilityDaysImpl(database, now, range.timeZone);
  for (let date = range.from; date <= range.through; date = addDays(date, 1)) {
    if (!available?.[date]) return false;
  }
  return true;
}

async function replaceCalendarAvailabilityRows(
  database: SQLiteDatabase, days: readonly CalendarAvailabilityDay[], householdId: string,
): Promise<void> {
  if (!days.length) throw new Error('Calendar coverage must include every queried day');
  const first = days[0];
  for (const [index, day] of days.entries()) {
    if (day.localDate !== addDays(first.localDate, index) || day.timeZone !== first.timeZone || day.fetchedAt !== first.fetchedAt
      || !Number.isInteger(day.busyMinutes) || day.busyMinutes < 0 || !parseGoogleCompletedAt(day.fetchedAt)) {
      throw new Error('Invalid calendar aggregate coverage');
    }
  }
  await database.runAsync('DELETE FROM calendar_availability_days WHERE household_id = ?', householdId);
  for (const day of days) {
    await database.runAsync(
      'INSERT INTO calendar_availability_days (household_id, local_date, busy_minutes, time_zone, fetched_at) VALUES (?, ?, ?, ?, ?)',
      householdId, day.localDate, day.busyMinutes, day.timeZone, day.fetchedAt,
    );
  }
}

async function replaceCalendarAvailabilityDaysImpl(
  database: SQLiteDatabase, days: readonly CalendarAvailabilityDay[], householdId = LOCAL_HOUSEHOLD_ID,
): Promise<void> {
  await database.withTransactionAsync(() => replaceCalendarAvailabilityRows(database, days, householdId));
}

async function commitCalendarAvailabilitySuccessImpl(
  database: SQLiteDatabase, days: readonly CalendarAvailabilityDay[], state: CalendarAvailabilityState,
): Promise<void> {
  await database.withTransactionAsync(async () => {
    await replaceCalendarAvailabilityRows(database, days, state.householdId);
    await saveCalendarAvailabilityStateImpl(database, state);
  });
}

export const loadCalendarAvailabilityState = serializeDatabaseOperation(loadCalendarAvailabilityStateImpl);
export const saveCalendarAvailabilityState = serializeDatabaseOperation(saveCalendarAvailabilityStateImpl);
export const setCalendarAvailabilityEnabled = serializePlannerOperation(setCalendarAvailabilityEnabledImpl, 'setCalendarAvailabilityEnabled');
export const listCalendarAvailabilityDays = serializeDatabaseOperation(listCalendarAvailabilityDaysImpl);
export const getFreshCalendarAvailabilityDays = serializeDatabaseOperation(getFreshCalendarAvailabilityDaysImpl);
export const readCalendarPlanningSignatures = serializeDatabaseOperation(readCalendarPlanningSignaturesImpl);
export const hasFreshCalendarCoverage = serializeDatabaseOperation(hasFreshCalendarCoverageImpl);
export const replaceCalendarAvailabilityDays = serializePlannerOperation(replaceCalendarAvailabilityDaysImpl);
export const commitCalendarAvailabilitySuccess = serializePlannerOperation(commitCalendarAvailabilitySuccessImpl);

// Serialize reads and writes across screens and widget callbacks on this connection.
export const initializeLocalDatabase = serializePlannerOperation(initializeLocalDatabaseImpl);
export const bindGoogleSyncAccount = serializeDatabaseOperation(bindGoogleSyncAccountImpl);
export const ensureLocalHousehold = serializePlannerOperation(ensureLocalHouseholdImpl);
export const loadApplianceCareReviewContext = serializeDatabaseOperation(loadApplianceCareReviewContextImpl);
export const loadPlannerSnapshot = serializePlannerOperation(loadPlannerSnapshotImpl);
export const completeFirstSetup = serializePlannerOperation(completeFirstSetupImpl, 'completeFirstSetup');
export const updatePlannerSettings = serializePlannerOperation(updatePlannerSettingsImpl, 'updatePlannerSettings');
export const updateCalendarCountDisplay = serializePlannerOperation(updateCalendarCountDisplayImpl);
export const setNotificationsEnabled = serializePlannerOperation(setNotificationsEnabledImpl);
export const saveWeatherLocation = serializePlannerOperation(saveWeatherLocationImpl);
export const clearWeatherLocation = serializePlannerOperation(clearWeatherLocationImpl);
export const updateChoreDefinition = serializePlannerOperation(updateChoreDefinitionImpl, 'updateChoreDefinition');
export const updateChoreSettings = serializeDatabaseOperation(updateChoreSettingsImpl, 'updateChoreSettings');
export const saveReviewedApplianceCare = serializePlannerOperation(saveReviewedApplianceCareImpl, 'saveReviewedApplianceCare');
export const setChoreEnabled = serializePlannerOperation(setChoreEnabledImpl, 'setChoreEnabled');
export const setChoresEnabled = serializePlannerOperation(setChoresEnabledImpl, 'setChoresEnabled');
export const completeChore = serializePlannerOperation(completeChoreImpl, 'completeChore');
export const completeChoreWithReceipt = serializePlannerOperation(completeChoreWithReceiptImpl, 'completeChoreWithReceipt');
export const undoCompletionReceipt = serializePlannerOperation(undoCompletionReceiptImpl, 'undoCompletionReceipt');
export const mirrorSharedChoreCompletions = serializeDatabaseOperation(mirrorSharedChoreCompletionsImpl);
export const readPersonalPlannerOverlaySnapshot = serializeDatabaseOperation(readPersonalPlannerOverlaySnapshotImpl);
export const readPersonalChoreCopySource = serializeDatabaseOperation(readPersonalChoreCopySourceImpl);
export const setPersonalDateTaskCompleted = serializePlannerOperation(setPersonalDateTaskCompletedImpl);
export const importGoogleTaskCompletions = serializePlannerOperation(importGoogleTaskCompletionsImpl, 'importGoogleTaskCompletions');
export const importGoogleTaskChanges = serializePlannerOperation(importGoogleTaskChangesImpl, 'importGoogleTaskChanges');
export const undoCompletedChore = serializePlannerOperation(undoCompletedChoreImpl, 'undoCompletedChore');
export const recordIncompleteChore = serializePlannerOperation(recordIncompleteChoreImpl, 'recordIncompleteChore');
export const setChoreAssignments = serializePlannerOperation(setChoreAssignmentsImpl, 'setChoreAssignments');
export const addHouseholdMember = serializePlannerOperation(addHouseholdMemberImpl, 'addHouseholdMember');
export const replaceChoreDependencies = serializePlannerOperation(replaceChoreDependenciesImpl, 'replaceChoreDependencies');
export const saveWeeklyWasteSchedule = serializePlannerOperation(saveWeeklyWasteScheduleImpl, 'saveWeeklyWasteSchedule');
export const setWasteOccurrenceHidden = serializePlannerOperation(setWasteOccurrenceHiddenImpl, 'setWasteOccurrenceHidden');
export const deleteWeeklyWasteSchedule = serializePlannerOperation(deleteWeeklyWasteScheduleImpl, 'deleteWeeklyWasteSchedule');
export const restoreDeletedWasteSchedule = serializePlannerOperation(restoreDeletedWasteScheduleImpl);
export const listDeletedWasteSchedules = serializeDatabaseOperation(listDeletedWasteSchedulesImpl);
export const loadGoogleSyncState = serializeDatabaseOperation(loadGoogleSyncStateImpl);
export const hasPendingGoogleTaskChanges = serializeDatabaseOperation(hasPendingGoogleTaskChangesImpl);
export const saveGoogleSyncState = serializeDatabaseOperation(saveGoogleSyncStateImpl);
export const listEntriesForGoogleSync = serializeDatabaseOperation(listEntriesForGoogleSyncImpl);
export const listGoogleTaskLinks = serializeDatabaseOperation(listGoogleTaskLinksImpl);
export const upsertGoogleTaskLink = serializeDatabaseOperation(upsertGoogleTaskLinkImpl);
export const acknowledgeGoogleTaskStatus = serializeDatabaseOperation(acknowledgeGoogleTaskStatusImpl);
export const deleteGoogleTaskLink = serializeDatabaseOperation(deleteGoogleTaskLinkImpl);
