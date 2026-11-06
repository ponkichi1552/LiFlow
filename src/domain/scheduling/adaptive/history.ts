import type { FrequencyMode } from '../../chores/types';
import type { LocalDate } from '../../shared/types';
import { daysBetween, parseLocalDate } from '../local-date.ts';
import { adaptiveReferenceLimit, adaptiveRepresentativeDays, chooseAdaptiveMethod, fitAdaptiveModels, predictAdaptiveDate } from './models.ts';
import type { AdaptiveForecastScore, AdaptiveInterval, AdaptiveMethod, AdaptiveModel } from './models';

export interface AdaptiveHistoryPolicy {
  choreId: string;
  kind: 'personal' | 'shared' | 'seasonal' | 'display';
  mode: FrequencyMode;
  initialDays: Record<FrequencyMode, number | null>;
  enabled: boolean;
  fixedDays: number | null;
  version: string;
  /** Optional one-time setup information. It is not a measured learning observation. */
  planningAnchorDate?: LocalDate;
}
interface HistoryOperation { operationId: string; sequence: number; recordedAt: string }
export type AdaptiveHistoryEvent = HistoryOperation & (
  | { type: 'settings'; mode?: FrequencyMode; enabled?: boolean; fixedDays?: number | null;
      initialDays?: AdaptiveHistoryPolicy['initialDays']; policyVersion?: string }
  | { type: 'complete'; completionId: string; roundId: string; localDate: LocalDate; timeZone: string;
      origin: 'personal' | 'shared'; mode: FrequencyMode; initialDays: number | null;
      /** null is genuinely date-only; missing means its frozen published version is unavailable. */
      displayedWindow: { revision: string; from: LocalDate; through: LocalDate } | null | 'missing';
      ruleDate?: LocalDate }
  | { type: 'undo'; completionId: string; targetOperationId: string }
);
export interface AdaptivePriorForecast {
  id: string; sourceOperationId: string; sourceSequence: number; sourceRevision: string; epoch: string;
  sourceUnitOperationId: string;
  forRoundId: string; createdAt: string; adoptedMethod: AdaptiveMethod;
  dates: Partial<Record<AdaptiveMethod, LocalDate>>;
}
interface Unit {
  operationId: string; completionId: string; date: LocalDate; initialDays: number;
  segment: string; generation: string; ordinal: number;
}
interface NormalizedInterval { ratio: number; segment: string; generation: string }
export interface AdaptiveHistoryState {
  policy: AdaptiveHistoryPolicy; model: AdaptiveModel | null; revision: string; epoch: string;
  lastCompletedDate: LocalDate | null; validUnitCount: number; validIntervalCount: number;
  /** Physical completion can suppress a shared/private duplicate without becoming a learning observation. */
  lastPlanCompletion: { operationId: string; completionId: string; roundId: string; date: LocalDate; origin: 'personal' | 'shared'; ruleDate?: LocalDate } | null;
  scores: AdaptiveForecastScore[]; forecast: AdaptivePriorForecast | null;
  issues: { operationId: string; kind: 'missingWindow' | 'completionPolicyMismatch' }[];
}
const modes: readonly FrequencyMode[] = ['frequent', 'balanced', 'relaxed'];
const finiteDays = (value: number | null) => value === null || Number.isFinite(value) && value > 0;
function copyModel(model: AdaptiveModel | null): AdaptiveModel | null { return model ? { ...model } : null; }
function initialModel(policy: AdaptiveHistoryPolicy): AdaptiveModel | null {
  if (policy.kind !== 'personal') return null;
  const days = policy.fixedDays ?? policy.initialDays[policy.mode];
  return days === null ? null : { method: 'median', days };
}
function calendarMonthsAfter(date: LocalDate, months: number): LocalDate {
  const source = parseLocalDate(date);
  const last = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months + 1, 0));
  const day = Math.min(source.getUTCDate(), last.getUTCDate());
  return new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), day)).toISOString().slice(0, 10) as LocalDate;
}
/** Calendar conversion uses a whole actual calendar period, never time remaining in its current round. */
export function adaptiveModeConversionDays(model: AdaptiveModel, completed: LocalDate): number {
  if (model.method === 'monthEnd') return daysBetween(completed, calendarMonthsAfter(completed, model.months));
  if (model.method === 'weekly') return model.weeks * 7;
  if (model.method === 'alternating') return (model.even + model.odd) / 2;
  return model.days;
}
function checkedEvents(events: readonly AdaptiveHistoryEvent[], fingerprint: (value: unknown) => string): AdaptiveHistoryEvent[] {
  const operations = new Map<string, string>(); const sequences = new Set<number>(); const ordered: AdaptiveHistoryEvent[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (!event.operationId || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isFinite(Date.parse(event.recordedAt))
      || !['settings', 'complete', 'undo'].includes(event.type)) throw new Error('家事の操作記録を確認してください。');
    const serialized = fingerprint(event); const previous = operations.get(event.operationId);
    if (previous !== undefined) { if (previous !== serialized) throw new Error('同じ操作の内容が異なります。'); continue; }
    if (sequences.has(event.sequence)) throw new Error('家事の操作順序が重複しています。');
    operations.set(event.operationId, serialized); sequences.add(event.sequence); ordered.push(event);
  }
  return ordered;
}

/**
 * Replay is used for Undo/recovery, not ordinary rendering. Only an explicitly
 * new final operation may emit a forecast. Stored forecasts must match their
 * original causal revision; replay never backfills historical prediction wins.
 */
export function replayAdaptiveHistory(input: {
  policy: AdaptiveHistoryPolicy; events: readonly AdaptiveHistoryEvent[]; forecasts: readonly AdaptivePriorForecast[];
  fingerprint(value: unknown): string;
  capture?: { afterOperationId: string; forRoundId: string | ((lastPlanCompletionOperationId: string | null) => string); createdAt: string };
}): AdaptiveHistoryState {
  const policy: AdaptiveHistoryPolicy = { ...input.policy, initialDays: { ...input.policy.initialDays } };
  if (policy.planningAnchorDate !== undefined) parseLocalDate(policy.planningAnchorDate);
  if (!policy.choreId || !policy.version || !modes.includes(policy.mode) || typeof policy.enabled !== 'boolean'
    || !['personal', 'shared', 'seasonal', 'display'].includes(policy.kind) || !finiteDays(policy.fixedDays)
    || modes.some(mode => !finiteDays(policy.initialDays[mode]))) throw new Error('家事の初期周期を確認してください。');
  const events = checkedEvents(input.events, input.fingerprint);
  const active = new Map<string, Extract<AdaptiveHistoryEvent, { type: 'complete' }>>();
  const activeRounds = new Map<string, Extract<AdaptiveHistoryEvent, { type: 'complete' }>>();
  const completedByOperation = new Map<string, Extract<AdaptiveHistoryEvent, { type: 'complete' }>>();
  const validatedZones = new Set<string>();
  for (const event of events) {
    if (event.type === 'complete') {
      parseLocalDate(event.localDate);
      if (!event.completionId || !event.roundId || !event.timeZone || !['personal', 'shared'].includes(event.origin)
        || !modes.includes(event.mode) || !finiteDays(event.initialDays)) throw new Error('家事の実施記録を確認してください。');
      if (!validatedZones.has(event.timeZone)) { new Intl.DateTimeFormat('en', { timeZone: event.timeZone }).format(0); validatedZones.add(event.timeZone); }
      if (event.ruleDate !== undefined) parseLocalDate(event.ruleDate);
      if (event.displayedWindow && event.displayedWindow !== 'missing') {
        parseLocalDate(event.displayedWindow.from); parseLocalDate(event.displayedWindow.through);
        if (!event.displayedWindow.revision || event.displayedWindow.from > event.displayedWindow.through) throw new Error('表示済みの実施期間を確認してください。');
      }
      completedByOperation.set(event.operationId, event);
      if (!active.has(event.completionId) && !activeRounds.has(event.roundId)) {
        active.set(event.completionId, event); activeRounds.set(event.roundId, event);
      }
    } else if (event.type === 'undo') {
      const target = completedByOperation.get(event.targetOperationId);
      if (!target || target.completionId !== event.completionId) throw new Error('取り消す実施記録を確認してください。');
      if (active.get(event.completionId)?.operationId === target.operationId) {
        active.delete(event.completionId); activeRounds.delete(target.roundId);
      }
    }
  }
  const activeOperations = new Set([...active.values()].map(event => event.operationId));
  const seenRounds = new Set<string>(); const seenDays = new Set<LocalDate>();
  const units: Unit[] = [];
  const generationUnits = new Map<string, Unit[]>(); const segmentUnits = new Map<string, Unit[]>();
  const intervalByEnd = new Map<string, NormalizedInterval>(); const edgeCounts = new Map<string, number>();
  const appliedOperations = new Set<string>();
  function insertUnit(unit: Unit) {
    const insert = (rows: Unit[]) => {
      let low = 0; let high = rows.length;
      while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].date < unit.date) low = mid + 1; else high = mid; }
      rows.splice(low, 0, unit); return low;
    };
    const all = generationUnits.get(unit.generation) ?? []; const position = insert(all); generationUnits.set(unit.generation, all);
    const current = segmentUnits.get(unit.segment) ?? []; insert(current); segmentUnits.set(unit.segment, current);
    const before = all[position - 1]; const after = all[position + 1];
    function remove(end: Unit | undefined) {
      if (end && intervalByEnd.delete(end.operationId)) edgeCounts.set(unit.generation, (edgeCounts.get(unit.generation) ?? 0) - 1);
    }
    function add(from: Unit | undefined, through: Unit | undefined) {
      if (!from || !through || from.segment !== through.segment || through.date <= from.date) return;
      intervalByEnd.set(through.operationId, { ratio: daysBetween(from.date, through.date) / through.initialDays,
        segment: through.segment, generation: through.generation });
      edgeCounts.set(unit.generation, (edgeCounts.get(unit.generation) ?? 0) + 1);
    }
    remove(after); add(before, unit); add(unit, after); units.push(unit);
  }
  let generation = `initial:${policy.version}`; let segment = generation; let epoch = generation;
  let model = initialModel(policy); let revision = input.fingerprint(['adaptive-history-v1', policy]);
  let lastCompletedDate: LocalDate | null = null;
  let lastUnitOperationId: string | null = null;
  let modeBasis: { mode: FrequencyMode; initialDays: number; model: AdaptiveModel; days: number } | null = null;
  const issues: AdaptiveHistoryState['issues'] = []; const scores: AdaptiveForecastScore[] = [];
  const validForecasts = new Map<string, AdaptivePriorForecast>();
  const sameDayForecastCarry = new Set<string>();
  const forecastBySource = new Map<string, AdaptivePriorForecast[]>();
  for (const forecast of input.forecasts) {
    if (!forecast.id || !forecast.forRoundId || !forecast.sourceUnitOperationId || !Number.isSafeInteger(forecast.sourceSequence) || !Number.isFinite(Date.parse(forecast.createdAt))) throw new Error('保存済みの事前予測を確認してください。');
    for (const date of Object.values(forecast.dates)) parseLocalDate(date);
    forecastBySource.set(forecast.sourceOperationId, [...(forecastBySource.get(forecast.sourceOperationId) ?? []), forecast]);
  }
  let latestCandidates: AdaptiveModel[] = [];
  const eligible = () => policy.kind === 'personal' && policy.enabled && policy.fixedDays === null && policy.initialDays[policy.mode] !== null;
  const fit = (previous: number) => {
    const base = policy.initialDays[policy.mode]; if (base === null) return [];
    const limit = adaptiveReferenceLimit(previous); const tail: NormalizedInterval[] = [];
    const all = generationUnits.get(generation) ?? [];
    for (let i = all.length - 1; i >= 0 && tail.length < limit; i--) {
      const edge = intervalByEnd.get(all[i].operationId); if (edge) tail.push(edge);
    }
    const normalized = tail.reverse().map((row, ordinal) => ({ days: row.ratio * base, ordinal }));
    const allCurrent = segmentUnits.get(segment) ?? []; const start = Math.max(0, allCurrent.length - limit - 1);
    const current = allCurrent.slice(start);
    const currentIntervals: AdaptiveInterval[] = [];
    for (let i = 1; i < current.length; i++) if (current[i].date > current[i - 1].date) currentIntervals.push({ days: daysBetween(current[i - 1].date, current[i].date), ordinal: start + i - 1 });
    return fitAdaptiveModels({ intervals: normalized, currentEpochIntervals: currentIntervals, currentEpochDates: current.map(row => row.date),
      previousRepresentativeDays: previous, retainingAlternating: model?.method === 'alternating' });
  };
  for (const event of events) {
    let applied = false;
    if (event.type === 'settings') {
      if (event.mode !== undefined && !modes.includes(event.mode) || event.enabled !== undefined && typeof event.enabled !== 'boolean'
        || event.fixedDays !== undefined && !finiteDays(event.fixedDays)
        || event.initialDays !== undefined && modes.some(mode => !finiteDays(event.initialDays![mode]))
        || event.policyVersion !== undefined && !event.policyVersion) throw new Error('家事の設定変更を確認してください。');
      const beforeMode = policy.mode; const beforeBase = policy.initialDays[beforeMode];
      const modeChanged = event.mode !== undefined && event.mode !== beforeMode;
      const fixedChanged = event.fixedDays !== undefined && event.fixedDays !== policy.fixedDays;
      const enabledChanged = event.enabled !== undefined && event.enabled !== policy.enabled;
      const basisChanged = event.initialDays !== undefined && modes.some(mode => event.initialDays![mode] !== policy.initialDays[mode])
        || event.policyVersion !== undefined && event.policyVersion !== policy.version;
      if (modeChanged) {
        policy.mode = event.mode!; const nextBase = policy.initialDays[policy.mode];
        if (policy.fixedDays !== null) model = initialModel(policy);
        else if (beforeBase !== null && nextBase !== null && model) {
          if (!modeBasis) {
            if ((model.method === 'monthEnd' || model.method === 'weekly') && !lastCompletedDate) throw new Error('暦周期の実施日を確認してください。');
            modeBasis = { mode: beforeMode, initialDays: beforeBase, model: { ...model },
              days: model.method === 'median' || model.method === 'exponential' ? model.days
                : adaptiveModeConversionDays(model, lastCompletedDate!) };
          }
          model = policy.mode === modeBasis.mode ? copyModel(modeBasis.model)
            : { method: 'median', days: modeBasis.days * nextBase / modeBasis.initialDays };
        } else { model = initialModel(policy); modeBasis = null; }
      }
      if (fixedChanged) {
        policy.fixedDays = event.fixedDays!; model = initialModel(policy); modeBasis = null;
        // Fixed release starts a new learning generation; older raw history remains in input.
        generation = `fixed:${event.operationId}`;
        lastUnitOperationId = null;
      }
      if (enabledChanged) {
        policy.enabled = event.enabled!;
        if (policy.enabled && eligible() && model) {
          const fitted = fit(adaptiveRepresentativeDays(model));
          model = fitted.find(candidate => candidate.method === model!.method) ?? model;
        }
      }
      if (basisChanged) {
        if (event.initialDays) policy.initialDays = { ...event.initialDays };
        if (event.policyVersion) policy.version = event.policyVersion;
        model = initialModel(policy); modeBasis = null; generation = `basis:${event.operationId}`; lastUnitOperationId = null;
      }
      if (modeChanged || fixedChanged || enabledChanged || basisChanged) {
        segment = `settings:${event.operationId}`; epoch = segment; latestCandidates = []; applied = true;
      }
    } else if (event.type === 'complete' && activeOperations.has(event.operationId)) {
      if (seenRounds.has(event.roundId)) continue;
      seenRounds.add(event.roundId);
      if (event.origin === 'shared' || policy.kind !== 'personal') continue;
      if (seenDays.has(event.localDate)) {
        const prior = lastUnitOperationId ? validForecasts.get(lastUnitOperationId) : undefined;
        if (prior && prior.epoch === epoch && (prior.forRoundId === event.roundId || sameDayForecastCarry.has(prior.id))) sameDayForecastCarry.add(prior.id);
        continue;
      }
      seenDays.add(event.localDate); modeBasis = null; applied = true;
      lastCompletedDate = event.localDate;
      const expectedBase = policy.initialDays[policy.mode];
      const matchesPolicy = event.mode === policy.mode && event.initialDays === expectedBase;
      if (!matchesPolicy) issues.push({ operationId: event.operationId, kind: 'completionPolicyMismatch' });
      if (event.displayedWindow === 'missing') issues.push({ operationId: event.operationId, kind: 'missingWindow' });
      if (eligible() && matchesPolicy && expectedBase !== null) {
        const unit: Unit = { operationId: event.operationId, completionId: event.completionId, date: event.localDate,
          initialDays: expectedBase, segment, generation, ordinal: units.length };
        insertUnit(unit);
        const forecast = lastUnitOperationId ? validForecasts.get(lastUnitOperationId) : undefined;
        if (forecast && (forecast.forRoundId === event.roundId || sameDayForecastCarry.has(forecast.id)) && forecast.epoch === epoch
          && forecast.sourceSequence < event.sequence && Date.parse(forecast.createdAt) < Date.parse(event.recordedAt)) {
          scores.push({ epoch, completionId: event.completionId, errors: Object.fromEntries(Object.entries(forecast.dates)
            .map(([method, date]) => [method, Math.abs(daysBetween(date, event.localDate))])) });
        }
        const previousModel = model!;
        latestCandidates = fit(adaptiveRepresentativeDays(previousModel));
        const window = event.displayedWindow;
        const mayUpdate = window !== 'missing' && (window === null || event.localDate < window.from || event.localDate > window.through);
        if (mayUpdate && latestCandidates.length) {
          const selected = chooseAdaptiveMethod(model!.method, scores, epoch, latestCandidates.map(candidate => candidate.method));
          const fitted = latestCandidates.find(candidate => candidate.method === selected);
          if (fitted) {
            const previous = model!;
            model = { ...fitted };
            if (previous.method === model.method && (model.method === 'weekly' || model.method === 'monthEnd')) {
              model.anchor = event.ruleDate ?? (previous as Extract<AdaptiveModel, { method: 'weekly' | 'monthEnd' }>).anchor;
              if (model.method === 'weekly' && previous.method === 'weekly') model.weekday = previous.weekday;
            }
            if (previous.method !== model.method) epoch = `method:${event.operationId}:${model.method}`;
          }
        } else if (model?.method === 'alternating') {
          model = { ...model, nextOrdinal: model.nextOrdinal + 1 };
        }
        if (previousModel.method === model?.method && (model?.method === 'weekly' || model?.method === 'monthEnd') && event.ruleDate) {
          // Closing a calendar round advances its phase even when its interval
          // parameters remain frozen by an in-window completion.
          predictAdaptiveDate(model, event.localDate, event.ruleDate);
          model = { ...model, anchor: event.ruleDate };
        }
        lastUnitOperationId = event.operationId;
      } else { segment = `unobserved:${event.operationId}`; epoch = segment; latestCandidates = []; lastUnitOperationId = null; }
    } else if (event.type === 'undo') applied = true;
    if (applied) { appliedOperations.add(event.operationId); revision = input.fingerprint([revision, event.operationId, policy, model]); }
    for (const forecast of forecastBySource.get(event.operationId) ?? []) {
      if (applied && forecast.sourceSequence === event.sequence && forecast.sourceRevision === revision && forecast.epoch === epoch
        && forecast.sourceUnitOperationId === lastUnitOperationId
        && Date.parse(forecast.createdAt) >= Date.parse(event.recordedAt)) validForecasts.set(forecast.sourceUnitOperationId, forecast);
    }
  }
  const lastPlanEvent = [...active.values()].reduce<Extract<AdaptiveHistoryEvent, { type: 'complete' }> | null>((latest, event) => !latest || event.sequence > latest.sequence ? event : latest, null);
  const capture = input.capture; let forecast: AdaptivePriorForecast | null = null;
  if (capture) {
    const last = events.at(-1);
    const forRoundId = typeof capture.forRoundId === 'function' ? capture.forRoundId(lastPlanEvent?.operationId ?? null) : capture.forRoundId;
    if (!last || capture.afterOperationId !== last.operationId || !forRoundId || !Number.isFinite(Date.parse(capture.createdAt))
      || Date.parse(capture.createdAt) < Date.parse(last.recordedAt)) throw new Error('過去の事前予測は作成できません。');
    if (appliedOperations.has(last.operationId) && eligible() && model && lastCompletedDate && lastUnitOperationId && lastPlanEvent?.origin !== 'shared') {
      const dates: AdaptivePriorForecast['dates'] = {};
      for (const candidate of latestCandidates) dates[candidate.method] = predictAdaptiveDate(candidate, lastCompletedDate);
      // The adopted method is its actual frozen model, never a newly fitted shadow version.
      dates[model.method] = predictAdaptiveDate(model, lastCompletedDate);
      forecast = { id: input.fingerprint(['forecast', revision, forRoundId]), sourceOperationId: last.operationId,
        sourceSequence: last.sequence, sourceRevision: revision, epoch, forRoundId, createdAt: capture.createdAt,
        sourceUnitOperationId: lastUnitOperationId,
        adoptedMethod: model.method, dates };
    }
  }
  const lastPlanCompletion = lastPlanEvent ? { operationId: lastPlanEvent.operationId, completionId: lastPlanEvent.completionId,
    roundId: lastPlanEvent.roundId, date: lastPlanEvent.localDate, origin: lastPlanEvent.origin, ...(lastPlanEvent.ruleDate ? { ruleDate: lastPlanEvent.ruleDate } : {}) } : null;
  return { policy, model, revision, epoch, lastCompletedDate, lastPlanCompletion, validUnitCount: units.filter(row => row.generation === generation).length,
    validIntervalCount: edgeCounts.get(generation) ?? 0, scores, forecast, issues };
}
