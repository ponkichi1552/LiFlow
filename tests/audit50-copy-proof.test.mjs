import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, groupId, now } from './helpers/sharing-v2-repository-fixture.mjs';
const { createHouseholdChoreDefinitions } = await import('../src/domain/chores/catalog.ts');
const { createV2PersonalCopyStore } = await import('../src/platform/storage/sharing-v2-personal-copy.ts');

test('audit50 reopening a committed personal copy indexes exact signed proof identities without rescanning unrelated history for every draft', async t => {
  const family = await fixture(); const d = await family.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  const chores = createHouseholdChoreDefinitions('local-household'); let ordinal = 0;
  const source = { scope: 'personal', ownerUserId: 'owner', householdId: 'local-household', frequencyMode: 'balanced', chores };
  const options = { repository: d.repository, userId: 'owner', groupId, assertAccess() {}, makeId: () => `proof-copy-${++ordinal}`, now };
  const store = createV2PersonalCopyStore(options); const staged = await store.prepare(0, source, chores.slice(0, 20).map(x => x.id), 'common');
  const saved = await store.confirm(staged.review, source); let reads = 0; let tamper = false;
  const wrapped = createV2PersonalCopyStore({ ...options, repository: { ...d.repository,
    readCurrent: work => d.repository.readCurrent((state, tx) => {
      const actual = state.replica.operations.map(op => tamper && op.operationId === saved.review.records[0].choreOperationId
        ? { ...op, payload: { ...op.payload, name: 'changed unreviewed content' } } : op);
      const padding = Array.from({ length: 1000 }, (_, n) => ({ get operationId() { reads++; return `unrelated-history-${n}`; } }));
      return work({ ...state, replica: { ...state.replica, operations: [...padding, ...actual] } }, tx);
    }) } });
  const reopened = await wrapped.read(); assert.equal(reopened.synchronization, 'pending');
  assert.ok(reads <= 3000, `unrelated history identity reads: ${reads}`);
  tamper = true; await assert.rejects(wrapped.read(), /コピー済み/u);
});
