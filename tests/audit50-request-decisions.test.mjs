import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createV2AuthorityIndex } = await import('../src/features/sharing/v2/history-view.ts');
const { unresolvedRequestReviews } = await import('../src/features/sharing/v2/request-review.ts');
const { approvedRequestRuleId } = await import('../src/features/sharing/v2/formal-rules.ts');

test('audit50 repeated request conflict reviews inspect only decisions for that request and still include later appended counteroffers', () => {
  const index = createV2AuthorityIndex('group'); let reads = 0;
  const stamp = { schemaVersion: 2, groupId: 'group', authorUserId: 'owner', authorDeviceId: 'device', context: {}, keyVersion: 1, logicalClock: 1, deviceSequence: 1 };
  const occurrence = { id: 'round', choreId: 'floor', anchorDate: '2026-11-07', ruleVersion: 1, windowStart: '2026-11-07', windowEnd: '2026-11-09' };
  const proposal = { choreId: 'floor', subjectUserId: null, proposedMode: 'day', proposed: { precision: 'date', date: '2026-11-07' },
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: 'round', anchorDate: '2026-11-07' } };
  const request = { ...stamp, operationId: 'request', entityType: 'changeRequest', entityId: 'request', operationType: 'patch', payload: proposal }; index.accept(request);
  for (let n = 0; n < 1000; n++) index.accept({ ...stamp, operationId: `other-${n}`, entityType: 'requestDecision', entityId: `other-${n}`, operationType: 'patch',
    payload: { get requestId() { reads++; return `foreign-${n}`; }, decision: 'counteroffer' } });
  reads = 0;
  const state = { requestId: 'request', kind: 'conflict', proposal, conflictIds: ['answer'] };
  const input = { occurrence, subjectUserId: null, candidates: [], allRules: [], requests: [state], view: index.view };
  for (let n = 0; n < 20; n++) assert.deepEqual(unresolvedRequestReviews(input), ['request']);
  assert.ok(reads < 2000, `unrelated decision request reads: ${reads}`);
  const target = { precision: 'date', date: '2026-11-08' }; const derived = approvedRequestRuleId(request, target, proposal.proposedOptions);
  const dependent = { operationId: 'uses-counteroffer', rule: { basisRuleIds: [derived] } };
  const follow = { ...input, candidates: [dependent], requests: [{ ...state, kind: 'approved' }] };
  assert.deepEqual(unresolvedRequestReviews(follow), []);
  index.accept({ ...stamp, operationId: 'new-counteroffer', entityType: 'requestDecision', entityId: 'new-counteroffer', operationType: 'patch',
    payload: { requestId: 'request', decision: 'counteroffer', target } });
  assert.deepEqual(unresolvedRequestReviews(follow), ['request']);
});
