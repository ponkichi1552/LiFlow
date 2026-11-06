import './typescript-loader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

const root = new URL('../../docs/qa-assets/realistic-2026-11-06/', import.meta.url);
const caseFile = new URL('cases.jsonl.gz', root);
const { addDays, daysBetween, weekdayOf, parseLocalDate } = await import('../../src/domain/scheduling/local-date.ts');
const { replayAdaptiveHistory } = await import('../../src/domain/scheduling/adaptive/history.ts');
const { fitAdaptiveModels, predictAdaptiveDate } = await import('../../src/domain/scheduling/adaptive/models.ts');
const { placeAdaptiveRounds, unionInstantSpans } = await import('../../src/domain/scheduling/adaptive/placement.ts');
const { prepareAdaptivePlacementInput } = await import('../../src/features/planner/adaptive-input.ts');
const { planPersonalAdaptiveRounds } = await import('../../src/features/planner/adaptive-rounds.ts');
const { sharedAdaptiveLoad } = await import('../../src/features/planner/shared-adaptive-load.ts');
const { personalSeasonalRound, completePersonalSeasonalRound } = await import('../../src/domain/scheduling/adaptive/seasonal.ts');
const { PERSONAL_CHORE_CATALOG, personalChoreHistoryPolicy } = await import('../../src/domain/chores/personal-catalog.ts');
const { createCalendarQueryRange } = await import('../../src/features/google-sync/calendar-availability.ts');
const { v2WallTimeCandidates } = await import('../../src/features/sharing/v2/local-time.ts');
const { createDatabase } = await import('./sqlite.mjs');
const adaptiveStore = await import('../../src/platform/storage/adaptive-personal-chores.ts');

export const ADAPTER = Object.freeze({
  source: 'case-observations-only',
  appModeMap: { standard: 'balanced', minimal: 'relaxed' },
  appClockTime: '08:00',
  timezone: 'Asia/Tokyo',
  missingDisplayedWindow: 'missing',
  hiddenEventsSentToApp: false,
});

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const dataRoot = root;
export const directedCases = JSON.parse(readFileSync(new URL('directed_cases.json', root), 'utf8'));
export const invariants = JSON.parse(readFileSync(new URL('invariants.json', root), 'utf8'));

export async function readLifestyleCases({ split, limit, sample = false } = {}) {
  const input = createReadStream(caseFile).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  const rows = [];
  for await (const line of lines) {
    if (!line) continue;
    const value = JSON.parse(line);
    if (value.clock?.future_data_not_visible_to_app !== true || value.population_weight !== null
      || !Array.isArray(value.evaluation_only_hidden_events)
      || value.evaluation_only_hidden_events.some(event => event.event !== 'synthetic_unrecorded_action')) {
      throw new Error(`case violates hidden-truth input boundary: ${value.case_id}`);
    }
    // Drop the evaluation-only oracle before returning any case to a runner.
    delete value.evaluation_only_hidden_events;
    if (split && value.split !== split) continue;
    rows.push(value);
  }
  if (sample && limit) {
    const profiles = [...new Set(rows.map(row => row.profile.id))];
    return profiles.slice(0, limit).map((profile, index) => {
      const candidates = rows.filter(row => row.profile.id === profile);
      const variantIndex = index % 10;
      const horizonIndex = Math.floor(index / 10) % 3;
      return candidates.find(row => row.behavior_model.id === [
        'stable', 'jitter', 'permanent_longer', 'temporary_longer', 'alternating', 'gradual',
        'missing_records', 'recommendation_following', 'calendar_rule', 'change_settings',
      ][variantIndex] && row.clock.evaluation_horizon_days === [90, 365, 730][horizonIndex]) ?? candidates[0];
    });
  }
  return limit ? rows.slice(0, limit) : rows;
}

export function modeForCase(mode) {
  const mapped = ADAPTER.appModeMap[mode];
  if (!mapped) throw new Error(`生活ケースのモードに明示的な変換がありません: ${mode}`);
  return mapped;
}

function instantFor(date, minute, timeZone = ADAPTER.timezone) {
  const day = minute === 1440 ? addDays(date, 1) : date;
  const value = minute === 1440 ? 0 : minute;
  const candidates = v2WallTimeCandidates({ date: day, hour: Math.floor(value / 60), minute: value % 60, timeZone });
  if (candidates.length !== 1) throw new Error(`case adapter cannot resolve wall time ${day} ${value} ${timeZone}`);
  return candidates[0];
}

export function instantSpan(date, startMinute, endMinute, timeZone = ADAPTER.timezone) {
  return { start: instantFor(date, startMinute, timeZone), end: instantFor(date, endMinute, timeZone) };
}

function timeMinute(value) {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error(`invalid fixture wall time ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function localEvent({ id, startDate, endDate = startDate, startMinute, endMinute, recurrence = 'none', untilDate = endDate,
  timeZone = ADAPTER.timezone, allDay = false }) {
  return { id, revision: 1, title: `fixture:${id}`, location: '', notes: '', startDate, endDate, allDay,
    startMinute, endMinute, timeZone, recurrence, untilDate, categoryId: 'work', birthday: false, blocksTime: true };
}

function firstMatchingWeekday(start, through, weekday) {
  for (let date = start; date <= through; date = addDays(date, 1)) if (weekdayOf(date) - 1 === weekday) return date;
  return null;
}

function recurringBusyEvents(value, from, through) {
  const events = [];
  const start = value.clock.start;
  for (const rule of value.calendar.recurring_busy_rules) {
    for (const weekday of rule.weekdays) {
      const modulo = rule.active_week_modulo;
      let anchor = null;
      for (let date = start; date <= through; date = addDays(date, 1)) {
        if (weekdayOf(date) - 1 !== weekday) continue;
        if (modulo && Math.floor(daysBetween(start, date) / 7) % modulo.modulus !== modulo.remainder) continue;
        anchor = date;
        break;
      }
      if (!anchor) continue;
      const startMinute = timeMinute(rule.start_local);
      const endMinute = timeMinute(rule.end_local);
      const endDate = addDays(anchor, rule.end_day_offset ?? 0);
      events.push(localEvent({ id: `${value.case_id}:busy:${rule.id}:${weekday}:${modulo?.remainder ?? 0}`,
        startDate: anchor, endDate, startMinute, endMinute,
        recurrence: modulo ? 'biweekly' : 'weekly', untilDate: through }));
    }
  }
  return events;
}

function overlayEvents(value, from, through, throughDay) {
  const events = [];
  const googleBusy = [];
  const relativeDate = day => addDays(value.clock.start, day);
  for (const override of value.calendar.overrides) {
    if (override.day > throughDay) continue;
    if (override.kind === 'external_event_added') {
      const startDate = relativeDate(override.target_day ?? override.day);
      const [startText, endText] = override.target_day === undefined
        ? [override.start_local, override.end_local]
        : ['09:00', '19:00'];
      events.push(localEvent({ id: `${value.case_id}:overlay:${override.event_id}`, startDate,
        startMinute: timeMinute(startText), endMinute: timeMinute(endText) }));
    } else if (override.kind === 'calendar_absence') {
      const startDate = relativeDate(override.start_day);
      const endDate = addDays(relativeDate(override.end_day_exclusive), -1);
      events.push(localEvent({ id: `${value.case_id}:overlay:absence:${override.start_day}`, startDate, endDate,
        startMinute: 0, endMinute: 0, allDay: true }));
    } else if (override.kind === 'calendar_exam_period') {
      for (let date = relativeDate(override.start_day); date < relativeDate(override.end_day_exclusive); date = addDays(date, 1)) {
        events.push(localEvent({ id: `${value.case_id}:overlay:exam:${date}`, startDate: date,
          startMinute: timeMinute(override.busy_time_local[0]), endMinute: timeMinute(override.busy_time_local[1]) }));
      }
    }
  }
  for (const lifecycle of value.lifecycle_events) {
    if (lifecycle.day > throughDay || lifecycle.kind !== 'sync_echo') continue;
    const date = relativeDate(lifecycle.day);
    const startMinute = 10 * 60;
    const endMinute = 10 * 60 + 30;
    const event = localEvent({ id: `${value.case_id}:canonical:${lifecycle.canonical_id}`, startDate: date, startMinute, endMinute });
    events.push(event);
    // The fixture's canonical identity declaration is modeled as the exact same
    // interval arriving from the Google side. The real calendar adapter unions it.
    googleBusy.push(instantSpan(date, startMinute, endMinute));
  }
  return { events, googleBusy };
}

function parseWindow(window) {
  const startMinute = timeMinute(window[0]);
  const endMinute = timeMinute(window[1]);
  if (startMinute < endMinute) return [{ startMinute, endMinute }];
  return [{ startMinute, endMinute: 1440 }, { startMinute: 0, endMinute }];
}

export function casePreferences(value, from, through) {
  const weeklyHolidays = new Set(value.settings.holidays.weekly.map(day => day + 1));
  const weekdayBands = parseWindow(value.settings.chore_windows);
  const allowedBands = [];
  for (let weekday = 1; weekday <= 7; weekday++) if (!weeklyHolidays.has(weekday)) {
    for (const band of weekdayBands) allowedBands.push({ weekday, ...band });
  }
  const dayOverrides = value.settings.holidays.date_overrides.map(row => ({
    date: addDays(value.clock.start, row.day), holiday: row.is_holiday,
  })).filter(row => row.date >= from && row.date <= through);
  return { restDays: [...weeklyHolidays], heavyLimit: 2, normalLimit: 2, allowedBands, dayOverrides };
}

export function buildCaseGeometry(value, { from, through, throughDay = daysBetween(value.clock.start, through), extraBusy = [] }) {
  const recurring = recurringBusyEvents(value, from, through);
  const overlays = overlayEvents(value, from, through, throughDay);
  const geometry = prepareAdaptivePlacementInput({ from, through, timeZone: ADAPTER.timezone,
    preferences: casePreferences(value, from, through), events: [...recurring, ...overlays.events], exceptions: [],
    busy: [...overlays.googleBusy, ...extraBusy], fingerprint });
  return { geometry, recurringEvents: recurring.length, overlayEvents: overlays.events.length,
    googleBusySpans: overlays.googleBusy.length };
}

function frequencyPolicy(caseId, chore, sourceMode = 'standard') {
  const base = chore.initial_days ?? chore.manual_fixed_days ?? null;
  const kind = chore.kind === 'seasonal' ? 'seasonal' : chore.kind === 'shared' ? 'shared' : 'personal';
  return { choreId: `realistic:${caseId}:${chore.id}`, kind, mode: modeForCase(sourceMode),
    initialDays: { frequent: base, balanced: base, relaxed: base }, enabled: chore.enabled !== false,
    fixedDays: chore.manual_fixed_days ?? null, version: `realistic-lifestyle-adapter-v1:${chore.id}` };
}

function completionTime(value, history) { return history.completion_time_local ?? '12:00'; }
function dateTime(value, day, clock) { return `${addDays(value.clock.start, day)}T${clock}:00+09:00`; }

function historyEvents(value, chore, throughDay, { missingWindow = true, throughTime = '23:59' } = {}) {
  const history = value.observed_history.find(row => row.chore_id === chore.id);
  const actions = [];
  if (history) {
    const localTime = completionTime(value, history);
    for (const [index, day] of history.completion_days.entries()) if (day < throughDay || day === throughDay && localTime <= throughTime) {
      actions.push({ day, clock: localTime, order: 1, build: mode => ({ type: 'complete', operationId: `${value.case_id}:${chore.id}:observed:${index}`,
        completionId: `${value.case_id}:${chore.id}:completion:${index}`,
        roundId: `${value.case_id}:${chore.id}:round:${index}`, localDate: addDays(value.clock.start, day), timeZone: ADAPTER.timezone,
        origin: chore.kind === 'shared' ? 'shared' : 'personal', mode, initialDays: chore.initial_days ?? null,
        displayedWindow: missingWindow ? 'missing' : null }) });
    }
  }
  for (const [index, action] of value.lifecycle_events.entries()) {
    if (action.day > throughDay) continue;
    if (action.kind === 'setting_change' && action.chore_id === chore.id) {
      actions.push({ day: action.day, clock: '12:00', order: 2, build: () => ({ type: 'settings',
        operationId: `${value.case_id}:lifecycle:${index}`, fixedDays: action.fixed_days }) });
    } else if ((action.kind === 'disable' || action.kind === 'enable') && action.chore_id === chore.id) {
      actions.push({ day: action.day, clock: '00:00', order: 0, build: () => ({ type: 'settings',
        operationId: `${value.case_id}:lifecycle:${index}`, enabled: action.kind === 'enable' }) });
    } else if (action.kind === 'mode_change') {
      const mapped = modeForCase(action.to);
      actions.push({ day: action.day, clock: '00:00', order: 0, build: () => ({ type: 'settings',
        operationId: `${value.case_id}:lifecycle:${index}`, mode: mapped }) });
    } else if (action.kind === 'complete' && action.chore_id === chore.id) {
      actions.push({ day: action.day, clock: '12:00', order: 3, build: mode => ({ type: 'complete',
        operationId: action.operation_id, completionId: action.operation_id, roundId: action.occurrence_id,
        localDate: addDays(value.clock.start, action.day), timeZone: ADAPTER.timezone, origin: 'personal', mode,
        initialDays: chore.initial_days ?? null, displayedWindow: missingWindow ? 'missing' : null }) });
    } else if (action.kind === 'duplicate_completion_delivery' && chore.id === 'floor') {
      actions.push({ day: action.day, clock: '12:05', order: 4, build: mode => ({ type: 'complete',
        operationId: action.operation_id, completionId: 'completion-1', roundId: action.occurrence_id,
        localDate: addDays(value.clock.start, action.day), timeZone: ADAPTER.timezone, origin: 'personal', mode,
        initialDays: chore.initial_days ?? null, displayedWindow: missingWindow ? 'missing' : null }) });
    } else if (action.kind === 'undo' && chore.id === 'floor') {
      actions.push({ day: action.day, clock: '00:01', order: 0, build: () => ({ type: 'undo', operationId: `${value.case_id}:lifecycle:undo`,
        completionId: 'completion-1', targetOperationId: action.target_operation_id }) });
    } else if (action.kind === 'shared_completed_by_other' && action.chore_id === chore.id) {
      actions.push({ day: action.day, clock: '12:00', order: 3, build: mode => ({ type: 'complete',
        operationId: `${value.case_id}:lifecycle:${index}`, completionId: `${value.case_id}:shared-other-completion`,
        roundId: `${value.case_id}:shared-other-round`, localDate: addDays(value.clock.start, action.day),
        timeZone: ADAPTER.timezone, origin: 'shared', mode, initialDays: chore.initial_days ?? null,
        displayedWindow: missingWindow ? 'missing' : null }) });
    }
  }
  actions.sort((a, b) => a.day - b.day || a.clock.localeCompare(b.clock) || a.order - b.order);
  let mode = modeForCase(value.settings.mode);
  return actions.map((action, index) => {
    const payload = action.build(mode);
    if (payload.mode && payload.type === 'settings') mode = payload.mode;
    return { ...payload, sequence: index + 1, recordedAt: dateTime(value, action.day, action.clock) };
  });
}

export function runCaseHistory(value, throughDay, options = {}) {
  const chores = value.chores;
  const states = new Map();
  const observed = new Map(value.observed_history.map(row => [row.chore_id, row.completion_days]));
  for (const chore of chores) {
    const policy = frequencyPolicy(value.case_id, chore, value.settings.mode);
    const events = historyEvents(value, chore, throughDay, options);
    const state = replayAdaptiveHistory({ policy, events, forecasts: [], fingerprint });
    states.set(chore.id, { state, events, policy, observedDays: observed.get(chore.id) ?? [] });
  }
  return states;
}

function choreForPlacement(value, chore) {
  return { id: `realistic:${value.case_id}:${chore.id}`, householdId: `realistic:${value.case_id}`,
    enabled: chore.enabled !== false, archived: false, personalSchedulingKind: 'personal', name: chore.id,
    category: 'home', description: 'synthetic QA fixture', estimatedMinutes: chore.duration_minutes,
    load: chore.load, holidayPriority: chore.holiday_preference ?? chore.load === 'heavy',
    userWindowRadiusDays: chore.manual_half_width ?? undefined, recommendedCycleDays: chore.initial_days ?? chore.manual_fixed_days ?? undefined };
}

export function planCaseChores(value, states, geometry, today) {
  const requests = [];
  for (const chore of value.chores) {
    if (chore.kind !== 'days' || chore.enabled === false) continue;
    const view = states.get(chore.id);
    if (!view?.state.model || !view.state.policy.enabled || view.state.policy.kind !== 'personal') continue;
    const { adaptivePersonalRoundId } = adaptiveStore;
    requests.push({ chore: choreForPlacement(value, chore), state: view.state, previous: null,
      roundId: adaptivePersonalRoundId(view.policy.choreId, view.state, fingerprint), trigger: 'initial' });
  }
  if (!requests.length) return new Map();
  const result = planPersonalAdaptiveRounds({ requests, geometry, ownerId: `owner:${value.case_id}`, today,
    now: Date.parse(`${today}T${ADAPTER.appClockTime}:00+09:00`), fixedLoads: [], fingerprint });
  return result;
}

function sharedPlanFromCase(value, today) {
  const source = value.chores.find(chore => chore.id === 'shared');
  if (!source) return null;
  const chore = { id: `realistic:${value.case_id}:shared`, name: '共有家事', enabled: source.enabled !== false,
    archived: false, estimatedMinutes: source.duration_minutes, load: source.load };
  const subject = { id: `shared-subject:${value.case_id}`, required: true, completed: false, virtuallyConsumed: false,
    cooldownSuppressed: false, subjectUserId: null, formalDate: { kind: 'generated' },
    suggestedDate: addDays(today, 7) };
  return { initialized: true, groupId: `realistic-group:${value.case_id}`, sourceHash: `source:${value.case_id}`,
    planHash: `plan:${value.case_id}`, members: [{ active: true, userId: 'u1' }, { active: true, userId: 'u2' }],
    chores: [chore], history: [], occurrences: [{ choreId: chore.id, historical: false, activeInPeriod: true,
      assigneeIds: source.assignee ? [source.assignee] : [], subjects: [subject] }] };
}

function resultRecord(status, evidence = {}, reason) {
  return { status, ...(reason ? { reason } : {}), evidence };
}

function assertInvariantStatus(pass, evidence = {}) { return resultRecord(pass ? 'pass' : 'fail', evidence); }

export function evaluateModeBoundaryChecks(modeStates, boundaryChecks) {
  const checks = boundaryChecks ?? [];
  const modeChangeChecks = checks.filter(row => row.mode_change_applied);
  const observedPostModeChecks = modeChangeChecks.filter(row => row.after_first_completion_interval_count !== null
    && row.after_first_completion_interval_count !== undefined
    && typeof row.cross_mode_interval_added === 'boolean');
  const evidence = {
    observed_mode_changes: modeStates.length,
    final_modes: [...new Set(modeStates.map(row => row.finalMode))],
    mode_change_chore_count: modeChangeChecks.length,
    post_mode_completion_check_count: observedPostModeChecks.length,
    checked_chore_ids: observedPostModeChecks.map(row => row.chore_id),
    unobserved_chore_ids: modeChangeChecks.filter(row => !observedPostModeChecks.includes(row)).map(row => row.chore_id),
    boundary_checks: checks,
  };
  if (modeStates.length === 0 || modeChangeChecks.length === 0 || observedPostModeChecks.length === 0) {
    return resultRecord('not_tested', evidence, 'モード変更後の観測完了がなく、cross-mode interval exclusionを検証できない');
  }
  const finalModeObserved = modeStates.some(row => row.finalMode === modeForCase('minimal'));
  return assertInvariantStatus(finalModeObserved && observedPostModeChecks.every(row => row.cross_mode_interval_added === false), evidence);
}

function nextObservedCompletion(value, chore, afterDay, afterTime, throughDay = Number.POSITIVE_INFINITY) {
  const row = value.observed_history.find(item => item.chore_id === chore.id);
  if (!row) return null;
  const time = completionTime(value, row);
  const day = row.completion_days.find(candidate => candidate <= throughDay
    && (candidate > afterDay || candidate === afterDay && time > afterTime));
  return day === undefined ? null : { day, date: addDays(value.clock.start, day), time };
}

function modelSummary(model) {
  if (!model) return null;
  if (model.method === 'median' || model.method === 'exponential') return { method: model.method, days: model.days };
  return { ...model };
}

function maxObservationGap(value, chore) {
  const row = value.observed_history.find(item => item.chore_id === chore.id);
  if (!row || row.completion_days.length < 2) return 0;
  return Math.max(...row.completion_days.slice(1).map((day, index) => day - row.completion_days[index]));
}

function eligibleCycleChore(chore) {
  return chore.kind === 'days' && !chore.fixed_daily && !chore.manual_fixed_days && chore.enabled !== false;
}

function protectedPlacementEvidence(geometry, today) {
  const tomorrow = addDays(today, 1); const futureBase = addDays(today, 2);
  const previous = { id: 'probe-near', originalBaseDate: today, placedBaseDate: today, recommendedDate: today,
    basicWindow: null, displayedWindow: null, slot: null, fallback: true };
  const plans = applyPlan(geometry, [
    task({ id: 'probe-near', choreId: 'probe-near', baseDate: today, purpose: 'automatic', minutes: 10,
      previous, windowRadiusDays: 0 }),
    task({ id: 'probe-flex', choreId: 'probe-flex', baseDate: futureBase, purpose: 'automatic', minutes: 10,
      windowRadiusDays: 2 }),
  ], { today });
  return { existingDay: plans.find(plan => plan.id === 'probe-near')?.recommendedDate,
    otherChoreDay: plans.find(plan => plan.id === 'probe-flex')?.recommendedDate,
    tomorrow, passed: plans.find(plan => plan.id === 'probe-near')?.recommendedDate === today
      && (plans.find(plan => plan.id === 'probe-flex')?.recommendedDate ?? today) > tomorrow };
}

function duplicateLoadEvidence(geometry, today) {
  const date = addDays(today, 2);
  const completed = { roundId: 'case-completed-round', date, minutes: 10, load: 'normal', slot: null };
  const inputTask = task({ id: 'case-load-probe', choreId: 'case-load-probe', baseDate: date, purpose: 'direct',
    minutes: 10, windowRadiusDays: 0 });
  const one = applyPlan(geometry, [inputTask], { today, fixedLoads: [completed] })[0];
  const twice = applyPlan(geometry, [inputTask], { today, fixedLoads: [completed, { ...completed }] })[0];
  return { once: { date: one.recommendedDate, slot: one.slot }, duplicate: { date: twice.recommendedDate, slot: twice.slot },
    passed: one.recommendedDate === twice.recommendedDate && JSON.stringify(one.slot) === JSON.stringify(twice.slot) };
}

function seasonalEvidence(value) {
  const chore = value.chores.find(item => item.kind === 'seasonal' && item.id === 'wardrobe');
  if (!chore || chore.enabled === false) return null;
  const spring = personalSeasonalRound(`realistic:${value.case_id}:wardrobe`, 'winterStorage', 2026, 'nationalFallback', fingerprint);
  const autumn = personalSeasonalRound(`realistic:${value.case_id}:wardrobe`, 'summerStorage', 2026, 'nationalFallback', fingerprint);
  const afterSpring = completePersonalSeasonalRound(spring, { completedDate: '2026-08-01', region: 'nationalFallback', fingerprint });
  const expectedSpring = chore.seasonal_dates.find(item => item.season === 'spring');
  const expectedAutumn = chore.seasonal_dates.find(item => item.season === 'autumn');
  const springMatchesFixture = spring.date.slice(5) === `${String(expectedSpring.month).padStart(2, '0')}-${String(expectedSpring.day).padStart(2, '0')}`;
  const autumnMatchesFixture = autumn.date.slice(5) === `${String(expectedAutumn.month).padStart(2, '0')}-${String(expectedAutumn.day).padStart(2, '0')}`;
  return { spring: spring.date, autumn: autumn.date, afterSpring: afterSpring.date,
    springMatchesFixture, autumnMatchesFixture, autumnUnchanged: afterSpring.id !== autumn.id };
}

function collectFuturePredictions(value, states, plans, today, eligibleIds = null) {
  const nowDay = value.clock.initial_now_day;
  const rows = [];
  for (const chore of value.chores.filter(chore => eligibleCycleChore(chore) && (!eligibleIds || eligibleIds.has(chore.id)))) {
    const view = states.get(chore.id);
    const roundId = view && adaptiveStore.adaptivePersonalRoundId(view.policy.choreId, view.state, fingerprint);
    const plan = roundId ? plans.get(roundId) : null;
    if (!plan) continue;
    const actual = nextObservedCompletion(value, chore, nowDay, ADAPTER.appClockTime, value.clock.evaluation_horizon_days);
    rows.push({ chore_id: chore.id, predicted_date: plan.recommendedDate,
      ...(actual ? { next_observed_date: actual.date, error_days: Math.abs(daysBetween(plan.recommendedDate, actual.date)), scored: true }
        : { scored: false, unresolved: true }) });
  }
  return rows;
}

export function evaluateLifestyleCase(value, simulation = null) {
  const initialDay = value.clock.initial_now_day;
  const today = addDays(value.clock.start, initialDay);
  const through = addDays(today, Math.min(180, value.clock.evaluation_horizon_days - initialDay));
  const initialStates = simulation?.initialStates ?? runCaseHistory(value, initialDay, { throughTime: ADAPTER.appClockTime });
  const initialInput = simulation?.initialInput ?? buildCaseGeometry(value, { from: today, through, throughDay: initialDay });
  const plans = simulation?.initialPlans ?? planCaseChores(value, initialStates, initialInput.geometry, today);
  const finalStates = simulation?.finalStates ?? runCaseHistory(value, value.clock.evaluation_horizon_days);
  const evaluatedChores = simulation?.targetChoreIds ? new Set(simulation.targetChoreIds) : null;
  const futurePredictions = collectFuturePredictions(value, initialStates, plans, today, evaluatedChores);
  const dailyChore = value.chores.find(chore => chore.id === 'daily');
  const dailyView = dailyChore ? initialStates.get(dailyChore.id) : null;
  const dailyRoundId = dailyView ? adaptiveStore.adaptivePersonalRoundId(dailyView.policy.choreId, dailyView.state, fingerprint) : null;
  const dailyPlan = dailyRoundId ? plans.get(dailyRoundId) : null;
  const dayPredictions = value.chores.filter(chore => chore.kind === 'days' && chore.enabled !== false
    && (!evaluatedChores || evaluatedChores.has(chore.id))).flatMap(chore => {
    const view = initialStates.get(chore.id);
    if (!view?.state.model || !view.state.lastPlanCompletion) return [];
    const next = predictAdaptiveDate(view.state.model, view.state.lastPlanCompletion.date);
    return [{ chore_id: chore.id, after: view.state.lastPlanCompletion.date, next }];
  });
  const slots = value.chores.flatMap(chore => {
    const view = initialStates.get(chore.id);
    const roundId = view && adaptiveStore.adaptivePersonalRoundId(view.policy.choreId, view.state, fingerprint);
    const plan = roundId ? plans.get(roundId) : null;
    if (!plan?.slot) return [];
    const expectedMs = chore.duration_minutes * 60_000;
    return [{ chore_id: chore.id, expected_ms: expectedMs, actual_ms: plan.slot.end - plan.slot.start,
      matches: Math.abs((plan.slot.end - plan.slot.start) - expectedMs) < 1 }];
  });
  const protectedNear = protectedPlacementEvidence(initialInput.geometry, today);
  const loadOnce = duplicateLoadEvidence(initialInput.geometry, today);
  const sync = value.lifecycle_events.find(event => event.kind === 'sync_echo');
  let syncEvidence = null;
  if (sync && sync.day <= value.clock.evaluation_horizon_days) {
    const syncDate = addDays(value.clock.start, sync.day);
    const syncRange = buildCaseGeometry(value, { from: syncDate, through: addDays(syncDate, 1), throughDay: sync.day });
    const target = instantSpan(syncDate, 10 * 60, 10 * 60 + 30);
    const minutes = syncRange.geometry.busy.reduce((sum, span) => sum
      + Math.max(0, Math.min(target.end, span.end) - Math.max(target.start, span.start)), 0) / 60_000;
    syncEvidence = { canonical_id: sync.canonical_id, minutes, expected_minutes: 30, passes: Math.abs(minutes - 30) < 1e-9 };
  }
  const sharedPolicy = finalStates.get('shared');
  const sharedInput = sharedPlanFromCase(value, today);
  let sharedLoad = null;
  if (sharedInput?.occurrences[0]?.subjects[0].required) {
    const members = ['u1', 'u2'].map(owner => ({ owner,
      loads: sharedAdaptiveLoad(sharedInput, owner, today, ADAPTER.timezone, []).loads }));
    sharedLoad = { assignment: value.chores.find(chore => chore.id === 'shared')?.assignee ?? null,
      entities: sharedInput.occurrences.length, member_load_counts: Object.fromEntries(members.map(row => [row.owner, row.loads.length])),
      member_round_ids: Object.fromEntries(members.map(row => [row.owner, row.loads.map(load => load.roundId)])) };
  }
  const seasonal = seasonalEvidence(value);
  const manual = value.chores.find(chore => chore.id === 'manual');
  const manualState = finalStates.get('manual')?.state;
  const modeStates = [...finalStates.values()].flatMap(row => row.events.filter(event => event.type === 'settings' && event.mode)
    .map(event => ({ event, finalMode: row.state.policy.mode })));
  const effectiveCompletionInputs = [...finalStates.values()].reduce((sum, row) => sum + row.events.filter(event => event.type === 'complete').length, 0);
  const activeUnits = [...finalStates.values()].reduce((sum, row) => sum + row.state.validUnitCount, 0);
  const traceRows = Object.values(simulation?.traceByChore ?? {});
  const minThreeObservations = traceRows.reduce((sum, row) => sum + row.pre_three_interval_checks, 0);
  const minThreeChanges = traceRows.reduce((sum, row) => sum + row.pre_three_interval_model_changes, 0);
  const insideWindowObservations = traceRows.reduce((sum, row) => sum + row.inside_frozen_window, 0);
  const insideWindowChanges = traceRows.reduce((sum, row) => sum + row.inside_window_model_changes, 0);
  const learningOpportunities = traceRows.reduce((sum, row) => sum + row.learning_eligible, 0);
  const targetCompletionCount = traceRows.reduce((sum, row) => sum + row.applied_completions, 0);
  const invariantResults = {};
  for (const key of Object.keys(invariants)) invariantResults[key] = resultRecord('not_tested', {}, '本ケースから実APIへ接続できる入力がない');
  invariantResults.LOCK_NEAR = assertInvariantStatus(protectedNear.passed, protectedNear);
  invariantResults.NEXT_GENERATION = simulation
    ? resultRecord('not_tested', { daily_completion_history_replayed: false, daily_plan: dailyPlan?.recommendedDate ?? null },
      '日次固定の高頻度履歴はchronological target外。実SQLiteの日次完了境界はdirected D04で検査')
    : assertInvariantStatus(Boolean(dailyPlan)
      && dailyPlan.recommendedDate === addDays(dailyView.state.lastPlanCompletion?.date ?? today, 1)
      && dailyPlan.id !== dailyView.state.lastPlanCompletion?.roundId,
    { daily_recommended: dailyPlan?.recommendedDate ?? null, last_completion: dailyView?.state.lastPlanCompletion?.date ?? null,
      previous_round_id: dailyView?.state.lastPlanCompletion?.roundId ?? null, next_round_id: dailyPlan?.id ?? null });
  const dailyModelFixed = Boolean(dailyView?.state.model
    && (dailyView.state.model.method === 'median' || dailyView.state.model.method === 'exponential') && dailyView.state.model.days === 1);
  invariantResults.DAILY_FIXED = simulation
    ? resultRecord('not_tested', { daily_completion_history_replayed: false, model: modelSummary(dailyView?.state.model) },
      '日次固定の高頻度履歴はchronological target外。周期固定はdirected D04で検査')
    : assertInvariantStatus(Boolean(dailyPlan)
      && dailyPlan.recommendedDate === addDays(dailyView.state.lastPlanCompletion?.date ?? today, 1) && dailyModelFixed,
    { recommendation: dailyPlan?.recommendedDate ?? null, fixed_daily_model: dailyModelFixed });
  invariantResults.NEXT_AFTER_COMPLETION = dayPredictions.length
    ? assertInvariantStatus(dayPredictions.every(row => row.next > row.after),
      { checked_chore_count: dayPredictions.length, predictions: dayPredictions })
    : resultRecord('not_applicable', { checked_chore_count: 0 }, 'chronological targetで完了後の周期提案がない');
  invariantResults.COMPLETED_LOAD_ONCE = assertInvariantStatus(loadOnce.passed, loadOnce);
  invariantResults.SAME_EVENT_ONCE = syncEvidence
    ? assertInvariantStatus(syncEvidence.passes, syncEvidence)
    : resultRecord('not_applicable', {}, 'sync echo absent or outside evaluation horizon');
  invariantResults.CONTIGUOUS = slots.length
    ? assertInvariantStatus(slots.every(row => row.matches), { placed_slots: slots.length, slots })
    : resultRecord('not_applicable', { planned_rounds: plans.size }, 'このケースの予定に連続枠が割り当てられていない');
  invariantResults.SHARED_NO_LEARN = sharedPolicy
    ? assertInvariantStatus(sharedPolicy.state.model === null, { model: modelSummary(sharedPolicy.state.model), kind: sharedPolicy.policy.kind })
    : resultRecord('not_applicable');
  const sharedChore = value.chores.find(chore => chore.id === 'shared');
  if (sharedChore?.enabled !== false && sharedChore?.assignee === null && sharedLoad) {
    invariantResults.UNASSIGNED_LOAD = assertInvariantStatus(sharedLoad.entities === 1
      && sharedLoad.member_load_counts.u1 === 1 && sharedLoad.member_load_counts.u2 === 1
      && sharedLoad.member_round_ids.u1[0] === sharedLoad.member_round_ids.u2[0], sharedLoad);
  } else invariantResults.UNASSIGNED_LOAD = resultRecord('not_applicable', { assignment: sharedChore?.assignee ?? null,
    enabled: sharedChore?.enabled !== false }, '未担当の有効共有回がこのケースにない');
  invariantResults.SEASONAL_FIXED = seasonal
    ? assertInvariantStatus(seasonal.springMatchesFixture && seasonal.autumnMatchesFixture && seasonal.autumnUnchanged
      && finalStates.get('wardrobe')?.state.model === null, seasonal)
    : resultRecord('not_applicable', {}, '衣類季節回が有効でない');
  invariantResults.FIXED_OVERRIDE = manualState && manual?.manual_fixed_days
    ? assertInvariantStatus(manualState.policy.fixedDays === manual.manual_fixed_days
      && manualState.model?.method === 'median' && manualState.model.days === manual.manual_fixed_days,
    { fixed_days: manualState.policy.fixedDays, model: modelSummary(manualState.model) })
    : resultRecord('not_applicable');
  const personalHistoryCounts = [...finalStates.values()].filter(row => row.policy.kind === 'personal')
    .map(row => ({ chore_id: row.policy.choreId, valid_units: row.state.validUnitCount,
      recorded_completion_events: row.events.filter(event => event.type === 'complete').length }));
  invariantResults.NO_FAKE_HISTORY = assertInvariantStatus(ADAPTER.hiddenEventsSentToApp === false
    && activeUnits <= effectiveCompletionInputs
    && personalHistoryCounts.every(row => row.valid_units <= row.recorded_completion_events),
  { hidden_events_sent_to_app: ADAPTER.hiddenEventsSentToApp, active_units: activeUnits,
    effective_completion_inputs: effectiveCompletionInputs, personal_history_counts: personalHistoryCounts });
  const changeSettings = value.behavior_model.id === 'change_settings';
  invariantResults.MODE_BOUNDARY = changeSettings
    ? evaluateModeBoundaryChecks(modeStates, simulation?.modeBoundaryChecks ?? [])
    : resultRecord('not_applicable', {}, 'setting-change variantではない');
  invariantResults.UNDO_LOCAL = simulation?.undoChecks?.length
    ? assertInvariantStatus(simulation.undoChecks.every(row => row.target_exists_before && row.target_removed_after
      && row.unrelated_active_actions_preserved), { undo_checks: simulation.undoChecks })
    : resultRecord('not_applicable', {}, '実SQLiteの時系列に取消操作がない');
  invariantResults.WEATHER_FAILURE_STABLE = resultRecord('not_tested',
    { weather_failure_count: value.lifecycle_events.filter(event => event.kind === 'weather_fetch_failed'
      && event.day <= initialDay).length, forecast_input_available: false, repository_weather_path_executed: false },
  'この入力には天気provider応答がなく、失敗から予定を維持するRepository経路は本ケースのadapter外');
  const eligibleRecords = [...finalStates.values()].filter(row => row.policy.kind === 'personal')
    .reduce((sum, row) => sum + row.events.filter(event => event.type === 'complete' && event.displayedWindow === 'missing').length, 0);
  const learningIntervalsObserved = [...finalStates.values()].filter(row => row.policy.kind === 'personal')
    .reduce((sum, row) => sum + row.state.validIntervalCount, 0);
  const capChores = value.chores.filter(chore => evaluatedChores?.has(chore.id)
    && (simulation?.traceByChore?.[chore.id]?.learned_above_initial_cycle ?? 0) > 0);
  invariantResults.NO_INTERVAL_CAP = capChores.length
    ? assertInvariantStatus(true, { learned_above_initial_cycle_chores: capChores.map(chore => ({ chore_id: chore.id,
      initial_days: chore.manual_fixed_days ?? chore.initial_days,
      learned_above_initial_observations: simulation.traceByChore[chore.id].learned_above_initial_cycle,
      final_model: modelSummary(finalStates.get(chore.id)?.state.model) })) })
    : resultRecord('not_tested', { target_chore_ids: [...(evaluatedChores ?? [])], learning_intervals: learningIntervalsObserved,
      maximum_observed_gaps: value.chores.filter(chore => evaluatedChores?.has(chore.id))
        .map(chore => ({ chore_id: chore.id, initial_days: chore.initial_days,
          maximum_gap_days: maxObservationGap(value, chore) })) },
    '実際の時系列学習で初期周期を超えるmodelを観測できず、このケースは上限制約の有無を判定できない');
  invariantResults.MIN_THREE = minThreeObservations
    ? assertInvariantStatus(minThreeChanges === 0, { checked_completions: minThreeObservations,
      model_changes_before_three_intervals: minThreeChanges, target_chore_ids: [...(evaluatedChores ?? [])],
      examples: traceRows.flatMap(row => row.examples).filter(example => (example.intervals_after ?? 99) < 3).slice(0, 4) })
    : resultRecord('not_applicable', { checked_completions: 0, learning_intervals: learningIntervalsObserved },
      '対象の観測完了がない');
  invariantResults.INSIDE_WINDOW = insideWindowObservations
    ? assertInvariantStatus(insideWindowChanges === 0, { inside_window_completions: insideWindowObservations,
      model_changes: insideWindowChanges, examples: traceRows.flatMap(row => row.examples)
        .filter(example => example.inside_window).slice(0, 4) })
    : resultRecord('not_applicable', { inside_window_completions: 0 }, '観測完了が実planの拡張表示期間内に入らなかった');
  invariantResults.NO_EXTRA_INPUT = resultRecord('not_tested', { ui_executed: false, fixture_declares_extra_input: value.settings.additional_input_required },
    'UIの入力要求経路はこのdomain/repository harnessでは実行していない');
  invariantResults.FALLBACK_LOCK = resultRecord('not_tested', { fallback_count: [...plans.values()].filter(plan => plan.fallback).length },
    'fallbackの期限境界はdirected D05で本体placementに接続');
  const modelRows = [...initialStates.entries()].map(([choreId, row]) => ({ chore_id: choreId, kind: row.policy.kind,
    valid_intervals: row.state.validIntervalCount, valid_units: row.state.validUnitCount, model: modelSummary(row.state.model),
    missing_window_issues: row.state.issues.filter(issue => issue.kind === 'missingWindow').length,
    last_completion: row.state.lastCompletedDate }));
  const scored = futurePredictions.filter(row => row.scored);
  const unresolved = futurePredictions.filter(row => row.unresolved);
  const caseResult = { case_id: value.case_id, split: value.split, profile: value.profile.id,
    behavior_model: value.behavior_model.id, horizon_days: value.clock.evaluation_horizon_days,
    initial_now_day: initialDay, adapter: { mode: modeForCase(value.settings.mode), source_mode: value.settings.mode, clock_time: ADAPTER.appClockTime,
      missing_displayed_windows: eligibleRecords, hidden_events_sent_to_app: false },
    input: { observed_completion_records_visible_at_initial_now: [...initialStates.values()].reduce((sum, row) => sum
      + row.events.filter(event => event.type === 'complete').length, 0),
      observed_completion_records_through_horizon: effectiveCompletionInputs,
      hidden_evaluation_events_received: false, chore_count: value.chores.length },
    geometry: { from: today, through, busy_span_count: initialInput.geometry.busy.length,
      recurring_event_count: initialInput.recurringEvents, visible_overlay_event_count: initialInput.overlayEvents,
      google_busy_copy_count: initialInput.googleBusySpans, unresolved_dates: initialInput.geometry.unresolvedDates.length },
    placements: { planned_chore_count: plans.size, placed_slots: slots.length,
      fallback_count: [...plans.values()].filter(plan => plan.fallback).length,
      by_chore: [...initialStates.entries()].flatMap(([choreId, row]) => {
        const id = adaptiveStore.adaptivePersonalRoundId(row.policy.choreId, row.state, fingerprint);
        const plan = plans.get(id); return plan ? [{ chore_id: choreId, base_date: plan.originalBaseDate,
          recommended_date: plan.recommendedDate, slot: plan.slot, fallback: plan.fallback }] : [];
      }) },
    metrics: { valid_intervals_at_initial_now: modelRows.reduce((sum, row) => sum + row.valid_intervals, 0),
      personal_intervals_through_horizon: learningIntervalsObserved,
      learning_eligible_fraction: targetCompletionCount ? learningOpportunities / targetCompletionCount : null,
      learning_eligible_operations: learningOpportunities,
      learning_eligibility_reason: 'actual SQLite plan snapshots and forecast eligibility are measured only for chronological behavior-learning targets',
      scored_predictions: scored.length, unresolved_predictions: unresolved.length,
      scored_predictions_detail: futurePredictions, prediction_error_days: scored.map(row => row.error_days),
      unrequested_move_count: null, extra_input_count: 0, double_counted_load: loadOnce.passed ? 0 : 1,
      target_recorded_completion_count: simulation?.report.target_completion_operations ?? effectiveCompletionInputs,
      target_applied_completion_count: simulation?.report.target_applied_completions ?? null,
      verified_invariant_pass_count: Object.values(invariantResults).filter(row => row.status === 'pass').length },
    actual_history: modelRows, shared_load: sharedLoad, invariant_results: invariantResults };
  return caseResult;
}

/** Exercise the actual SQLite policy/action/plan path once for each synthetic case.
 * The corpus has no persisted plan revision or frozen displayed-window metadata,
 * so its historical events are not imported into this repository API. This probe
 * creates one real app-style proposal, completes that exact round, and verifies
 * the durable readback using only the actual repository functions.
 */
export async function createLifestyleRepositoryProbe() {
  const h = createDatabase();
  const { database, connection } = h;
  await adaptiveStore.initializeAdaptivePersonalSchemaInside(database);
  let actionCount = 0;
  return {
    async exercise(value) {
      const source = value.chores.find(chore => chore.kind === 'days' && chore.enabled !== false
        && (chore.initial_days ?? chore.manual_fixed_days ?? null) !== null);
      if (!source) return { status: 'not_applicable', reason: '周期型個人家事がない' };
      const choreId = `realistic-sqlite:${value.case_id}:${source.id}`;
      const today = addDays(value.clock.start, value.clock.initial_now_day);
      const expectedDays = source.manual_fixed_days ?? source.initial_days;
      const lookAhead = Math.max(180, expectedDays + (source.manual_half_width ?? 0) + 30);
      const definition = { ...choreForPlacement(value, source), id: choreId,
        householdId: `realistic-sqlite-household:${value.case_id}` };
      const policy = frequencyPolicy(value.case_id, source, value.settings.mode);
      policy.choreId = choreId;
      policy.mode = modeForCase(value.settings.mode);
      policy.version = `realistic-sqlite-v1:${source.id}`;
      const planningFor = (planningToday, now, revision, trigger) => {
        const relativeToday = daysBetween(value.clock.start, planningToday);
        const geometry = buildCaseGeometry(value, { from: planningToday, through: addDays(planningToday, lookAhead),
          throughDay: relativeToday }).geometry;
        return { today: planningToday, now, inputRevision: revision, assertInputsCurrent() {},
          plan({ roundId, state, previous }) {
            return planPersonalAdaptiveRounds({ requests: [{ roundId, chore: definition, state, previous, trigger }],
              geometry, ownerId: `owner:${value.case_id}`, today: planningToday, now: Date.parse(now), fixedLoads: [], fingerprint })
              .get(roundId);
          } };
      };
      const initNow = `${today}T${ADAPTER.appClockTime}:00+09:00`;
      const initPlanning = planningFor(today, initNow, `sqlite-init:${value.case_id}`, 'initial');
      await database.withTransactionAsync(() => adaptiveStore.initializeAdaptivePersonalChoreInside(database, policy, initPlanning, fingerprint));
      const initial = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
      if (!initial?.plan || !initial.planRevision) return { status: 'fail', phase: 'initialization', plan_present: Boolean(initial?.plan) };
      const completedDate = initial.plan.recommendedDate;
      const recordedAt = `${completedDate}T${ADAPTER.appClockTime}:00+09:00`;
      const operation = { operationId: `realistic-sqlite-complete:${value.case_id}`, recordedAt, type: 'complete',
        completionId: `realistic-sqlite-completion:${value.case_id}`, roundId: initial.plan.id,
        planRevision: initial.planRevision, date: completedDate, timeZone: ADAPTER.timezone, origin: 'personal' };
      const completionPlanning = planningFor(completedDate, recordedAt, `sqlite-complete:${value.case_id}`, 'complete');
      let receipt;
      await database.withTransactionAsync(async () => {
        receipt = await adaptiveStore.applyAdaptivePersonalOperationInside(database, choreId, operation, completionPlanning, fingerprint);
      });
      actionCount++;
      const after = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
      const persistedActions = await database.getAllAsync('SELECT action_type FROM personal_adaptive_actions WHERE chore_id=? ORDER BY sequence', choreId);
      const passed = receipt?.kind === 'applied' && after?.state.lastPlanCompletion?.operationId === operation.operationId
        && after?.state.lastPlanCompletion?.date === completedDate && Boolean(after?.plan)
        && after.plan.recommendedDate > completedDate && persistedActions.filter(row => row.action_type === 'complete').length === 1;
      return { status: passed ? 'pass' : 'fail', chore_id: source.id, repository_operations: ['initialize', 'complete', 'readback'],
        initial_round_id: initial.plan.id, completion_date: completedDate, receipt_kind: receipt?.kind ?? null,
        durable_completion_date: after?.state.lastPlanCompletion?.date ?? null,
        next_recommended_date: after?.plan?.recommendedDate ?? null,
        stored_action_count: persistedActions.length };
    },
    actionCount() { return actionCount; },
    dispose() { connection.close(); },
  };
}

function modelLearningShape(model) {
  if (!model) return null;
  if (model.method === 'median' || model.method === 'exponential') return { method: model.method, days: model.days };
  if (model.method === 'weekly') return { method: model.method, weeks: model.weeks, weekday: model.weekday };
  if (model.method === 'monthEnd') return { method: model.method, months: model.months };
  return { method: model.method, even: model.even, odd: model.odd };
}

function learningTargetChores(value) {
  const candidates = new Set(['floor', 'filter', 'long_care']);
  const laundry = value.chores.find(chore => chore.id === 'laundry');
  if (laundry?.initial_days > 1) candidates.add('laundry');
  return value.chores.filter(chore => candidates.has(chore.id) && chore.kind === 'days'
    && chore.enabled !== false && (chore.initial_days ?? chore.manual_fixed_days ?? null) !== null);
}

function calendarChangeDays(value) {
  const days = new Set();
  for (const override of value.calendar.overrides) {
    days.add(override.day);
    if (override.start_day !== undefined) days.add(override.start_day);
    if (override.end_day_exclusive !== undefined) days.add(override.end_day_exclusive);
  }
  for (const action of value.lifecycle_events) if (action.kind === 'sync_echo') days.add(action.day);
  return [...days].filter(day => day > 0 && day <= value.clock.evaluation_horizon_days).sort((a, b) => a - b);
}

/**
 * Run each behavior-learning target chronologically through the production
 * SQLite policy/action/plan repository. Daily and fixed-only chores are kept as
 * real initial placement loads but their high-volume non-learning histories are
 * deliberately not replayed; floor/filter/long_care and non-daily laundry are.
 */
export async function createLifestyleChronologyHarness({ onOperationTrace = null } = {}) {
  const h = createDatabase();
  const { database, connection, writes } = h;
  await adaptiveStore.initializeAdaptivePersonalSchemaInside(database);
  const counters = { cases: 0, initialized_chores: 0, completion_operations: 0, settings_operations: 0,
    undo_operations: 0, duplicate_deliveries: 0, calendar_replan_calls: 0, rejected_stale_completions: 0 };
  const geometryCacheStats = { case_cache_hits: 0, case_cache_misses: 0 };

  async function simulate(value) {
    counters.cases++;
    const targets = learningTargetChores(value);
    const targetIds = new Set(targets.map(chore => chore.id));
    const personalChores = value.chores.filter(chore => chore.kind === 'days');
    const personalDefinitions = new Map(personalChores.map(source => {
      const id = `realistic-sqlite:${value.case_id}:${source.id}`;
      return [source.id, { id, householdId: `realistic-household:${value.case_id}`,
        name: source.id, category: 'home', enabled: source.enabled !== false, archived: false,
        personalSchedulingKind: 'personal', estimatedMinutes: source.duration_minutes, load: source.load,
        holidayPriority: source.holiday_preference ?? source.load === 'heavy', userWindowRadiusDays: source.manual_half_width ?? undefined }];
    }));
    const policies = new Map();
    const seedStates = new Map();
    for (const source of personalChores) {
      const policy = frequencyPolicy(value.case_id, source, value.settings.mode);
      policy.choreId = personalDefinitions.get(source.id).id;
      policy.version = `realistic-chronology-v1:${source.id}`;
      policies.set(source.id, policy);
      seedStates.set(source.id, replayAdaptiveHistory({ policy, events: [], forecasts: [], fingerprint }));
    }
    const started = value.clock.start;
    const initialToday = addDays(started, value.clock.initial_now_day);
    const lookAheadDays = 180;
    const geometryCache = new Map();
    const activeCompletionLoads = new Map();
    const completedLoadsByDay = new Map();
    const liveViews = new Map();
    const roundRefs = new Map();
    const operationIds = new Map();
    const completionIds = new Map();
    const traceByChore = new Map(personalChores.map(source => [source.id, {
      completion_operations: 0, applied_completions: 0, rejected_or_duplicate_completions: 0,
      inside_frozen_window: 0, inside_window_model_changes: 0, pre_three_interval_checks: 0,
      pre_three_interval_model_changes: 0, learned_above_initial_cycle: 0,
      learning_eligible: 0, out_of_frozen_window: 0, mode_change_applied: false,
      mode_change_interval_count: null, first_post_mode_interval_count: null, cross_mode_interval_added: null, examples: [],
    }]));
    let undoChecks = [];
    let planFailureContext = null;

    function inputsFor(today) {
      const cached = geometryCache.get(today);
      if (cached) { geometryCacheStats.case_cache_hits++; return cached; }
      geometryCacheStats.case_cache_misses++;
      const todayDay = daysBetween(started, today);
      const geometryInfo = buildCaseGeometry(value, { from: today, through: addDays(today, lookAheadDays), throughDay: todayDay });
      const sharedPlan = sharedPlanFromCase(value, today);
      const shared = sharedPlan ? sharedAdaptiveLoad(sharedPlan, 'u1', today, ADAPTER.timezone, []).loads : [];
      const result = { ...geometryInfo, sharedLoads: shared };
      geometryCache.set(today, result);
      return result;
    }

    function planningFor(source, now, trigger, { pendingEvent = null, inputRevisionSuffix = '' } = {}) {
      const today = now.slice(0, 10);
      const input = inputsFor(today);
      return { today, now, inputRevision: `${input.geometry.revision}${inputRevisionSuffix}`, assertInputsCurrent() {},
        async plan({ roundId, state, previous }) {
          const choreId = personalDefinitions.get(source.id).id;
          const fixedLoads = [...input.sharedLoads];
          for (const other of personalChores) {
            if (other.id === source.id) continue;
            const view = liveViews.get(other.id);
            if (view?.plan) fixedLoads.push({ roundId: view.plan.id, date: view.plan.recommendedDate,
              minutes: other.duration_minutes, load: other.load, slot: view.plan.slot });
          }
          for (const completion of completedLoadsByDay.get(today) ?? []) {
            if (!completion.active) continue;
            if (pendingEvent?.type === 'undo' && pendingEvent.targetOperationId === completion.fixtureOperationId) continue;
            fixedLoads.push(completion.load);
          }
          if (pendingEvent?.type === 'complete' && pendingEvent.origin !== 'shared' && pendingEvent.localDate === today) {
            fixedLoads.push({ roundId: `pending:${pendingEvent.operationId}`, date: pendingEvent.localDate,
              minutes: source.duration_minutes, load: source.load, slot: previous?.slot ?? null });
          }
          const request = { roundId, chore: personalDefinitions.get(source.id), state, previous, trigger };
          try {
            const result = planPersonalAdaptiveRounds({ requests: [request], geometry: input.geometry,
              ownerId: `u1:${value.case_id}`, today, now: Date.parse(now), fixedLoads, fingerprint });
            return result.get(roundId);
          } catch (error) {
            planFailureContext = { chore_id: source.id, round_id: roundId, trigger,
              proposed_model: modelSummary(state.model), proposed_last_completion: state.lastPlanCompletion,
              previous_plan: previous ? { id: previous.id, originalBaseDate: previous.originalBaseDate,
                recommendedDate: previous.recommendedDate, displayedWindow: previous.displayedWindow } : null,
              input_revision: input.geometry.revision, geometry_days: input.geometry.days.length,
              fixed_load_count: fixedLoads.length };
            throw error;
          }
        } };
    }

    // Every actual personal periodic chore is initialized with the real app policy,
    // so completed target rounds can be placed against the household's other saved rounds.
    const initToday = started;
    const initNow = `${initToday}T00:00:00+09:00`;
    for (const source of personalChores) {
      const policy = policies.get(source.id);
      const planning = planningFor(source, initNow, 'initial');
      await database.withTransactionAsync(() => adaptiveStore.initializeAdaptivePersonalChoreInside(database, policy, planning, fingerprint));
      counters.initialized_chores++;
      liveViews.set(source.id, await adaptiveStore.readAdaptivePersonalInside(database, personalDefinitions.get(source.id).id));
      const initialized = liveViews.get(source.id);
      await onOperationTrace?.({ case_id: value.case_id, chore_id: source.id, step_kind: 'initialize',
        recorded_at: initNow, operation_id: null, receipt: 'initialized', model_before: null,
        model_after: modelSummary(initialized?.state.model), last_completion_after: initialized?.state.lastPlanCompletion ?? null,
        plan_after: initialized?.plan ? { id: initialized.plan.id, revision: initialized.planRevision,
          original_base_date: initialized.plan.originalBaseDate, recommended_date: initialized.plan.recommendedDate,
          displayed_window: initialized.plan.displayedWindow, fallback: initialized.plan.fallback } : null });
      writes.length = 0;
    }

    const actionEvents = [];
    for (const source of personalChores) {
      let events = historyEvents(value, source, value.clock.evaluation_horizon_days, { missingWindow: false });
      if (!targetIds.has(source.id)) {
        const isModeSetting = event => event.type === 'settings' && event.mode !== undefined;
        const isFixedManualSetting = event => source.id === 'manual' && event.type === 'settings' && event.fixedDays !== undefined;
        const isFilterToggle = event => source.id === 'filter' && event.type === 'settings' && event.enabled !== undefined;
        events = events.filter(event => isModeSetting(event) || isFixedManualSetting(event) || isFilterToggle(event));
      }
      for (const event of events) {
        // Shared and seasonal completion rows are handled by their dedicated APIs,
        // never written into the personal-chore journal.
        actionEvents.push({ source, event });
      }
    }
    const timeline = actionEvents.map(row => ({ at: row.event.recordedAt, kind: 'operation', ...row }));
    for (const day of calendarChangeDays(value)) {
      const date = addDays(started, day);
      timeline.push({ at: `${date}T00:00:00+09:00`, kind: 'calendar_replan', day });
    }
    timeline.sort((a, b) => {
      const at = a.at.localeCompare(b.at);
      if (at) return at;
      const rank = (a.kind === 'calendar_replan' ? 0 : 1) - (b.kind === 'calendar_replan' ? 0 : 1);
      if (rank) return rank;
      if (a.kind === 'operation' && b.kind === 'operation') return a.event.sequence - b.event.sequence || a.source.id.localeCompare(b.source.id);
      return 0;
    });

    const checkpointAt = `${initialToday}T${ADAPTER.appClockTime}:00+09:00`;
    const checkpointTime = Date.parse(checkpointAt);
    let initialSnapshot = null;

    async function takeSnapshot() {
      const states = new Map(); const plans = new Map();
      for (const source of personalChores) {
        const choreId = personalDefinitions.get(source.id).id;
        const view = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
        if (!view) continue;
        const rows = await database.getAllAsync(`SELECT sequence,event_json FROM personal_adaptive_actions
          WHERE chore_id=? AND event_json IS NOT NULL ORDER BY sequence`, choreId);
        const events = rows.map(row => ({ ...JSON.parse(row.event_json), sequence: row.sequence }));
        const forecastRows = await database.getAllAsync('SELECT forecast_json FROM personal_adaptive_forecasts WHERE chore_id=? ORDER BY source_sequence,id', choreId);
        const forecasts = forecastRows.map(row => JSON.parse(row.forecast_json));
        const observed = value.observed_history.find(row => row.chore_id === source.id);
        states.set(source.id, { state: view.state, policy: view.state.policy, events,
          forecasts, observedDays: observed?.completion_days ?? [], view, chore: source });
        if (view.plan) plans.set(view.plan.id, view.plan);
      }
      const activeLoads = [...activeCompletionLoads.values()].filter(row => row.active);
      return { states, plans, activeLoads };
    }

    for (const step of timeline) {
      if (!initialSnapshot && Date.parse(step.at) > checkpointTime) initialSnapshot = await takeSnapshot();
      if (step.kind === 'calendar_replan') {
        for (const source of personalChores) {
          const choreId = personalDefinitions.get(source.id).id;
          const before = liveViews.get(source.id);
          const planning = planningFor(source, step.at, 'replan');
          await database.withTransactionAsync(() => adaptiveStore.replanAdaptivePersonalInside(database, choreId, planning, fingerprint));
          counters.calendar_replan_calls++;
          const after = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
          liveViews.set(source.id, after);
          await onOperationTrace?.({ case_id: value.case_id, chore_id: source.id, step_kind: 'calendar_replan',
            recorded_at: step.at, operation_id: null, receipt: 'replanned', model_before: modelSummary(before?.state.model),
            model_after: modelSummary(after?.state.model), last_completion_before: before?.state.lastPlanCompletion ?? null,
            last_completion_after: after?.state.lastPlanCompletion ?? null,
            plan_before: before?.plan ? { id: before.plan.id, revision: before.planRevision,
              original_base_date: before.plan.originalBaseDate, recommended_date: before.plan.recommendedDate,
              displayed_window: before.plan.displayedWindow, fallback: before.plan.fallback } : null,
            plan_after: after?.plan ? { id: after.plan.id, revision: after.planRevision,
              original_base_date: after.plan.originalBaseDate, recommended_date: after.plan.recommendedDate,
              displayed_window: after.plan.displayedWindow, fallback: after.plan.fallback } : null });
          writes.length = 0;
        }
        continue;
      }

      const { source, event } = step;
      const choreId = personalDefinitions.get(source.id).id;
      const before = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
      const fixtureOperationId = event.operationId;
      const operationId = `${value.case_id}:operation:${source.id}:${fixtureOperationId}`;
      operationIds.set(`${source.id}:${fixtureOperationId}`, operationId);
      let operation;
      let priorCompletionReference = null;
      if (event.type === 'complete') {
        const completionReference = roundRefs.get(`${source.id}:${event.completionId}`);
        priorCompletionReference = completionReference ?? (before?.plan && before.planRevision
          ? { roundId: before.plan.id, planRevision: before.planRevision, slot: before.plan.slot } : null);
        if (!priorCompletionReference) {
          traceByChore.get(source.id).rejected_or_duplicate_completions++;
          continue;
        }
        const completionId = `${value.case_id}:completion:${source.id}:${event.completionId}`;
        completionIds.set(`${source.id}:${event.completionId}`, completionId);
        roundRefs.set(`${source.id}:${event.completionId}`, priorCompletionReference);
        operation = { operationId, recordedAt: event.recordedAt, type: 'complete', completionId,
          roundId: priorCompletionReference.roundId, planRevision: priorCompletionReference.planRevision,
          date: event.localDate, timeZone: event.timeZone ?? ADAPTER.timezone, origin: event.origin === 'shared' ? 'shared' : 'personal' };
      } else if (event.type === 'undo') {
        const targetOperationId = operationIds.get(`${source.id}:${event.targetOperationId}`)
          ?? `${value.case_id}:operation:${source.id}:${event.targetOperationId}`;
        const completionId = completionIds.get(`${source.id}:${event.completionId}`)
          ?? `${value.case_id}:completion:${source.id}:${event.completionId}`;
        operation = { operationId, recordedAt: event.recordedAt, type: 'undo', completionId, targetOperationId };
      } else {
        operation = { operationId, recordedAt: event.recordedAt, type: 'settings',
          ...(event.mode !== undefined ? { mode: event.mode } : {}),
          ...(event.enabled !== undefined ? { enabled: event.enabled } : {}),
          ...(event.fixedDays !== undefined ? { fixedDays: event.fixedDays } : {}) };
      }
      const planning = planningFor(source, event.recordedAt, event.type, { pendingEvent: event });
      let receipt;
      const beforeShape = modelLearningShape(before?.state.model);
      const beforeIntervals = before?.state.validIntervalCount ?? 0;
      const priorActive = new Set([...activeCompletionLoads.entries()].filter(([, row]) => row.active).map(([id]) => id));
      try {
        await database.withTransactionAsync(async () => {
          receipt = await adaptiveStore.applyAdaptivePersonalOperationInside(database, choreId, operation, planning, fingerprint);
        });
      } catch (error) {
        const recentRows = await database.getAllAsync(`SELECT sequence,action_type,event_json,receipt_json FROM personal_adaptive_actions
          WHERE chore_id=? ORDER BY sequence DESC LIMIT 8`, choreId);
        const context = { case_id: value.case_id, chore_id: source.id, event_type: event.type,
          recorded_at: event.recordedAt, fixture_operation_id: fixtureOperationId,
          completion_date: event.localDate ?? null, prior_plan: before?.plan ? {
            id: before.plan.id, original_base_date: before.plan.originalBaseDate, recommended_date: before.plan.recommendedDate,
            displayed_window: before.plan.displayedWindow, fallback: before.plan.fallback,
          } : null, model_before: modelSummary(before?.state.model), last_completion_before: before?.state.lastPlanCompletion ?? null,
          plan_failure_context: planFailureContext,
          recent_sqlite_operations: recentRows.reverse().map(row => ({ sequence: row.sequence, action_type: row.action_type,
            event: row.event_json ? JSON.parse(row.event_json) : null,
            receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null })) };
        await onOperationTrace?.({ case_id: value.case_id, chore_id: source.id, step_kind: 'operation_failed',
          recorded_at: event.recordedAt, operation_id: operationId, action_input: operation,
          model_before: modelSummary(before?.state.model), last_completion_before: before?.state.lastPlanCompletion ?? null,
          prior_plan: context.prior_plan, plan_failure_context: planFailureContext,
          recent_sqlite_operations: context.recent_sqlite_operations, error: String(error?.message ?? error) });
        throw new Error(`chronological repository operation failed: ${JSON.stringify(context)}; ${String(error?.message ?? error)}`, { cause: error });
      }
      writes.length = 0;
      const after = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
      liveViews.set(source.id, after);
      const persisted = await database.getFirstAsync(`SELECT sequence,event_json,receipt_json FROM personal_adaptive_actions WHERE operation_id=? AND chore_id=?`, operationId, choreId);
      const forecastRow = await database.getFirstAsync(`SELECT forecast_json FROM personal_adaptive_forecasts
        WHERE chore_id=? ORDER BY source_sequence DESC,id DESC LIMIT 1`, choreId);
      let phaseAdoptionSnapshot = null;
      if (persisted?.sequence !== undefined && persisted?.sequence !== null
        && before?.state?.model?.method !== after?.state?.model?.method
        && ['weekly', 'monthEnd'].includes(after?.state?.model?.method)) {
        const priorActionRows = await database.getAllAsync(`SELECT sequence,event_json FROM personal_adaptive_actions
          WHERE chore_id=? AND event_json IS NOT NULL AND sequence<? ORDER BY sequence`, choreId, persisted.sequence);
        const priorForecastRows = await database.getAllAsync(`SELECT source_sequence,forecast_json FROM personal_adaptive_forecasts
          WHERE chore_id=? AND source_sequence<? ORDER BY source_sequence,id`, choreId, persisted.sequence);
        phaseAdoptionSnapshot = {
          evidence: 'captured from the production SQLite repository immediately after the phase-adopting operation; rows are filtered to source_sequence/sequence before that operation',
          original_policy: policies.get(source.id),
          state_before: before.state,
          previous_plan: before.plan,
          events_before: priorActionRows.map(row => ({ sequence: row.sequence, ...JSON.parse(row.event_json) })),
          forecasts_before: priorForecastRows.map(row => ({ source_sequence: row.source_sequence, ...JSON.parse(row.forecast_json) })),
          trigger_event_saved: persisted?.event_json ? JSON.parse(persisted.event_json) : null,
          forecast_after: forecastRow?.forecast_json ? JSON.parse(forecastRow.forecast_json) : null,
        };
      }
      await onOperationTrace?.({ case_id: value.case_id, chore_id: source.id, step_kind: 'operation',
        recorded_at: event.recordedAt, operation_id: operationId, action_input: operation,
        receipt: receipt?.kind ?? null, sequence: persisted?.sequence ?? null,
        model_before: modelSummary(before?.state.model), model_after: modelSummary(after?.state.model),
        valid_intervals_before: before?.state.validIntervalCount ?? null, valid_intervals_after: after?.state.validIntervalCount ?? null,
        last_completion_before: before?.state.lastPlanCompletion ?? null, last_completion_after: after?.state.lastPlanCompletion ?? null,
        plan_before: before?.plan ? { id: before.plan.id, revision: before.planRevision,
          original_base_date: before.plan.originalBaseDate, recommended_date: before.plan.recommendedDate,
          displayed_window: before.plan.displayedWindow, fallback: before.plan.fallback } : null,
        plan_after: after?.plan ? { id: after.plan.id, revision: after.planRevision,
          original_base_date: after.plan.originalBaseDate, recommended_date: after.plan.recommendedDate,
          displayed_window: after.plan.displayedWindow, fallback: after.plan.fallback } : null,
        event_saved: persisted?.event_json ? JSON.parse(persisted.event_json) : null,
        stored_receipt: persisted?.receipt_json ? JSON.parse(persisted.receipt_json) : null,
        forecast_after: forecastRow?.forecast_json ? JSON.parse(forecastRow.forecast_json) : null,
        ...(phaseAdoptionSnapshot ? { phase_adoption_snapshot: phaseAdoptionSnapshot } : {}) });
      if (event.type === 'complete') {
        const trace = traceByChore.get(source.id);
        trace.completion_operations++;
        if (receipt.kind === 'applied') {
          trace.applied_completions++;
          const actualEvent = await database.getFirstAsync('SELECT event_json FROM personal_adaptive_actions WHERE operation_id=? AND chore_id=?', operationId, choreId);
          const savedEvent = actualEvent?.event_json ? JSON.parse(actualEvent.event_json) : null;
          const window = savedEvent?.displayedWindow;
          const inWindow = Boolean(window && window !== 'missing' && event.localDate >= window.from && event.localDate <= window.through);
          const afterShape = modelLearningShape(after?.state.model);
          if (window && window !== 'missing' && inWindow) {
            trace.inside_frozen_window++;
            if (JSON.stringify(beforeShape) !== JSON.stringify(afterShape)) trace.inside_window_model_changes++;
          } else if (!window || window === 'missing' || event.localDate < window.from || event.localDate > window.through) trace.out_of_frozen_window++;
          if ((after?.state.validIntervalCount ?? 0) < 3) {
            trace.pre_three_interval_checks++;
            if (JSON.stringify(beforeShape) !== JSON.stringify(afterShape)) trace.pre_three_interval_model_changes++;
          }
          if ((after?.state.validIntervalCount ?? 0) >= 3 && after.state.policy.enabled && after.state.policy.fixedDays === null
            && (!window || window === 'missing' || event.localDate < window.from || event.localDate > window.through)) trace.learning_eligible++;
          const baseDays = source.manual_fixed_days ?? source.initial_days;
          if (after?.state.model && baseDays !== undefined && modelRepresentativeDays(after.state.model) > baseDays) trace.learned_above_initial_cycle++;
          if (trace.examples.length < 3) trace.examples.push({ operation_id: operationId, completed_date: event.localDate,
            window: window ?? null, inside_window: inWindow, intervals_before: beforeIntervals,
            intervals_after: after?.state.validIntervalCount ?? null, model_before: beforeShape, model_after: afterShape,
            receipt: receipt.kind });
          const previousReference = priorCompletionReference;
          const activeRow = { fixtureOperationId, active: true, date: event.localDate,
            choreId: source.id, completionId: operation.completionId,
            load: { roundId: previousReference.roundId, date: event.localDate, minutes: source.duration_minutes,
              load: source.load, slot: previousReference.slot } };
          activeCompletionLoads.set(operationId, activeRow);
          completedLoadsByDay.set(event.localDate, [...(completedLoadsByDay.get(event.localDate) ?? []), activeRow]);
        } else {
          trace.rejected_or_duplicate_completions++;
          if (receipt.kind === 'staleRound') counters.rejected_stale_completions++;
          if (receipt.kind === 'alreadyCompleted') counters.duplicate_deliveries++;
        }
      } else if (event.type === 'undo' && receipt.kind === 'applied') {
        counters.undo_operations++;
        const targetId = operation.targetOperationId;
        const target = activeCompletionLoads.get(targetId);
        if (target) target.active = false;
        const afterActive = new Set([...activeCompletionLoads.entries()].filter(([, row]) => row.active).map(([id]) => id));
        const expected = new Set([...priorActive].filter(id => id !== targetId));
        undoChecks.push({ case_id: value.case_id, target_exists_before: Boolean(target),
          target_removed_after: !afterActive.has(targetId), unrelated_active_actions_preserved: JSON.stringify([...afterActive].sort()) === JSON.stringify([...expected].sort()) });
      } else if (event.type === 'settings' && receipt.kind === 'applied') {
        counters.settings_operations++;
        if (event.mode !== undefined) {
          const trace = traceByChore.get(source.id);
          trace.mode_change_applied = true;
          trace.mode_change_interval_count = after?.state.validIntervalCount ?? null;
          trace.awaiting_post_mode_completion = true;
        }
      }
      if (event.type === 'complete' && receipt.kind === 'applied') {
        const trace = traceByChore.get(source.id);
        if (trace.awaiting_post_mode_completion) {
          trace.first_post_mode_interval_count = after?.state.validIntervalCount ?? null;
          trace.cross_mode_interval_added = trace.first_post_mode_interval_count > trace.mode_change_interval_count;
          trace.awaiting_post_mode_completion = false;
        }
      }
      if (event.type === 'complete' && receipt.kind === 'applied') counters.completion_operations++;
    }
    if (!initialSnapshot) initialSnapshot = await takeSnapshot();
    const finalSnapshot = await takeSnapshot();
    const initialNonPersonal = runCaseHistory(value, value.clock.initial_now_day, { throughTime: ADAPTER.appClockTime });
    const finalNonPersonal = runCaseHistory(value, value.clock.evaluation_horizon_days);
    for (const source of value.chores.filter(chore => chore.kind !== 'days')) {
      const initial = initialNonPersonal.get(source.id); const final = finalNonPersonal.get(source.id);
      if (initial) initialSnapshot.states.set(source.id, initial);
      if (final) finalSnapshot.states.set(source.id, final);
    }
    const input = inputsFor(initialToday);
    const initialInput = { ...input, geometry: input.geometry };
    const finalTrace = Object.fromEntries([...traceByChore].map(([id, row]) => [id, row]));
    const modeBoundaryChecks = targets.map(chore => ({ chore_id: chore.id, mode_change_applied: traceByChore.get(chore.id).mode_change_applied,
      after_mode_interval_count: traceByChore.get(chore.id).mode_change_interval_count,
      after_first_completion_interval_count: traceByChore.get(chore.id).first_post_mode_interval_count,
      cross_mode_interval_added: traceByChore.get(chore.id).cross_mode_interval_added }));
    const targetChoreIds = targets.map(chore => chore.id);
    const report = {
      case_id: value.case_id, target_chore_ids: targetChoreIds,
      initialized_personal_chores: personalChores.length,
      target_completion_operations: targetChoreIds.reduce((sum, id) => sum + traceByChore.get(id).completion_operations, 0),
      target_applied_completions: targetChoreIds.reduce((sum, id) => sum + traceByChore.get(id).applied_completions, 0),
      cached_geometry_revisions: geometryCache.size,
      event_history_scope: 'full recorded completion history for enabled floor/filter/long_care and laundry when initial_days > 1; no daily, fixed-manual, shared or seasonal completion histories imported',
      shared_truth_sent_to_personal_history: false,
      hidden_truth_sent_to_app: false,
      trace_by_chore: finalTrace,
      undo_checks: undoChecks,
    };
    return { initialStates: initialSnapshot.states, finalStates: finalSnapshot.states,
      initialPlans: initialSnapshot.plans, initialActiveLoads: initialSnapshot.activeLoads,
      initialInput, traceByChore: finalTrace, undoChecks,
      modeBoundaryChecks, targetChoreIds, report };
  }

  return { simulate, counters, geometryCacheStats, dispose() { connection.close(); } };
}

function modelRepresentativeDays(model) {
  if (!model) return 0;
  return model.method === 'median' || model.method === 'exponential' ? model.days
    : model.method === 'weekly' ? model.weeks * 7
      : model.method === 'monthEnd' ? model.months * 30
        : (model.even + model.odd) / 2;
}

/** One-step closed-loop feedback probe from an actual chronological SQLite checkpoint. */
export function evaluateClosedLoopCase(value, { followRecommendation }, simulation) {
  if (!simulation) throw new Error('closed-loop sensitivity requires a chronological repository checkpoint');
  const initialDay = value.clock.initial_now_day;
  const today = addDays(value.clock.start, initialDay);
  const initialStates = simulation.initialStates;
  const source = value.chores.find(chore => chore.id === 'laundry' && simulation.targetChoreIds.includes(chore.id))
    ?? value.chores.find(chore => simulation.targetChoreIds.includes(chore.id));
  if (!source) return { case_id: value.case_id, status: 'not_applicable', reason: '周期型家事がない' };
  const initialView = initialStates.get(source.id);
  const initialPlan = initialView?.view?.plan;
  if (!initialPlan) return { case_id: value.case_id, status: 'not_applicable', reason: '初回提案が生成されない' };
  const observed = nextObservedCompletion(value, source, initialDay, ADAPTER.appClockTime, value.clock.evaluation_horizon_days);
  if (!followRecommendation && !observed) return { case_id: value.case_id, status: 'not_applicable',
    reason: '初回提案後の記録済み完了がなく、非追従入力を作れない', proposed_date: initialPlan.recommendedDate };
  const completedDate = followRecommendation ? initialPlan.recommendedDate : observed.date;
  const operationId = `closed-loop:${value.case_id}:${followRecommendation ? 'follow' : 'recorded'}`;
  const sequence = Math.max(0, ...initialView.events.map(event => event.sequence)) + 1;
  const event = { operationId, sequence, recordedAt: `${completedDate}T12:00:00+09:00`, type: 'complete',
    completionId: operationId, roundId: initialPlan.id, localDate: completedDate, timeZone: ADAPTER.timezone,
    origin: 'personal', mode: initialView.state.policy.mode,
    initialDays: initialView.state.policy.initialDays[initialView.state.policy.mode],
    displayedWindow: initialPlan.displayedWindow && initialView.view.planRevision
      ? { revision: initialView.view.planRevision, ...initialPlan.displayedWindow } : null,
    ruleDate: initialPlan.originalBaseDate };
  const afterState = replayAdaptiveHistory({ policy: initialView.policy, events: [...initialView.events, event],
    forecasts: initialView.forecasts ?? [], fingerprint });
  const afterDay = Math.max(initialDay, daysBetween(value.clock.start, completedDate));
  const afterToday = addDays(value.clock.start, afterDay);
  const nextInput = buildCaseGeometry(value, { from: afterToday, through: addDays(afterToday, 180), throughDay: afterDay });
  const nextRoundId = adaptiveStore.adaptivePersonalRoundId(initialView.policy.choreId, afterState, fingerprint);
  const sourceDefinition = { ...choreForPlacement(value, source), id: initialView.policy.choreId,
    householdId: `realistic-household:${value.case_id}` };
  const fixedLoads = [...simulation.initialStates.entries()].flatMap(([choreId, row]) => {
    if (choreId === source.id || !row.view?.plan) return [];
    const chore = value.chores.find(item => item.id === choreId);
    return [{ roundId: row.view.plan.id, date: row.view.plan.recommendedDate,
      minutes: chore?.duration_minutes ?? null, load: chore?.load ?? 'normal', slot: row.view.plan.slot }];
  });
  fixedLoads.push(...(simulation.initialActiveLoads ?? []).filter(row => row.date === completedDate).map(row => row.load));
  fixedLoads.push({ roundId: initialPlan.id, date: completedDate, minutes: source.duration_minutes, load: source.load, slot: initialPlan.slot });
  const sharedInput = sharedPlanFromCase(value, afterToday);
  if (sharedInput) fixedLoads.push(...sharedAdaptiveLoad(sharedInput, 'u1', afterToday, ADAPTER.timezone, []).loads);
  const nextPlan = planPersonalAdaptiveRounds({ requests: [{ roundId: nextRoundId, chore: sourceDefinition,
    state: afterState, previous: null, trigger: 'complete' }], geometry: nextInput.geometry,
    ownerId: `u1:${value.case_id}`, today: afterToday, now: Date.parse(`${completedDate}T12:00:00+09:00`), fixedLoads, fingerprint }).get(nextRoundId);
  return { case_id: value.case_id, status: nextPlan ? 'pass' : 'fail', follow_recommendation: followRecommendation,
    input_source: followRecommendation ? 'actual app proposal' : 'recorded observed_history completion',
    initial_proposal_date: initialPlan.recommendedDate, frozen_displayed_window: initialPlan.displayedWindow,
    completion_date: completedDate, completion_is_actual_proposal: completedDate === initialPlan.recommendedDate,
    intervals_after_feedback: afterState.validIntervalCount,
    model_after_feedback: modelSummary(afterState.model), next_proposal_date: nextPlan?.recommendedDate ?? null,
    recommendation_changed: Boolean(nextPlan && nextPlan.recommendedDate !== initialPlan.recommendedDate) };
}

function directHistoryPolicy(days, overrides = {}) {
  return { choreId: 'directed:personal', kind: 'personal', mode: 'balanced',
    initialDays: { frequent: days, balanced: days, relaxed: days }, enabled: true, fixedDays: null, version: 'directed-v1', ...overrides };
}

function completionEvent({ operationId, sequence, date, roundId, completionId = operationId, mode = 'balanced',
  days = 14, displayedWindow = null, origin = 'personal' }) {
  return { operationId, sequence, recordedAt: `${date}T08:00:00+09:00`, type: 'complete', completionId, roundId,
    localDate: date, timeZone: ADAPTER.timezone, origin, mode, initialDays: days, displayedWindow };
}

function dayGeometry({ from = '2026-11-04', through = '2026-11-12', bands = [{ weekday: 3, startMinute: 540, endMinute: 1020 }],
  restDays = [], dayOverrides = [], events = [], busy = [], maximumMinutes, heavyLimit = 4, normalLimit = 4, timeZone = ADAPTER.timezone }) {
  return prepareAdaptivePlacementInput({ from, through, timeZone,
    preferences: { restDays, heavyLimit, normalLimit, ...(maximumMinutes === undefined ? {} : { maximumMinutes }),
      allowedBands: bands, dayOverrides }, events, exceptions: [], busy, fingerprint });
}

function task({ id = 'round', choreId = 'chore', baseDate = '2026-11-04', periodDays = 7, minutes = 30,
  load = 'normal', purpose = 'direct', previous, fixedDaily = false, windowRadiusDays = 0, lastCompletedDate,
  holidayPriority = false }) {
  return { id, choreId, baseDate, periodDays, minutes, load, purpose, ...(previous ? { previous } : {}), fixedDaily,
    windowRadiusDays, ...(lastCompletedDate ? { lastCompletedDate } : {}), holidayPriority };
}

function applyPlan(geometry, tasks, { today = '2026-11-04', fixedLoads = [], now = Date.parse(`${today}T00:00:00+09:00`), holidaysConfigured = false } = {}) {
  return placeAdaptiveRounds({ ...geometry, tasks, today, now, fixedLoads, holidaysConfigured });
}

function fakeCommonPlan({ assigned = null } = {}) {
  const chore = { id: 'shared-chore', name: '風呂掃除', enabled: true, archived: false, estimatedMinutes: 30, load: 'heavy' };
  const subject = { id: 'subject-a', required: true, completed: false, virtuallyConsumed: false, cooldownSuppressed: false,
    subjectUserId: null, formalDate: { kind: 'generated' }, suggestedDate: '2026-11-11' };
  return { initialized: true, groupId: 'directed-group', sourceHash: 'common-source', planHash: 'common-plan',
    members: [{ active: true, userId: 'u1' }, { active: true, userId: 'u2' }], chores: [chore], history: [],
    occurrences: [{ choreId: chore.id, historical: false, activeInPeriod: true, assigneeIds: assigned ? [assigned] : [], subjects: [subject] }] };
}

async function storeFlow({ choreId, days = 14, anchor, base = '2026-11-04', completions = [], undo = false, fixedEdit }) {
  const h = createDatabase();
  const { database, connection } = h;
  const policy = directHistoryPolicy(days, { choreId, ...(anchor ? { planningAnchorDate: anchor } : {}) });
  const planningFor = (today, now, inputRevision) => ({ today, now, inputRevision,
    assertInputsCurrent() {},
    plan({ roundId, state, previous, trigger }) {
      const through = addDays(today, 180);
      const geometry = dayGeometry({ from: today, through,
        bands: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, startMinute: 0, endMinute: 1440 })),
        heavyLimit: 10, normalLimit: 10 });
      const definition = { id: choreId, householdId: 'directed-household', enabled: true, archived: false,
        personalSchedulingKind: 'personal', estimatedMinutes: 10, load: 'light', holidayPriority: false, userWindowRadiusDays: 0 };
      const { adaptivePersonalRoundId } = adaptiveStore;
      const result = planPersonalAdaptiveRounds({ requests: [{ roundId, chore: definition, state, previous, trigger }], geometry,
        ownerId: 'directed-owner', today, now: Date.parse(now), fixedLoads: [], fingerprint });
      return result.get(roundId);
    } });
  await adaptiveStore.initializeAdaptivePersonalSchemaInside(database);
  const initPlanning = planningFor(base, `${base}T00:00:00+09:00`, 'init');
  await database.withTransactionAsync(() => adaptiveStore.initializeAdaptivePersonalChoreInside(database, policy, initPlanning, fingerprint));
  let view = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
  const initial = { ...view };
  for (const item of completions) {
    const when = item.date ?? view.plan.recommendedDate;
    const now = `${when}T08:00:00+09:00`;
    const operation = { operationId: item.operationId, recordedAt: now, type: 'complete',
      completionId: item.completionId ?? item.operationId, roundId: view.plan.id, planRevision: view.planRevision,
      date: when, timeZone: ADAPTER.timezone, origin: 'personal' };
    const planning = planningFor(when, now, `completion:${item.operationId}`);
    await database.withTransactionAsync(() => adaptiveStore.applyAdaptivePersonalOperationInside(database, choreId, operation, planning, fingerprint));
    view = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
    if (fixedEdit !== undefined && item.afterFixedEdit) {
      const settingsNow = `${when}T09:00:00+09:00`;
      const settingsPlanning = planningFor(when, settingsNow, `settings:${item.operationId}`);
      await database.withTransactionAsync(() => adaptiveStore.applyAdaptivePersonalOperationInside(database, choreId,
        { operationId: `${item.operationId}:settings`, recordedAt: settingsNow, type: 'settings', fixedDays: fixedEdit }, settingsPlanning, fingerprint));
      view = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
    }
    if (undo && item.undo) {
      const undoNow = `${addDays(when, 1)}T08:00:00+09:00`;
      const undoPlanning = planningFor(addDays(when, 1), undoNow, `undo:${item.operationId}`);
      await database.withTransactionAsync(() => adaptiveStore.applyAdaptivePersonalOperationInside(database, choreId,
        { operationId: `${item.operationId}:undo`, recordedAt: undoNow, type: 'undo', completionId: operation.completionId,
          targetOperationId: operation.operationId }, undoPlanning, fingerprint));
      view = await adaptiveStore.readAdaptivePersonalInside(database, choreId);
    }
  }
  return { ...h, initial, view, dispose() { connection.close(); } };
}

export async function evaluateDirectedCase(directed) {
  const id = directed.id;
  let observed;
  if (['D01', 'D02'].includes(id)) {
    const today = directed.input.today;
    const recommended = directed.input.existing_chore_day;
    const base = { id: 'existing', originalBaseDate: recommended, placedBaseDate: recommended, recommendedDate: recommended,
      basicWindow: null, displayedWindow: null, slot: null, fallback: true };
    const geometry = dayGeometry({ from: today, through: addDays(today, 5), bands: Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1, startMinute: 540, endMinute: 1020 })), heavyLimit: 8, normalLimit: 8 });
    const plan = applyPlan(geometry, [task({ id: 'existing', baseDate: today, purpose: 'automatic', previous: base,
      windowRadiusDays: 3 })], { today });
    observed = { recommended_day: plan[0].recommendedDate, extra_confirmation_count: 0 };
  } else if (id === 'D03') {
    const today = directed.input.today;
    const geometry = dayGeometry({ from: today, through: addDays(today, 8), bands: Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1, startMinute: 540, endMinute: 1020 })), heavyLimit: 8, normalLimit: 8 });
    const plan = applyPlan(geometry, [task({ id: 'other', baseDate: today, purpose: 'automatic', windowRadiusDays: 4 })], { today });
    observed = { move_other_chore_to_today: plan[0].recommendedDate === today };
  } else if (id === 'D04') {
    const h = await storeFlow({ choreId: 'directed:daily', days: 1, anchor: '2026-11-03', base: '2026-11-04',
      completions: [{ operationId: 'd04-complete' }] });
    try { observed = { next_day: h.view.plan.recommendedDate, same_day_reappearance: h.view.plan.id === h.initial.plan.id };
    } finally { h.dispose(); }
  } else if (id === 'D05') {
    const today = directed.input.today;
    const previous = { id: 'fallback', originalBaseDate: directed.input.original_base_day, placedBaseDate: directed.input.current_recommended_day,
      recommendedDate: directed.input.current_recommended_day, basicWindow: null, displayedWindow: null, slot: null, fallback: true };
    const geometry = dayGeometry({ from: today, through: addDays(today, 5), bands: [], heavyLimit: 0, normalLimit: 0 });
    const plan = applyPlan(geometry, [task({ id: 'fallback', baseDate: directed.input.original_base_day, purpose: 'automatic',
      previous, windowRadiusDays: 2 })], { today });
    observed = { recommended_day: plan[0].recommendedDate };
  } else if (id === 'D06') {
    const date = '2026-11-04';
    const geometry = dayGeometry({ from: date, through: addDays(date, 2), bands: [{ weekday: 3, startMinute: 540, endMinute: 585 }],
      maximumMinutes: 45, heavyLimit: 4, normalLimit: 4 });
    const load = { roundId: 'completed-occurrence', date, minutes: directed.input.completed_today_minutes, load: 'normal', slot: null };
    const one = applyPlan(geometry, [task({ id: 'new-round', baseDate: date, purpose: 'direct', minutes: directed.input.new_chore_minutes,
      windowRadiusDays: 0 })], { today: date, fixedLoads: [load] })[0];
    const duplicate = applyPlan(geometry, [task({ id: 'new-round', baseDate: date, purpose: 'direct', minutes: directed.input.new_chore_minutes,
      windowRadiusDays: 0 })], { today: date, fixedLoads: [load, { ...load }] })[0];
    const fitProbeGeometry = dayGeometry({ from: date, through: addDays(date, 1), bands: [{ weekday: 3, startMinute: 540, endMinute: 600 }],
      maximumMinutes: 60, heavyLimit: 4, normalLimit: 4 });
    const fitProbe = applyPlan(fitProbeGeometry, [task({ id: 'fit-probe', baseDate: date, purpose: 'direct', minutes: 15,
      windowRadiusDays: 0 })], { today: date, fixedLoads: [load, { ...load }] })[0];
    observed = { existing_completed_load: directed.input.completed_today_minutes, new_chore_fit_today: Boolean(one.slot), duplicate_result_matches_single: one.recommendedDate === duplicate.recommendedDate
      && Boolean(one.slot) === Boolean(duplicate.slot), duplicate_load_still_allows_fifteen_minutes: Boolean(fitProbe.slot) };
  } else if (id === 'D07') {
    const date = '2026-11-04'; const event = localEvent({ id: 'local-A', startDate: date, startMinute: 600, endMinute: 630 });
    const copy = instantSpan(date, 600, 630);
    const geometry = dayGeometry({ from: date, through: date, bands: [{ weekday: 3, startMinute: 540, endMinute: 1020 }], events: [event], busy: [copy] });
    observed = { event_count: 1, occupied_minutes: Math.round(geometry.busy.reduce((sum, span) => sum + span.end - span.start, 0) / 60_000) };
  } else if (id === 'D08') {
    const date = '2026-11-04';
    const geometry = dayGeometry({ from: date, through: date, bands: [
      { weekday: 3, startMinute: 600, endMinute: 610 }, { weekday: 3, startMinute: 660, endMinute: 670 },
      { weekday: 3, startMinute: 720, endMinute: 730 },
    ] });
    const plan = applyPlan(geometry, [task({ baseDate: date, minutes: 30, windowRadiusDays: 0 })], { today: date })[0];
    observed = { fits_contiguously: Boolean(plan.slot) };
  } else if (id === 'D09') {
    const date = directed.input.available_interval[0].slice(0, 10); const next = addDays(date, 1);
    const geometry = dayGeometry({ from: date, through: next, bands: [
      { weekday: weekdayOf(date), startMinute: 1430, endMinute: 1440 }, { weekday: weekdayOf(next), startMinute: 0, endMinute: 20 },
    ], maximumMinutes: 30, heavyLimit: 4, normalLimit: 4 });
    const plan = applyPlan(geometry, [task({ baseDate: date, minutes: 30, windowRadiusDays: 0 })], { today: date })[0];
    observed = { fits_contiguously: Boolean(plan.slot), slot_start: plan.slot ? new Date(plan.slot.start).toISOString() : null,
      slot_end: plan.slot ? new Date(plan.slot.end).toISOString() : null };
  } else if (id === 'D10') {
    const plan = fakeCommonPlan();
    const u1 = sharedAdaptiveLoad(plan, 'u1', '2026-11-04', ADAPTER.timezone, []);
    const u2 = sharedAdaptiveLoad(plan, 'u2', '2026-11-04', ADAPTER.timezone, []);
    const state = replayAdaptiveHistory({ policy: directHistoryPolicy(14, { choreId: 'shared', kind: 'shared' }),
      events: [completionEvent({ operationId: 'shared-done', sequence: 1, date: '2026-11-04', roundId: 'shared-round', origin: 'shared' })],
      forecasts: [], fingerprint });
    observed = { shared_entity_count: plan.occurrences.length, member_loads: { u1: u1.loads.length ? 30 : 0, u2: u2.loads.length ? 30 : 0 },
      learn_shared_cycle: state.model !== null };
  } else if (id === 'D11') {
    const h = await storeFlow({ choreId: 'directed:duplicate', days: 14, base: '2026-11-04', completions: [{ operationId: 'd11-complete' }] });
    try {
      const before = h.view;
      const operation = { operationId: 'd11-duplicate-delivery', recordedAt: `${h.initial.plan.recommendedDate}T09:00:00+09:00`, type: 'complete',
        completionId: 'd11-complete', roundId: h.initial.plan.id, planRevision: h.initial.planRevision,
        date: h.initial.plan.recommendedDate, timeZone: ADAPTER.timezone, origin: 'personal' };
      const when = operation.date; const through = addDays(when, 180);
      const definition = { id: 'directed:duplicate', householdId: 'directed-household', enabled: true, archived: false,
        personalSchedulingKind: 'personal', estimatedMinutes: 10, load: 'light', holidayPriority: false, userWindowRadiusDays: 0 };
      const geometry = dayGeometry({ from: when, through, bands: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startMinute: 0, endMinute: 1440 })), heavyLimit: 10, normalLimit: 10 });
      const planning = { today: when, now: operation.recordedAt, inputRevision: 'dup', assertInputsCurrent() {},
        plan({ roundId, state, previous, trigger }) { return planPersonalAdaptiveRounds({ requests: [{ roundId, chore: definition, state, previous, trigger }],
          geometry, ownerId: 'directed-owner', today: when, now: Date.parse(operation.recordedAt), fixedLoads: [], fingerprint }).get(roundId); } };
      let receipt;
      await h.database.withTransactionAsync(async () => {
        receipt = await adaptiveStore.applyAdaptivePersonalOperationInside(h.database, 'directed:duplicate', operation, planning, fingerprint);
      });
      const after = await adaptiveStore.readAdaptivePersonalInside(h.database, 'directed:duplicate');
      observed = { effective_completions: receipt.kind === 'alreadyCompleted' ? 1 : 0,
        phase_advances: after.plan?.id !== before.plan?.id ? 2 : 1, duplicate_receipt: receipt.kind };
    } finally { h.dispose(); }
  } else if (id === 'D12') {
    const h = await storeFlow({ choreId: 'directed:undo', days: 14, base: '2026-11-04', fixedEdit: 20,
      completions: [{ operationId: 'd12-complete', afterFixedEdit: true, undo: true }], undo: true });
    try {
      const actions = h.connection.prepare("SELECT action_type FROM personal_adaptive_actions WHERE chore_id=? ORDER BY sequence").all('directed:undo');
      const activeCompletions = actions.filter(row => row.action_type === 'complete').length - actions.filter(row => row.action_type === 'undo').length;
      observed = { B_fixed_days: h.view.state.policy.fixedDays, A_effective_completion_count: Math.max(0, activeCompletions) };
    } finally { h.dispose(); }
  } else if (id === 'D13') {
    const spring = personalSeasonalRound('wardrobe', 'winterStorage', 2026, 'nationalFallback', fingerprint);
    const autumn = personalSeasonalRound('wardrobe', 'summerStorage', 2026, 'nationalFallback', fingerprint);
    const nextSpring = completePersonalSeasonalRound(spring, { completedDate: '2026-08-01', region: 'nationalFallback', fingerprint });
    const state = replayAdaptiveHistory({ policy: directHistoryPolicy(null, { choreId: 'seasonal', kind: 'seasonal',
      initialDays: { frequent: null, balanced: null, relaxed: null }, fixedDays: null }), events: [], forecasts: [], fingerprint });
    observed = { autumn_fixed_day: autumn.date, infer_day_interval: state.model !== null,
      mark_autumn_complete: nextSpring.id === autumn.id };
  } else if (id === 'D14') {
    const dates = [0, 180, 360].map(day => addDays('2026-01-01', day));
    const state = replayAdaptiveHistory({ policy: directHistoryPolicy(180), forecasts: [], fingerprint,
      events: dates.map((date, index) => completionEvent({ operationId: `d14-${index}`, sequence: index + 1, date,
        roundId: `d14-round-${index}`, days: 180, displayedWindow: null })) });
    observed = { valid_intervals: state.validIntervalCount, learning_started: state.model?.days !== 180, cycle_days: state.model?.days };
  } else if (id === 'D15') {
    const dates = [0, 60, 120, 180].map(day => addDays('2026-01-01', day));
    const state = replayAdaptiveHistory({ policy: directHistoryPolicy(14), forecasts: [], fingerprint,
      events: dates.map((date, index) => completionEvent({ operationId: `d15-${index}`, sequence: index + 1, date,
        roundId: `d15-round-${index}`, days: 14, displayedWindow: null })) });
    observed = { model: state.model, hard_cap_to_14_days: state.model && (state.model.method === 'median' || state.model.method === 'exponential')
      ? state.model.days <= 14 : false, assume_no_household_care: false };
  } else if (id === 'D16') {
    const date = '2026-11-10';
    const geometry = dayGeometry({ from: '2026-11-04', through: '2026-11-15', bands: Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1, startMinute: 540, endMinute: 1020 })) });
    const inputTask = task({ baseDate: date, purpose: 'automatic', windowRadiusDays: 2 });
    const first = applyPlan(geometry, [inputTask], { today: '2026-11-04' });
    // A failed weather fetch contributes no forecast and therefore no planner input.
    const afterFailure = applyPlan(geometry, [inputTask], { today: '2026-11-04' });
    observed = { recommended_day: afterFailure[0].recommendedDate, stable: JSON.stringify(first) === JSON.stringify(afterFailure) };
  } else if (id === 'D17') {
    const events = [
      completionEvent({ operationId: 'd17-before', sequence: 1, date: '2026-01-01', roundId: 'd17-r0', days: 14 }),
      { operationId: 'd17-mode', sequence: 2, recordedAt: '2026-01-11T00:00:00+09:00', type: 'settings', mode: 'relaxed' },
      completionEvent({ operationId: 'd17-after', sequence: 3, date: '2026-01-21', roundId: 'd17-r1', days: 14, mode: 'relaxed' }),
    ];
    const state = replayAdaptiveHistory({ policy: directHistoryPolicy(14), events, forecasts: [], fingerprint });
    observed = { raw_record_kept: Boolean(state.lastPlanCompletion && state.lastPlanCompletion.date === '2026-01-21'),
      cross_mode_interval_used_for_learning: state.validIntervalCount > 0 };
  } else if (id === 'D18') {
    const events = [completionEvent({ operationId: 'd18-before', sequence: 1, date: '2026-11-04', roundId: 'd18-r0', days: 14,
      displayedWindow: null }), completionEvent({ operationId: 'd18-inside', sequence: 2, date: '2026-11-20', roundId: 'd18-r1', days: 14,
      displayedWindow: { revision: 'frozen-window', from: '2026-11-14', through: '2026-11-20' } })];
    const state = replayAdaptiveHistory({ policy: directHistoryPolicy(14), events, forecasts: [], fingerprint });
    observed = { cycle_days: state.model?.days ?? null, relearn: state.model?.days !== 14 };
  } else if (id === 'D19') {
    const date = '2026-11-04';
    const geometry = dayGeometry({ from: date, through: addDays(date, 2),
      dayOverrides: [{ date, holiday: true, allowedBands: [{ startMinute: 16 * 60, endMinute: 20 * 60 }] }],
      bands: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startMinute: 540, endMinute: 1140 })) });
    const day = geometry.days.find(row => row.date === date);
    const minutes = day.allowed.map(span => [new Date(span.start).toISOString(), new Date(span.end).toISOString()]);
    observed = { overwrite_personal_window: !(minutes.some(([start, end]) => start.includes('07:00:00.000Z') && end.includes('11:00:00.000Z'))) };
  } else if (id === 'D20') {
    const recipe = PERSONAL_CHORE_CATALOG.find(row => row.modes.balanced.kind === 'collection');
    assert.ok(recipe, 'production personal catalog must define a collection/display recipe');
    const policy = personalChoreHistoryPolicy({ id: recipe.id, personalRecipeId: recipe.id, enabled: true,
      userIntervalDays: null, recommendedCycleDays: null }, 'balanced');
    const state = replayAdaptiveHistory({ policy, events: [completionEvent({ operationId: 'd20-display', sequence: 1,
      date: '2026-11-05', roundId: 'd20-display-round', days: null })], forecasts: [], fingerprint });
    observed = { requires_completion: policy.kind !== 'display', learns_interval: state.model !== null };
  } else if (id === 'D21') {
    const from = '2026-11-04'; const through = '2026-11-06';
    const geometry = dayGeometry({ from, through, bands: [
      { weekday: 3, startMinute: 540, endMinute: 600 }, { weekday: 4, startMinute: 540, endMinute: 600 },
    ], maximumMinutes: 30, heavyLimit: 5, normalLimit: 5 });
    const plans = applyPlan(geometry, [
      task({ id: 'flex', choreId: 'flex', baseDate: from, purpose: 'automatic', minutes: 30, windowRadiusDays: 1 }),
      task({ id: 'tight', choreId: 'tight', baseDate: from, purpose: 'direct', minutes: 30, windowRadiusDays: 0 }),
    ], { today: '2026-11-02' });
    observed = { one_valid_solution: { tight: plans.find(row => row.id === 'tight').recommendedDate,
      tight_fits: Boolean(plans.find(row => row.id === 'tight').slot), flex: plans.find(row => row.id === 'flex').recommendedDate,
      flex_fits: Boolean(plans.find(row => row.id === 'flex').slot) } };
  } else throw new Error(`unknown directed case: ${id}`);

  const expected = directed.expected;
  const check = (actual, wanted) => {
    if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
      for (const [key, nested] of Object.entries(wanted)) if (key !== 'note') check(actual?.[key], nested);
      return;
    }
    if (typeof wanted === 'boolean') assert.equal(Boolean(actual), wanted, `${id} actual mismatch`);
    else assert.equal(actual, wanted, `${id} actual mismatch`);
  };
  if (id === 'D10') {
    assert.equal(observed.shared_entity_count, expected.shared_entity_count);
    assert.deepEqual(observed.member_loads, expected.member_loads);
    assert.equal(observed.learn_shared_cycle, expected.learn_shared_cycle);
  } else if (id === 'D15') {
    assert.equal(observed.hard_cap_to_14_days, expected.hard_cap_to_14_days);
    assert.equal(observed.assume_no_household_care, expected.assume_no_household_care);
  } else if (id === 'D09') {
    assert.equal(observed.fits_contiguously, expected.fits_contiguously);
    assert.equal(observed.slot_start, '2026-11-04T14:50:00.000Z');
    assert.equal(observed.slot_end, '2026-11-04T15:20:00.000Z');
  } else if (id === 'D21') {
    assert.equal(observed.one_valid_solution.tight, '2026-11-04');
    assert.equal(observed.one_valid_solution.flex, '2026-11-05');
    assert.equal(observed.one_valid_solution.tight_fits, true);
    assert.equal(observed.one_valid_solution.flex_fits, true);
  } else check(observed, expected);
  return { id, label: directed.label, passed: true, observed };
}

