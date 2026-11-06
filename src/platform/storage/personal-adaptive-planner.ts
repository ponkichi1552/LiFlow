import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChoreDefinition, ChoreScheduleEntry, ChoreState, FrequencyMode } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import type { AdaptivePlacementLoad, AdaptiveRoundPlacement } from '../../domain/scheduling/adaptive/placement';
import { adaptiveWindowRadius, unionInstantSpans } from '../../domain/scheduling/adaptive/placement.ts';
import { adaptiveRepresentativeDays, adaptiveNextIntervalDays, adaptiveModelIsDaily } from '../../domain/scheduling/adaptive/models.ts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { personalChoreHistoryPolicy, usesPersonalAdaptivePlanner } from '../../domain/chores/personal-catalog.ts';
import { replayAdaptiveHistory } from '../../domain/scheduling/adaptive/history.ts';
import { adaptiveRoundEntry, adaptiveRoundIsProtected, planPersonalAdaptiveRounds } from '../../features/planner/adaptive-rounds.ts';
import type { AdaptiveRoundRequest } from '../../features/planner/adaptive-rounds';
import type { prepareAdaptivePlacementInput } from '../../features/planner/adaptive-input';
import { adaptivePersonalRoundId, applyAdaptivePersonalOperationInside, initializeAdaptivePersonalChoreInside,
  readAllAdaptivePersonalInside, readAdaptivePersonalInside, replanAdaptivePersonalInside } from './adaptive-personal-chores.ts';
import type { AdaptivePersonalOperation, AdaptivePersonalPlanning, AdaptivePersonalReceipt, AdaptivePersonalView } from './adaptive-personal-chores';
import { personalChoreUsesWeather } from '../../features/weather/chore-weather.ts';
import { createMetWeatherEvaluator } from '../../../server/appliance-care-api/src/weather/forecast.mjs';

type Geometry = ReturnType<typeof prepareAdaptivePlacementInput>;
type Fingerprint = (value: unknown) => string;
export interface PersonalAdaptiveContext {
  clothingRegion?: import('../../domain/scheduling/adaptive/seasonal').ClothingRegion;
  householdId: string; ownerId: string; today: LocalDate; now: string; mode: FrequencyMode;
  chores: readonly ChoreDefinition[]; states: readonly ChoreState[];
  assignedMemberIds(choreId: string): readonly string[];
  /** Original timing/configuration revision, independent of screen render, current hour and today's date. */
  sourceRevision: string;
  prepareGeometry(): Promise<Geometry> | Geometry;
  fixedLoads: readonly AdaptivePlacementLoad[];
  /** Internal cache provenance, kept separate from spent work on the same seasonal round. */
  seasonalPendingRoundIds?: ReadonlySet<string>;
  /** A linked common chore supplies its load once; the private definition/history remains intact. */
  suppressedChoreIds?: ReadonlySet<string>;
  assertInputsCurrent(): Promise<void> | void;
  fingerprint: Fingerprint;
}
interface SavedInput { sourceRevision: string; geometry: Geometry; definitions: Record<string, string>; fixedLoads?: readonly AdaptivePlacementLoad[]; suppressedChoreIds?: readonly string[] }
function definitionSignature(chore: ChoreDefinition, fingerprint: Fingerprint) {
  return fingerprint([chore.enabled, chore.estimatedMinutes, chore.load, chore.holidayPriority, chore.userWindowRadiusDays,
    chore.recommendedCycleDays, chore.userIntervalDays, chore.frequencyDaysByMode, chore.laundryDryingPreference]);
}
function loadFor(chore: ChoreDefinition, plan: AdaptiveRoundPlacement): AdaptivePlacementLoad {
  return { roundId: plan.id, date: plan.recommendedDate, minutes: chore.estimatedMinutes ?? null, load: chore.load, slot: plan.slot };
}
function requests(input: PersonalAdaptiveContext, views: ReadonlyMap<string, AdaptivePersonalView>, ids: ReadonlySet<string>,
  trigger: AdaptiveRoundRequest['trigger']): AdaptiveRoundRequest[] {
  return input.chores.flatMap(chore => {
    const view = views.get(chore.id);
    return !input.suppressedChoreIds?.has(chore.id) && ids.has(chore.id) && view?.state.policy.enabled && view.state.model ? [{ chore, roundId: adaptivePersonalRoundId(chore.id, view.state, input.fingerprint),
      state: view.state, previous: view.plan, trigger }] : [];
  });
}
function allocate(input: PersonalAdaptiveContext, geometry: Geometry, views: ReadonlyMap<string, AdaptivePersonalView>, tasks: readonly AdaptiveRoundRequest[]) {
  const ids = new Set(tasks.map(task => task.chore.id));
  const fixedLoads = [...input.fixedLoads, ...input.chores.flatMap(chore => {
    const plan = views.get(chore.id)?.plan; return !input.suppressedChoreIds?.has(chore.id) && !ids.has(chore.id) && plan ? [loadFor(chore, plan)] : [];
  })];
  return planPersonalAdaptiveRounds({ requests: tasks, geometry, ownerId: input.ownerId, today: input.today, now: Date.parse(input.now),
    fixedLoads, fingerprint: input.fingerprint });
}
function planning(input: PersonalAdaptiveContext, geometry: Geometry | (() => Geometry | Promise<Geometry>), views: Map<string, AdaptivePersonalView>, phase: string,
  prepared?: ReadonlyMap<string, AdaptiveRoundPlacement>, globalModeChange = false): AdaptivePersonalPlanning {
  return { today: input.today, now: input.now, inputRevision: input.fingerprint([input.sourceRevision, phase]), assertInputsCurrent: input.assertInputsCurrent,
    async plan({ roundId, state, previous, trigger }) {
      if (prepared?.has(roundId)) return prepared.get(roundId)!;
      const chore = input.chores.find(chore => chore.id === state.policy.choreId);
      if (!chore) throw new Error('対象の個人家事が見つかりません。');
      return allocate(input, typeof geometry === 'function' ? await geometry() : geometry, views, [{ chore, roundId, state, previous, trigger, globalModeChange }]).get(roundId)!;
    } };
}
function searchableDates(view: AdaptivePersonalView, chore: ChoreDefinition) {
  if (!view.plan || !view.state.model) return null;
  const anchor = view.state.lastPlanCompletion?.date ?? view.state.policy.planningAnchorDate;
  const period = anchor ? adaptiveNextIntervalDays(view.state.model, anchor) : adaptiveRepresentativeDays(view.state.model);
  const radius = chore.userWindowRadiusDays ?? adaptiveWindowRadius(period);
  const width = radius * 2 + 1; const extent = radius + Math.floor(width * 1.2) + (radius ? Math.floor(width * 1.5) - width : 0);
  const from = addDays(view.plan.originalBaseDate, -extent); const through = addDays(view.plan.originalBaseDate, extent);
  return { from: from < view.plan.recommendedDate ? from : view.plan.recommendedDate,
    through: through > view.plan.recommendedDate ? through : view.plan.recommendedDate };
}
function changedGeometryDates(before: Geometry | null, after: Geometry, fingerprint: Fingerprint): Set<LocalDate> {
  const result = new Set<LocalDate>(); const priorDays = new Map(before?.days.map(day => [day.date, day]) ?? []);
  const nextDays = new Map(after.days.map(day => [day.date, day]));
  const previousBusy = new Set(before?.busy.map(span => JSON.stringify(span)) ?? []);
  const nextBusy = new Set(after.busy.map(span => JSON.stringify(span)));
  const changed = unionInstantSpans([...(before?.busy ?? []).filter(span => !nextBusy.has(JSON.stringify(span))),
    ...after.busy.filter(span => !previousBusy.has(JSON.stringify(span)))]);
  let position = 0;
  const days = [...new Map([...priorDays, ...nextDays]).values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of days) {
    if (fingerprint(priorDays.get(day.date) ?? null) !== fingerprint(nextDays.get(day.date) ?? null)) { result.add(day.date); continue; }
    while (position < changed.length && changed[position].end <= day.bounds.start) position++;
    if (changed[position]?.start < day.bounds.end) result.add(day.date);
  }
  return result;
}
/** Recalculate the connected set sharing candidate dates. Fixed/today/tomorrow rounds are immutable inputs. */
function affected(input: PersonalAdaptiveContext, views: ReadonlyMap<string, AdaptivePersonalView>, previous: SavedInput | null,
  geometry: Geometry, explicitlyChanged: ReadonlySet<string>) {
  const changedDays = changedGeometryDates(previous?.geometry ?? null, geometry, input.fingerprint);
  const priorLoads = new Map((previous?.fixedLoads ?? []).map(load => [load.roundId, load]));
  const nextLoads = new Map(input.fixedLoads.map(load => [load.roundId, load]));
  for (const id of new Set([...priorLoads.keys(), ...nextLoads.keys()])) {
    const before = priorLoads.get(id); const after = nextLoads.get(id);
    if (input.fingerprint(before ?? null) === input.fingerprint(after ?? null)) continue;
    for (const load of [before, after]) if (load) {
      changedDays.add(load.date);
      if (load.slot) for (const day of geometry.days) if (day.bounds.start < load.slot.end && day.bounds.end > load.slot.start) changedDays.add(day.date);
    }
  }
  const newWeather = createMetWeatherEvaluator(geometry.weatherForecast);
  const weatherDays = geometry.weatherForecast ? geometry.days.filter(day => {
    const relevant = (value: Geometry | null) => value?.weatherForecast?.intervals.filter(row => row.start < day.bounds.end && row.end > day.bounds.start) ?? [];
    return input.fingerprint(relevant(previous?.geometry ?? null)) !== input.fingerprint(relevant(geometry));
  }).map(day => day.date) : [];
  const candidates = input.chores.flatMap(chore => {
    const view = views.get(chore.id);
    if (input.suppressedChoreIds?.has(chore.id) || !view?.state.model || !view.plan || !chore.enabled || adaptiveRoundIsProtected(view.plan, input.today, adaptiveModelIsDaily(view.state.model))) return [];
    const range = searchableDates(view, chore)!;
    return [{ chore, range, changed: explicitlyChanged.has(chore.id) || previous?.definitions[chore.id] !== definitionSignature(chore, input.fingerprint)
      || previous?.suppressedChoreIds?.includes(chore.id) || [...changedDays].some(date => date >= range.from && date <= range.through)
      || personalChoreUsesWeather(chore) && Boolean(view.plan.slot && newWeather?.evaluate(view.plan.slot.start, view.plan.slot.end).known)
        && weatherDays.some(date => date >= range.from && date <= range.through) }];
  });
  const ids = new Set(candidates.filter(row => row.changed).map(row => row.chore.id));
  const queue = candidates.filter(row => row.changed);
  for (let i = 0; i < queue.length; i++) for (const row of candidates) {
    if (!ids.has(row.chore.id) && row.range.from <= queue[i].range.through && row.range.through >= queue[i].range.from) { ids.add(row.chore.id); queue.push(row); }
  }
  return ids;
}
async function requireTransaction(database: SQLiteDatabase) {
  if (!await database.isInTransactionAsync()) throw new Error('個人家事と予定は同じトランザクションで保存してください。');
}
async function savedInput(database: SQLiteDatabase, householdId: string): Promise<SavedInput | null> {
  const row = await database.getFirstAsync<{ source_revision: string; geometry_json: string }>('SELECT source_revision,geometry_json FROM personal_adaptive_inputs WHERE household_id=?', householdId);
  if (!row) return null; const parsed = JSON.parse(row.geometry_json) as Omit<SavedInput, 'sourceRevision'>;
  if (!parsed.geometry || !parsed.definitions) throw new Error('保存された個人予定の計算版を確認してください。');
  return { ...parsed, sourceRevision: row.source_revision };
}
function currentDefinitions(input: PersonalAdaptiveContext) {
  return Object.fromEntries(input.chores.map(chore => [chore.id, definitionSignature(chore, input.fingerprint)]));
}
async function saveInput(database: SQLiteDatabase, input: PersonalAdaptiveContext, geometry: Geometry) {
  await input.assertInputsCurrent();
  await database.runAsync(`INSERT INTO personal_adaptive_inputs VALUES(?,?,?) ON CONFLICT(household_id)
    DO UPDATE SET source_revision=excluded.source_revision,geometry_json=excluded.geometry_json`, input.householdId, input.sourceRevision,
  JSON.stringify({ geometry, definitions: currentDefinitions(input), fixedLoads: input.fixedLoads, suppressedChoreIds: [...input.suppressedChoreIds ?? []].sort() }));
}

/** Initial generation and legitimate input changes only. Render/day passage reads the durable projection. */
export async function synchronizePersonalAdaptiveInside(database: SQLiteDatabase, input: PersonalAdaptiveContext) {
  await requireTransaction(database); const views = await readAllAdaptivePersonalInside(database);
  const previous = await savedInput(database, input.householdId);
  const ownChores = input.chores.filter(chore => usesPersonalAdaptivePlanner(chore) && !chore.archived && personalChoreHistoryPolicy(chore, input.mode).kind === 'personal');
  if (!ownChores.length) return views;
  const missing = ownChores.filter(chore => chore.enabled && !views.has(chore.id));
  const policyChanged = ownChores.filter(chore => {
    const view = views.get(chore.id); if (!view) return false;
    const policy = personalChoreHistoryPolicy(chore, input.mode);
    return view.state.policy.mode !== input.mode || view.state.policy.enabled !== policy.enabled
      || view.state.policy.fixedDays !== policy.fixedDays || view.state.policy.version !== policy.version
      || (['frequent', 'balanced', 'relaxed'] as const).some(mode => view.state.policy.initialDays[mode] !== policy.initialDays[mode]);
  });
  const definitionChanges = ownChores.filter(chore => previous?.definitions[chore.id] !== definitionSignature(chore, input.fingerprint));
  const sourceChanged = previous?.sourceRevision !== input.sourceRevision;
  if (!sourceChanged && !missing.length && !policyChanged.length && !definitionChanges.length) return views;
  const geometry = await input.prepareGeometry(); const changedIds = new Set<string>();
  const initialRequests = missing.flatMap(chore => {
    if (input.suppressedChoreIds?.has(chore.id)) return [];
    const policy = personalChoreHistoryPolicy(chore, input.mode);
    if (policy.kind !== 'personal') return [];
    const anchor = input.states.find(state => state.choreId === chore.id)?.lastCompletedDate;
    if (anchor) policy.planningAnchorDate = anchor;
    const state = replayAdaptiveHistory({ policy, events: [], forecasts: [], fingerprint: input.fingerprint });
    return state.model ? [{ chore, state, previous: null, roundId: adaptivePersonalRoundId(chore.id, state, input.fingerprint), trigger: 'initial' as const }] : [];
  });
  const initialPlans = allocate(input, geometry, views, initialRequests);
  for (const chore of missing) {
    const policy = personalChoreHistoryPolicy(chore, input.mode); if (policy.kind !== 'personal') continue;
    const anchor = input.states.find(state => state.choreId === chore.id)?.lastCompletedDate;
    if (anchor) policy.planningAnchorDate = anchor;
    const view = await initializeAdaptivePersonalChoreInside(database, policy, planning(input, geometry, views, 'initial', initialPlans), input.fingerprint);
    views.set(chore.id, view);
  }
  for (const chore of policyChanged) {
    const current = views.get(chore.id)!; const globalModeChange = current.state.policy.mode !== input.mode;
    const policy = personalChoreHistoryPolicy(chore, input.mode);
    const operation: AdaptivePersonalOperation = { operationId: `adaptive-settings.${input.fingerprint([chore.id, current.revision, policy])}`,
      type: 'settings', recordedAt: input.now, mode: input.mode, enabled: policy.enabled, fixedDays: policy.fixedDays,
      initialDays: policy.initialDays, policyVersion: policy.version };
    await applyAdaptivePersonalOperationInside(database, chore.id, operation, planning(input, geometry, views, operation.operationId, undefined, globalModeChange), input.fingerprint);
    views.set(chore.id, (await readAdaptivePersonalInside(database, chore.id))!); changedIds.add(chore.id);
  }
  const targets = affected(input, views, previous, geometry, changedIds);
  // An initial plan is already globally allocated. Do not immediately replace
  // its stable first range with ordinary automatic-window exploration.
  for (const chore of missing) targets.delete(chore.id);
  const plans = allocate(input, geometry, views, requests(input, views, targets, 'replan'));
  for (const choreId of targets) views.set(choreId, await replanAdaptivePersonalInside(database, choreId,
    planning(input, geometry, views, `input:${input.sourceRevision}`, plans), input.fingerprint));
  await saveInput(database, input, geometry);
  return views;
}

/** Same transaction as the completion projection and Google pending status; no whole-app refresh or network here. */
export async function applyPersonalAdaptiveInside(database: SQLiteDatabase, input: PersonalAdaptiveContext, choreId: string,
  operation: AdaptivePersonalOperation): Promise<AdaptivePersonalReceipt> {
  await requireTransaction(database);
  const views = await readAllAdaptivePersonalInside(database); const current = views.get(choreId);
  if (!current) throw new Error('実施対象の個人家事を初期化してください。');
  const result = await applyAdaptivePersonalOperationInside(database, choreId, operation,
    planning(input, input.prepareGeometry, views, operation.operationId), input.fingerprint);
  // Do not refill other rounds after a completion/Undo. Their next legitimate
  // calendar/settings input change will use the new current reservations.
  return result;
}
export function personalAdaptiveEntries(input: Pick<PersonalAdaptiveContext, 'chores' | 'today' | 'assignedMemberIds'>,
  views: ReadonlyMap<string, AdaptivePersonalView>): ChoreScheduleEntry[] {
  return input.chores.flatMap(chore => {
    const view = views.get(chore.id); if (!view) return [];
    const entry = adaptiveRoundEntry({ chore, plan: view.plan, state: view.state, today: input.today, assignedMemberIds: input.assignedMemberIds(chore.id) });
    return entry ? [entry] : [];
  });
}

/** Dates in the input are intentionally absent: advancing the clock is not a placement trigger. */
export function personalAdaptiveSourceRevision(input: { mode: FrequencyMode; timeZone: string; preferences: unknown;
  calendarTiming: unknown; sharedLoads: unknown; weatherRevision?: string }, fingerprint: Fingerprint) {
  return fingerprint(['adaptive-source-v1', input]);
}

