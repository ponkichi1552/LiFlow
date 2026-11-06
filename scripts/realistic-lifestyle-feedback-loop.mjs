import '../tests/helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../tests/helpers/sqlite.mjs';

const { addDays, daysBetween, weekdayOf } = await import('../src/domain/scheduling/local-date.ts');
const { prepareAdaptivePlacementInput } = await import('../src/features/planner/adaptive-input.ts');
const { planPersonalAdaptiveRounds } = await import('../src/features/planner/adaptive-rounds.ts');
const { replanAdaptivePersonalInside, initializeAdaptivePersonalSchemaInside, initializeAdaptivePersonalChoreInside,
  readAdaptivePersonalInside, applyAdaptivePersonalOperationInside } = await import('../src/platform/storage/adaptive-personal-chores.ts');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timeZone = 'Asia/Tokyo';
const ownerId = 'realistic-feedback-owner';
const choreId = 'realistic-feedback-target';
const roundCount = 15;
const scenarioDefinitions = Object.freeze([
  { profile: 'daily', initialDays: 1, expectedSeedModel: 'median', seedCompletions: 4,
    seedKind: 'followed_proposals', windowRadiusDays: 0, minimumNextIntervalDays: 1, maximumNextIntervalDays: 10 },
  { profile: 'weekly', initialDays: 7, expectedSeedModel: 'weekly', seedCompletions: 7,
    seedKind: 'recorded_floor_prefix_fixed_early_v01', seedDayOffsets: [0, 9, 18, 26, 35, 41, 46],
    windowRadiusDays: 2, minimumNextIntervalDays: 7, maximumNextIntervalDays: 45 },
  { profile: 'monthEnd', initialDays: 30, expectedSeedModel: 'monthEnd', seedCompletions: 10,
    seedKind: 'gregorian_month_end_observed_rhythm', windowRadiusDays: 3, minimumNextIntervalDays: 21, maximumNextIntervalDays: 60 },
]);
const followRates = Object.freeze([0, 50, 100]);

function endOfMonth(date) {
  const value = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function dailyGeometry(today) {
  const through = addDays(today, 180);
  return prepareAdaptivePlacementInput({ from: today, through, timeZone,
    preferences: { restDays: [], heavyLimit: 10, normalLimit: 10,
      allowedBands: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, startMinute: 0, endMinute: 1440 })), dayOverrides: [] },
    events: [], exceptions: [], busy: [], fingerprint });
}

function createPlanning(today, now, revision, trigger, definition) {
  const geometry = dailyGeometry(today);
  return { today, now, inputRevision: revision, assertInputsCurrent() {},
    plan({ roundId, state, previous }) {
      return planPersonalAdaptiveRounds({ requests: [{ roundId, state, previous, trigger, chore: definition }],
        geometry, ownerId, today, now: Date.parse(now), fixedLoads: [], fingerprint }).get(roundId);
    } };
}

function basicModel(model) {
  if (!model) return null;
  if (model.method === 'median' || model.method === 'exponential') return { method: model.method, days: model.days };
  if (model.method === 'weekly') return { method: model.method, weeks: model.weeks, weekday: model.weekday, anchor: model.anchor };
  if (model.method === 'monthEnd') return { method: model.method, months: model.months, anchor: model.anchor };
  return { method: model.method, even: model.even, odd: model.odd };
}

function learningParameters(model) {
  if (!model) return null;
  if (model.method === 'median' || model.method === 'exponential') return { method: model.method, days: model.days };
  if (model.method === 'weekly') return { method: model.method, weeks: model.weeks, weekday: model.weekday };
  if (model.method === 'monthEnd') return { method: model.method, months: model.months };
  return { method: model.method, even: model.even, odd: model.odd };
}

function modelPhaseAnchor(model) {
  return model?.method === 'weekly' || model?.method === 'monthEnd' ? model.anchor : null;
}

function representativeDays(model) {
  if (!model) return 0;
  if (model.method === 'weekly') return model.weeks * 7;
  if (model.method === 'monthEnd') return model.months * 30;
  if (model.method === 'alternating') return (model.even + model.odd) / 2;
  return model.days;
}

function isInside(window, date) {
  return Boolean(window && date >= window.from && date <= window.through);
}

async function runOperation(database, { operationId, date, before, definition, eventIndex }) {
  assert.ok(before?.plan && before.planRevision, 'each completion consumes a real, currently published SQLite plan');
  const recordedAt = `${date}T12:00:00+09:00`;
  const planning = createPlanning(date, recordedAt, `feedback-${eventIndex}`, 'complete', definition);
  let receipt;
  await database.withTransactionAsync(async () => {
    receipt = await applyAdaptivePersonalOperationInside(database, choreId, {
      operationId, recordedAt, type: 'complete', completionId: `completion:${operationId}`,
      roundId: before.plan.id, planRevision: before.planRevision, date, timeZone, origin: 'personal',
    }, planning, fingerprint);
  });
  const after = await readAdaptivePersonalInside(database, choreId);
  const saved = await database.getFirstAsync('SELECT event_json FROM personal_adaptive_actions WHERE operation_id=?', operationId);
  return { receipt, after, recordedAt, savedEvent: saved?.event_json ? JSON.parse(saved.event_json) : null };
}

async function runScenario(profile, followPercent) {
  const definitionConfig = scenarioDefinitions.find(row => row.profile === profile);
  if (!definitionConfig) throw new Error(`unknown profile: ${profile}`);
  const h = createDatabase();
  const { database, connection } = h;
  const definition = { id: choreId, householdId: ownerId, name: profile, enabled: true, archived: false,
    personalSchedulingKind: 'personal', estimatedMinutes: 10, load: 'light', holidayPriority: false,
    userWindowRadiusDays: 0 };
  const policy = { choreId, kind: 'personal', mode: 'balanced',
    initialDays: { frequent: definitionConfig.initialDays, balanced: definitionConfig.initialDays, relaxed: definitionConfig.initialDays },
    enabled: true, fixedDays: profile === 'daily' ? 1 : null, version: `multi-step-feedback-v1:${profile}` };
  try {
    await initializeAdaptivePersonalSchemaInside(database);
    const start = profile === 'daily' ? '2026-01-05' : profile === 'weekly' ? '2026-01-01' : '2026-01-01';
    const initialPlanning = createPlanning(start, `${start}T08:00:00+09:00`, `initial:${profile}:${followPercent}`, 'initial', definition);
    await database.withTransactionAsync(() => initializeAdaptivePersonalChoreInside(database, policy, initialPlanning, fingerprint));

    let eventIndex = 0;
    const seedDates = [];
    const seedHistory = [];
    for (let index = 0; index < definitionConfig.seedCompletions; index++) {
      const before = await readAdaptivePersonalInside(database, choreId);
      const monthStart = new Date(Date.UTC(2026, index, 1)).toISOString().slice(0, 10);
      const seedDate = profile === 'daily' ? before.plan.recommendedDate
        : profile === 'weekly' ? addDays(start, definitionConfig.seedDayOffsets[index])
          : endOfMonth(monthStart);
      const { receipt, after } = await runOperation(database, { operationId: `seed:${profile}:${index}`, date: seedDate,
        before, definition, eventIndex: eventIndex++ });
      if (receipt.kind !== 'applied' || !after?.plan) throw new Error(`${profile} seed ${index} did not apply and publish the next plan`);
      seedDates.push(seedDate);
      seedHistory.push({ date: seedDate, model: basicModel(after.state.model), valid_interval_count: after.state.validIntervalCount,
        previous_plan_base: before.plan.originalBaseDate, previous_proposal: before.plan.recommendedDate,
        next_plan_base: after.plan.originalBaseDate, next_proposal: after.plan.recommendedDate });
    }

    let view = await readAdaptivePersonalInside(database, choreId);
    if (view.state.model?.method !== definitionConfig.expectedSeedModel) {
      return { profile, follow_percent: followPercent, status: 'not_tested', reason: 'predeclared seed rhythm did not adopt the requested production model',
        seed_kind: definitionConfig.seedKind, seed_completion_count: seedDates.length, seed_dates: seedDates,
        adopted_model: basicModel(view.state.model), expected_model: definitionConfig.expectedSeedModel, seed_history: seedHistory,
        completed_steps: 0, operations: [] };
    }

    // Radius is an explicit test setting changed after the real model is adopted.
    // Replan through the application store; do not add a displayed window to an event.
    definition.userWindowRadiusDays = definitionConfig.windowRadiusDays;
    const settingDay = view.state.lastPlanCompletion.date;
    const settingNow = `${settingDay}T13:00:00+09:00`;
    const settingPlanning = createPlanning(settingDay, settingNow, `window-setting:${profile}:${followPercent}`, 'replan', definition);
    await database.withTransactionAsync(() => replanAdaptivePersonalInside(database, choreId, settingPlanning, fingerprint));
    view = await readAdaptivePersonalInside(database, choreId);
    const startingModel = basicModel(view.state.model);
    if (profile !== 'daily' && !view.plan?.displayedWindow) throw new Error(`${profile} real replan did not publish the configured displayed window`);

    const operations = [];
    const violations = [];
    for (let step = 0; step < roundCount; step++) {
      const before = await readAdaptivePersonalInside(database, choreId);
      assert.ok(before?.plan && before.planRevision, `${profile}/${followPercent}% step ${step} has no live plan`);
      const shouldFollow = followPercent === 100 || followPercent === 50 && step % 2 === 0;
      const date = shouldFollow ? before.plan.recommendedDate
        : addDays(before.plan.displayedWindow?.through ?? before.plan.recommendedDate, 1);
      const insideWindow = isInside(before.plan.displayedWindow, date);
      const planId = before.plan.id;
      const planRevision = before.planRevision;
      const { receipt, after, savedEvent } = await runOperation(database, { operationId: `loop:${profile}:${followPercent}:${step}`,
        date, before, definition, eventIndex: eventIndex++ });
      if (receipt.kind !== 'applied' || !after?.plan || after.plan.id === planId || after.planRevision === planRevision) {
        throw new Error(`${profile}/${followPercent}% step ${step} did not consume one proposal and publish a new proposal`);
      }
      const parametersBefore = learningParameters(before.state.model);
      const parametersAfter = learningParameters(after.state.model);
      const learningParametersChanged = JSON.stringify(parametersBefore) !== JSON.stringify(parametersAfter);
      const phaseAnchorBefore = modelPhaseAnchor(before.state.model);
      const phaseAnchorAfter = modelPhaseAnchor(after.state.model);
      const phaseAnchorAdvanced = phaseAnchorBefore !== phaseAnchorAfter;
      if (insideWindow && learningParametersChanged) violations.push({ step: step + 1,
        kind: 'learning_parameters_changed_inside_frozen_window', completion_date: date,
        displayed_window: before.plan.displayedWindow, model_before: parametersBefore, model_after: parametersAfter });
      const expectedStoredWindow = before.plan.displayedWindow
        ? { revision: planRevision, ...before.plan.displayedWindow } : null;
      if (JSON.stringify(savedEvent?.displayedWindow ?? null) !== JSON.stringify(expectedStoredWindow)
        || savedEvent?.ruleDate !== before.plan.originalBaseDate) {
        violations.push({ step: step + 1, kind: 'stored_completion_did_not_preserve_published_window_and_rule_date',
          expected_rule_date: before.plan.originalBaseDate, actual_rule_date: savedEvent?.ruleDate ?? null,
          expected_window: expectedStoredWindow, actual_window: savedEvent?.displayedWindow ?? null });
      }
      if (after.state.model?.method === 'weekly' && weekdayOf(after.plan.originalBaseDate) !== after.state.model.weekday) {
        violations.push({ step: step + 1, kind: 'next_plan_left_adopted_weekday_phase',
          model: basicModel(after.state.model), next_plan_base: after.plan.originalBaseDate });
      }
      if (after.state.model?.method === 'monthEnd' && endOfMonth(after.plan.originalBaseDate) !== after.plan.originalBaseDate) {
        violations.push({ step: step + 1, kind: 'next_plan_left_adopted_month_end_phase',
          model: basicModel(after.state.model), next_plan_base: after.plan.originalBaseDate });
      }
      const nextPlanAheadDays = daysBetween(date, after.plan.recommendedDate);
      if (nextPlanAheadDays < 1) throw new Error(`${profile}/${followPercent}% step ${step} published a plan on or before its completion`);
      const modelPeriodDays = representativeDays(after.state.model);
      if (modelPeriodDays < definitionConfig.minimumNextIntervalDays
        || modelPeriodDays > definitionConfig.maximumNextIntervalDays) {
        violations.push({ step: step + 1, kind: 'model_period_outside_predeclared_guardrail', model_period_days: modelPeriodDays,
          predeclared_minimum_days: definitionConfig.minimumNextIntervalDays,
          predeclared_maximum_days: definitionConfig.maximumNextIntervalDays,
          model_after: basicModel(after.state.model) });
      }
      operations.push({ step: step + 1, followed_proposal: shouldFollow, prior_plan_id: planId, prior_plan_revision: planRevision,
        proposal_date: before.plan.recommendedDate, displayed_window: before.plan.displayedWindow, completion_date: date,
        completion_inside_actual_frozen_window: insideWindow, model_before: basicModel(before.state.model),
        model_after: basicModel(after.state.model), learning_parameters_before: parametersBefore,
        learning_parameters_after: parametersAfter, learning_parameters_changed: learningParametersChanged,
        learning_parameters_changed_inside_window: insideWindow && learningParametersChanged,
        phase_anchor_before: phaseAnchorBefore, phase_anchor_after: phaseAnchorAfter, phase_anchor_advanced: phaseAnchorAdvanced,
        stored_rule_date: savedEvent?.ruleDate ?? null, stored_window: savedEvent?.displayedWindow ?? null,
        next_plan_id: after.plan.id,
        next_plan_revision: after.planRevision, next_recommended_date: after.plan.recommendedDate,
        next_plan_ahead_days: nextPlanAheadDays, model_period_days: modelPeriodDays,
        next_plan_base: after.plan.originalBaseDate, receipt: receipt.kind });
      view = after;
    }

    return { profile, follow_percent: followPercent, status: violations.length ? 'fail' : 'pass', violations,
      seed_kind: definitionConfig.seedKind,
      seed_completion_count: seedDates.length, seed_dates: seedDates, starting_model: startingModel,
      configured_window_radius_days: definitionConfig.windowRadiusDays, initial_displayed_window: operations[0]?.displayed_window ?? null,
      completed_steps: operations.length, expected_steps: roundCount,
      follow_actions: operations.filter(row => row.followed_proposal).length,
      actual_sqlite_completion_operations: eventIndex,
      learning_parameter_changes_inside_window: operations.filter(row => row.learning_parameters_changed_inside_window).length,
      phase_anchor_advances_inside_window: operations.filter(row => row.completion_inside_actual_frozen_window && row.phase_anchor_advanced).length,
      minimum_model_period_days: Math.min(...operations.map(row => row.model_period_days)),
      maximum_model_period_days: Math.max(...operations.map(row => row.model_period_days)),
      minimum_next_plan_ahead_days: Math.min(...operations.map(row => row.next_plan_ahead_days)), operations };
  } finally {
    connection.close();
  }
}

export async function runFeedbackLoopSuite() {
  const scenarios = [];
  for (const definition of scenarioDefinitions) for (const followPercent of followRates) {
    scenarios.push(await runScenario(definition.profile, followPercent));
  }
  const notTested = scenarios.filter(row => row.status === 'not_tested');
  const failures = scenarios.filter(row => row.status === 'fail');
  const expectedObservations = scenarioDefinitions.length * followRates.length * roundCount;
  const actualObservations = scenarios.reduce((total, row) => total + row.completed_steps, 0);
  const sourceFiles = ['scripts/realistic-lifestyle-feedback-loop.mjs', 'tests/realistic-lifestyle-feedback-loop.test.mjs',
    'src/domain/scheduling/local-date.ts', 'src/domain/scheduling/adaptive/history.ts',
    'src/domain/scheduling/adaptive/models.ts', 'src/domain/scheduling/adaptive/placement.ts',
    'src/features/planner/adaptive-input.ts', 'src/features/planner/adaptive-rounds.ts',
    'src/platform/storage/adaptive-personal-chores.ts', 'tests/helpers/sqlite.mjs', 'tests/helpers/typescript-loader.mjs'];
  const sourceHashes = {};
  for (const relativePath of sourceFiles) sourceHashes[relativePath] = createHash('sha256').update(await readFile(join(root, relativePath))).digest('hex');
  return { schema_version: 1,
    kind: 'predeclared multi-step feedback probe using real adaptive SQLite store and published plans',
    source_input: 'preregistered daily and Gregorian month-end behavior plus a recorded observed_history prefix; operations enter one at a time, and no hidden truth or future completion column is used',
    source_file_sha256: sourceHashes,
    profiles: scenarioDefinitions, follow_rates_percent: followRates, steps_per_scenario: roundCount,
    scenario_count: scenarios.length, expected_operation_observations: expectedObservations,
    actual_operation_observations: actualObservations, status: failures.length || notTested.length ? 'fail' : 'pass',
    failure_count: failures.length, not_tested_count: notTested.length,
    assertions: { each_step_consumes_actual_published_sqlite_plan: true, next_plan_republished_by_actual_store: true,
      no_synthetic_displayed_windows: true,
      in_window_learning_parameter_changes: scenarios.reduce((total, row) => total + (row.learning_parameter_changes_inside_window ?? 0), 0),
      extra_inputs_or_prompts_in_fixture: 0, no_runaway_shortening: failures.length === 0 },
    scenarios };
}

async function main() {
  const result = await runFeedbackLoopSuite();
  const outputPath = join(root, 'docs/qa-assets/realistic-2026-11-06/results/multistep-feedback.json');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: outputPath, status: result.status, scenarios: result.scenario_count,
    expected_steps: result.expected_operation_observations, actual_steps: result.actual_operation_observations,
    failures: result.failure_count, not_tested: result.not_tested_count }, null, 2)}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
