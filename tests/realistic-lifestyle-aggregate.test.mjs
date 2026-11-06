import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifestyleAggregate, summarizeChronologyMetrics, summarizeOperationTraceRows } from '../scripts/realistic-lifestyle-aggregate.mjs';

const trace = ({ applied, eligible, inside, insideChanges, preThree, preThreeChanges, aboveInitial, outside }) => ({
  applied_completions: applied,
  learning_eligible: eligible,
  inside_frozen_window: inside,
  inside_window_model_changes: insideChanges,
  pre_three_interval_checks: preThree,
  pre_three_interval_model_changes: preThreeChanges,
  learned_above_initial_cycle: aboveInitial,
  out_of_frozen_window: outside,
});

function syntheticReport(split = 'development') {
  return {
    split,
    unique_cases: 2,
    requested_case_count: 2,
    actual_case_evaluations: 2,
    actual_repetitions_per_case: 1,
    corpus: {
      cases: [
        { case_id: 'case-a', split, metrics: { target_recorded_completion_count: 4, target_applied_completion_count: 3,
          learning_eligible_operations: 2, scored_predictions: 1, unresolved_predictions: 0,
          scored_predictions_detail: [{ scored: true, error_days: 2 }] } },
        { case_id: 'case-b', split, metrics: { target_recorded_completion_count: 2, target_applied_completion_count: 2,
          learning_eligible_operations: 1, scored_predictions: 1, unresolved_predictions: 1,
          scored_predictions_detail: [{ scored: true, error_days: 6 }, { unresolved: true }] } },
      ],
      case_status_counts: { pass: 2 },
      metrics: { recorded_completion_inputs: 6, learning_eligible_fraction: 0,
        learning_eligibility_reason: 'legacy source-only calculation', scored_predictions: 2,
        unresolved_predictions: 1, mean_absolute_error_days_scored_only: 4 },
    },
    sqlite_repository: { cases: [
      { case_id: 'case-a', status: 'pass', target_completion_operations: 4, target_applied_completions: 3,
        trace_by_chore: { floor: trace({ applied: 3, eligible: 2, inside: 1, insideChanges: 0,
          preThree: 2, preThreeChanges: 0, aboveInitial: 1, outside: 2 }) } },
      { case_id: 'case-b', status: 'pass', target_completion_operations: 2, target_applied_completions: 2,
        trace_by_chore: { filter: trace({ applied: 2, eligible: 1, inside: 1, insideChanges: 1,
          preThree: 1, preThreeChanges: 0, aboveInitial: 0, outside: 1 }) } },
    ], status_counts: { pass: 2 } },
  };
}

function validFullAggregateReport() {
  const caseCount = 840;
  const metric = { target_recorded_completion_count: 1, target_applied_completion_count: 1,
    learning_eligible_operations: 0, scored_predictions: 0, unresolved_predictions: 0, scored_predictions_detail: [] };
  const emptyTrace = trace({ applied: 1, eligible: 0, inside: 0, insideChanges: 0,
    preThree: 0, preThreeChanges: 0, aboveInitial: 0, outside: 1 });
  const cases = Array.from({ length: caseCount }, (_, index) => ({ case_id: `case-${index}`, split: 'development', metrics: metric }));
  const repositoryCases = Array.from({ length: caseCount }, (_, index) => ({ case_id: `case-${index}`, status: 'pass',
    target_completion_operations: 1, target_applied_completions: 1, trace_by_chore: { floor: emptyTrace } }));
  const directedCases = Array.from({ length: 21 }, (_, index) => ({ id: `D${String(index + 1).padStart(2, '0')}`, passed: true }));
  const closedLoop = [0, 50, 100].map(percent => {
    const followActions = percent === 0 ? 0 : percent === 50 ? 42 : 84;
    const loopCases = Array.from({ length: 84 }, (_, index) => ({ case_id: `loop-${index}`, status: 'pass',
      follow_recommendation: index < followActions }));
    return { target_follow_percent: percent, unique_source_cases: 84, scenario_observations: 84,
      actionable_cases: 84, follow_actions: followActions, observed_follow_fraction: followActions / 84,
      fail_count: 0, not_applicable_count: 0, mean_next_proposal_changed: 1, cases: loopCases };
  });
  return {
    split: 'development', sampled: false, generated_at: '2026-11-06T00:00:00.000Z',
    unique_cases: caseCount, requested_case_count: caseCount, actual_case_evaluations: caseCount, actual_repetitions_per_case: 1,
    failures: [], code_fingerprint: 'f'.repeat(64), code_snapshot: { code_files: {}, code_sha256: 'c'.repeat(64),
      asset_files: {}, asset_manifest_sha256: 'a'.repeat(64) },
    corpus: { cases, case_status_counts: { pass: caseCount }, invariant_summary: {},
      metrics: { recorded_completion_inputs: caseCount, learning_eligible_fraction: 0, learning_eligibility_reason: 'raw',
        scored_predictions: 0, unresolved_predictions: 0, mean_absolute_error_days_scored_only: null } },
    sqlite_repository: { cases: repositoryCases, engine: 'node:sqlite', operations_applied: caseCount,
      counters: {}, condition_evaluations: caseCount, status_counts: { pass: caseCount }, geometry_cache: {} },
    automatic_checks: { input_asset_sha256_files: 12, corpus_cases_evaluated: caseCount, invariant_condition_evaluations: 1,
      sqlite_repository_condition_evaluations: caseCount, directed_case_assertions_passed: 21,
      closed_loop_condition_evaluations: 252, failures: 0 },
    directed: { unique_cases: 21, actual_case_evaluations: 21, assertion_pass_count: 21,
      status_counts: { pass: 21, fail: 0 }, cases: directedCases },
    closed_loop: closedLoop, elapsed_ms: 1, operation_trace: 'test-trace.jsonl.gz',
  };
}

test('lifestyle aggregate derives eligibility and frozen-window counts from actual per-case SQLite traces for either split', () => {
  for (const split of ['development', 'holdout']) {
    const result = summarizeChronologyMetrics(syntheticReport(split));
    assert.equal(result.target_completion_attempts, 6);
    assert.equal(result.target_applied_completions, 5);
    assert.equal(result.duplicate_or_rejected_completion_attempts, 1);
    assert.equal(result.learning_eligible_completions, 3);
    assert.equal(result.learning_eligible_fraction_of_applied_target_completions, 0.6);
    assert.equal(result.learning_eligible_fraction_of_attempted_target_completions, 0.5);
    assert.equal(result.frozen_window_and_learning_checks.inside_frozen_window_completions, 2);
    assert.equal(result.frozen_window_and_learning_checks.inside_window_model_changes, 1);
    assert.equal(result.frozen_window_and_learning_checks.pre_three_interval_checks, 3);
    assert.equal(result.frozen_window_and_learning_checks.pre_three_interval_model_changes, 0);
    assert.equal(result.prediction_scoring.scored_predictions, 2);
    assert.equal(result.prediction_scoring.unresolved_predictions, 1);
    assert.equal(result.prediction_scoring.mean_absolute_error_days_scored_only, 4);
    assert.equal(result.prediction_scoring.unresolved_counted_as_zero_error, false);
    assert.equal(result.raw_report_metric_caveat.raw_value, 0);
    assert.equal(result.raw_report_metric_caveat.status, 'invalid_for_chronological_sqlite_evaluation');
  }
});

test('lifestyle aggregate rejects per-case counts that disagree with the actual SQLite trace', () => {
  const report = syntheticReport();
  report.corpus.cases[0].metrics.learning_eligible_operations++;
  assert.throws(() => summarizeChronologyMetrics(report), /eligibility count disagrees with the actual SQLite trace/u);
});

test('lifestyle aggregate rejects empty, missing, duplicate, or mismatched case records even when claimed totals match', () => {
  const empty = syntheticReport();
  empty.corpus.cases = [];
  empty.sqlite_repository.cases = [];
  assert.throws(() => summarizeChronologyMetrics(empty), /per-case evaluation counts do not agree/u);

  const duplicate = syntheticReport();
  duplicate.corpus.cases[1].case_id = duplicate.corpus.cases[0].case_id;
  assert.throws(() => summarizeChronologyMetrics(duplicate), /duplicate case_id/u);

  const mismatched = syntheticReport();
  mismatched.sqlite_repository.cases[1].case_id = 'other-case';
  assert.throws(() => summarizeChronologyMetrics(mismatched), /IDs do not match exactly/u);
});

test('lifestyle aggregate rejects a failing directed result masked by an empty raw failures array', () => {
  const report = validFullAggregateReport();
  report.directed.cases[0].passed = false;
  assert.throws(() => createLifestyleAggregate(report, { sourceReportSha256: 'r'.repeat(64), aggregateSourceSha256: 's'.repeat(64) }), /directed cases contain.*failing/u);
});

test('lifestyle aggregate rejects a failing closed-loop row masked by zero scenario failures', () => {
  const report = validFullAggregateReport();
  report.closed_loop[1].cases[0].status = 'fail';
  assert.throws(() => createLifestyleAggregate(report, { sourceReportSha256: 'r'.repeat(64), aggregateSourceSha256: 's'.repeat(64) }), /summary contradicts per-case/u);
});

test('lifestyle trace summary counts actual fallback plans and calendar replans separately', () => {
  const result = summarizeOperationTraceRows([
    { case_id: 'case-a', step_kind: 'initialize', plan_after: { fallback: false } },
    { case_id: 'case-a', step_kind: 'calendar_replan', plan_after: { fallback: true } },
    { case_id: 'case-a', step_kind: 'operation', action_input: { type: 'complete' }, receipt: 'applied', plan_after: { fallback: false } },
    { case_id: 'case-b', step_kind: 'calendar_replan', plan_after: null },
    { case_id: 'case-b', step_kind: 'operation', action_input: { type: 'undo' }, receipt: 'applied', plan_after: { fallback: true } },
  ]);
  assert.equal(result.total.rows, 5);
  assert.equal(result.total.calendar_replan_calls, 2);
  assert.equal(result.total.published_plan_results, 4);
  assert.equal(result.total.fallback_plan_results, 2);
  assert.equal(result.total.fallback_by_step_kind.calendar_replan, 1);
  assert.equal(result.total.no_plan_results, 1);
  assert.equal(result.per_case['case-a'].fallback_calendar_replans, 1);
  assert.equal(result.per_case['case-b'].no_plan_calendar_replans, 1);
  assert.equal(result.total.completion_receipts.applied, 1);
});
