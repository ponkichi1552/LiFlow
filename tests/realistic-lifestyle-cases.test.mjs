import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { dataRoot, directedCases, evaluateDirectedCase, evaluateModeBoundaryChecks, readLifestyleCases } from './helpers/realistic-lifestyle-cases.mjs';

test('realistic lifestyle asset hash manifest covers the shipped case inputs', async () => {
  const manifest = await readFile(new URL('SHA256SUMS', dataRoot), 'utf8');
  const entries = manifest.trim().split('\n');
  assert.equal(entries.length, 12);
  const verified = new Set();
  for (const line of entries) {
    const match = /^([a-f0-9]{64})  (\.\/[^\n]+)$/u.exec(line);
    assert.ok(match, `invalid SHA256SUMS row: ${line}`);
    const [, expected, relativePath] = match;
    assert.ok(!verified.has(relativePath), `duplicate SHA256SUMS path: ${relativePath}`);
    verified.add(relativePath);
    const bytes = await readFile(new URL(relativePath.slice(2), dataRoot));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `asset hash mismatch: ${relativePath}`);
  }
  assert.equal(verified.size, 12);
  const lines = createInterface({ input: createReadStream(new URL('cases.jsonl.gz', dataRoot)).pipe(createGunzip()), crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    const row = JSON.parse(line);
    assert.equal(row.clock.future_data_not_visible_to_app, true);
    assert.equal(row.population_weight, null);
    assert.ok(Array.isArray(row.evaluation_only_hidden_events));
    assert.ok(row.evaluation_only_hidden_events.every(event => event.event === 'synthetic_unrecorded_action'));
    count++;
  }
  assert.equal(count, 1680);
  const directed = JSON.parse(await readFile(new URL('directed_cases.json', dataRoot), 'utf8'));
  assert.equal(directed.length, 21);
});

test('realistic lifestyle corpus keeps development and holdout cases disjoint and does not include population weights', async () => {
  const development = await readLifestyleCases({ split: 'development' });
  const holdout = await readLifestyleCases({ split: 'holdout' });
  assert.equal(development.length, 840);
  assert.equal(holdout.length, 840);
  const devIds = new Set(development.map(row => row.case_id));
  assert.ok(holdout.every(row => !devIds.has(row.case_id)));
  assert.ok([...development, ...holdout].every(row => row.population_weight === null
    && row.clock.future_data_not_visible_to_app === true
    && !Object.hasOwn(row, 'evaluation_only_hidden_events')));
});

test('MODE_BOUNDARY ignores unobserved post-mode periods and fails any observed interval leak', () => {
  const modeStates = [{ event: { type: 'settings', mode: 'relaxed' }, finalMode: 'relaxed' }];
  const unobserved = evaluateModeBoundaryChecks(modeStates, [
    { chore_id: 'long-care', mode_change_applied: true, after_first_completion_interval_count: null, cross_mode_interval_added: null },
  ]);
  assert.equal(unobserved.status, 'not_tested');

  const compliant = evaluateModeBoundaryChecks(modeStates, [
    { chore_id: 'floor', mode_change_applied: true, after_first_completion_interval_count: 4, cross_mode_interval_added: false },
    { chore_id: 'filter', mode_change_applied: true, after_first_completion_interval_count: 2, cross_mode_interval_added: false },
  ]);
  assert.equal(compliant.status, 'pass');
  assert.equal(compliant.evidence.post_mode_completion_check_count, 2);

  const mixedWithViolation = evaluateModeBoundaryChecks(modeStates, [
    { chore_id: 'floor', mode_change_applied: true, after_first_completion_interval_count: 4, cross_mode_interval_added: false },
    { chore_id: 'filter', mode_change_applied: true, after_first_completion_interval_count: 3, cross_mode_interval_added: true },
    { chore_id: 'long-care', mode_change_applied: true, after_first_completion_interval_count: null, cross_mode_interval_added: null },
  ]);
  assert.equal(mixedWithViolation.status, 'fail');
  assert.deepEqual(mixedWithViolation.evidence.checked_chore_ids, ['floor', 'filter']);
  assert.deepEqual(mixedWithViolation.evidence.unobserved_chore_ids, ['long-care']);
});

for (const scenario of directedCases) {
  test(`realistic directed ${scenario.id}: ${scenario.label}`, async () => {
    const result = await evaluateDirectedCase(scenario);
    assert.equal(result.passed, true);
  });
}

