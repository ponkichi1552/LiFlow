import { writeScheduleCacheDiffInside, saveScopedScheduleCacheInside } from './schedule-cache-diff.ts';
import { normalizeStoredWeatherLocation, resolveWeatherMunicipality } from '../../features/weather/municipality-search.ts';
import { MetServerForecastProvider, weatherCacheFreshness } from '../../features/weather/met-server-provider.ts';
import { readRegionalWeatherInside, saveRegionalWeatherInside } from './regional-weather.ts';
import { personalChoreUsesWeather } from '../../features/weather/chore-weather.ts';
import type { SQLiteDatabase } from 'expo-sqlite';
import { createGoogleTaskCreateJournal, reserveGoogleTaskCreateInside, rejectGoogleTaskCreateInside, linkGoogleTaskCreateInside, deleteGoogleTaskCreateInside } from './google-task-create-intents.ts';
import type { GoogleTaskCreateIdentity, GoogleTaskCreateIntent } from '../../features/google-sync/task-create-intent';
import { createGoogleTaskReadCache } from './google-task-read-cache.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { actionCycleDate, previousCompletionState, appendCompletionActionInside, appendCompletionUndoInside, readCompletionJournalInside, seedCompletionJournalInside } from './completion-journal.ts';
import { personalChoreHistoryCutoffInstant } from '../../domain/chores/history-retention.ts';

import { compareBuiltInChoreOrder } from '@/domain/chores/catalog';
import { choreScheduleDefaults, resetChoreSchedule } from '@/domain/chores/schedule-defaults';
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
import { householdSettingsFromRow } from './personal-settings-view.ts';
import type { HouseholdSettingsRow } from './personal-settings-view';
import { completionCycleDate, completionWasRecordedBeforeWindow } from '@/domain/scheduling/completion-matching';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import type { DateTask } from '@/domain/scheduling/date-tasks';
import { dateTaskRevision, dateTaskOccurrenceReference, sameDateTaskOccurrence } from '@/domain/scheduling/date-task-reference';
import type { PersonalDateTaskCommand } from '@/domain/scheduling/date-task-reference';
import type { ScheduleGenerationInput } from '@/domain/scheduling/contracts';
import { generateHouseworkScheduleResult, wouldCreateDependencyCycle } from '@/domain/scheduling/engine';
import { addDays, localDateFromDate, localDateFromISODateTime, parseLocalDate } from '@/domain/scheduling/local-date';
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
import type { UploadedManualInput } from '@/features/appliance-care/api-contracts';
import { storeApplianceManualInside } from './appliance-manual-storage';
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
import { readPlanningInputRevision } from './planning-input-revision';
import { commonChoreLinks, sharedMirrorEntryId, parseSharedMirrorEntryId } from '../../features/planner/common-chore-links.ts';
import type { CommonCompletionSource } from '../../features/planner/common-chore-links';
import { validateWidgetCompletionOperation } from '../../features/widgets/completion-operation.ts';
import type { WidgetCompletionOperation } from '../../features/widgets/completion-operation.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { readCalendarEventRows } from './calendar-event-rows';
import { combineCalendarAvailability, localCalendarAvailability } from '../../features/calendar/local-availability';
import { notifyGooglePlannerChanges } from '../../features/google-sync/planner-change-events';
import { choreOccurrenceName } from '../../domain/chores/occurrence-name.ts';
import { planPersonalCatalogToggles, comparePersonalChoreOrder, PERSONAL_CHORE_CATALOG_VERSION, usesPersonalAdaptivePlanner } from '../../domain/chores/personal-catalog.ts';
import { installPersonalCatalogInside } from './personal-catalog.ts';
import { createCustomPersonalChore } from '../../domain/chores/custom-chore.ts';
import type { CustomChoreOptions } from '../../domain/chores/custom-chore';
import { personalCadenceView } from '../../features/planner/adaptive-cadence.ts';
import type { PersonalCadenceView } from '../../features/planner/adaptive-cadence';
import { readPersonalAdaptiveContextInside } from './repository-adaptive.ts';
import { PERSONAL_HOUSEHOLD_ID as LOCAL_HOUSEHOLD_ID } from '../../domain/chores/cycle-policy.ts';
import { adaptiveOwnerClock, readAdaptiveOwnerInputs, withAdaptiveOwnerInputScope, withAdaptiveOwnerTransaction, adaptiveOwnerReaderIdentity, AdaptiveOwnerInputsChangedError } from './adaptive-owner-inputs.ts';
import { snapshotPersonalPlacementPreferences } from '../../features/planner/personal-placement-preferences.ts';
import type { PersonalPlacementPreferences } from '../../features/planner/personal-placement-preferences';
import type { AdaptiveOwnerInputs, AdaptiveOwnerReader } from './adaptive-owner-inputs';
import type { CapturedSharedPlanning } from '../../features/planner/shared-adaptive-load';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';
import { synchronizePersonalAdaptiveInside, applyPersonalAdaptiveInside, personalAdaptiveEntries } from './personal-adaptive-planner.ts';
import { readAdaptivePersonalInside } from './adaptive-personal-chores.ts';
import { synchronizePersonalSeasonalInside, readPersonalSeasonalInside, applyPersonalSeasonalInside, personalSeasonalEntries } from './personal-seasonal-chores.ts';

export { PERSONAL_HOUSEHOLD_ID as LOCAL_HOUSEHOLD_ID } from '../../domain/chores/cycle-policy.ts';
export const LOCAL_MEMBER_ID = 'local-member';

export function plannerGenerationRange(today: LocalDate) {
  return { from: today, through: addDays(today, 180) };
}

const initializedHouseholds = new WeakSet<SQLiteDatabase>();
const operationTails = new WeakMap<SQLiteDatabase, Promise<unknown>>();
const plannerVersions = new WeakMap<SQLiteDatabase, number>();
const snapshotVersions = new WeakMap<PlannerSnapshot, number>();
const snapshotDataVersions = new WeakMap<PlannerSnapshot, number>();
class PlannerInputsChangedError extends Error {
  constructor() { super('別の処理で家事が更新されました。表示を読み直してください。'); }
}
async function plannerDataVersion(database: SQLiteDatabase): Promise<number> {
  const row = await database.getFirstAsync<{ data_version: number }>('PRAGMA data_version');
  if (!Number.isSafeInteger(row?.data_version) || row!.data_version < 1) throw new Error('保存データの更新状態を確認できません。');
  return row!.data_version;
}
async function assertPlannerDataVersion(database: SQLiteDatabase, expected: number) {
  if (await plannerDataVersion(database) !== expected) throw new PlannerInputsChangedError();
}
const isPlannerReadRace = (error: unknown) => error instanceof PlannerInputsChangedError || error instanceof AdaptiveOwnerInputsChangedError
  || error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/iu.test(error.message);
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
const regionalWeatherProvider = new MetServerForecastProvider();
const cachedPlannerSnapshots = new WeakMap<SQLiteDatabase, {
  snapshot: PlannerSnapshot; today: LocalDate; timeZone: string; savedAt: number; expiresAt: number; owner?: AdaptiveOwnerInputs | null; ownerReader?: AdaptiveOwnerReader;
}>();

/** Optimistic display cache. Derived writes separately verify SQLite's connection-local data version. */
export function readCachedPlannerSnapshot(database: SQLiteDatabase, now = new Date()): PlannerSnapshot | null {
  if (sharedRepositoryAdapter(database)) return null;
  const cached = cachedPlannerSnapshots.get(database);
  if (cached?.ownerReader !== adaptiveOwnerReaderIdentity(database)) return null;
  try { cached?.owner?.assertCurrent(); } catch { return null; }
  if (!cached || cached.today !== (cached.owner?.preferences ? sharedLocalDate(now, cached.timeZone) : localDateFromDate(now))
    || !cached.owner?.preferences && cached.timeZone !== getDeviceTimeZone()
    || now.getTime() < cached.savedAt || now.getTime() > cached.expiresAt
    || snapshotVersions.get(cached.snapshot) !== (plannerVersions.get(database) ?? 0)) return null;
  return cached.snapshot;
}
/** Refresh only appliance metadata; saved schedules, weather assessment and periods stay reusable. */
export function refreshCachedApplianceLibrary(database: SQLiteDatabase): Promise<void> {
  return withPlannerDatabaseOperation(database, async () => {
    if (!readCachedPlannerSnapshot(database)) return;
    const rows = await database.getAllAsync<ApplianceRow>('SELECT * FROM appliances WHERE household_id=? ORDER BY display_name', LOCAL_HOUSEHOLD_ID);
    const cached = cachedPlannerSnapshots.get(database); if (!cached || !readCachedPlannerSnapshot(database)) return;
    const appliances = rows.map(applianceFromRow);
    if (JSON.stringify(appliances) === JSON.stringify(cached.snapshot.appliances)) return;
    const snapshot = { ...cached.snapshot, appliances };
    snapshotVersions.set(snapshot, snapshotVersions.get(cached.snapshot) ?? 0);
    const dataVersion = snapshotDataVersions.get(cached.snapshot); if (dataVersion !== undefined) snapshotDataVersions.set(snapshot, dataVersion);
    const weather = weatherAssessments.get(cached.snapshot);
    if (weather) {
      const result = weather.result === cached.snapshot ? snapshot : { ...weather.result, appliances };
      snapshotVersions.set(result, snapshotVersions.get(weather.result) ?? 0);
      const resultDataVersion = snapshotDataVersions.get(weather.result); if (resultDataVersion !== undefined) snapshotDataVersions.set(result, resultDataVersion);
      const refreshed = { ...weather, result }; weatherAssessments.set(snapshot, refreshed); weatherAssessments.set(result, refreshed);
    }
    cachedPlannerSnapshots.set(database, { ...cached, snapshot });
  });
}
/** Local event edits invalidate recommendations without uploading their private contents. */
export function invalidateLocalCalendarPlan(database: SQLiteDatabase) {
  plannerVersions.set(database, (plannerVersions.get(database) ?? 0) + 1); cachedPlannerSnapshots.delete(database);
  notifyGooglePlannerChanges();
}

function runDatabaseOperation<T>(database: SQLiteDatabase, operation: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(database) ?? Promise.resolve();
  const run = () => withAdaptiveOwnerInputScope(database, operation);
  const pending = previous.then(run, run);
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

/** Retrying a captured owner read must start a new operation scope. Never replay a mutation here. */
function retryOwnerRead<Args extends unknown[], Result>(read: (database: SQLiteDatabase, ...args: Args) => Promise<Result>) {
  return async (database: SQLiteDatabase, ...args: Args): Promise<Result> => {
    for (let attempt = 0; ; attempt++) {
      try { return await read(database, ...args); }
      catch (error) { if (attempt >= 2 || !(error instanceof AdaptiveOwnerInputsChangedError)) throw error; }
    }
  };
}

export function withPlannerDatabaseOperation<T>(database: SQLiteDatabase, work: () => Promise<T>): Promise<T> {
  return runDatabaseOperation(database, work);
}
export async function drainPlannerDatabaseOperations(database: SQLiteDatabase): Promise<void> { await operationTails.get(database); }

export interface PlannerSnapshot {
  /** Shared clock, or an explicitly selected private owner clock. Otherwise use the device clock. */
  today?: LocalDate;
  timeZone?: string;
  sharing?: { groupId: string; activeMemberIds: string[]; issues: { entityType: string; entityId: string; fields: string[]; kind: string }[] };
  household: Household;
  settings: HouseholdPlannerSettings;
  chores: ChoreDefinition[];
  personalCadences?: Record<string, PersonalCadenceView>;
  widgetCompletionGenerations?: Record<string, number>;
  planningInputRevision?: number;
  personalSharedPlanning?: CapturedSharedPlanning;
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
  frequencyMode?: FrequencyMode;
}

interface HouseholdRow {
  id: string;
  name: string;
  created_at: string;
}

type SettingsRow = HouseholdSettingsRow;

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
  completed_local_date?: string | null;
  completed_time_zone?: string | null;
  adaptive_operation_id?: string | null;
  seasonal_work?: ChoreCompletion['seasonalWork'] | null;
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
    ...(row.completed_local_date ? { completedLocalDate: row.completed_local_date as LocalDate } : {}),
    ...(row.completed_time_zone ? { completedTimeZone: row.completed_time_zone } : {}),
    ...(row.adaptive_operation_id ? { adaptiveOperationId: row.adaptive_operation_id } : {}),
    ...(row.seasonal_work ? { seasonalWork: row.seasonal_work } : {}),
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
  const existing = await database.getFirstAsync<{ built_in_chore_catalog_version: number }>(
    `SELECT s.built_in_chore_catalog_version FROM household_settings s
     JOIN households h ON h.id=s.household_id
     JOIN household_members m ON m.household_id=h.id AND m.id=?
     WHERE s.household_id=?`, LOCAL_MEMBER_ID, LOCAL_HOUSEHOLD_ID,
  );
  if (existing && existing.built_in_chore_catalog_version >= PERSONAL_CHORE_CATALOG_VERSION) {
    initializedHouseholds.add(database); return;
  }
  const now = new Date().toISOString();
  await withAdaptiveOwnerTransaction(database, async () => {
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

    await installPersonalCatalogInside(database, LOCAL_HOUSEHOLD_ID, LOCAL_MEMBER_ID);
    // Catalogue6 removes retired built-ins, but custom/appliance history survives.
    // Preserve the one-time repair required by older private completion records.
    if (existing && existing.built_in_chore_catalog_version < 2) await repairRetainedFutureCompletionStates(database);
  });
  initializedHouseholds.add(database);
}

async function repairRetainedFutureCompletionStates(database: SQLiteDatabase): Promise<void> {
  const today = localDateFromDate(new Date());
  const rows = await database.getAllAsync<{
    chore_id: string; completed_at: string; scheduled_date: string | null;
    scheduled_window_start: string | null; previous_chore_state_json: string | null;
  }>(`SELECT chore_id, completed_at, scheduled_date, scheduled_window_start, previous_chore_state_json
    FROM chore_completions WHERE household_id=? AND outcome='completed'
      AND adaptive_operation_id IS NULL AND seasonal_work IS NULL ORDER BY completed_at DESC, rowid DESC`, LOCAL_HOUSEHOLD_ID);
  const byChore = new Map<string, typeof rows>();
  for (const row of rows) { const history = byChore.get(row.chore_id) ?? []; history.push(row); byChore.set(row.chore_id, history); }
  const future = (row: (typeof rows)[number]) => {
    const timing = { completedAt: row.completed_at, scheduledDate: (row.scheduled_date ?? undefined) as LocalDate | undefined,
      scheduledWindowStart: (row.scheduled_window_start ?? undefined) as LocalDate | undefined };
    return completionWasRecordedBeforeWindow(timing) && completionCycleDate(timing) > today;
  };
  for (const [choreId, history] of byChore) {
    const latest = history[0]; if (!future(latest) || latest.previous_chore_state_json === null) continue;
    const state = await database.getFirstAsync<StateRow>(`SELECT chore_id, last_completed_date, last_completed_estimated,
      initial_pending, initial_scheduled_date, unknown_reason FROM chore_state WHERE chore_id=?`, choreId);
    if (!state || state.initial_pending || state.last_completed_estimated
      || state.last_completed_date !== localDateFromDate(new Date(latest.completed_at))) continue;
    let previous = JSON.parse(latest.previous_chore_state_json) as ChoreState | null; let before = 1;
    while (previous?.lastCompletedDate) {
      const date = previous.lastCompletedDate;
      const index = history.findIndex((row, position) => position >= before && localDateFromDate(new Date(row.completed_at)) === date);
      const record = history[index];
      if (!record || !future(record) || record.previous_chore_state_json === null) break;
      previous = JSON.parse(record.previous_chore_state_json) as ChoreState | null; before = index + 1;
    }
    await restoreChoreState(database, choreId, previous);
  }
}

function applianceFromRow(row: ApplianceRow): Appliance { return {
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
  }; }

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
  const settings = await database.getFirstAsync<{ frequency_mode: FrequencyMode }>('SELECT frequency_mode FROM household_settings WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
  const definitionRows = await database.getAllAsync<DefinitionRow>(
    'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
  );
  return {
    frequencyMode: settings?.frequency_mode ?? 'balanced',
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
  if (!sharedRepositoryAdapter(database)) ({ today, timeZone } = await adaptiveOwnerClock(database, calendarNow, { today, timeZone }));
  for (let attempt = 0; ; attempt++) {
    try { return await loadPlannerSnapshotOnce(database, today, calendarNow, timeZone); }
    catch (error) { if (attempt >= 2 || error instanceof AdaptiveOwnerInputsChangedError || !isPlannerReadRace(error)) throw error; }
  }
}
async function loadPlannerSnapshotOnce(database: SQLiteDatabase, today: LocalDate, calendarNow: Date, timeZone: string): Promise<PlannerSnapshot> {
  const shared = sharedRepositoryAdapter(database);
  if (shared) return shared.readSnapshot(calendarNow);
  await ensureLocalHouseholdImpl(database);
  const dataVersion = await plannerDataVersion(database);
  // The adopted adaptive-scheduling specification retains personal source history
  // for learning and exact undo. Presentation may use a shorter date range.
  const householdRow = await database.getFirstAsync<HouseholdRow>(
    'SELECT id, name, created_at FROM households WHERE id = ?', LOCAL_HOUSEHOLD_ID,
  );
  const settingsRow = await database.getFirstAsync<SettingsRow>(
    `SELECT frequency_mode, rest_days_json, heavy_daily_limit, normal_daily_limit,
            notification_hour, notification_minute, notifications_enabled, setup_completed, weather_municipality_id, weather_region, weather_region_name,
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
      `SELECT id, household_id, chore_id, completed_at, completed_local_date, completed_time_zone, adaptive_operation_id, seasonal_work, completed_by_member_id, source, schedule_entry_id,
              scheduled_date, scheduled_window_start, scheduled_window_end, outcome
       FROM chore_completions WHERE household_id = ? AND
         (julianday(completed_at) >= julianday(?) OR scheduled_date >= ? OR scheduled_window_start >= ?) ORDER BY julianday(completed_at) DESC`,
      LOCAL_HOUSEHOLD_ID, personalChoreHistoryCutoffInstant(today, timeZone), today, today,
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
  const settings = householdSettingsFromRow(householdRow.id, settingsRow);
  const chores = definitionRows.map((row) => ({
    ...(JSON.parse(row.definition_json) as ChoreDefinition),
    enabled: Boolean(row.enabled),
  })).sort((a, b) => comparePersonalChoreOrder(a, b) || compareBuiltInChoreOrder(a, b));
  const adaptiveChoreIds = new Set(chores.filter(usesPersonalAdaptivePlanner).map(chore => chore.id));
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
  const appliances = applianceRows.map(applianceFromRow);

  let scheduleEntries: ChoreScheduleEntry[] = [];
  const personalCadences: Record<string, PersonalCadenceView> = {};
  const weatherOutcome: WeatherScheduleOutcome = settings.weatherLocation ? 'current' : 'disabled';
  const weatherAdjustmentCount = 0;
  // Availability is optional: corrupt/unavailable cache never prevents normal planning or completion.
  const { google: googleAvailability, combined: externalAvailabilityByDate } = await plannerCalendarAvailability(database, today, calendarNow, timeZone);
  if (settings.setupCompleted) {
    // Repair records made by the old enable path, which left an unknown first date non-pending.
    const statesById = new Map(states.map((state) => [state.choreId, state]));
    const repairedStates: ChoreState[] = [];
    for (const chore of chores.filter((item) => item.enabled && !item.archived && !usesPersonalAdaptivePlanner(item))) {
      const state = statesById.get(chore.id);
      const previousInitial = previousScheduleEntries.find((entry) => entry.id === `${chore.id}:initial` && entry.choreId === chore.id);
      if (state?.lastCompletedDate || (state?.initialPending && (state.initialScheduledDate || !previousInitial))
        || completions.some((item) => item.choreId === chore.id && item.outcome === 'completed' && completionCycleDate(item) <= today)) continue;
      const repaired: ChoreState = { choreId: chore.id, lastCompletedDate: undefined, initialScheduledDate: state?.initialScheduledDate ?? previousInitial?.suggestedDate,
        initialPending: true, lastCompletedEstimated: false, unknownReason: state?.unknownReason ?? 'unknown' };
      repairedStates.push(repaired);
      statesById.set(chore.id, repaired);
    }
    states = [...statesById.values()];
    const input: ScheduleGenerationInput = {
      householdId: household.id,
      ...plannerGenerationRange(today),
      today,
      chores: chores.filter(chore => !adaptiveChoreIds.has(chore.id)),
      states: states.filter(state => !adaptiveChoreIds.has(state.choreId)),
      assignments,
      dependencies: dependencies.filter(link => !adaptiveChoreIds.has(link.predecessorChoreId) && !adaptiveChoreIds.has(link.successorChoreId)),
      completions: completions.filter(row => !adaptiveChoreIds.has(row.choreId)),
      previousScheduleEntries: previousScheduleEntries.filter(entry => !adaptiveChoreIds.has(entry.choreId)),
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
    // Advancing an estimated cycle anchor must not erase the same still-open occurrence's
    // missed-cycle count or rewrite its cache on the next identical read.
    if (scheduleEntries.some(entry => entry.status === 'overdue' && stateById.get(entry.choreId)?.lastCompletedEstimated)) {
      const previousById = new Map(previousScheduleEntries.map(entry => [entry.id, entry]));
      for (const entry of scheduleEntries) {
        const previous = previousById.get(entry.id);
        if (entry.status === 'overdue' && stateById.get(entry.choreId)?.lastCompletedEstimated && previous?.status === 'overdue'
          && previous.choreId === entry.choreId && previous.cycleBaseDate === entry.cycleBaseDate
          && previous.windowStart === entry.windowStart && previous.windowEnd === entry.windowEnd
          && (previous.overdueCycles ?? 0) > (entry.overdueCycles ?? 0)) entry.overdueCycles = previous.overdueCycles;
      }
    }
    const missingInitialDates = scheduleEntries.filter((entry) => entry.id === `${entry.choreId}:initial`
      && stateById.get(entry.choreId)?.initialPending && !stateById.get(entry.choreId)?.initialScheduledDate);
    const calendarSignature = calendarAvailabilitySignature(externalAvailabilityByDate);
    scheduleEntries = await replaceGeneratedSchedule(database, household.id, scheduleEntries, scheduleResult.simulatedCompletions, missingInitialDates,
      { dataVersion, repairedStates, calendarSignature: settingsRow.planner_calendar_signature === calendarSignature ? undefined : calendarSignature,
        ...(chores.some(usesPersonalAdaptivePlanner) ? { additionalEntries: async () => {
          const context = await readPersonalAdaptiveContextInside(database, { householdId: household.id, memberId: LOCAL_MEMBER_ID, today,
            now: calendarNow, timeZone, assertInputsCurrent: () => assertPlannerDataVersion(database, dataVersion) });
          if (!context) return [];
          const seasonal = await synchronizeSeasonalRepositoryInside(database, context);
          const views = await synchronizePersonalAdaptiveInside(database, context);
          for (const chore of context.chores) {
            const view = views.get(chore.id); if (view) personalCadences[chore.id] = personalCadenceView(chore, view.state);
          }
          return [...seasonal, ...personalAdaptiveEntries(context, views)];
        } } : {}) });
    const initialDates = new Map(scheduleEntries.filter((entry) => entry.id === `${entry.choreId}:initial`)
      .map((entry) => [entry.choreId, entry.suggestedDate]));
    states = states.map((state) => state.initialPending && !state.initialScheduledDate && initialDates.has(state.choreId)
      ? { ...state, initialScheduledDate: initialDates.get(state.choreId) } : state);
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

  const widgetGenerations = await database.getAllAsync<{ schedule_entry_id: string; generation: number }>('SELECT * FROM widget_completion_generations');
  const snapshot: PlannerSnapshot = {
    household,
    settings,
    chores,
    ...(Object.keys(personalCadences).length ? { personalCadences } : {}),
    appliances,
    states,
    members,
    assignments,
    dependencies,
    scheduleEntries,
    completions,
    widgetCompletionGenerations: Object.fromEntries(widgetGenerations.map(row => [row.schedule_entry_id, row.generation])),
    wasteSchedules,
    upcomingWasteDates,
    hiddenWasteDates,
    hiddenWasteOccurrenceKeys: [...hiddenOccurrenceKeys],
    weatherOutcome,
    weatherAdjustmentCount,
    externalAvailabilityByDate,
  };
  const calendarState = googleAvailability ? await loadCalendarAvailabilityStateImpl(database) : null;
  const fetchedAt = calendarState?.lastSuccessfulSyncAt ? Date.parse(calendarState.lastSuccessfulSyncAt) : NaN;
  snapshot.planningInputRevision = await readPlanningInputRevision(database);
  await assertPlannerDataVersion(database, dataVersion);
  snapshotVersions.set(snapshot, plannerVersions.get(database) ?? 0); snapshotDataVersions.set(snapshot, dataVersion);
  const owner = await readAdaptiveOwnerInputs(database, calendarNow); owner?.assertCurrent();
  if (owner?.preferences) { snapshot.today = today; snapshot.timeZone = timeZone; }
  if (owner?.sharedPlanning) snapshot.personalSharedPlanning = owner.sharedPlanning;
  cachedPlannerSnapshots.set(database, { snapshot, today, timeZone, owner, ownerReader: adaptiveOwnerReaderIdentity(database),
    savedAt: calendarNow.getTime(), expiresAt: googleAvailability
      ? Number.isFinite(fetchedAt) ? fetchedAt + CALENDAR_AVAILABILITY_MAX_AGE_MS : calendarNow.getTime()
      : Infinity });
  return snapshot;
}

/** Only the lifecycle refresh invokes HTTP. Ordinary snapshot/guide/calendar reads
 * consume the durable regional cache and do not start a forecast request. */
export async function applyRegionalWeatherToPlannerSnapshot(database: SQLiteDatabase, snapshot: PlannerSnapshot,
  canCommit: () => boolean = () => true, provider: Pick<MetServerForecastProvider, 'refresh'> = regionalWeatherProvider,
  clock: () => Date = () => new Date()): Promise<PlannerSnapshot | null> {
  const location = snapshot.settings.weatherLocation;
  if (!snapshot.settings.setupCompleted || !location || !snapshot.chores.some(chore => chore.enabled && !chore.archived && personalChoreUsesWeather(chore))) return snapshot;
  const region = resolveWeatherMunicipality(location); if (!region) return { ...snapshot, weatherOutcome: 'unavailable', weatherAdjustmentCount: 0 };
  const version = snapshotVersions.get(snapshot) ?? plannerVersions.get(database) ?? 0;
  const expected = snapshotDataVersions.get(snapshot);
  const zone = snapshot.timeZone ?? getDeviceTimeZone();
  const day = snapshot.timeZone ? sharedLocalDate(clock(), zone) : localDateFromDate(clock());
  const sourceOwner = cachedPlannerSnapshots.get(database)?.snapshot === snapshot ? cachedPlannerSnapshots.get(database)?.owner : undefined;
  try { sourceOwner?.assertCurrent(); await sourceOwner?.assertCommitCurrent?.(); } catch (error) { if (isPlannerReadRace(error)) return null; throw error; }
  if (snapshot.today && snapshot.today !== day) return null;
  if (!canCommit() || expected === undefined || await plannerDataVersion(database) !== expected) return null;
  const prior = await readRegionalWeatherInside(database, region.id);
  const incoming = await provider.refresh(location, prior);
  return runDatabaseOperation(database, async () => {
    const assertCurrent = () => {
      sourceOwner?.assertCurrent();
      if (!canCommit() || (snapshot.timeZone ? sharedLocalDate(clock(), zone) : localDateFromDate(clock())) !== day || !snapshot.timeZone && getDeviceTimeZone() !== zone
        || version !== (plannerVersions.get(database) ?? 0)) throw new PlannerInputsChangedError();
    };
    try {
      assertCurrent(); await assertPlannerDataVersion(database, expected);
      let changed = false;
      if (incoming) await withIsolatedSqliteTransaction(database, async transaction => {
        await sourceOwner?.assertCommitCurrent?.();
        assertCurrent(); await assertPlannerDataVersion(database, expected);
        changed = await saveRegionalWeatherInside(transaction, incoming);
        if (changed) await synchronizeAdaptiveRepositoryInside(transaction, clock(), assertCurrent);
        assertCurrent(); await sourceOwner?.assertCommitCurrent?.();
      });
      let current = snapshot;
      if (changed) {
        plannerVersions.set(database, version + 1); cachedPlannerSnapshots.delete(database);
        current = await loadPlannerSnapshotImpl(database, day, clock(), zone);
      }
      const usable = weatherCacheFreshness(incoming ?? prior, clock().getTime()).placement;
      const count = current.scheduleEntries.filter(entry => snapshot.scheduleEntries.some(old => old.id === entry.id && old.suggestedDate !== entry.suggestedDate)).length;
      const outcome = usable ? count ? 'adjusted' : 'current' : 'unavailable';
      if (current.weatherOutcome === outcome && current.weatherAdjustmentCount === count) return current;
      const result: PlannerSnapshot = { ...current, weatherOutcome: outcome, weatherAdjustmentCount: count };
      snapshotVersions.set(result, snapshotVersions.get(current) ?? plannerVersions.get(database) ?? 0);
      const dataVersion = snapshotDataVersions.get(current); if (dataVersion !== undefined) snapshotDataVersions.set(result, dataVersion);
      const cached = cachedPlannerSnapshots.get(database); if (cached?.snapshot === current) cachedPlannerSnapshots.set(database, { ...cached, snapshot: result });
      return result;
    } catch (error) { if (isPlannerReadRace(error)) return null; throw error; }
  });
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
  if (optimize === optimizeLaundryScheduleForWeather && !sharedRepositoryAdapter(database)) {
    return applyRegionalWeatherToPlannerSnapshot(database, snapshot, canCommit, regionalWeatherProvider, clock);
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
  const dataVersion = snapshotDataVersions.get(snapshot);
  if (dataVersion === undefined || await plannerDataVersion(database) !== dataVersion) return null;
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
    if (await plannerDataVersion(database) !== dataVersion) return null;
    const existing = weatherAssessments.get(snapshot);
    if (reusable(existing, finishedAt)) return existing!.result;
    const cached = cachedPlannerSnapshots.get(database);
    if (version !== (plannerVersions.get(database) ?? 0) || (cached && cached.snapshot !== snapshot)
      || (cached && (cached.today !== today || cached.timeZone !== getDeviceTimeZone() || finishedAt.getTime() > cached.expiresAt))) return null;
    const changed = JSON.stringify(weatherResult.schedule) !== JSON.stringify(snapshot.scheduleEntries);
    if (changed) try { await replaceGeneratedSchedule(database, snapshot.household.id, weatherResult.schedule, [], [], { dataVersion }); }
    catch (error) { if (isPlannerReadRace(error)) return null; throw error; }
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
    snapshotDataVersions.set(result, dataVersion);
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
  guard?: { dataVersion: number; repairedStates?: readonly ChoreState[]; calendarSignature?: string; additionalEntries?(): Promise<ChoreScheduleEntry[]> },
): Promise<ChoreScheduleEntry[]> {
  const materialized = [...entries];
  await withAdaptiveOwnerTransaction(database, async () => {
    // This PRAGMA opens the same SQLite read snapshot as the following diff.
    // An intervening WAL commit then either fails this comparison or prevents
    // promotion to a writer (SQLITE_BUSY_SNAPSHOT); no stale plan is published.
    if (guard) await assertPlannerDataVersion(database, guard.dataVersion);
    if (guard?.additionalEntries) materialized.push(...await guard.additionalEntries());
    const previous = await database.getAllAsync<{ id: string; entry_json: string }>(
      'SELECT id, entry_json FROM chore_schedule_entries WHERE household_id = ?', householdId,
    );
    for (const state of guard?.repairedStates ?? []) await restoreChoreState(database, state.choreId, state);
    await writeScheduleCacheDiffInside(database, householdId, previous, materialized);
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
    if (guard?.calendarSignature !== undefined) await database.runAsync(
      'UPDATE household_settings SET planner_calendar_signature = ? WHERE household_id = ?', guard.calendarSignature, householdId);
  });
  return materialized;
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
  const weatherLocation = submission.weatherLocation ? normalizeStoredWeatherLocation(submission.weatherLocation) : null;
  const enabled = new Set(submission.enabledChoreIds);
  const now = new Date().toISOString();

  await withAdaptiveOwnerTransaction(database, async () => {
    const definitions = await database.getAllAsync<DefinitionRow>(
      'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
    );
    for (const row of definitions) {
      const definition = JSON.parse(row.definition_json) as ChoreDefinition;
      if (enabled.has(row.id) && definition.requiresCycleSelection) throw new Error(`「${definition.name}」は周期を設定してから有効にしてください。`);
    }
    // Initial setup is a one-time commit. A lost refresh/reply must never replay
    // its relative dates over subsequent settings or completion history.
    const setup = await database.getFirstAsync<{ setup_completed: number }>('SELECT setup_completed FROM household_settings WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
    if (setup?.setup_completed) return;
    planPersonalCatalogToggles([], submission.enabledChoreIds, true);
    await database.runAsync(
      `UPDATE household_settings SET frequency_mode = ?, rest_days_json = ?, notifications_enabled = ?, setup_completed = 1,
       weather_municipality_id = ?, weather_region = ?, weather_region_name = ?, weather_latitude = ?, weather_longitude = ?, updated_at = ?
       WHERE household_id = ?`,
      submission.frequencyMode, JSON.stringify(submission.restDays), submission.notificationsEnabled ? 1 : 0,
      weatherLocation?.municipalityId ?? null, weatherLocation?.region ?? null, weatherLocation?.displayName ?? null,
      weatherLocation?.latitude ?? null, weatherLocation?.longitude ?? null,
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
    await synchronizeAdaptiveRepositoryInside(database);
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
  await withAdaptiveOwnerTransaction(database, async () => {
  const updated = await database.runAsync(
    `UPDATE household_settings SET frequency_mode = ?, rest_days_json = ?, heavy_daily_limit = ?,
     normal_daily_limit = ?, updated_at = ? WHERE household_id = ?${_displayedBase ? ' AND frequency_mode=? AND rest_days_json=? AND heavy_daily_limit=? AND normal_daily_limit=?' : ''}`,
    settings.frequencyMode, JSON.stringify(settings.restDays), settings.heavyDailyLimit,
    settings.normalDailyLimit, new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
    ...(_displayedBase ? [_displayedBase.frequencyMode, JSON.stringify(_displayedBase.restDays), _displayedBase.heavyDailyLimit, _displayedBase.normalDailyLimit] : []),
  );
  if (_displayedBase && !updated.changes) {
    const current = await database.getFirstAsync<{ frequency_mode: string; rest_days_json: string; heavy_daily_limit: number; normal_daily_limit: number }>('SELECT frequency_mode,rest_days_json,heavy_daily_limit,normal_daily_limit FROM household_settings WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
    if (!current || current.frequency_mode !== settings.frequencyMode || current.rest_days_json !== JSON.stringify(settings.restDays)
      || current.heavy_daily_limit !== settings.heavyDailyLimit || current.normal_daily_limit !== settings.normalDailyLimit) throw new Error('端末の生活リズムが別の操作で更新されています。最新の設定を確認してください。');
  }
  await synchronizeAdaptiveRepositoryInside(database);
  });
}

async function loadPersonalPlacementPreferencesImpl(database: SQLiteDatabase): Promise<PersonalPlacementPreferences> {
  const row = await database.getFirstAsync<{ preferences_json: string }>('SELECT preferences_json FROM personal_adaptive_preferences WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
  return snapshotPersonalPlacementPreferences(row ? JSON.parse(row.preferences_json) : { allowedBands: [], dayOverrides: [] });
}

async function savePersonalPlacementPreferencesImpl(database: SQLiteDatabase, value: PersonalPlacementPreferences, expected: PersonalPlacementPreferences): Promise<void> {
  const own = snapshotPersonalPlacementPreferences(value); const before = snapshotPersonalPlacementPreferences(expected);
  await withAdaptiveOwnerTransaction(database, async () => {
    if ((await readAdaptiveOwnerInputs(database, new Date()))?.ownerUserId) throw new AdaptiveOwnerInputsChangedError();
    const current = await loadPersonalPlacementPreferencesImpl(database);
    if (JSON.stringify(current) === JSON.stringify(own)) return;
    if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error('家事の時間・日別設定が別の操作で更新されています。');
    await database.runAsync(`INSERT INTO personal_adaptive_preferences(household_id,revision,preferences_json) VALUES(?,1,?)
      ON CONFLICT(household_id) DO UPDATE SET revision=revision+1,preferences_json=excluded.preferences_json`, LOCAL_HOUSEHOLD_ID, JSON.stringify(own));
    await synchronizeAdaptiveRepositoryInside(database);
  });
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
  const known = normalizeStoredWeatherLocation(location);
  await database.runAsync(
    `UPDATE household_settings SET weather_municipality_id = ?, weather_region = ?, weather_region_name = ?, weather_latitude = ?, weather_longitude = ?, updated_at = ?
     WHERE household_id = ?`,
    known.municipalityId ?? null, known.region, known.displayName, known.latitude, known.longitude, new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
  );
}

async function clearWeatherLocationImpl(database: SQLiteDatabase): Promise<void> {
  await database.runAsync(
    `UPDATE household_settings SET weather_municipality_id = NULL, weather_region = NULL, weather_region_name = NULL,
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

async function resetAllChoreSchedulesImpl(database: SQLiteDatabase): Promise<void> {
  // Personal settings never mutate a shared adapter or another household.
  if (sharedRepositoryAdapter(database) || await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sharing_workspace_metadata'")) throw new Error('個人用の設定を開いてください。');
  let changed = false;
  await withAdaptiveOwnerTransaction(database, async () => {
    const rows = await database.getAllAsync<{ id: string; enabled: number; definition_json: string }>('SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ?', LOCAL_HOUSEHOLD_ID);
    for (const row of rows) {
      const current = { ...JSON.parse(row.definition_json) as ChoreDefinition, enabled: Boolean(row.enabled) };
      if (current.archived || !choreScheduleDefaults(current)) continue;
      const next = resetChoreSchedule(current);
      if (choreScheduleSignature(current) === choreScheduleSignature(next)) continue;
      await database.runAsync('UPDATE chore_definitions SET definition_json = ? WHERE id = ? AND household_id = ?', JSON.stringify(next), row.id, LOCAL_HOUSEHOLD_ID);
      await database.runAsync('DELETE FROM chore_schedule_entries WHERE chore_id = ? AND household_id = ?', row.id, LOCAL_HOUSEHOLD_ID);
      changed = true;
    }
    if (changed) await synchronizeAdaptiveRepositoryInside(database);
  });
  if (changed) plannerVersions.set(database, (plannerVersions.get(database) ?? 0) + 1);
}

async function addPersonalChoreImpl(database: SQLiteDatabase, input: { name: string; intervalDays: number } & CustomChoreOptions): Promise<ChoreDefinition> {
  if (sharedRepositoryAdapter(database)) throw new Error('個人用の保存先を確認してください。');
  const chore = createCustomPersonalChore(createId('custom-chore'), LOCAL_HOUSEHOLD_ID, input.name, input.intervalDays, input);
  await ensureLocalHouseholdImpl(database);
  await withAdaptiveOwnerTransaction(database, async () => {
    const { today } = await adaptiveOwnerClock(database, new Date(), { today: localDateFromDate(new Date()), timeZone: getDeviceTimeZone() });
    await database.runAsync('INSERT INTO chore_definitions(id,household_id,name,enabled,definition_json) VALUES(?,?,?,?,?)',
      chore.id, chore.householdId, chore.name, 1, JSON.stringify(chore));
    await database.runAsync('INSERT INTO chore_state(chore_id,initial_pending,initial_scheduled_date) VALUES(?,1,?)', chore.id, today);
    await database.runAsync('INSERT INTO chore_assignments(chore_id,member_id) VALUES(?,?)', chore.id, LOCAL_MEMBER_ID);
    await synchronizeAdaptiveRepositoryInside(database);
  });
  notifyGooglePlannerChanges();
  return chore;
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
  const savedDefinition = JSON.parse(previous.definition_json) as ChoreDefinition;
  if (savedDefinition.customPersonal && (definition.customPersonal !== true || definition.personalSchedulingKind !== savedDefinition.personalSchedulingKind
    || JSON.stringify(definition.personalScheduleDefaults) !== JSON.stringify(savedDefinition.personalScheduleDefaults))) throw new Error('追加した家事の初期設定を上書きできません。');
  if (savedDefinition.personalRecipeId && (definition.personalRecipeId !== savedDefinition.personalRecipeId || definition.personalSchedulingKind !== savedDefinition.personalSchedulingKind
    || JSON.stringify(definition.personalScheduleDefaults) !== JSON.stringify(savedDefinition.personalScheduleDefaults))) throw new Error('家事の初期設定を上書きできません。');
  if (definition.enabled && definition.requiresCycleSelection) throw new Error('周期を設定してから有効にしてください。');
  const scheduleChanged = choreScheduleSignature(JSON.parse(previous.definition_json) as ChoreDefinition)
    !== choreScheduleSignature(definition);
  await withAdaptiveOwnerTransaction(database, async () => {
    if (definition.personalRecipeId && definition.enabled) await disablePersonalCatalogAlternativesInside(database, [definition.id]);
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
    if (usesPersonalAdaptivePlanner(definition) && scheduleChanged) await synchronizeAdaptiveRepositoryInside(database);
  });
}

/** Only the enabled flags/cache change; replacing an aggregate never erases its settings or history. Caller owns the transaction. */
async function disablePersonalCatalogAlternativesInside(database: SQLiteDatabase, selectedIds: readonly string[]): Promise<boolean> {
  const rows = await database.getAllAsync<DefinitionRow>(
    'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ? AND enabled = 1', LOCAL_HOUSEHOLD_ID,
  );
  const selection = new Set(planPersonalCatalogToggles(rows.map(row => row.id), selectedIds, true));
  let changed = false;
  for (const row of rows) {
    if (selection.has(row.id)) continue;
    const definition = JSON.parse(row.definition_json) as ChoreDefinition;
    if (definition.personalRecipeId !== row.id) throw new Error('家事カタログの識別子を確認してください。');
    await database.runAsync('UPDATE chore_definitions SET enabled = 0, definition_json = ? WHERE id = ? AND household_id = ?',
      JSON.stringify({ ...definition, enabled: false }), row.id, LOCAL_HOUSEHOLD_ID);
    await database.runAsync('DELETE FROM chore_schedule_entries WHERE chore_id = ? AND household_id = ?', row.id, LOCAL_HOUSEHOLD_ID);
    changed = true;
  }
  return changed;
}

function choreScheduleSignature(chore: ChoreDefinition): string {
  return JSON.stringify([
    chore.enabled, chore.load, chore.everyday, chore.requiresCycleSelection, chore.estimatedMinutes,
    chore.frequencyDaysByMode.frequent, chore.frequencyDaysByMode.balanced, chore.frequencyDaysByMode.relaxed,
    chore.recommendedCycleDays, chore.userIntervalDays, chore.manufacturerRecommendedIntervalDays,
    chore.windowRadiusDays, chore.userWindowRadiusDays, chore.maxShiftDays, chore.holidayPriority, chore.laundryDryingPreference,
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
  manual?: UploadedManualInput,
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
  await withAdaptiveOwnerTransaction(database, async () => {
    if (manual) {
      if (manual.rightsConfirmed !== true || !analysis.manualSource) throw new Error('解析したPDFの保存を確認してください。');
      await storeApplianceManualInside(database, manual.base64, analysis.manualSource.sha256);
    }
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
    await synchronizeAdaptiveRepositoryInside(database);
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
  await withAdaptiveOwnerTransaction(database, async () => {
    const changes: { chore: ChoreDefinition; wasEnabled: boolean }[] = [];
    const rows = await database.getAllAsync<DefinitionRow>('SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id=? AND id IN (SELECT value FROM json_each(?))', LOCAL_HOUSEHOLD_ID, JSON.stringify(choreIds));
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const id of choreIds) {
      const row = byId.get(id);
      if (!row) throw new Error('家事が見つかりません。最新の一覧を読み直してください。');
      const chore = { ...JSON.parse(row.definition_json) as ChoreDefinition, enabled };
      if (chore.archived) throw new Error('削除済みの家事は変更できません。');
      if (enabled && chore.requiresCycleSelection) throw new Error(`「${chore.name}」の周期を設定してから有効にしてください。`);
      if (Boolean(row.enabled) !== enabled) changes.push({ chore, wasEnabled: Boolean(row.enabled) });
    }
    const alternativesChanged = enabled ? await disablePersonalCatalogAlternativesInside(database, choreIds) : false;
    if (changes.length) {
      const ids = JSON.stringify(changes.map(({ chore }) => chore.id));
      await database.runAsync(`UPDATE chore_definitions SET enabled=?, definition_json=json_set(definition_json,'$.enabled',json(?))
        WHERE household_id=? AND id IN (SELECT value FROM json_each(?))`, enabled ? 1 : 0, enabled ? 'true' : 'false', LOCAL_HOUSEHOLD_ID, ids);
      await database.runAsync('DELETE FROM chore_schedule_entries WHERE chore_id IN (SELECT value FROM json_each(?))', ids);
      if (enabled) await database.runAsync(`UPDATE chore_state SET initial_pending=1, initial_scheduled_date=NULL,
        unknown_reason=COALESCE(unknown_reason,'unknown') WHERE last_completed_date IS NULL AND chore_id IN (SELECT value FROM json_each(?))`, ids);
    }
    if (alternativesChanged || changes.some(row => usesPersonalAdaptivePlanner(row.chore))) await synchronizeAdaptiveRepositoryInside(database);
  });
}

async function completeChoreImpl(
  database: SQLiteDatabase,
  entry: ChoreScheduleEntry,
  memberId?: EntityId,
  source: NonNullable<ChoreCompletion['source']> = 'inApp',
  assertAccess?: () => void | Promise<void>,
): Promise<boolean> {
  await assertAccess?.();
  if (!await isActiveChoreEntry(database, entry)) return false;
  let inserted = false;
  await withAdaptiveOwnerTransaction(database, async () => {
    await assertAccess?.();
    if (!await isActiveChoreEntry(database, entry)) return;
    inserted = await persistChoreCompletion(database, entry, new Date().toISOString(), source, memberId);
    await assertAccess?.();
  });
  return inserted;
}

/** Capture the exact saved fact in the same transaction, for the short-lived Undo action. */
async function completeChoreWithReceiptImpl(database: SQLiteDatabase, entry: ChoreScheduleEntry, assertAccess?: () => void | Promise<void>): Promise<ChoreCompletion | undefined> {
  await assertAccess?.();
  let receipt: ChoreCompletion | undefined;
  await withAdaptiveOwnerTransaction(database, async () => {
    await assertAccess?.();
    if (!await isActiveChoreEntry(database, entry)) return;
    if (!await persistChoreCompletion(database, entry, new Date().toISOString(), 'inApp')) return;
    const row = await database.getFirstAsync<CompletionRow>('SELECT * FROM chore_completions WHERE schedule_entry_id = ?', entry.id);
    if (row) receipt = completionFromRow(row);
    await assertAccess?.();
  });
  return receipt;
}

/** A durable native input uses the same journal and Google intent transaction as an ordinary completion. */
async function commitWidgetCompletionOperationImpl(database: SQLiteDatabase, raw: WidgetCompletionOperation,
  assertAccess: () => void | Promise<void>): Promise<'saved' | 'alreadyApplied' | 'targetChanged'> {
  const operation = validateWidgetCompletionOperation(raw); const digest = sharedDocumentDigest(operation);
  await assertAccess(); await assertPersonalPlannerDatabase(database);
  let outcome: 'saved' | 'alreadyApplied' | 'targetChanged' = 'targetChanged';
  await withAdaptiveOwnerTransaction(database, async () => {
    await assertAccess();
    const home = await database.getFirstAsync<HouseholdRow>('SELECT id,name,created_at FROM households WHERE id=?', LOCAL_HOUSEHOLD_ID);
    const sameHome = home?.created_at === operation.householdCreatedAt;
    const received = await database.getFirstAsync<{ target_digest: string }>('SELECT target_digest FROM planner_completion_intents WHERE intent_id=?', operation.id);
    if (received && received.target_digest !== digest) throw new Error('ウィジェット操作の内容が変わっています。');
    if (received) outcome = 'alreadyApplied';
    else {
      const row = await database.getFirstAsync<{ entry_json: string }>('SELECT entry_json FROM chore_schedule_entries WHERE id=? AND household_id=? AND chore_id=?',
        operation.entry.id, LOCAL_HOUSEHOLD_ID, operation.entry.choreId);
      const entry = row ? JSON.parse(row.entry_json) as ChoreScheduleEntry : undefined;
      const generation = await database.getFirstAsync<{ generation: number }>('SELECT generation FROM widget_completion_generations WHERE schedule_entry_id=?', operation.entry.id);
      if (sameHome && (operation.completionGeneration ?? 0) === (generation?.generation ?? 0) && entry && entry.id === operation.entry.id && entry.choreId === operation.entry.choreId
        && entry.cycleBaseDate === operation.entry.cycleBaseDate && await isActiveChoreEntry(database, entry)) {
        const changed = await persistChoreCompletion(database, operation.entry, new Date(operation.acceptedAtMs).toISOString(), 'widget', undefined,
          { localDate: operation.completedLocalDate, timeZone: operation.timeZone });
        outcome = changed ? 'saved' : 'alreadyApplied';
      }
      await database.runAsync('INSERT INTO planner_completion_intents VALUES (?,?)', operation.id, digest);
    }
    if (await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE name='native_widget_completion_intents'")) {
      const queued = await database.getFirstAsync<{ operation_json: string }>('SELECT operation_json FROM native_widget_completion_intents WHERE operation_id=?', operation.id);
      if (queued && sharedDocumentDigest(validateWidgetCompletionOperation(JSON.parse(queued.operation_json))) !== digest) throw new Error('保存待ち操作の内容が変わっています。');
      await database.runAsync('DELETE FROM native_widget_completion_intents WHERE operation_id=?', operation.id);
    }
    await assertAccess();
  });
  return outcome;
}

async function undoCompletionReceiptImpl(database: SQLiteDatabase, receipt: ChoreCompletion, assertAccess?: () => void | Promise<void>): Promise<boolean> {
  await assertAccess?.();
  let changed = false;
  await withAdaptiveOwnerTransaction(database, async () => {
    await assertAccess?.();
    const row = await database.getFirstAsync<CompletionRow>('SELECT * FROM chore_completions WHERE id = ?', receipt.id);
    if (!row || row.household_id !== LOCAL_HOUSEHOLD_ID || row.household_id !== receipt.householdId
      || row.chore_id !== receipt.choreId || row.schedule_entry_id !== receipt.scheduleEntryId
      || (row.adaptive_operation_id ?? null) !== (receipt.adaptiveOperationId ?? null)
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
  await withAdaptiveOwnerTransaction(database, async () => {
    await assertAccess();
    const rows = await database.getAllAsync<DefinitionRow>('SELECT id,enabled,definition_json FROM chore_definitions WHERE household_id=?', LOCAL_HOUSEHOLD_ID);
    const personal = rows.map(row => ({ ...JSON.parse(row.definition_json) as ChoreDefinition, enabled: Boolean(row.enabled) }));
    const ids = new Set(personal.map(chore => chore.id));
    const links = commonChoreLinks(personal, input.chores);
    const existing = await database.getAllAsync<{ id: string; chore_id: string; schedule_entry_id: string; outcome: ChoreCompletion['outcome'] }>(
      "SELECT id,chore_id,schedule_entry_id,outcome FROM chore_completions WHERE household_id=? AND schedule_entry_id LIKE 'shared-home:%'", LOCAL_HOUSEHOLD_ID);
    // A prior name match keeps only its exact mirrored occurrence addressable.
    // Renaming/disabling shared work must not subscribe an old personal chore
    // to every new occurrence of a now-unrelated definition.
    const priorByOccurrence = new Map<string, typeof links>();
    for (const row of existing) {
      const key = parseSharedMirrorEntryId(row.schedule_entry_id);
      if (key?.groupId === input.groupId && key.personalChoreId === row.chore_id && ids.has(row.chore_id)) {
        const occurrence = JSON.stringify([key.sharedChoreId, key.occurrenceId]);
        const previous = priorByOccurrence.get(occurrence) ?? []; previous.push(key); priorByOccurrence.set(occurrence, previous);
      }
    }
    const known = new Map(existing.map(row => [row.schedule_entry_id, row]));
    const bySharedChore = new Map<string, typeof links>();
    for (const link of links) { const values = bySharedChore.get(link.sharedChoreId) ?? []; values.push(link); bySharedChore.set(link.sharedChoreId, values); }
    for (const fact of [...input.completions].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || a.id.localeCompare(b.id))) {
      if (!fact.scheduleEntryId) continue;
      if (!Number.isFinite(Date.parse(fact.completedAt))) throw new Error('共有家事の実施日時を確認してください。');
      for (const date of [fact.scheduledDate, fact.scheduledWindowStart, fact.scheduledWindowEnd]) if (date) parseLocalDate(date);
      const matches = new Map([...(bySharedChore.get(fact.choreId) ?? []),
        ...(priorByOccurrence.get(JSON.stringify([fact.choreId, fact.scheduleEntryId])) ?? [])].map(link => [link.personalChoreId, link]));
      for (const link of matches.values()) {
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
  // Reading the owner clock captures a full shared plan. Reuse the completed
  // personal read only after checking its actual protected inputs and both DBs;
  // never repeat that calculation merely to compose the same home/calendar view.
  const saved = cachedPlannerSnapshots.get(database);
  const reusable = readCachedPlannerSnapshot(database, now);
  if (saved && reusable && snapshotDataVersions.get(reusable) === await plannerDataVersion(database)) {
    try {
      await saved.owner?.assertCommitCurrent?.();
      if (cachedPlannerSnapshots.get(database) === saved && readCachedPlannerSnapshot(database, now) === reusable
        && snapshotDataVersions.get(reusable) === await plannerDataVersion(database)) {
        return { snapshot: reusable, today: saved.today, timeZone: saved.timeZone };
      }
    } catch (error) {
      if (!(error instanceof AdaptiveOwnerInputsChangedError)) throw error;
      if (cachedPlannerSnapshots.get(database) === saved) cachedPlannerSnapshots.delete(database);
    }
  }
  const { today, timeZone } = await adaptiveOwnerClock(database, now, { today: localDateFromDate(now), timeZone: getDeviceTimeZone() });
  const cached = readCachedPlannerSnapshot(database, now);
  const snapshot = cached && snapshotDataVersions.get(cached) === await plannerDataVersion(database)
    ? cached : await loadPlannerSnapshotImpl(database, today, now, timeZone);
  return { snapshot, today, timeZone };
}

/** Copy selection needs definitions and the selected frequency only; never load history or generate schedules here. */
async function readPersonalChoreCopySourceImpl(database: SQLiteDatabase, ids?: readonly string[]) {
  const selected = ids ? [...ids] : undefined;
  if (selected && (!selected.length || selected.length > 20 || new Set(selected).size !== selected.length
    || selected.some(id => typeof id !== 'string' || !id.length || id.length > 512 || id.includes('\0')))) throw new Error('コピーする個人家事を選び直してください。');
  let result!: { householdId: string; frequencyMode: FrequencyMode; chores: ChoreDefinition[] };
  await withAdaptiveOwnerTransaction(database, async () => {
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
export interface PersonalCompletionIntentIdentity { id: string; digest: string; householdCreatedAt: string; createdAt: string }
async function setPersonalDateTaskCompletedImpl(database: SQLiteDatabase, command: PersonalDateTaskCommand,
  assertAccess: () => void | Promise<void>, intent?: PersonalCompletionIntentIdentity): Promise<boolean> {
  parseLocalDate(command.date);
  if (![0, 3].includes(command.graceDays) || typeof command.completed !== 'boolean' || typeof command.revision !== 'string'
    || !command.choreId) throw new Error('表示した個人家事を選び直してください。');
  await assertAccess(); await assertPersonalPlannerDatabase(database);
  if (intent && (!/^completion-intent\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(intent.id)
    || !/^[a-f0-9]{64}$/u.test(intent.digest) || !Number.isFinite(Date.parse(intent.createdAt)))) throw new Error('保存待ちの完了操作を確認できません。');
  let changed = false;
  await withAdaptiveOwnerTransaction(database, async () => {
    if (intent) {
      const household = await database.getFirstAsync<HouseholdRow>('SELECT id, name, created_at FROM households WHERE id=?', LOCAL_HOUSEHOLD_ID);
      if (!household || household.created_at !== intent.householdCreatedAt) throw new Error('個人家事の保存先が変わりました。');
      const previous = await database.getFirstAsync<{ target_digest: string }>('SELECT target_digest FROM planner_completion_intents WHERE intent_id=?', intent.id);
      if (previous) {
        if (previous.target_digest !== intent.digest) throw new Error('保存待ちの完了操作が一致しません。');
        await assertAccess(); return;
      }
    }
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
      `SELECT id, household_id, chore_id, completed_at, completed_local_date, completed_time_zone, adaptive_operation_id, seasonal_work, completed_by_member_id, source, schedule_entry_id,
       scheduled_date, scheduled_window_start, scheduled_window_end, outcome FROM chore_completions
       WHERE chore_id = ? AND household_id = ? ORDER BY completed_at DESC`, command.choreId, LOCAL_HOUSEHOLD_ID,
    )).map(completionFromRow);
    const candidates = selectDateTasks(entries, completions, command.date, command.graceDays, [chore], command.graceDays === 3);
    let task: DateTask | undefined = candidates.find(task => dateTaskRevision(task) === command.revision)
      ?? (intent ? candidates.find(task => sameDateTaskOccurrence(command.revision, dateTaskRevision(task))) : undefined);
    if (intent && (!task || !sameDateTaskOccurrence(command.revision, dateTaskRevision(task)))) {
      // Another overlapping cycle may now sort first. Resolve only the exact
      // original cycle, using current stored entries and actual completion facts.
      const original = dateTaskOccurrenceReference(command.revision);
      const entry = entries.find(value => original !== null && dateTaskOccurrenceReference(dateTaskRevision({ id: value.id, choreId: value.choreId,
        suggestedDate: value.suggestedDate, completed: false, entry: value })) === original);
      const completion = completions.find(value => value.outcome === 'completed' && original !== null
        && dateTaskOccurrenceReference(dateTaskRevision({ id: `completed:${value.id}`, choreId: value.choreId,
          suggestedDate: value.scheduledDate ?? command.date, completed: true, completion: value })) === original);
      task = entry || completion ? { id: entry?.id ?? `completed:${completion!.id}`, choreId: command.choreId,
        suggestedDate: entry?.suggestedDate ?? completion!.scheduledDate ?? command.date, completed: Boolean(completion), entry, completion } : undefined;
    }
    if (!task || (intent ? !sameDateTaskOccurrence(command.revision, dateTaskRevision(task)) : dateTaskRevision(task) !== command.revision)) {
      throw new Error('個人家事の状態が変わっています。表示を更新して選び直してください。');
    }
    await assertAccess();
    if (task.completed !== command.completed) {
      if (command.completed && task.entry && await isActiveChoreEntry(database, task.entry)) changed = await persistChoreCompletion(database, task.entry, intent?.createdAt ?? new Date().toISOString(), 'inApp');
      else if (!command.completed && task.completion) changed = await undoCompletionInTransaction(database, task.completion.id, 'inApp', intent ? localDateFromISODateTime(intent.createdAt) : localDateFromDate(new Date()));
    }
    await assertAccess();
    if (intent) {
      await database.runAsync('INSERT INTO planner_completion_intents VALUES (?, ?)', intent.id, intent.digest);
      await assertAccess();
    }
  });
  return changed;
}

async function isActiveChoreEntry(database: SQLiteDatabase, entry: ChoreScheduleEntry): Promise<boolean> {
  if (entry.householdId !== LOCAL_HOUSEHOLD_ID) return false;
  if (entry.status === 'initialPending' && !entry.id.endsWith(':initial')) {
    const adaptive = entry.id.startsWith('personal-round.') ? await readAdaptivePersonalInside(database, entry.choreId) : null;
    if (adaptive?.plan?.id !== entry.id || adaptive.state.policy.choreId !== entry.choreId || !adaptive.state.policy.enabled) return false;
  }
  const active = await database.getFirstAsync<{ enabled: number }>(
    'SELECT enabled FROM chore_definitions WHERE id = ? AND household_id = ?', entry.choreId, LOCAL_HOUSEHOLD_ID,
  );
  return Boolean(active?.enabled);
}

type CompletionTarget = Pick<ChoreScheduleEntry, 'id' | 'householdId' | 'choreId'>
  & Partial<Pick<ChoreScheduleEntry, 'suggestedDate' | 'windowStart' | 'windowEnd'>>;

async function saveAdaptiveChoreCacheInside(database: SQLiteDatabase, context: NonNullable<Awaited<ReturnType<typeof readPersonalAdaptiveContextInside>>>, choreId: string,
  prepared?: Awaited<ReturnType<typeof readAdaptivePersonalInside>>) {
  const view = prepared ?? await readAdaptivePersonalInside(database, choreId); if (!view) return;
  const entry = personalAdaptiveEntries(context, new Map([[choreId, view]]))[0];
  await saveScopedScheduleCacheInside(database, context.householdId, [choreId], entry ? [entry] : []);
}

async function synchronizeAdaptiveRepositoryInside(database: SQLiteDatabase, now = new Date(), assertInputsCurrent: () => void | Promise<void> = () => {}) {
  const context = await readPersonalAdaptiveContextInside(database, { householdId: LOCAL_HOUSEHOLD_ID, memberId: LOCAL_MEMBER_ID,
    now, timeZone: getDeviceTimeZone(), assertInputsCurrent });
  if (!context) return;
  const seasonal = await synchronizeSeasonalRepositoryInside(database, context);
  const views = await synchronizePersonalAdaptiveInside(database, context);
  const choreIds = [...new Set([...views.keys(), ...context.chores.filter(chore => chore.personalSchedulingKind === 'seasonal').map(chore => chore.id)])];
  await saveScopedScheduleCacheInside(database, context.householdId, choreIds, [...seasonal, ...personalAdaptiveEntries(context, views)]);
}

type AdaptiveRepositoryContext = NonNullable<Awaited<ReturnType<typeof readPersonalAdaptiveContextInside>>>;
function seasonalContext(context: AdaptiveRepositoryContext, chore: ChoreDefinition) {
  return { chore, region: context.clothingRegion ?? 'nationalFallback', today: context.today, now: context.now,
    fingerprint: context.fingerprint, assertInputsCurrent: context.assertInputsCurrent };
}
async function synchronizeSeasonalRepositoryInside(database: SQLiteDatabase, context: AdaptiveRepositoryContext) {
  const entries: ChoreScheduleEntry[] = [];
  for (const chore of context.chores.filter(chore => chore.personalSchedulingKind === 'seasonal')) {
    const view = await synchronizePersonalSeasonalInside(database, seasonalContext(context, chore));
    entries.push(...personalSeasonalEntries(chore, view, context.today, context.assignedMemberIds(chore.id)));
  }
  const byId = new Map(context.chores.map(chore => [chore.id, chore]));
  context.fixedLoads = [...context.fixedLoads.filter(load => !context.seasonalPendingRoundIds?.has(load.roundId)), ...entries.map(entry => ({ roundId: entry.id, date: entry.suggestedDate,
    load: byId.get(entry.choreId)!.load, minutes: byId.get(entry.choreId)!.estimatedMinutes!, slot: null }))];
  context.sourceRevision = context.fingerprint([context.sourceRevision, entries.map(entry => [entry.id, entry.suggestedDate,
    byId.get(entry.choreId)!.load, byId.get(entry.choreId)!.estimatedMinutes])]);
  return entries;
}
async function saveSeasonalChoreCacheInside(database: SQLiteDatabase, choreId: string, entries: readonly ChoreScheduleEntry[]) {
  await saveScopedScheduleCacheInside(database, LOCAL_HOUSEHOLD_ID, [choreId], entries);
}

async function applyAdaptiveCompletionInside(database: SQLiteDatabase, entry: CompletionTarget, completionId: string,
  completedAt: string, localDate: LocalDate, timeZone: string): Promise<string | false | undefined> {
  if (entry.id.startsWith('seasonal-round.')) {
    const current = await readPersonalSeasonalInside(database, entry.choreId);
    if (!current) return false;
    const context = await readPersonalAdaptiveContextInside(database, { householdId: LOCAL_HOUSEHOLD_ID, memberId: LOCAL_MEMBER_ID,
      now: new Date(), timeZone: getDeviceTimeZone() });
    const chore = context?.chores.find(chore => chore.id === entry.choreId && chore.personalSchedulingKind === 'seasonal');
    if (!context || !chore) throw new Error('対象の季節家事を確認してください。');
    const operationId = createId('seasonal-completion');
    const result = await applyPersonalSeasonalInside(database, seasonalContext(context, chore), { operationId, recordedAt: completedAt,
      type: 'complete', completionId, roundId: entry.id, date: localDate, timeZone, origin: 'personal' });
    if (result.kind !== 'applied') return false;
    await saveSeasonalChoreCacheInside(database, chore.id, personalSeasonalEntries(chore,
      await readPersonalSeasonalInside(database, chore.id), context.today, context.assignedMemberIds(chore.id)));
    return operationId;
  }
  const current = await readAdaptivePersonalInside(database, entry.choreId); if (!current) return undefined;
  const context = await readPersonalAdaptiveContextInside(database, { householdId: LOCAL_HOUSEHOLD_ID, memberId: LOCAL_MEMBER_ID,
    now: new Date(), timeZone: getDeviceTimeZone() });
  if (!context) throw new Error('個人家事の実施先を確認してください。');
  const shared = Boolean(parseSharedMirrorEntryId(entry.id));
  if (shared && !current.plan) return undefined;
  const roundId = shared ? current.plan!.id : entry.id;
  const versions = await database.getAllAsync<{ revision: string; plan_json: string }>(
    'SELECT revision,plan_json FROM personal_adaptive_plans WHERE chore_id=? AND round_id=? ORDER BY rowid DESC', entry.choreId, roundId);
  const matching = shared ? current.planRevision : versions.find(row => {
    const plan = JSON.parse(row.plan_json);
    return plan.recommendedDate === entry.suggestedDate && (plan.displayedWindow?.from ?? plan.recommendedDate) === entry.windowStart
      && (plan.displayedWindow?.through ?? plan.recommendedDate) === entry.windowEnd;
  })?.revision;
  const operationId = createId('adaptive-completion');
  if (!shared && localDate === context.today) {
    const chore = context.chores.find(chore => chore.id === entry.choreId);
    if (chore?.estimatedMinutes) context.fixedLoads = [...context.fixedLoads, { roundId: entry.id, date: localDate, minutes: chore.estimatedMinutes, load: chore.load, slot: null }];
  }
  const result = await applyPersonalAdaptiveInside(database, context, entry.choreId, { operationId, recordedAt: completedAt, type: 'complete',
    completionId, roundId, planRevision: matching ?? `missing.${sharedDocumentDigest(entry)}`, date: localDate, timeZone, origin: shared ? 'shared' : 'personal' });
  if (result.kind !== 'applied') return false;
  await saveAdaptiveChoreCacheInside(database, context, entry.choreId);
  return operationId;
}

/** Shared by app/widget completion and Google import, inside the caller's transaction. */
async function persistChoreCompletion(
  database: SQLiteDatabase,
  entry: CompletionTarget,
  completedAt: string,
  source: NonNullable<ChoreCompletion['source']>,
  memberId?: EntityId,
  recorded?: { localDate: LocalDate; timeZone: string },
): Promise<boolean> {
  const instant = Date.parse(completedAt);
  if (!Number.isFinite(instant)) throw new Error('家事の実施日時を確認してください。');
  // Mirror reports can contain a valid RFC3339 offset. Keep the stored local
  // projection canonical while the signed source retains its original bytes.
  completedAt = new Date(instant).toISOString();
  let clock = recorded;
  if (!clock) {
    // A historical Google timestamp determines the completion day, not the
    // shared horizon captured for this current synchronization operation.
    const now = new Date(); const own = await adaptiveOwnerClock(database, now, { today: localDateFromDate(now), timeZone: getDeviceTimeZone() });
    clock = { localDate: own.owner?.preferences ? sharedLocalDate(new Date(completedAt), own.timeZone) : localDateFromDate(new Date(completedAt)), timeZone: own.timeZone };
  }
  const completedDate = clock.localDate;
  const completedTimeZone = clock.timeZone;
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
  const completionId = existing?.id ?? createId('completion');
  const adaptiveOperationId = await applyAdaptiveCompletionInside(database, entry, completionId, completedAt, completedDate, completedTimeZone);
  if (adaptiveOperationId === false) return false;
  if (!adaptiveOperationId) await seedCompletionJournalInside(database, entry.choreId, getDeviceTimeZone());
  if (existing) {
    await database.runAsync(
      `UPDATE chore_completions SET outcome = 'completed', completed_at = ?, completed_local_date = ?, completed_time_zone = ?,
       completed_by_member_id = ?, source = ?, scheduled_date = ?,
       scheduled_window_start = ?, scheduled_window_end = ?, previous_chore_state_json = ? WHERE id = ?`,
      completedAt, completedDate, completedTimeZone, memberId ?? null, source, entry.suggestedDate ?? null, entry.windowStart ?? null, entry.windowEnd ?? null,
      previousStateJson, completionId,
    );
  } else {
    await database.runAsync(
      `INSERT INTO chore_completions
       (id, household_id, chore_id, completed_at, completed_local_date, completed_time_zone, completed_by_member_id, source, schedule_entry_id,
        scheduled_date, scheduled_window_start, scheduled_window_end, outcome, previous_chore_state_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
      completionId, entry.householdId, entry.choreId, completedAt, completedDate, completedTimeZone, memberId ?? null, source,
      entry.id, entry.suggestedDate ?? null, entry.windowStart ?? null, entry.windowEnd ?? null, previousStateJson,
    );
  }
  if (adaptiveOperationId) {
    const seasonal = adaptiveOperationId.startsWith('seasonal-completion') ? await database.getFirstAsync<{ event_json: string }>(
      'SELECT event_json FROM personal_adaptive_actions WHERE operation_id=? AND chore_id=?', adaptiveOperationId, entry.choreId) : null;
    await database.runAsync('UPDATE chore_completions SET adaptive_operation_id=?,seasonal_work=? WHERE id=?', adaptiveOperationId,
      seasonal ? JSON.parse(seasonal.event_json).work : null, completionId);
  }
  else await appendCompletionActionInside(database, { operationId: createId('completion-action'), completionId,
    choreId: entry.choreId, completedAt, localDate: completedDate, timeZone: completedTimeZone,
    scheduledDate: entry.suggestedDate, windowStart: entry.windowStart, previousState, source,
    origin: parseSharedMirrorEntryId(entry.id) ? 'shared' : 'personal' });
  if (source !== 'googleTasks') await markPendingGoogleStatus(database, entry.id, 'completed');
  // Historical Google completions must not move a newer local completion backwards.
  // Future checkmarks retain their actual timestamp but take effect on their scheduled day.
  const windowStart = entry.windowStart ?? entry.suggestedDate;
  if ((adaptiveOperationId || !windowStart || completedDate >= windowStart)
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
  const captureIds = [...new Set(changes.flatMap(change => {
    const link = linksByTask.get(JSON.stringify([change.googleTaskListId, change.googleTaskId]));
    return link && link.scheduleEntryId === change.scheduleEntryId ? [link.scheduleEntryId] : [];
  }))];
  const capturedRows = captureIds.length ? await database.getAllAsync<{ schedule_entry_id: string; entry_json: string | null }>(
    `SELECT l.schedule_entry_id,s.entry_json FROM google_task_links l
     JOIN chore_definitions d ON d.id=l.chore_id AND d.household_id=l.household_id
     LEFT JOIN chore_schedule_entries s ON s.id=l.schedule_entry_id AND s.chore_id=d.id AND s.household_id=d.household_id
     WHERE l.household_id=? AND l.schedule_entry_id IN (SELECT value FROM json_each(?))`, LOCAL_HOUSEHOLD_ID, JSON.stringify(captureIds)) : [];
  const capturedById = new Map(capturedRows.map(row => [row.schedule_entry_id, row]));
  const targets: { entry: CompletionTarget; change: GoogleTaskStatusChange }[] = [];
  const seenEntries = new Set<string>();
  // Capture every mapped occurrence before saving any completion or regenerating schedules.
  for (const completion of changes) {
    const completedAt = completion.status === 'completed' ? parseGoogleCompletedAt(completion.completedAt) : undefined;
    const link = linksByTask.get(JSON.stringify([completion.googleTaskListId, completion.googleTaskId]));
    if ((completion.status === 'completed' && !completedAt) || !link || link.scheduleEntryId !== completion.scheduleEntryId || seenEntries.has(link.scheduleEntryId)) continue;
    const row = capturedById.get(link.scheduleEntryId);
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
  await withAdaptiveOwnerTransaction(database, async () => {
    const currentRows = await database.getAllAsync<{ schedule_entry_id: string; google_task_list_id: string; google_task_id: string;
      last_synced_status: string | null; pending_status: string | null; completion_id: string | null; outcome: string | null }>(
      `SELECT l.schedule_entry_id,l.google_task_list_id,l.google_task_id,l.last_synced_status,l.pending_status,c.id AS completion_id,c.outcome
       FROM google_task_links l LEFT JOIN chore_completions c ON c.schedule_entry_id=l.schedule_entry_id
       WHERE l.household_id=? AND l.schedule_entry_id IN (SELECT value FROM json_each(?))`, LOCAL_HOUSEHOLD_ID, JSON.stringify(targets.map(row => row.entry.id)));
    const currentById = new Map(currentRows.map(row => [row.schedule_entry_id, row]));
    for (const { entry, change } of targets) {
      // Recheck inside the same transaction as the import. A local action during network I/O wins.
      const currentLink = currentById.get(entry.id);
      if (!currentLink || currentLink.google_task_list_id !== change.googleTaskListId || currentLink.google_task_id !== change.googleTaskId || currentLink.pending_status) continue;
      const current = currentLink.completion_id ? { id: currentLink.completion_id, outcome: currentLink.outcome ?? undefined } : undefined;
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
  await withAdaptiveOwnerTransaction(database, async () => {
    await assertAccess?.();
    undone = await undoCompletionInTransaction(database, completionId, 'inApp', localDateFromDate(new Date()));
    await assertAccess?.();
  });
  return undone;
}

async function invalidateWidgetCompletionGeneration(database: SQLiteDatabase, entryId: string | null) {
  if (entryId) await database.runAsync(`INSERT INTO widget_completion_generations VALUES(?,1)
    ON CONFLICT(schedule_entry_id) DO UPDATE SET generation=generation+1`, entryId);
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
    adaptive_operation_id: string | null;
    seasonal_work: ChoreCompletion['seasonalWork'] | null;
  }>(
    `SELECT rowid AS sequence, chore_id, outcome, schedule_entry_id, scheduled_date,
     scheduled_window_start, completed_at, previous_chore_state_json, adaptive_operation_id, seasonal_work
     FROM chore_completions WHERE id = ?`, completionId,
  );
  if (!completion || completion.outcome !== 'completed') return false;
  if (completion.adaptive_operation_id && completion.seasonal_work) {
    const context = await readPersonalAdaptiveContextInside(database, { householdId: LOCAL_HOUSEHOLD_ID, memberId: LOCAL_MEMBER_ID,
      now: new Date(), timeZone: getDeviceTimeZone(), today });
    const chore = context?.chores.find(chore => chore.id === completion.chore_id && chore.personalSchedulingKind === 'seasonal');
    if (!context || !chore) throw new Error('取り消す季節家事の保存先を確認してください。');
    const result = await applyPersonalSeasonalInside(database, seasonalContext(context, chore), { operationId: createId('seasonal-undo'),
      type: 'undo', recordedAt: context.now, completionId, targetOperationId: completion.adaptive_operation_id });
    if (result.kind !== 'applied') return false;
    await database.runAsync("UPDATE chore_completions SET outcome='incomplete',completed_by_member_id=NULL,source=? WHERE id=?", source, completionId);
    if (source !== 'googleTasks' && completion.schedule_entry_id) await markPendingGoogleStatus(database, completion.schedule_entry_id, 'needsAction');
    const remaining = await database.getFirstAsync<{ date: LocalDate | null }>("SELECT MAX(completed_local_date) AS date FROM chore_completions WHERE chore_id=? AND outcome='completed'", chore.id);
    await restoreChoreState(database, chore.id, { choreId: chore.id, lastCompletedDate: remaining?.date ?? undefined,
      lastCompletedEstimated: false, initialPending: !remaining?.date });
    await saveSeasonalChoreCacheInside(database, chore.id, personalSeasonalEntries(chore, await readPersonalSeasonalInside(database, chore.id), context.today, context.assignedMemberIds(chore.id)));
    await invalidateWidgetCompletionGeneration(database, completion.schedule_entry_id);
    return true;
  }
  if (completion.adaptive_operation_id) {
    const context = await readPersonalAdaptiveContextInside(database, { householdId: LOCAL_HOUSEHOLD_ID, memberId: LOCAL_MEMBER_ID,
      now: new Date(), timeZone: getDeviceTimeZone(), today });
    if (!context) throw new Error('取り消す個人家事の保存先を確認してください。');
    context.fixedLoads = context.fixedLoads.filter(load => load.roundId !== completion.schedule_entry_id);
    const result = await applyPersonalAdaptiveInside(database, context, completion.chore_id, { operationId: createId('adaptive-undo'),
      type: 'undo', recordedAt: context.now, completionId, targetOperationId: completion.adaptive_operation_id });
    if (result.kind !== 'applied') return false;
    await database.runAsync("UPDATE chore_completions SET outcome='incomplete',completed_by_member_id=NULL,source=? WHERE id=?", source, completionId);
    if (source !== 'googleTasks' && completion.schedule_entry_id) await markPendingGoogleStatus(database, completion.schedule_entry_id, 'needsAction');
    const view = (await readAdaptivePersonalInside(database, completion.chore_id))!;
    const date = view.state.lastPlanCompletion?.date ?? view.state.policy.planningAnchorDate;
    const original = completion.previous_chore_state_json ? JSON.parse(completion.previous_chore_state_json) as ChoreState | null : null;
    await restoreChoreState(database, completion.chore_id, { choreId: completion.chore_id, lastCompletedDate: date,
      lastCompletedEstimated: Boolean(!view.state.lastPlanCompletion && original?.lastCompletedDate === date && original?.lastCompletedEstimated),
      initialPending: !date, ...(date ? {} : { initialScheduledDate: view.plan?.recommendedDate, unknownReason: 'unknown' }) });
    await saveAdaptiveChoreCacheInside(database, context, completion.chore_id);
    await invalidateWidgetCompletionGeneration(database, completion.schedule_entry_id);
    return true;
  }
  await seedCompletionJournalInside(database, completion.chore_id, getDeviceTimeZone());
  const actionHistory = await readCompletionJournalInside(database, completion.chore_id);
  const targetAction = actionHistory.find(row => row.completion_id === completionId);
  if (!targetAction) throw new Error('完了操作の記録を確認できません。');
  await appendCompletionUndoInside(database, createId('completion-action'), targetAction, completion.chore_id,
    getDeviceTimeZone(), new Date().toISOString(), source);

  await database.runAsync(
    `UPDATE chore_completions SET outcome = 'incomplete',
     completed_by_member_id = NULL, source = ?
     WHERE id = ?`,
    source, completionId,
  );
  if (source !== 'googleTasks' && completion.schedule_entry_id) {
    await markPendingGoogleStatus(database, completion.schedule_entry_id, 'needsAction');
  }
  const completionDate = actionCycleDate(targetAction);
  const wasCheckedEarly = completionWasRecordedBeforeWindow({ completedAt: targetAction.completed_at,
    completedLocalDate: targetAction.completed_local_date, scheduledDate: targetAction.scheduled_date ?? undefined,
    scheduledWindowStart: targetAction.scheduled_window_start ?? undefined });
  if (wasCheckedEarly && completionDate > today) {
    await invalidateWidgetCompletionGeneration(database, completion.schedule_entry_id);
    return true;
  }
  const datedHistory = actionHistory.map(row => ({ ...row,
    outcome: row.completion_id === completionId ? 'incomplete' as const : row.outcome, cycleDate: actionCycleDate(row) }));
  const heads = new Map<string, typeof datedHistory[number]>();
  for (const row of datedHistory) if (!heads.has(row.completion_id)) heads.set(row.completion_id, row);
  const latestRemaining = [...heads.values()]
    .filter((row) => row.outcome === 'completed' && (row.cycleDate <= today || !completionWasRecordedBeforeWindow({
      completedAt: row.completed_at, completedLocalDate: row.completed_local_date,
      scheduledDate: row.scheduled_date ?? undefined, scheduledWindowStart: row.scheduled_window_start ?? undefined })))
    .sort((left, right) => right.cycleDate.localeCompare(left.cycleDate))[0];
  if (targetAction.previous_chore_state_json !== null) {
    let previousState = previousCompletionState(targetAction, actionHistory, heads, datedHistory);
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
  await invalidateWidgetCompletionGeneration(database, completion.schedule_entry_id);
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
      if (cycleDays !== undefined && Number.isInteger(cycleDays) && cycleDays > 0) {
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
  await withAdaptiveOwnerTransaction(database, async () => {
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
  await withAdaptiveOwnerTransaction(database, async () => {
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
  const previousIds = dependencies.filter(item => item.successorChoreId === successorChoreId).map(item => item.predecessorChoreId);
  if (nextIds.length === previousIds.length && nextIds.every(id => previousIds.includes(id))) return;
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

  await withAdaptiveOwnerTransaction(database, async () => {
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
    // These are generated first dates, never a user's explicit Calendar designation.
    // Re-evaluate only the changed successor and its descendants; completed anchors and unrelated first dates stay stable.
    const affected = new Set([successorChoreId]); const pending = [successorChoreId];
    for (let index = 0; index < pending.length; index++) {
      for (const edge of proposed) if (edge.predecessorChoreId === pending[index] && !affected.has(edge.successorChoreId)) {
        affected.add(edge.successorChoreId); pending.push(edge.successorChoreId);
      }
    }
    for (const id of affected) {
      const reset = await database.runAsync(`UPDATE chore_state SET initial_scheduled_date=NULL WHERE chore_id=? AND initial_pending=1
        AND initial_scheduled_date IS NOT NULL AND chore_id IN (SELECT id FROM chore_definitions WHERE household_id=?)`, id, LOCAL_HOUSEHOLD_ID);
      if (reset.changes) await database.runAsync('DELETE FROM chore_schedule_entries WHERE id=? AND chore_id=? AND household_id=?', `${id}:initial`, id, LOCAL_HOUSEHOLD_ID);
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
  await withAdaptiveOwnerTransaction(database, async () => {
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
  await withAdaptiveOwnerTransaction(database, async () => {
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
    if (!entry || !chore || entry.status === 'initialPending' && (!usesPersonalAdaptivePlanner(chore) || !entry.id.startsWith('personal-round.'))) return [];
    if (entry.suggestedDate < today && entry.status !== 'overdue' && !row.completed_at) return [];
    return [{ entry, choreName: choreOccurrenceName(chore.name, entry.seasonalWork), ...(row.completed_at ? { completedAt: row.completed_at } : {}),
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
    seasonal_work: ChoreCompletion['seasonalWork'] | null;
  }>(
    `SELECT c.schedule_entry_id, c.household_id, c.chore_id, d.name AS chore_name,
       c.completed_at, c.outcome, c.scheduled_date, c.scheduled_window_start, c.scheduled_window_end, c.seasonal_work
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
      ...(row.seasonal_work ? { seasonalWork: row.seasonal_work } : {}),
    };
    entries.push({ entry, choreName: choreOccurrenceName(row.chore_name, row.seasonal_work ?? undefined),
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
  await withAdaptiveOwnerTransaction(database, async () => {
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
  const { combined } = await plannerCalendarAvailability(database, localDateFromDate(now), now, timeZone);
  return { current: calendarAvailabilitySignature(combined), applied: row?.planner_calendar_signature ?? null };
}

/** The freshness check and planner must hash identical optional sources and coverage. */
async function plannerCalendarAvailability(database: SQLiteDatabase, today: LocalDate, now: Date, timeZone: string) {
  const google = await getFreshCalendarAvailabilityDaysImpl(database, now, timeZone).catch(() => undefined);
  const local = await readCalendarEventRows(database).then(({ events, exceptions }) => localCalendarAvailability(events, exceptions, today, addDays(today, 180), timeZone)).catch(() => undefined);
  return { google, combined: combineCalendarAvailability(google, local) };
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
  for (let offset = 0; offset < days.length; offset += 100) {
    const chunk = days.slice(offset, offset + 100);
    await database.runAsync(
      `INSERT INTO calendar_availability_days (household_id, local_date, busy_minutes, time_zone, fetched_at) VALUES ${chunk.map(() => '(?,?,?,?,?)').join(',')}`,
      ...chunk.flatMap(day => [householdId, day.localDate, day.busyMinutes, day.timeZone, day.fetchedAt]),
    );
  }
}

async function replaceCalendarAvailabilityDaysImpl(
  database: SQLiteDatabase, days: readonly CalendarAvailabilityDay[], householdId = LOCAL_HOUSEHOLD_ID,
): Promise<void> {
  await withAdaptiveOwnerTransaction(database, () => replaceCalendarAvailabilityRows(database, days, householdId));
}

async function commitCalendarAvailabilitySuccessImpl(
  database: SQLiteDatabase, days: readonly CalendarAvailabilityDay[], state: CalendarAvailabilityState,
): Promise<void> {
  await withAdaptiveOwnerTransaction(database, async () => {
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
export const loadPlannerSnapshot = retryOwnerRead(serializePlannerOperation(loadPlannerSnapshotImpl));
export const completeFirstSetup = serializePlannerOperation(completeFirstSetupImpl, 'completeFirstSetup');
export const updatePlannerSettings = serializePlannerOperation(updatePlannerSettingsImpl, 'updatePlannerSettings');
export const updateCalendarCountDisplay = serializePlannerOperation(updateCalendarCountDisplayImpl);
export const setNotificationsEnabled = serializePlannerOperation(setNotificationsEnabledImpl);
export const saveWeatherLocation = serializePlannerOperation(saveWeatherLocationImpl);
export const clearWeatherLocation = serializePlannerOperation(clearWeatherLocationImpl);
export const updateChoreDefinition = serializePlannerOperation(updateChoreDefinitionImpl, 'updateChoreDefinition');
export const addPersonalChore = serializePlannerOperation(addPersonalChoreImpl);
export const updateChoreSettings = serializeDatabaseOperation(updateChoreSettingsImpl, 'updateChoreSettings');
export const resetAllChoreSchedules = serializeDatabaseOperation(resetAllChoreSchedulesImpl);
export const saveReviewedApplianceCare = serializePlannerOperation(saveReviewedApplianceCareImpl, 'saveReviewedApplianceCare');
export const setChoreEnabled = serializePlannerOperation(setChoreEnabledImpl, 'setChoreEnabled');
export const setChoresEnabled = serializePlannerOperation(setChoresEnabledImpl, 'setChoresEnabled');
export const completeChore = serializePlannerOperation(completeChoreImpl, 'completeChore');
export const completeChoreWithReceipt = serializePlannerOperation(completeChoreWithReceiptImpl, 'completeChoreWithReceipt');
export const commitWidgetCompletionOperation = serializePlannerOperation(commitWidgetCompletionOperationImpl);
export const undoCompletionReceipt = serializePlannerOperation(undoCompletionReceiptImpl, 'undoCompletionReceipt');
export const mirrorSharedChoreCompletions = serializeDatabaseOperation(mirrorSharedChoreCompletionsImpl);
export const readPersonalPlannerOverlaySnapshot = retryOwnerRead(serializeDatabaseOperation(readPersonalPlannerOverlaySnapshotImpl));
export const readPersonalChoreCopySource = serializeDatabaseOperation(readPersonalChoreCopySourceImpl);
export const setPersonalDateTaskCompleted = serializePlannerOperation(setPersonalDateTaskCompletedImpl);
export const setPersonalDateTaskCompletedIntent = serializePlannerOperation((database: SQLiteDatabase, command: PersonalDateTaskCommand,
  intent: PersonalCompletionIntentIdentity, assertAccess: () => void | Promise<void>) => setPersonalDateTaskCompletedImpl(database, command, assertAccess, { ...intent }));
export const importGoogleTaskCompletions = serializePlannerOperation(importGoogleTaskCompletionsImpl, 'importGoogleTaskCompletions');
export const importGoogleTaskChanges = serializePlannerOperation(importGoogleTaskChangesImpl, 'importGoogleTaskChanges');
export const loadPersonalPlacementPreferences = serializeDatabaseOperation(loadPersonalPlacementPreferencesImpl);
export const savePersonalPlacementPreferences = serializePlannerOperation(savePersonalPlacementPreferencesImpl);
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
export const reserveGoogleTaskCreate = serializeDatabaseOperation((database: SQLiteDatabase, identity: GoogleTaskCreateIdentity) =>
  reserveGoogleTaskCreateInside(database, { ...identity, attemptId: createId('google-create'), startedAt: new Date().toISOString() }));
export const rejectGoogleTaskCreate = serializeDatabaseOperation((database: SQLiteDatabase, intent: GoogleTaskCreateIntent) => rejectGoogleTaskCreateInside(database, intent));
export const linkGoogleTaskCreate = serializeDatabaseOperation((database: SQLiteDatabase, identity: GoogleTaskCreateIdentity, taskId: string) => linkGoogleTaskCreateInside(database, identity, taskId));
export const deleteGoogleTaskCreate = serializeDatabaseOperation((database: SQLiteDatabase, identity: GoogleTaskCreateIdentity, taskId: string) => deleteGoogleTaskCreateInside(database, identity, taskId));

const personalTaskReadCaches = new WeakMap<SQLiteDatabase, ReturnType<typeof createGoogleTaskReadCache>>();
export function personalGoogleTaskReadCache(database: SQLiteDatabase) {
  let cache = personalTaskReadCaches.get(database);
  if (!cache) { cache = createGoogleTaskReadCache(work => withPlannerDatabaseOperation(database, () => withIsolatedSqliteTransaction(database, work))); personalTaskReadCaches.set(database, cache); }
  return cache;
}
export function readPersonalGoogleStatusSnapshot(database: SQLiteDatabase, today: LocalDate, householdId = LOCAL_HOUSEHOLD_ID) {
  return withPlannerDatabaseOperation(database, () => withIsolatedSqliteTransaction(database, async tx => {
    const entries = await listEntriesForGoogleSyncImpl(tx, today, householdId);
    const links = await listGoogleTaskLinksImpl(tx, householdId);
    const revisions = new Map(links.filter(link => link.pendingStatusRevision).map(link => [link.scheduleEntryId,link.pendingStatusRevision!]));
    return { entries: entries.map(item => ({ ...item, ...(revisions.has(item.entry.id) ? { localRevision: revisions.get(item.entry.id) } : {}) })),
      links: links.map(link => ({ ...link, ...(revisions.has(link.scheduleEntryId) ? { observedLocalRevision: revisions.get(link.scheduleEntryId) } : {}) })) };
  }));
}
export function personalGoogleTaskCreateJournal(database: SQLiteDatabase) {
  return createGoogleTaskCreateJournal(work => withPlannerDatabaseOperation(database, () => withIsolatedSqliteTransaction(database, work)),
    () => createId('google-create'), () => new Date());
}
