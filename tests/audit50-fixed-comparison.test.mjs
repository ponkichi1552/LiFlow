import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/sharing-v2-plan-fixture.mjs';
const { createV2AuthorityIndex } = await import('../src/features/sharing/v2/history-view.ts');
const { v2ReadPoint } = await import('../src/features/sharing/v2/view-point.ts');
const { fixedConflictAtOperation } = await import('../src/features/sharing/v2/fixed-conflict.ts');

test('audit50 equivalent fixed rule history counts a compared occurrence once rather than exhausting the safety limit on old revisions', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] });
  f.designation({ precision: 'interval', start: '2026-10-27T04:30:00Z', end: '2026-10-27T05:30:00Z' }, { selector: { scope: 'ongoing', from: '2026-10-27' } });
  const state = f.state(); assert.deepEqual(state.assessment.rejected, []);
  const original = state.assessment.view.ofType('designation')[0]; const index = createV2AuthorityIndex(original.groupId);
  for (const op of state.assessment.view.ready) index.accept(op);
  for (let n = 1; n <= 10001; n++) index.accept({ ...original, operationId: `later-rule-${n}`, authorDeviceId: 'rule-editor', deviceSequence: n,
    logicalClock: original.logicalClock + n, context: { ...original.context, [original.authorDeviceId]: original.deviceSequence, 'rule-editor': n - 1 },
    payload: { configuration: { ...original.payload.configuration, id: `later-rule-${n}` } } });
  const at = v2ReadPoint(index.view, f.archive.at(-1));
  assert.equal(fixedConflictAtOperation(index.view, f.archive, at,
    { precision: 'interval', start: '2026-11-03T06:00:00Z', end: '2026-11-03T07:00:00Z' }, ['a'],
    { occurrenceId: 'different-round', subjectUserId: null }), false);
  assert.equal(fixedConflictAtOperation(index.view, f.archive, at,
    { precision: 'interval', start: '2026-11-03T05:00:00Z', end: '2026-11-03T06:00:00Z' }, ['a'],
    { occurrenceId: 'different-round', subjectUserId: null }), true, 'real overlaps are still rejected');
});
