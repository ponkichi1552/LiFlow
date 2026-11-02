import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';

const id = 'completion-intent.55a4e011-1dac-4c8d-b817-a67189ae39b1';
const intent = { id, digest: sharedDocumentDigest({ chore: 'floor', completed: true }) };
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };

test('a shared completion intent commits its receipt, signature and Outbox atomically and never repeats after restart or a later undo', async () => {
  const f = await fixture(); const h = await f.device(); let ordinal = 0;
  try {
    await h.repository.commit(seeds());
    const queued = createV2PlannerActions({ ...h.repository, commitCurrent: build => h.repository.commitCompletionIntent(intent, build) },
      { makeId: () => `queued-${++ordinal}`, now });
    const completed = await queued.complete(ref); assert.equal(completed.length, 1);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_v2_completion_intents').get().n, 1);
    const before = h.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n;
    assert.deepEqual(await queued.complete(ref), []); assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n, before);
    const ordinary = createV2PlannerActions(h.repository, { makeId: () => `ordinary-${++ordinal}`, now });
    await ordinary.undo(completed[0].operationId);
    assert.deepEqual(await queued.complete(ref), [], 'a delayed acknowledgement cannot re-complete a later undone chore');
    assert.equal((await h.repository.readState()).replica.operations.filter(op => op.operationType === 'complete').length, 1);
    h.stopWrites(); await assert.rejects(queued.complete(ref), /account changed/, 'a stored intent receipt never authorizes a removed or different account');
  } finally { h.connection.close(); }
});

test('a shared completion intent rejects a changed target or device instead of accepting an unrelated receipt', async () => {
  const f = await fixture(); const h = await f.device();
  try {
    await h.repository.commit(seeds()); await h.repository.commitCompletionIntent(intent, async () => []);
    await assert.rejects(h.repository.commitCompletionIntent({ ...intent, digest: 'f'.repeat(64) }, async () => []), /一致しません/);
    h.connection.prepare('UPDATE sharing_v2_completion_intents SET device_id=?').run('other-device');
    await assert.rejects(h.repository.commitCompletionIntent(intent, async () => []), /一致しません/);
  } finally { h.connection.close(); }
});

test('a shared completion intent rolls back its marker and Outbox when authority or business validation rejects the change', async () => {
  const f = await fixture(); const h = await f.device();
  try {
    await h.repository.commit(seeds()); const before = h.state(); const outbox = h.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n;
    await assert.rejects(h.repository.commitCompletionIntent(intent, async () => [{ operationId: 'bad-completion', entityType: 'completion', entityId: 'unknown', operationType: 'complete',
      payload: { choreId: 'missing', anchorDate: '2026-10-27', subjectUserId: null, ruleVersion: 1, completedAt: now().toISOString(), completedByMemberId: 'other', originalAssigneeIds: [], outcome: 'completed' } }]));
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_v2_completion_intents').get().n, 0);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n, outbox); assert.deepEqual(h.state(), before);
    await assert.rejects(h.repository.commitCompletionIntent(intent, async () => [{ operationId: 'wrong-command', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: 'changed' } }]), /別の設定/);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_v2_completion_intents').get().n, 0);
  } finally { h.connection.close(); }
});
