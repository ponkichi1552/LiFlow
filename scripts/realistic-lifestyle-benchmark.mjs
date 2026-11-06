import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import {
  createLifestyleChronologyHarness,
  dataRoot,
  directedCases,
  evaluateClosedLoopCase,
  evaluateDirectedCase,
  evaluateLifestyleCase,
  invariants,
  readLifestyleCases,
} from '../tests/helpers/realistic-lifestyle-cases.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const resultsDirectory = fileURLToPath(new URL('../docs/qa-assets/realistic-2026-11-06/results/', import.meta.url));
const freezePath = join(resultsDirectory, 'runner-freeze.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv) {
  const result = { split: null, limit: null, sample: false, caseId: null, closedLoop: true };
  for (const arg of argv) {
    if (arg.startsWith('--split=')) result.split = arg.slice('--split='.length);
    else if (arg.startsWith('--limit=')) result.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--case-id=')) result.caseId = arg.slice('--case-id='.length);
    else if (arg === '--sample') result.sample = true;
    else if (arg === '--no-closed-loop') result.closedLoop = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['development', 'holdout'].includes(result.split)) throw new Error('--split=development or --split=holdout is required');
  if (result.limit !== null && (!Number.isSafeInteger(result.limit) || result.limit < 1)) throw new Error('--limit must be a positive integer');
  if (result.sample && result.limit === null) throw new Error('--sample requires --limit');
  if (result.caseId && (!/^[a-z0-9_-]+$/u.test(result.caseId) || result.sample || result.limit !== null)) throw new Error('--case-id is a safe exact ID and cannot be combined with --sample/--limit');
  if (result.split === 'holdout' && (result.sample || result.limit !== null || result.caseId)) throw new Error('holdout must run without --sample/--limit/--case-id');
  return result;
}

const trackedCode = [
  'tests/helpers/realistic-lifestyle-cases.mjs',
  'tests/helpers/sqlite.mjs',
  'tests/helpers/typescript-loader.mjs',
  'tests/realistic-lifestyle-cases.test.mjs',
  'scripts/realistic-lifestyle-benchmark.mjs',
  'src/domain/scheduling/local-date.ts',
  'src/domain/scheduling/adaptive/history.ts',
  'src/domain/scheduling/adaptive/models.ts',
  'src/domain/scheduling/adaptive/placement.ts',
  'src/domain/scheduling/adaptive/seasonal.ts',
  'src/domain/chores/personal-catalog.ts',
  'src/features/planner/adaptive-input.ts',
  'src/features/planner/adaptive-rounds.ts',
  'src/features/planner/shared-adaptive-load.ts',
  'src/features/weather/chore-weather.ts',
  'src/features/google-sync/calendar-availability.ts',
  'src/features/sharing/v2/local-time.ts',
  'src/platform/storage/adaptive-personal-chores.ts',
  'server/appliance-care-api/src/weather/forecast.mjs',
];

async function codeSnapshot() {
  const files = {};
  for (const relative of trackedCode) files[relative] = sha256(await readFile(join(root, relative)));
  const assets = {};
  const manifest = await readFile(new URL('SHA256SUMS', dataRoot), 'utf8');
  for (const line of manifest.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (\.\/[^\n]+)$/u.exec(line);
    if (!match) throw new Error(`invalid asset manifest row: ${line}`);
    const [, expected, relative] = match;
    const bytes = await readFile(new URL(relative.slice(2), dataRoot));
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`asset SHA-256 mismatch: ${relative}`);
    assets[relative] = actual;
  }
  if (Object.keys(assets).length !== 12) throw new Error(`expected 12 SHA256SUMS assets, got ${Object.keys(assets).length}`);
  const snapshot = {
    code_files: files,
    code_sha256: sha256(JSON.stringify(files)),
    asset_files: assets,
    asset_manifest_sha256: sha256(manifest),
    git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  };
  snapshot.fingerprint = sha256(JSON.stringify(snapshot));
  return snapshot;
}

async function verifyHoldoutFreeze(snapshot) {
  let freeze;
  try { freeze = JSON.parse(await readFile(freezePath, 'utf8')); }
  catch { throw new Error('holdout requires a completed full development run and runner-freeze.json'); }
  const dev = JSON.parse(await readFile(join(resultsDirectory, 'development.json'), 'utf8'));
  if (dev.split !== 'development' || dev.unique_cases !== 840 || dev.sampled) {
    throw new Error('holdout requires development.json with all 840 development cases');
  }
  if (freeze.fingerprint !== snapshot.fingerprint || dev.code_fingerprint !== snapshot.fingerprint) {
    throw new Error('runner/adapter or connected production source changed after development; rerun full development before holdout');
  }
}

function summarizeInvariantResults(cases) {
  const summary = {};
  for (const name of Object.keys(invariants)) {
    const counts = { pass: 0, fail: 0, not_applicable: 0, not_tested: 0 };
    for (const row of cases) {
      const status = row.invariant_results?.[name]?.status;
      if (Object.hasOwn(counts, status)) counts[status]++;
    }
    summary[name] = { ...counts, condition_evaluations: counts.pass + counts.fail,
      tested_pass_fraction: counts.pass + counts.fail ? counts.pass / (counts.pass + counts.fail) : null };
  }
  return summary;
}

function collectCorpusMetrics(cases) {
  const scored = cases.flatMap(row => row.metrics?.scored_predictions_detail ?? []).filter(row => row.scored);
  const unresolved = cases.flatMap(row => row.metrics?.scored_predictions_detail ?? []).filter(row => row.unresolved);
  const errors = scored.map(row => row.error_days);
  const errorSum = errors.reduce((sum, value) => sum + value, 0);
  const sourceCount = cases.reduce((sum, row) => sum + (row.input?.observed_completion_records_through_horizon ?? 0), 0);
  return {
    recorded_completion_inputs: sourceCount,
    hidden_truth_sent_to_app: false,
    hidden_truth_used_as_prediction_target: false,
    scored_predictions: scored.length,
    unresolved_predictions: unresolved.length,
    mean_absolute_error_days_scored_only: errors.length ? errorSum / errors.length : null,
    prediction_error_days: errors,
    unresolved_counted_as_zero_error: false,
    learning_eligible_fraction: 0,
    learning_eligibility_reason: 'observed corpus events do not include frozen displayed-window snapshots; missing-window completions do not produce learning updates',
  };
}

function statusCounts(rows) {
  return rows.reduce((counts, row) => {
    const status = row.status ?? 'error';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

async function writeJson(path, value) {
  await mkdir(resultsDirectory, { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function createOperationTraceWriter(path) {
  await mkdir(resultsDirectory, { recursive: true });
  const output = createWriteStream(path);
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  let rows = 0;
  return {
    async write(value) {
      if (!gzip.write(`${JSON.stringify(value)}\n`)) await once(gzip, 'drain');
      rows++;
    },
    async finish() {
      const completed = once(output, 'finish');
      gzip.end();
      await completed;
      return { rows, bytes: (await stat(path)).size, sha256: sha256(await readFile(path)) };
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = await codeSnapshot();
  if (options.split === 'holdout') await verifyHoldoutFreeze(snapshot);
  const startedAt = new Date().toISOString();
  const monotonicStart = process.hrtime.bigint();
  let corpus = await readLifestyleCases({ split: options.split, ...(!options.caseId && options.limit ? { limit: options.limit } : {}),
    sample: !options.caseId && options.sample });
  if (options.caseId) corpus = corpus.filter(row => row.case_id === options.caseId);
  if (!corpus.length) throw new Error(`no cases in split ${options.split}`);
  const fullCorpus = !options.sample && options.limit === null && corpus.length === 840;
  const label = fullCorpus ? options.split : options.caseId ? `${options.split}-case-${options.caseId}`
    : `${options.split}-${options.sample ? 'sample-' : 'limit-'}${options.limit}`;
  const operationTracePath = join(resultsDirectory, `${label}.operations.jsonl.gz`);
  const operationTraceWriter = await createOperationTraceWriter(operationTracePath);
  const repository = await createLifestyleChronologyHarness({ onOperationTrace: row => operationTraceWriter.write(row) });
  const caseResults = [];
  const repositoryResults = [];
  const focus = corpus.filter(row => row.behavior_model.id === 'recommendation_following').sort((a, b) => a.case_id.localeCompare(b.case_id));
  const half = Math.floor(focus.length / 2);
  const followHalfIds = new Set(focus.slice(0, half).map(row => row.case_id));
  const focusIds = new Set(focus.map(row => row.case_id));
  const closedLoopRows = new Map([[0, []], [50, []], [100, []]]);
  let operationTrace;
  try {
    for (const [index, value] of corpus.entries()) {
      let simulation = null;
      try {
        simulation = await repository.simulate(value);
        const result = evaluateLifestyleCase(value, simulation);
        caseResults.push(result);
        repositoryResults.push({ case_id: value.case_id, status: 'pass', ...simulation.report });
      } catch (error) {
        caseResults.push({ case_id: value.case_id, split: value.split, status: 'error', error: String(error?.message ?? error) });
        if (simulation) repositoryResults.push({ case_id: value.case_id, status: 'error', ...simulation.report,
          error: String(error?.message ?? error) });
      }
      if (simulation && options.closedLoop && focusIds.has(value.case_id)) {
        const followAt50 = followHalfIds.has(value.case_id);
        for (const [target, follows] of [[0, false], [50, followAt50], [100, true]]) {
          try { closedLoopRows.get(target).push({ scenario_target_follow_percent: target,
            ...evaluateClosedLoopCase(value, { followRecommendation: follows }, simulation) }); }
          catch (error) { closedLoopRows.get(target).push({ scenario_target_follow_percent: target, case_id: value.case_id,
            status: 'error', error: String(error?.message ?? error) }); }
        }
      }
      if ((index + 1) % 100 === 0) process.stderr.write(`processed ${index + 1}/${corpus.length} ${options.split}\n`);
    }
  } finally {
    repository.dispose();
    operationTrace = await operationTraceWriter.finish();
  }

  const directedResults = [];
  for (const directed of directedCases) {
    try { directedResults.push(await evaluateDirectedCase(directed)); }
    catch (error) { directedResults.push({ id: directed.id, label: directed.label, passed: false, error: String(error?.message ?? error) }); }
  }

  let closedLoop = null;
  if (options.closedLoop) {
    for (const target of [0, 50, 100]) {
      // Results were measured from each case's real SQLite checkpoint in the main loop.
    }
    closedLoop = [0, 50, 100].map(target => {
      const rows = closedLoopRows.get(target);
      const actionable = rows.filter(row => row.status === 'pass');
      const followed = actionable.filter(row => row.follow_recommendation);
      return { target_follow_percent: target, unique_source_cases: focus.length,
        scenario_observations: rows.length, actionable_cases: actionable.length,
        follow_actions: followed.length, observed_follow_fraction: actionable.length ? followed.length / actionable.length : null,
        fail_count: rows.filter(row => row.status === 'fail' || row.status === 'error').length,
        not_applicable_count: rows.filter(row => row.status === 'not_applicable').length,
        mean_next_proposal_changed: actionable.length ? actionable.filter(row => row.recommendation_changed).length / actionable.length : null,
        cases: rows };
    });
  }

  const invariantSummary = summarizeInvariantResults(caseResults);
  const invariantEvaluations = Object.values(invariantSummary).reduce((sum, row) => sum + row.condition_evaluations, 0);
  const repositoryChecks = repositoryResults.length;
  const directedAssertions = directedResults.filter(row => row.passed).length;
  const caseStatuses = caseResults.map(row => ({ status: row.status === 'error' ? 'error'
    : Object.values(row.invariant_results ?? {}).some(result => result.status === 'fail') ? 'fail' : 'pass' }));
  const failed = [
    ...caseResults.filter(row => row.status === 'error').map(row => ({ type: 'case_error', case_id: row.case_id, error: row.error })),
    ...Object.entries(invariantSummary).flatMap(([invariant, row]) => row.fail
      ? caseResults.filter(result => result.invariant_results?.[invariant]?.status === 'fail')
        .map(result => ({ type: 'invariant', invariant, case_id: result.case_id, evidence: result.invariant_results[invariant].evidence })) : []),
    ...repositoryResults.filter(row => row.status === 'fail' || row.status === 'error')
      .map(row => ({ type: 'sqlite_repository', case_id: row.case_id, detail: row.error ?? row })),
    ...directedResults.filter(row => !row.passed).map(row => ({ type: 'directed', case_id: row.id, error: row.error ?? row.observed })),
    ...(closedLoop ?? []).flatMap(scenario => scenario.cases.filter(row => row.status === 'fail' || row.status === 'error')
      .map(row => ({ type: 'closed_loop', target_follow_percent: scenario.target_follow_percent, case_id: row.case_id, error: row.error }))),
  ];
  const durationMs = Number(process.hrtime.bigint() - monotonicStart) / 1e6;
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    split: options.split,
    sampled: !fullCorpus,
    run_label: label,
    unique_cases: new Set(caseResults.map(row => row.case_id)).size,
    requested_case_count: corpus.length,
    actual_case_evaluations: caseResults.length,
    actual_repetitions_per_case: 1,
    code_fingerprint: snapshot.fingerprint,
    code_snapshot: snapshot,
    corpus: {
      case_status_counts: statusCounts(caseStatuses),
      invariant_summary: invariantSummary,
      metrics: collectCorpusMetrics(caseResults),
      cases: caseResults,
    },
    sqlite_repository: {
      engine: 'Node built-in node:sqlite DatabaseSync (in-memory SQLite), through the production SQLite repository functions',
      chronology: 'initialize at clock.start; run each recorded target completion/settings/undo/duplicate in timestamp order; snapshot at initial_now and evaluation horizon; save the published plan/window after every accepted operation',
      unique_case_probes: repositoryResults.length,
      operations_applied: repository.counters.completion_operations + repository.counters.settings_operations + repository.counters.undo_operations,
      counters: repository.counters,
      geometry_cache: repository.geometryCacheStats,
      condition_evaluations: repositoryChecks,
      status_counts: statusCounts(repositoryResults),
      cases: repositoryResults,
      boundary: 'Chronological recorded histories are imported only for floor/filter/long_care and laundry when initial_days > 1. Daily/fixed-manual/shared/seasonal histories are excluded from the high-volume learning loop; directed cases cover the relevant production APIs.',
    },
    operation_trace: { file: basename(operationTracePath), format: 'gzip-compressed JSONL', ...operationTrace,
      contents: 'Every target completion/settings/undo/duplicate, initialization, calendar replan, pre/post model, frozen plan/window, ruleDate and available forecast record.' },
    directed: {
      unique_cases: new Set(directedResults.map(row => row.id)).size,
      actual_case_evaluations: directedResults.length,
      assertion_pass_count: directedAssertions,
      status_counts: { pass: directedResults.filter(row => row.passed).length,
        fail: directedResults.filter(row => !row.passed).length },
      cases: directedResults,
    },
    closed_loop: closedLoop,
    automatic_checks: {
      input_asset_sha256_files: Object.keys(snapshot.asset_files).length,
      corpus_cases_evaluated: caseResults.length,
      invariant_condition_evaluations: invariantEvaluations,
      sqlite_repository_condition_evaluations: repositoryChecks,
      directed_case_assertions_passed: directedAssertions,
      closed_loop_condition_evaluations: (closedLoop ?? []).reduce((sum, row) => sum + row.scenario_observations, 0),
      failures: failed.length,
      note: 'Condition evaluations, directed test assertions, unique cases, and repeated scenario observations are counted separately.',
    },
    failures: failed,
    elapsed_ms: Math.round(durationMs),
  };
  const output = join(resultsDirectory, `${label}.json`);
  await writeJson(output, report);

  if (fullCorpus && options.split === 'development') {
    const freeze = { frozen_at: new Date().toISOString(), split: 'development', unique_cases: report.unique_cases,
      completed_case_evaluations: report.actual_case_evaluations, fingerprint: snapshot.fingerprint,
      code_snapshot: snapshot, failures_at_freeze: failed.length,
      instruction: 'Holdout may run only while this exact runner, adapter, connected API source, and input-asset fingerprint remain unchanged.' };
    await writeJson(freezePath, freeze);
  }

  process.stdout.write(`${JSON.stringify({ output, split: report.split, unique_cases: report.unique_cases,
    sqlite_operations: report.sqlite_repository.operations_applied, invariant_evaluations: invariantEvaluations,
    directed: report.directed.status_counts, closed_loop: closedLoop?.map(row => ({ target_follow_percent: row.target_follow_percent,
      actionable_cases: row.actionable_cases, observed_follow_fraction: row.observed_follow_fraction })), failures: failed.length,
    elapsed_ms: report.elapsed_ms }, null, 2)}\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${basename(import.meta.filename ?? 'realistic-lifestyle-benchmark.mjs')}: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
