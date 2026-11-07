import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/sharing-v2-plan-fixture.mjs';
const { buildV2CommonPlan } = await import('../src/features/sharing/v2/common-plan.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');

test('audit50 completed round assignment preservation selects observed assignment changes once before indexing their chore and rule version', async () => {
  const f = await fixture({ cycle: 1 }); const state = f.state(); let reads = 0;
  const base = state.assessment.view.ready[0];
  const unrelated = Array.from({ length: 1000 }, (_, n) => ({ ...base, entityType: 'assignmentRule', operationId: `unrelated-assignment-${n}`,
    get deviceSequence() { reads++; return base.deviceSequence; }, payload: { choreId: `other-${n}`, ruleVersion: 1, scope: 'from', fromAnchorDate: '2026-10-27' } }));
  const view = { ...state.assessment.view,
    ofType: type => type === 'assignmentRule' ? unrelated : state.assessment.view.ofType(type),
    assignmentsAt: () => ({ facts: unrelated, requests: [] }) };
  const range = { from: '2026-10-27', through: addDays('2026-10-27', 180), asOfDate: '2026-10-27' };
  const expected = buildV2CommonPlan(state, range);
  const actual = buildV2CommonPlan({ ...state, assessment: { ...state.assessment, view } }, range);
  assert.deepEqual(actual, expected); assert.ok(reads < 4000, `unrelated assignment causal checks: ${reads}`);
});
