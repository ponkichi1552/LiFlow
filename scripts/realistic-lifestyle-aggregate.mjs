import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const resultsDirectory = join(root, 'docs/qa-assets/realistic-2026-11-06/results');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number.isFinite(row?.[key]) ? row[key] : 0), 0);
}

function traceTotals(repositoryCases) {
  const totals = { applied_completions: 0, learning_eligible_completions: 0, inside_frozen_window_completions: 0,
    inside_window_model_changes: 0, out_of_frozen_window_completions: 0, pre_three_interval_checks: 0,
    pre_three_interval_model_changes: 0, learned_above_initial_cycle: 0 };
  for (const result of repositoryCases) for (const row of Object.values(result.trace_by_chore ?? {})) {
    totals.applied_completions += row.applied_completions ?? 0;
    totals.learning_eligible_completions += row.learning_eligible ?? 0;
    totals.inside_frozen_window_completions += row.inside_frozen_window ?? 0;
    totals.inside_window_model_changes += row.inside_window_model_changes ?? 0;
    totals.out_of_frozen_window_completions += row.out_of_frozen_window ?? 0;
    totals.pre_three_interval_checks += row.pre_three_interval_checks ?? 0;
    totals.pre_three_interval_model_changes += row.pre_three_interval_model_changes ?? 0;
    totals.learned_above_initial_cycle += row.learned_above_initial_cycle ?? 0;
  }
  return totals;
}

export function summarizeOperationTraceRows(rows) {
  const total = { rows: 0, initialization_rows: 0, operation_rows: 0, calendar_replan_calls: 0,
    published_plan_results: 0, fallback_plan_results: 0, no_plan_results: 0,
    fallback_by_step_kind: {}, no_plan_by_step_kind: {}, completion_operation_rows: 0,
    completion_receipts: {}, settings_operation_rows: 0, undo_operation_rows: 0 };
  const perCase = new Map();
  for (const row of rows) {
    if (typeof row?.case_id !== 'string' || !row.case_id) throw new Error('operation trace row is missing case_id');
    const kind = row.step_kind ?? 'unknown';
    const current = perCase.get(row.case_id) ?? { trace_rows: 0, initialization_rows: 0, operation_rows: 0,
      calendar_replan_calls: 0, published_plan_results: 0, fallback_plan_results: 0, no_plan_results: 0,
      fallback_calendar_replans: 0, no_plan_calendar_replans: 0, completion_operation_rows: 0,
      completion_receipts: {}, settings_operation_rows: 0, undo_operation_rows: 0 };
    total.rows++; current.trace_rows++;
    if (kind === 'initialize') { total.initialization_rows++; current.initialization_rows++; }
    if (kind === 'operation') { total.operation_rows++; current.operation_rows++; }
    if (kind === 'calendar_replan') { total.calendar_replan_calls++; current.calendar_replan_calls++; }
    if (row.action_input?.type === 'complete') {
      total.completion_operation_rows++; current.completion_operation_rows++;
      total.completion_receipts[row.receipt] = (total.completion_receipts[row.receipt] ?? 0) + 1;
      current.completion_receipts[row.receipt] = (current.completion_receipts[row.receipt] ?? 0) + 1;
    }
    if (row.action_input?.type === 'settings') { total.settings_operation_rows++; current.settings_operation_rows++; }
    if (row.action_input?.type === 'undo') { total.undo_operation_rows++; current.undo_operation_rows++; }
    if (row.plan_after) total.published_plan_results++, current.published_plan_results++;
    else {
      total.no_plan_results++; current.no_plan_results++;
      total.no_plan_by_step_kind[kind] = (total.no_plan_by_step_kind[kind] ?? 0) + 1;
      if (kind === 'calendar_replan') current.no_plan_calendar_replans++;
    }
    if (row.plan_after?.fallback === true) {
      total.fallback_plan_results++; current.fallback_plan_results++;
      total.fallback_by_step_kind[kind] = (total.fallback_by_step_kind[kind] ?? 0) + 1;
      if (kind === 'calendar_replan') current.fallback_calendar_replans++;
    }
    perCase.set(row.case_id, current);
  }
  return { total, per_case: Object.fromEntries([...perCase].sort(([a], [b]) => a.localeCompare(b))) };
}

async function summarizeOperationTraceFile(path) {
  const hash = createHash('sha256');
  const parser = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  const total = { rows: 0, initialization_rows: 0, operation_rows: 0, calendar_replan_calls: 0,
    published_plan_results: 0, fallback_plan_results: 0, no_plan_results: 0,
    fallback_by_step_kind: {}, no_plan_by_step_kind: {}, completion_operation_rows: 0,
    completion_receipts: {}, settings_operation_rows: 0, undo_operation_rows: 0 };
  const perCase = new Map();
  const source = createReadStream(path);
  let bytes = 0;
  source.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
  // Keep hashing separate from decompression so the digest is over the exact archived bytes.
  const checksumPromise = new Promise((resolveChecksum, rejectChecksum) => {
    source.on('end', resolveChecksum); source.on('error', rejectChecksum);
  });
  for await (const line of parser) {
    if (!line) continue;
    const part = summarizeOperationTraceRows([JSON.parse(line)]);
    for (const [key, value] of Object.entries(part.total)) {
      if (typeof value === 'number') total[key] += value;
      else if (value && typeof value === 'object') for (const [innerKey, innerValue] of Object.entries(value)) {
        total[key][innerKey] = (total[key][innerKey] ?? 0) + innerValue;
      }
    }
    const [caseId, stats] = Object.entries(part.per_case)[0];
    const target = perCase.get(caseId) ?? { trace_rows: 0, initialization_rows: 0, operation_rows: 0,
      calendar_replan_calls: 0, published_plan_results: 0, fallback_plan_results: 0, no_plan_results: 0,
      fallback_calendar_replans: 0, no_plan_calendar_replans: 0, completion_operation_rows: 0,
      completion_receipts: {}, settings_operation_rows: 0, undo_operation_rows: 0 };
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === 'number') target[key] += value;
      else for (const [innerKey, innerValue] of Object.entries(value)) target[key][innerKey] = (target[key][innerKey] ?? 0) + innerValue;
    }
    perCase.set(caseId, target);
  }
  await checksumPromise;
  return { ...total, bytes, sha256: hash.digest('hex'), per_case: Object.fromEntries([...perCase].sort(([a], [b]) => a.localeCompare(b))) };
}

function assertMatchingCaseRecords(report, { requireFullSample = false } = {}) {
  const cases = report.corpus?.cases;
  const repositoryCases = report.sqlite_repository?.cases;
  const expectedCount = report.unique_cases;
  if (!Number.isInteger(expectedCount) || expectedCount < 1
    || !Array.isArray(cases) || !Array.isArray(repositoryCases)) {
    throw new Error('report is missing a valid unique-case count or per-case arrays');
  }
  if (report.requested_case_count !== expectedCount || report.actual_case_evaluations !== expectedCount
    || report.actual_repetitions_per_case !== 1 || cases.length !== expectedCount || repositoryCases.length !== expectedCount) {
    throw new Error('requested, actual, unique, and per-case evaluation counts do not agree');
  }
  if (requireFullSample && (expectedCount !== 840 || report.sampled !== false)) {
    throw new Error('full split aggregate requires exactly 840 unsampled unique cases');
  }
  const collectIds = (rows, label) => {
    const ids = rows.map(row => row?.case_id);
    if (ids.some(id => typeof id !== 'string' || id.length === 0)) throw new Error(`${label} contains a missing case_id`);
    const unique = new Set(ids);
    if (unique.size !== expectedCount) throw new Error(`${label} contains duplicate case_id values`);
    return unique;
  };
  const corpusIds = collectIds(cases, 'corpus per-case records');
  const repositoryIds = collectIds(repositoryCases, 'SQLite per-case records');
  if ([...corpusIds].some(id => !repositoryIds.has(id)) || [...repositoryIds].some(id => !corpusIds.has(id))) {
    throw new Error('corpus and SQLite per-case IDs do not match exactly');
  }
  if (cases.some(row => row.split !== report.split)) throw new Error('corpus per-case split does not match report split');
  if (cases.some(row => row.status !== undefined && row.status !== 'pass')) throw new Error('corpus per-case record is not passing');
  if (repositoryCases.some(row => row.status !== 'pass')) throw new Error('SQLite per-case record is not passing');
  if (report.corpus.case_status_counts?.pass !== expectedCount
    || report.sqlite_repository.status_counts?.pass !== expectedCount) {
    throw new Error('per-case pass totals disagree with the reported corpus or SQLite status counts');
  }
  return { cases, repositoryCases };
}

function assertBenchmarkOutcomes(report) {
  if (!Array.isArray(report.failures) || report.failures.length !== 0
    || report.automatic_checks?.failures !== 0) throw new Error('raw report has failures or a missing/contradictory failure count');

  const directed = report.directed;
  const expectedDirectedIds = Array.from({ length: 21 }, (_, index) => `D${String(index + 1).padStart(2, '0')}`);
  if (!directed || directed.unique_cases !== 21 || directed.actual_case_evaluations !== 21
    || directed.assertion_pass_count !== 21 || directed.status_counts?.pass !== 21
    || directed.status_counts?.fail !== 0 || !Array.isArray(directed.cases) || directed.cases.length !== 21) {
    throw new Error('directed result counts are incomplete or contradictory');
  }
  const directedIds = directed.cases.map(row => row?.id);
  if (new Set(directedIds).size !== 21 || expectedDirectedIds.some(id => !directedIds.includes(id))
    || directed.cases.some(row => row.passed !== true)) throw new Error('directed cases contain missing, duplicate, or failing results');

  const scenarios = report.closed_loop;
  if (!Array.isArray(scenarios) || scenarios.length !== 3) throw new Error('closed-loop sensitivity is missing one or more follow-rate scenarios');
  const percentages = [0, 50, 100];
  const sourceIdsByScenario = [];
  for (const percent of percentages) {
    const scenario = scenarios.find(row => row.target_follow_percent === percent);
    if (!scenario || scenario.unique_source_cases !== 84 || scenario.scenario_observations !== 84
      || !Array.isArray(scenario.cases) || scenario.cases.length !== 84) {
      throw new Error(`closed-loop ${percent}% scenario has incomplete case counts`);
    }
    const caseIds = scenario.cases.map(row => row?.case_id);
    if (caseIds.some(id => typeof id !== 'string' || id.length === 0) || new Set(caseIds).size !== 84) {
      throw new Error(`closed-loop ${percent}% scenario has missing or duplicate case IDs`);
    }
    sourceIdsByScenario.push(new Set(caseIds));
    const failures = scenario.cases.filter(row => row.status === 'fail').length;
    const notApplicable = scenario.cases.filter(row => row.status === 'not_applicable').length;
    const passing = scenario.cases.filter(row => row.status === 'pass').length;
    const followActions = scenario.cases.filter(row => row.follow_recommendation === true).length;
    if (scenario.cases.some(row => !['pass', 'not_applicable'].includes(row.status))
      || scenario.fail_count !== failures || scenario.fail_count !== 0
      || scenario.not_applicable_count !== notApplicable || scenario.actionable_cases !== passing
      || scenario.follow_actions !== followActions) {
      throw new Error(`closed-loop ${percent}% scenario summary contradicts per-case results`);
    }
    const observedFraction = passing ? followActions / passing : null;
    if (scenario.observed_follow_fraction !== observedFraction) {
      throw new Error(`closed-loop ${percent}% scenario follow fraction contradicts per-case results`);
    }
  }
  for (let index = 1; index < sourceIdsByScenario.length; index++) {
    if ([...sourceIdsByScenario[0]].some(id => !sourceIdsByScenario[index].has(id))) {
      throw new Error('closed-loop scenarios do not use the same 84 source cases');
    }
  }
}

export function summarizeChronologyMetrics(report) {
  const { cases, repositoryCases } = assertMatchingCaseRecords(report);
  const attemptedFromCases = sum(cases.map(row => row.metrics), 'target_recorded_completion_count');
  const attemptedFromRepository = sum(repositoryCases, 'target_completion_operations');
  const appliedFromCases = sum(cases.map(row => row.metrics), 'target_applied_completion_count');
  const appliedFromRepository = sum(repositoryCases, 'target_applied_completions');
  const eligibleFromCases = sum(cases.map(row => row.metrics), 'learning_eligible_operations');
  const actualTrace = traceTotals(repositoryCases);
  if (attemptedFromCases !== attemptedFromRepository) throw new Error('per-case target completion attempts disagree across evaluators');
  if (appliedFromCases !== appliedFromRepository || appliedFromRepository !== actualTrace.applied_completions) {
    throw new Error('per-case applied target completions disagree with the actual SQLite trace');
  }
  if (eligibleFromCases !== actualTrace.learning_eligible_completions) {
    throw new Error('per-case eligibility count disagrees with the actual SQLite trace');
  }
  if (actualTrace.learning_eligible_completions > actualTrace.applied_completions) {
    throw new Error('learning-eligible completions exceed applied completions');
  }
  const rawEligible = report.corpus.metrics.learning_eligible_fraction;
  const actualFraction = actualTrace.applied_completions
    ? actualTrace.learning_eligible_completions / actualTrace.applied_completions : null;
  const scored = cases.flatMap(row => row.metrics?.scored_predictions_detail ?? []).filter(row => row.scored);
  const unresolved = cases.flatMap(row => row.metrics?.scored_predictions_detail ?? []).filter(row => row.unresolved);
  const errorSum = scored.reduce((total, row) => total + row.error_days, 0);
  const actualMae = scored.length ? errorSum / scored.length : null;
  if (scored.length !== report.corpus.metrics.scored_predictions
    || unresolved.length !== report.corpus.metrics.unresolved_predictions) throw new Error('per-case prediction totals disagree with corpus metrics');
  if (actualMae !== null && Math.abs(actualMae - report.corpus.metrics.mean_absolute_error_days_scored_only) > 1e-12) {
    throw new Error('per-case prediction errors disagree with corpus MAE');
  }
  return {
    recorded_completion_inputs_visible_to_adapter: report.corpus.metrics.recorded_completion_inputs,
    target_completion_attempts: attemptedFromCases,
    target_applied_completions: appliedFromCases,
    duplicate_or_rejected_completion_attempts: attemptedFromCases - appliedFromCases,
    learning_eligible_completions: actualTrace.learning_eligible_completions,
    learning_eligible_fraction_of_applied_target_completions: actualFraction,
    learning_eligible_fraction_of_attempted_target_completions: attemptedFromCases
      ? actualTrace.learning_eligible_completions / attemptedFromCases : null,
    frozen_window_and_learning_checks: {
      ...actualTrace,
      eligibility_definition: 'Actual SQLite applied target completion with at least three valid intervals, enabled personal policy, no fixed-days override, and outside its frozen displayed window. Counts are taken from the chronological repository trace; missing-window history is not treated as eligible input unless the actual published plan had no frozen displayed window.',
    },
    prediction_scoring: {
      scored_predictions: scored.length,
      unresolved_predictions: unresolved.length,
      mean_absolute_error_days_scored_only: actualMae,
      unresolved_counted_as_zero_error: false,
      hidden_truth_sent_to_app: false,
      hidden_truth_used_as_prediction_target: false,
    },
    raw_report_metric_caveat: {
      field: 'corpus.metrics.learning_eligible_fraction',
      raw_value: rawEligible,
      status: 'invalid_for_chronological_sqlite_evaluation',
      reason: report.corpus.metrics.learning_eligibility_reason,
      replacement_field: 'learning_eligible_fraction_of_applied_target_completions',
      replacement_value: actualFraction,
      source: 'reconciled per-case metrics against the actual SQLite operation trace; raw report was preserved unchanged',
    },
  };
}

function summarizeCoverageAndError(report, operationTraceSummary) {
  const repositoryByCase = new Map(report.sqlite_repository.cases.map(row => [row.case_id, row]));
  const traceByCase = operationTraceSummary?.per_case ?? {};
  const caseDetails = report.corpus.cases.map(row => {
    const repository = repositoryByCase.get(row.case_id);
    const targetIds = repository?.target_chore_ids;
    if (!Array.isArray(targetIds)) throw new Error(`SQLite target chore IDs are missing for ${row.case_id}`);
    const historyById = new Map((row.actual_history ?? []).map(history => [history.chore_id, history]));
    const targetHistories = targetIds.map(choreId => {
      const history = historyById.get(choreId);
      if (!history) throw new Error(`actual history is missing target chore ${row.case_id}/${choreId}`);
      return { chore_id: choreId, valid_intervals: history.valid_intervals, valid_units: history.valid_units,
        reaches_three_valid_intervals: history.valid_intervals >= 3, model: history.model, last_completion: history.last_completion };
    });
    const predictions = row.metrics?.scored_predictions_detail ?? [];
    const scored = predictions.filter(item => item.scored === true);
    const unresolved = predictions.filter(item => item.unresolved === true);
    const trace = traceByCase[row.case_id] ?? {};
    const learningEligible = sum(Object.values(repository.trace_by_chore ?? {}), 'learning_eligible');
    return { case_id: row.case_id, profile: row.profile, behavior_model: row.behavior_model,
      horizon_days: row.horizon_days, initial_now_day: row.initial_now_day,
      observed_completion_records_visible_at_initial_now: row.input?.observed_completion_records_visible_at_initial_now ?? null,
      observed_completion_records_through_horizon: row.input?.observed_completion_records_through_horizon ?? null,
      valid_intervals_at_initial_now: row.metrics?.valid_intervals_at_initial_now ?? null,
      personal_intervals_through_horizon: row.metrics?.personal_intervals_through_horizon ?? null,
      target_chore_count: targetIds.length, target_histories_reaching_three_intervals: targetHistories.filter(item => item.reaches_three_valid_intervals).length,
      target_valid_interval_total: targetHistories.reduce((total, item) => total + item.valid_intervals, 0),
      scored_predictions: scored.length, unresolved_predictions: unresolved.length,
      prediction_error_days_sum: scored.reduce((total, item) => total + item.error_days, 0),
      learning_eligible_completions: learningEligible,
      initial_placement_fallback_count: row.placements?.fallback_count ?? null,
      sqlite_calendar_replan_calls: trace.calendar_replan_calls ?? 0,
      sqlite_fallback_plan_results: trace.fallback_plan_results ?? 0,
      sqlite_fallback_calendar_replans: trace.fallback_calendar_replans ?? 0,
      sqlite_no_plan_results: trace.no_plan_results ?? 0,
      sqlite_no_plan_calendar_replans: trace.no_plan_calendar_replans ?? 0,
      target_chore_histories: targetHistories };
  });

  const groupBy = selector => {
    const groups = new Map();
    for (const row of caseDetails) {
      const key = selector(row);
      const group = groups.get(key) ?? { key, case_count: 0, observation_days_total: 0,
        observation_days_min: Number.POSITIVE_INFINITY, observation_days_max: 0,
        visible_completion_records_total: 0, horizon_completion_records_total: 0,
        initial_valid_intervals_total: 0, final_personal_valid_intervals_total: 0,
        target_chore_histories: 0, target_histories_reaching_three_intervals: 0,
        target_valid_interval_total: 0, target_valid_interval_histogram: {},
        scored_predictions: 0, unresolved_predictions: 0, prediction_error_days_sum: 0,
        learning_eligible_completions: 0, initial_placement_fallback_count: 0,
        sqlite_calendar_replan_calls: 0, sqlite_fallback_plan_results: 0,
        sqlite_fallback_calendar_replans: 0, sqlite_no_plan_results: 0, sqlite_no_plan_calendar_replans: 0 };
      group.case_count++;
      group.observation_days_total += row.horizon_days;
      group.observation_days_min = Math.min(group.observation_days_min, row.horizon_days);
      group.observation_days_max = Math.max(group.observation_days_max, row.horizon_days);
      group.visible_completion_records_total += row.observed_completion_records_visible_at_initial_now ?? 0;
      group.horizon_completion_records_total += row.observed_completion_records_through_horizon ?? 0;
      group.initial_valid_intervals_total += row.valid_intervals_at_initial_now ?? 0;
      group.final_personal_valid_intervals_total += row.personal_intervals_through_horizon ?? 0;
      group.target_chore_histories += row.target_chore_count;
      group.target_histories_reaching_three_intervals += row.target_histories_reaching_three_intervals;
      group.target_valid_interval_total += row.target_valid_interval_total;
      for (const history of row.target_chore_histories) {
        const intervalKey = String(history.valid_intervals);
        group.target_valid_interval_histogram[intervalKey] = (group.target_valid_interval_histogram[intervalKey] ?? 0) + 1;
      }
      group.scored_predictions += row.scored_predictions;
      group.unresolved_predictions += row.unresolved_predictions;
      group.prediction_error_days_sum += row.prediction_error_days_sum;
      group.learning_eligible_completions += row.learning_eligible_completions;
      group.initial_placement_fallback_count += row.initial_placement_fallback_count ?? 0;
      for (const field of ['sqlite_calendar_replan_calls', 'sqlite_fallback_plan_results', 'sqlite_fallback_calendar_replans',
        'sqlite_no_plan_results', 'sqlite_no_plan_calendar_replans']) group[field] += row[field];
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map(group => ({
      ...group,
      three_interval_reach_fraction: group.target_chore_histories
        ? group.target_histories_reaching_three_intervals / group.target_chore_histories : null,
      mean_absolute_error_days_scored_only: group.scored_predictions
        ? group.prediction_error_days_sum / group.scored_predictions : null,
      unresolved_counted_as_zero_error: false,
      target_valid_intervals_per_target_history: group.target_chore_histories
        ? group.target_valid_interval_total / group.target_chore_histories : null,
    }));
  };
  const traceTotal = operationTraceSummary ? {
    rows: operationTraceSummary.rows, bytes: operationTraceSummary.bytes, sha256: operationTraceSummary.sha256,
    calendar_replan_calls: operationTraceSummary.calendar_replan_calls,
    published_plan_results: operationTraceSummary.published_plan_results,
    fallback_plan_results_no_candidate: operationTraceSummary.fallback_plan_results,
    fallback_by_step_kind: operationTraceSummary.fallback_by_step_kind,
    no_plan_results: operationTraceSummary.no_plan_results,
    no_plan_by_step_kind: operationTraceSummary.no_plan_by_step_kind,
    completion_operation_rows: operationTraceSummary.completion_operation_rows,
    completion_receipts: operationTraceSummary.completion_receipts,
    settings_operation_rows: operationTraceSummary.settings_operation_rows,
    undo_operation_rows: operationTraceSummary.undo_operation_rows,
    definitions: { fallback_plan_results_no_candidate: 'actual persisted plan_after.fallback === true from chronological SQLite trace',
      no_plan_results: 'actual trace rows with no plan_after; separated from no-candidate fallback results' },
  } : null;
  return {
    per_case: caseDetails,
    observation_and_learning: {
      total_observation_days: caseDetails.reduce((total, row) => total + row.horizon_days, 0),
      visible_completion_records: caseDetails.reduce((total, row) => total + (row.observed_completion_records_visible_at_initial_now ?? 0), 0),
      completion_records_through_horizon: caseDetails.reduce((total, row) => total + (row.observed_completion_records_through_horizon ?? 0), 0),
      target_chore_histories: caseDetails.reduce((total, row) => total + row.target_chore_count, 0),
      target_histories_reaching_three_intervals: caseDetails.reduce((total, row) => total + row.target_histories_reaching_three_intervals, 0),
      three_interval_reach_fraction: caseDetails.reduce((total, row) => total + row.target_histories_reaching_three_intervals, 0)
        / caseDetails.reduce((total, row) => total + row.target_chore_count, 0),
      target_valid_interval_total: caseDetails.reduce((total, row) => total + row.target_valid_interval_total, 0),
      target_valid_intervals_per_target_history: caseDetails.reduce((total, row) => total + row.target_valid_interval_total, 0)
        / caseDetails.reduce((total, row) => total + row.target_chore_count, 0),
      minimum_observation_days: Math.min(...caseDetails.map(row => row.horizon_days)),
      maximum_observation_days: Math.max(...caseDetails.map(row => row.horizon_days)),
      reach_three_definition: 'one target personal chore with at least three valid chronological SQLite completion intervals; seasonal, shared, fixed and non-target histories are excluded',
    },
    prediction_error_breakdowns: {
      by_profile: groupBy(row => row.profile).map(group => ({ ...group, profile: group.key, key: undefined })),
      by_behavior_model: groupBy(row => row.behavior_model).map(group => ({ ...group, behavior_model: group.key, key: undefined })),
      by_profile_and_behavior_model: groupBy(row => `${row.profile}|${row.behavior_model}`).map(group => ({
        ...group, profile: group.key.split('|')[0], behavior_model: group.key.split('|')[1], key: undefined })),
      unresolved_predictions_are_missing_outcomes_not_zero_error: true,
    },
    no_candidate_and_replan_counts: {
      static_initial_placement_fallbacks: caseDetails.reduce((total, row) => total + (row.initial_placement_fallback_count ?? 0), 0),
      sqlite_trace: traceTotal,
      aggregation_by_profile: groupBy(row => row.profile).map(group => ({ profile: group.key,
        calendar_replan_calls: group.sqlite_calendar_replan_calls, fallback_plan_results_no_candidate: group.sqlite_fallback_plan_results,
        fallback_calendar_replans: group.sqlite_fallback_calendar_replans, no_plan_results: group.sqlite_no_plan_results,
        no_plan_calendar_replans: group.sqlite_no_plan_calendar_replans })),
      aggregation_by_behavior_model: groupBy(row => row.behavior_model).map(group => ({ behavior_model: group.key,
        calendar_replan_calls: group.sqlite_calendar_replan_calls, fallback_plan_results_no_candidate: group.sqlite_fallback_plan_results,
        fallback_calendar_replans: group.sqlite_fallback_calendar_replans, no_plan_results: group.sqlite_no_plan_results,
        no_plan_calendar_replans: group.sqlite_no_plan_calendar_replans })),
    },
  };
}

export function createLifestyleAggregate(report, { sourceReportSha256, aggregateSourceSha256, operationTraceSummary = null }) {
  if (!['development', 'holdout'].includes(report.split)) throw new Error(`unexpected split: ${report.split}`);
  const { cases, repositoryCases } = assertMatchingCaseRecords(report, { requireFullSample: true });
  assertBenchmarkOutcomes(report);
  const status = 'pass';
  const perCase = new Map(repositoryCases.map(row => [row.case_id, row]));
  const coverageAndError = summarizeCoverageAndError(report, operationTraceSummary);
  const coverageByCase = new Map(coverageAndError.per_case.map(row => [row.case_id, row]));
  const caseMetrics = cases.map(row => {
    const repository = perCase.get(row.case_id);
    const coverage = coverageByCase.get(row.case_id);
    const scoredDetails = (row.metrics?.scored_predictions_detail ?? []).filter(item => item.scored);
    const predictionMae = scoredDetails.length
      ? scoredDetails.reduce((total, item) => total + item.error_days, 0) / scoredDetails.length : null;
    return { case_id: row.case_id, split: row.split, profile: row.profile, behavior_model: row.behavior_model,
      horizon_days: row.horizon_days, status: row.status ?? 'pass',
      initial_now_day: row.initial_now_day,
      observation_days: row.horizon_days,
      observed_completion_records_visible_at_initial_now: row.input?.observed_completion_records_visible_at_initial_now ?? null,
      observed_completion_records_through_horizon: row.input?.observed_completion_records_through_horizon ?? null,
      valid_intervals_at_initial_now: row.metrics?.valid_intervals_at_initial_now ?? null,
      personal_intervals_through_horizon: row.metrics?.personal_intervals_through_horizon ?? null,
      target_chore_count: coverage?.target_chore_count ?? 0,
      target_histories_reaching_three_intervals: coverage?.target_histories_reaching_three_intervals ?? 0,
      target_valid_interval_total: coverage?.target_valid_interval_total ?? 0,
      target_chore_histories: coverage?.target_chore_histories ?? [],
      initial_placement_fallback_count: coverage?.initial_placement_fallback_count ?? null,
      sqlite_calendar_replan_calls: coverage?.sqlite_calendar_replan_calls ?? 0,
      sqlite_fallback_plan_results: coverage?.sqlite_fallback_plan_results ?? 0,
      sqlite_fallback_calendar_replans: coverage?.sqlite_fallback_calendar_replans ?? 0,
      sqlite_no_plan_results: coverage?.sqlite_no_plan_results ?? 0,
      sqlite_no_plan_calendar_replans: coverage?.sqlite_no_plan_calendar_replans ?? 0,
      target_completion_attempts: row.metrics?.target_recorded_completion_count ?? null,
      target_applied_completions: row.metrics?.target_applied_completion_count ?? null,
      learning_eligible_completions: row.metrics?.learning_eligible_operations ?? null,
      learning_eligible_fraction: row.metrics?.learning_eligible_fraction ?? null,
      scored_predictions: row.metrics?.scored_predictions ?? 0, unresolved_predictions: row.metrics?.unresolved_predictions ?? 0,
      mean_absolute_error_days_scored_only: predictionMae,
      invariant_statuses: Object.fromEntries(Object.entries(row.invariant_results ?? {}).map(([name, result]) => [name, result.status])),
      sqlite_trace_by_chore: Object.fromEntries(Object.entries(repository?.trace_by_chore ?? {}).map(([choreId, trace]) => [choreId, {
        completion_operations: trace.completion_operations, applied_completions: trace.applied_completions,
        learning_eligible: trace.learning_eligible, inside_frozen_window: trace.inside_frozen_window,
        inside_window_model_changes: trace.inside_window_model_changes,
        pre_three_interval_checks: trace.pre_three_interval_checks,
        pre_three_interval_model_changes: trace.pre_three_interval_model_changes,
        learned_above_initial_cycle: trace.learned_above_initial_cycle,
      }])) };
  });
  const closedLoop = (report.closed_loop ?? []).map(scenario => ({
    target_follow_percent: scenario.target_follow_percent, unique_source_cases: scenario.unique_source_cases,
    scenario_observations: scenario.scenario_observations, actionable_cases: scenario.actionable_cases,
    follow_actions: scenario.follow_actions, observed_follow_fraction: scenario.observed_follow_fraction,
    fail_count: scenario.fail_count, not_applicable_count: scenario.not_applicable_count,
    mean_next_proposal_changed: scenario.mean_next_proposal_changed,
    cases: scenario.cases.map(row => ({ case_id: row.case_id, status: row.status,
      follow_recommendation: row.follow_recommendation ?? null, initial_proposal_date: row.initial_proposal_date ?? null,
      completion_date: row.completion_date ?? null, next_proposal_date: row.next_proposal_date ?? null,
      recommendation_changed: row.recommendation_changed ?? null })),
  }));
  return {
    schema_version: 1,
    kind: 'deterministic post-run aggregate; raw benchmark report is retained unchanged',
    finalized_at: report.generated_at,
    split: report.split,
    evaluation_status: status,
    unique_cases: report.unique_cases,
    requested_case_count: report.requested_case_count,
    actual_case_evaluations: report.actual_case_evaluations,
    actual_repetitions_per_case: report.actual_repetitions_per_case,
    case_status_counts: report.corpus.case_status_counts,
    failures: report.failures,
    execution: {
      code_fingerprint: report.code_fingerprint,
      code_file_hashes: report.code_snapshot.code_files,
      code_snapshot_sha256: report.code_snapshot.code_sha256,
      input_asset_hashes: report.code_snapshot.asset_files,
      input_asset_manifest_sha256: report.code_snapshot.asset_manifest_sha256,
      input_asset_sha256_files: report.automatic_checks.input_asset_sha256_files,
      operation_trace: report.operation_trace,
      sqlite: { engine: report.sqlite_repository.engine, operations_applied: report.sqlite_repository.operations_applied,
        counters: report.sqlite_repository.counters, condition_evaluations: report.sqlite_repository.condition_evaluations,
        status_counts: report.sqlite_repository.status_counts, geometry_cache: report.sqlite_repository.geometry_cache },
      directed: report.directed,
      closed_loop: closedLoop,
      elapsed_ms: report.elapsed_ms,
    },
    invariant_summary: report.corpus.invariant_summary,
    condition_evaluations: report.automatic_checks,
    actual_chronological_metrics: summarizeChronologyMetrics(report),
    observation_learning_and_error_coverage: {
      observation_and_learning: coverageAndError.observation_and_learning,
      prediction_error_breakdowns: coverageAndError.prediction_error_breakdowns,
      no_candidate_and_replan_counts: coverageAndError.no_candidate_and_replan_counts,
    },
    case_metrics: caseMetrics,
    provenance: {
      source_report: { path: join('docs/qa-assets/realistic-2026-11-06/results', `${report.split}.json`), sha256: sourceReportSha256 },
      aggregate_source: { path: join('scripts', basename(fileURLToPath(new URL(import.meta.url)))), sha256: aggregateSourceSha256 },
      execution_fingerprint: report.code_fingerprint,
      hidden_truth_sent_to_app: false,
      holdout_started: report.split === 'holdout',
    },
  };
}

async function main() {
  const splitArg = process.argv.slice(2).find(arg => arg.startsWith('--split='));
  const split = splitArg?.slice('--split='.length);
  if (!['development', 'holdout'].includes(split)) throw new Error('--split=development or --split=holdout is required');
  const reportPath = join(resultsDirectory, `${split}.json`);
  const bytes = await readFile(reportPath);
  const report = JSON.parse(bytes.toString('utf8'));
  const drift = [];
  for (const [relativePath, expected] of Object.entries(report.code_snapshot.code_files)) {
    if (sha256(await readFile(join(root, relativePath))) !== expected) drift.push(relativePath);
  }
  const assetRoot = join(root, 'docs/qa-assets/realistic-2026-11-06');
  for (const [relativePath, expected] of Object.entries(report.code_snapshot.asset_files)) {
    if (sha256(await readFile(join(assetRoot, relativePath.slice(2)))) !== expected) drift.push(`asset:${relativePath}`);
  }
  if (drift.length) throw new Error(`execution source changed after benchmark: ${drift.join(', ')}`);
  const tracePathArg = process.argv.slice(2).find(arg => arg.startsWith('--trace-path='));
  const tracePath = tracePathArg ? resolve(tracePathArg.slice('--trace-path='.length)) : join(resultsDirectory, report.operation_trace.file);
  const operationTraceSummary = await summarizeOperationTraceFile(tracePath);
  if (operationTraceSummary.rows !== report.operation_trace.rows || operationTraceSummary.bytes !== report.operation_trace.bytes
    || operationTraceSummary.sha256 !== report.operation_trace.sha256) {
    throw new Error('operation trace row count, byte size, or SHA-256 does not match the raw report');
  }
  if (operationTraceSummary.calendar_replan_calls !== report.sqlite_repository.counters.calendar_replan_calls) {
    throw new Error('SQLite calendar replan count disagrees with the chronological operation trace');
  }
  const traceCaseIds = Object.keys(operationTraceSummary.per_case);
  if (traceCaseIds.length !== report.unique_cases
    || traceCaseIds.some(id => !report.sqlite_repository.cases.some(row => row.case_id === id))) {
    throw new Error('operation trace case IDs do not match the full SQLite case set');
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const aggregate = createLifestyleAggregate(report, { sourceReportSha256: sha256(bytes),
    aggregateSourceSha256: sha256(await readFile(scriptPath)), operationTraceSummary });
  const outputPath = join(resultsDirectory, `${split}-final-aggregate.json`);
  await writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: outputPath, split, status: aggregate.evaluation_status,
    unique_cases: aggregate.unique_cases, invariant_conditions: aggregate.condition_evaluations.invariant_condition_evaluations,
    learning_eligible: aggregate.actual_chronological_metrics.learning_eligible_completions,
    target_applied_completions: aggregate.actual_chronological_metrics.target_applied_completions,
    raw_metric_status: aggregate.actual_chronological_metrics.raw_report_metric_caveat.status,
    report_sha256: aggregate.provenance.source_report.sha256,
    aggregate_source_sha256: aggregate.provenance.aggregate_source.sha256 }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
