import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/sharing-v2-plan-fixture.mjs';
const { buildV2CommonPlan } = await import('../src/features/sharing/v2/common-plan.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');

test('audit50 common planning scopes request review and extension work to the relevant chore before walking every round', async () => {
  const f = await fixture({ cycle: 1 }); const state = f.state(); let reads = 0;
  const requests = Array.from({ length: 1000 }, (_, n) => ({ requestId: `unrelated-request-${n}`, kind: 'conflict', formal: null, conflictIds: [`answer-${n}`],
    proposal: { get choreId() { reads++; return `other-${n}`; }, subjectUserId: null } }));
  const range = { from: '2026-10-27', through: addDays('2026-10-27', 180), asOfDate: '2026-10-27' };
  const expected = buildV2CommonPlan(state, range);
  const actual = buildV2CommonPlan({ ...state, assessment: { ...state.assessment, requestStates: requests } }, range);
  assert.deepEqual(actual, expected); assert.ok(reads < 4000, `unrelated request identity reads: ${reads}`);
});
