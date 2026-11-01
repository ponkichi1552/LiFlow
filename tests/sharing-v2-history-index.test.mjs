import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createV2RoundVisibility } from '../src/features/sharing/v2-ui/round-visibility.ts';

test('visible shared cards index an immutable history once while a new history and changed permissions take effect', () => {
  let visits = 0;
  const history = Array.from({ length: 5000 }, (_, n) => ({ get operationId() { visits++; return `op-${n}`; }, recorderUserId: 'other', performerUserId: 'other', subjectUserId: 'other', originalAssigneeIds: [] }));
  const model = { viewerUserId: 'viewer', adminUserId: 'admin', plan: { history, policy: { showCompletionStatus: false } } };
  const round = { assigneeIds: ['other'] }; const subject = { subjectUserId: 'other', completionOperationIds: ['op-4999'], pendingCompletionIds: [] };
  for (let n = 0; n < 100; n++) assert.equal(createV2RoundVisibility(model)(round, subject).showStatus, false);
  assert.equal(visits, 5000);
  assert.equal(createV2RoundVisibility({ ...model, viewerUserId: 'admin' })(round, subject).showStatus, true);
  assert.equal(visits, 5000);
  const updated = { ...model, plan: { ...model.plan, history: [...history, { operationId: 'op-new', recorderUserId: 'viewer' }] } };
  assert.equal(createV2RoundVisibility(updated)(round, { ...subject, completionOperationIds: ['op-new'] }).showStatus, true);
  assert.equal(visits, 10000);
});
