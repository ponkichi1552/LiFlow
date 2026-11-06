import assert from 'node:assert/strict';
import test from 'node:test';
import { runFeedbackLoopSuite } from '../scripts/realistic-lifestyle-feedback-loop.mjs';

test('multi-step feedback consumes actual SQLite proposals at 0, 50, and 100 percent for daily, weekly, and month-end profiles', async () => {
  const result = await runFeedbackLoopSuite();
  assert.equal(result.status, 'pass');
  assert.equal(result.scenario_count, 9);
  assert.equal(result.expected_operation_observations, 135);
  assert.equal(result.actual_operation_observations, 135);
  assert.equal(result.failure_count, 0);
  assert.equal(result.not_tested_count, 0);
  assert.equal(result.assertions.no_synthetic_displayed_windows, true);
  assert.equal(result.assertions.in_window_learning_parameter_changes, 0);
  assert.equal(result.assertions.no_runaway_shortening, true);

  for (const profile of ['daily', 'weekly', 'monthEnd']) {
    for (const followPercent of [0, 50, 100]) {
      const scenario = result.scenarios.find(row => row.profile === profile && row.follow_percent === followPercent);
      assert.ok(scenario);
      assert.equal(scenario.status, 'pass');
      assert.equal(scenario.completed_steps, 15);
      assert.equal(scenario.follow_actions, followPercent === 0 ? 0 : followPercent === 50 ? 8 : 15);
      assert.equal(scenario.violations.length, 0);
      assert.ok(scenario.operations.every(row => row.receipt === 'applied'));
      assert.ok(scenario.operations.every(row => row.prior_plan_id && row.prior_plan_revision && row.next_plan_id && row.next_plan_revision));
      assert.ok(scenario.operations.every(row => row.next_plan_ahead_days >= 1));
      if (profile !== 'daily') {
        assert.ok(scenario.operations.every(row => row.displayed_window !== null));
        assert.equal(scenario.learning_parameter_changes_inside_window, 0);
        assert.ok(scenario.operations.every(row => row.stored_rule_date));
        assert.ok(scenario.operations.every(row => row.stored_window?.revision === row.prior_plan_revision));
      }
    }
  }

  const weekly100 = result.scenarios.find(row => row.profile === 'weekly' && row.follow_percent === 100);
  assert.ok(weekly100.operations.every(row => row.model_after.method === 'weekly'));
  const monthEnd100 = result.scenarios.find(row => row.profile === 'monthEnd' && row.follow_percent === 100);
  assert.ok(monthEnd100.operations.every(row => row.model_after.method === 'monthEnd'));
});
