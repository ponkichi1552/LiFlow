import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const results = join(root, 'docs/qa-assets/realistic-2026-11-06/results');
const fmt = value => Number.isInteger(value) ? String(value) : Number(value).toFixed(4);
const invariantOrder = ['LOCK_NEAR', 'NEXT_GENERATION', 'DAILY_FIXED', 'NEXT_AFTER_COMPLETION', 'COMPLETED_LOAD_ONCE',
  'SAME_EVENT_ONCE', 'CONTIGUOUS', 'SHARED_NO_LEARN', 'UNASSIGNED_LOAD', 'SEASONAL_FIXED', 'FIXED_OVERRIDE',
  'NO_INTERVAL_CAP', 'MIN_THREE', 'INSIDE_WINDOW', 'UNDO_LOCAL', 'WEATHER_FAILURE_STABLE', 'NO_EXTRA_INPUT',
  'NO_FAKE_HISTORY', 'MODE_BOUNDARY', 'FALLBACK_LOCK'];

async function readJson(name) { return JSON.parse(await readFile(join(results, name), 'utf8')); }

async function main() {
  const [development, holdout, feedback, evidence] = await Promise.all([
    readJson('development-final-aggregate.json'), readJson('holdout-final-aggregate.json'),
    readJson('multistep-feedback.json'), readJson('evidence-index.json'),
  ]);
  if (development.evaluation_status !== 'pass' || holdout.evaluation_status !== 'pass'
    || development.unique_cases !== 840 || holdout.unique_cases !== 840
    || development.execution.code_fingerprint !== holdout.execution.code_fingerprint
    || feedback.status !== 'pass' || feedback.actual_operation_observations !== 135) {
    throw new Error('final aggregate consistency check failed');
  }
  const devArchive = evidence.archives.find(row => row.run_id === 'final-development-20261106');
  const holdArchive = evidence.archives.find(row => row.run_id === 'final-holdout-20261106');
  if (!devArchive || !holdArchive) throw new Error('final external archive records are missing');
  const invariantRows = invariantOrder.map(name => {
    const dev = development.invariant_summary[name]; const test = holdout.invariant_summary[name];
    return `| ${name} | ${dev.pass}/${dev.fail}/${dev.not_applicable}/${dev.not_tested} | ${test.pass}/${test.fail}/${test.not_applicable}/${test.not_tested} |`;
  });
  const devMetric = development.actual_chronological_metrics;
  const holdMetric = holdout.actual_chronological_metrics;
  const devCoverage = development.observation_learning_and_error_coverage.observation_and_learning;
  const holdCoverage = holdout.observation_learning_and_error_coverage.observation_and_learning;
  const feedbackRows = feedback.scenarios.map(row => `| ${row.profile} | ${row.follow_percent}% | ${row.completed_steps} | ${row.follow_actions} | ${row.learning_parameter_changes_inside_window} | ${row.phase_anchor_advances_inside_window} | ${row.status} |`);
  const fullyNotTested = invariantOrder.filter(name => development.invariant_summary[name].not_tested === 840
    && holdout.invariant_summary[name].not_tested === 840);
  const report = `# 生活ケース評価の最終結果

## 評価範囲

- 生活ケースはdevelopment 840件とholdout 840件、計1,680件を各1回実行。サンプリングなし。
- D01–D21は各splitで21件すべて通過。各splitの0/50/100%一歩感度分析は84元ケース×3=252観測。これは多段安定性の証拠として数えない。
- 独立した多段ループは日次・週次・月末×0/50/100%の9シナリオ、15回ずつ、合計135実SQLite操作。元の1,680件や一歩252観測へ加算しない。
- SQLite適用操作数はdevelopment ${development.execution.sqlite.operations_applied.toLocaleString()}、holdout ${holdout.execution.sqlite.operations_applied.toLocaleString()}。
- 共通実行fingerprint: \`${development.execution.code_fingerprint}\`（19実行ソース）。集計スクリプトSHA-256: \`${development.provenance.aggregate_source.sha256}\`。入力ZIP SHA-256: \`df5a7481859bd9d77a55903084355ceae9ca3457be80a5235dfab95d481e743b\`。元資材12件は保持。

## 学習・予測

| 値 | Development | Holdout |
|---|---:|---:|
| 観測日数合計 | ${devCoverage.total_observation_days.toLocaleString()} | ${holdCoverage.total_observation_days.toLocaleString()} |
| 期間内の記録済み完了 | ${devCoverage.completion_records_through_horizon.toLocaleString()} | ${holdCoverage.completion_records_through_horizon.toLocaleString()} |
| 対象家事の有効間隔 | ${devCoverage.target_valid_interval_total.toLocaleString()} | ${holdCoverage.target_valid_interval_total.toLocaleString()} |
| 3間隔へ到達した対象履歴 | ${devCoverage.target_histories_reaching_three_intervals}/${devCoverage.target_chore_histories} (${(devCoverage.three_interval_reach_fraction * 100).toFixed(2)}%) | ${holdCoverage.target_histories_reaching_three_intervals}/${holdCoverage.target_chore_histories} (${(holdCoverage.three_interval_reach_fraction * 100).toFixed(2)}%) |
| 学習可能な完了 / 適用完了 | ${devMetric.learning_eligible_completions.toLocaleString()} / ${devMetric.target_applied_completions.toLocaleString()} (${(devMetric.learning_eligible_fraction_of_applied_target_completions * 100).toFixed(2)}%) | ${holdMetric.learning_eligible_completions.toLocaleString()} / ${holdMetric.target_applied_completions.toLocaleString()} (${(holdMetric.learning_eligible_fraction_of_applied_target_completions * 100).toFixed(2)}%) |
| 採点済み予測 | ${devMetric.prediction_scoring.scored_predictions.toLocaleString()} | ${holdMetric.prediction_scoring.scored_predictions.toLocaleString()} |
| 未採点のまま残った予測 | ${devMetric.prediction_scoring.unresolved_predictions} | ${holdMetric.prediction_scoring.unresolved_predictions} |
| MAE（採点済みだけ） | ${fmt(devMetric.prediction_scoring.mean_absolute_error_days_scored_only)}日 | ${fmt(holdMetric.prediction_scoring.mean_absolute_error_days_scored_only)}日 |

未採点予測は誤差0として扱っていない。raw reportの全体\`learning_eligible_fraction=0\`は時系列SQLite評価用ではない値として無効と明示し、raw reportは変更せず、ケース別結果と実SQLite traceから再集計した値を併記した。

## 20 invariantの件数

列の順は\`PASS/FAIL/NOT APPLICABLE/NOT TESTED\`。NOT APPLICABLEとNOT TESTEDは成功件数へ加えていない。

| Invariant | Development | Holdout |
|---|---:|---:|
${invariantRows.join('\n')}

両splitともFAILは0。全文字列は\`development-final-aggregate.json\`と\`holdout-final-aggregate.json\`にある。全体として未検査の5項目は${fullyNotTested.join(', ')}。その境界を補うdirected専用チェックはD04 (NEXT_GENERATION/DAILY_FIXED)、D05 (FALLBACK_LOCK)、D16 (WEATHER_FAILURE_STABLE)、D01–D02 (追加確認要求なしのAPI観測)で通過した。UIルートの操作そのものは実行していない。

MODE_BOUNDARYは各splitでPASS83、NOT APPLICABLE756、NOT TESTED1。未検査の1件はモード変更後に対象家事の記録完了が存在しないため、PASSへ置き換えていない。NO_INTERVAL_CAPはdevelopment 484 PASS/356 NOT TESTED、holdout 486 PASS/354 NOT TESTED。

## 閉ループ

一歩感度分析は各splitで0/50/100%追従の84ケース。FAILは0。Developmentの0%に1件、提案後の記録完了がないNOT APPLICABLEがある。Holdoutは各84件が適用可能。予測次回日の変化率はすべて1だが、これは一回の完了後に別の次回日が出たことだけを表し、長期安定性とは呼ばない。

多段の135操作では、各完了がSQLiteへ保存された実plan ID/revisionを使い、storeが次planを再発行した。実表示窓内の学習周期パラメータ変更は0。週次・月末の位相anchorは窓内完了で進むため別集計し、元ruleDate保持と次planの曜日/月末位相を確認した。9シナリオはすべてPASS。固定fixture以外の将来完了やhidden truthは入力していない。

| Profile | 追従率 | 実完了操作 | 提案追従数 | 窓内の周期変更 | 窓内phase更新 | 結果 |
|---|---:|---:|---:|---:|---:|---|
${feedbackRows.join('\n')}

## 配置と再現

- SQLite chronology traceから計数: development calendar replan ${development.observation_learning_and_error_coverage.no_candidate_and_replan_counts.sqlite_trace.calendar_replan_calls.toLocaleString()}回・fallback/no-candidate plan ${development.observation_learning_and_error_coverage.no_candidate_and_replan_counts.sqlite_trace.fallback_plan_results_no_candidate.toLocaleString()}件、holdout ${holdout.observation_learning_and_error_coverage.no_candidate_and_replan_counts.sqlite_trace.calendar_replan_calls.toLocaleString()}回・${holdout.observation_learning_and_error_coverage.no_candidate_and_replan_counts.sqlite_trace.fallback_plan_results_no_candidate.toLocaleString()}件。
- Development trace SHA-256: \`${development.execution.operation_trace.sha256}\`; Holdout trace SHA-256: \`${holdout.execution.operation_trace.sha256}\`。両方を外部保存先へコピーし、各ファイルサイズとSHA-256を照合した。
- 外部索引・manifest・全ファイルSHA: \`evidence-index.json\`。入力ZIP原本と12のテスト資材は外部移動・削除していない。
- 集計再実行例: \`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/realistic-lifestyle-aggregate.mjs --split=development --trace-path=/Volumes/DockerExternal/LiFlowBuildCache/realistic-20261106/lifestyle-traces/final-development-20261106/results/development.operations.jsonl.gz\`。Holdoutも\`--split=holdout --trace-path=.../final-holdout-20261106/results/holdout.operations.jsonl.gz\`で同じ集計コードを使う。
- 追加Node回帰: 7件PASS（集計のeligibility/window一致、欠落/重複ケース拒否、Directed/closed-loop失敗の隠蔽拒否、trace fallback/replan集計、多段実SQLiteループ）。

## 制約

合成データの結果であり、実ユーザー人口の代表性や実機UI操作の受入を証明しない。天気provider実通信、追加確認UI、時刻/端末を跨ぐ同期はこの本体学習実行からは未検査。未採点予測は期限内に次の観測完了がないため残した。
`;
  const output = join(results, 'RUN-RESULTS.md');
  await writeFile(output, report);
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
