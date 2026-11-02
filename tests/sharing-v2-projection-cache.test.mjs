import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds } from './helpers/sharing-v2-repository-fixture.mjs';

test('v2 cached authority queries never expose captured facts arrays maps or filter arguments to mutations', async t => {
  const f = await fixture(), d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  const first = await d.repository.readState(); const fact = first.assessment.view.ofType('chore')[0];
  fact.payload.name = 'forged public return';
  first.assessment.view.ready.length = 0; first.assessment.view.topic('chore', 'floor').length = 0;
  const at = { ...first.replica.operations.at(-1), context: { [f.owner.deviceId]: 9999 } };
  first.assessment.view.field('chore', 'floor', 'name', at, operation => { operation.payload.name = 'forged filter argument'; return true; });
  first.replica.operations[2].payload.name = 'forged replica'; first.archive[0].body.ownerUserId = 'forged owner';
  first.receipts.clear();
  const next = await d.repository.readState();
  assert.equal(next.assessment.view.ofType('chore')[0].payload.name, '床を掃除する');
  assert.equal(next.assessment.view.ready.length, 4); assert.equal(next.archive[0].body.ownerUserId, 'owner');
});
test('v2 a warmed projection still rejects changed raw signed content and repairs independently damaged derived rows', async t => {
  const f = await fixture(), d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  await d.repository.readState(); const expected = d.state();
  d.connection.prepare('UPDATE sharing_v2_projection SET accepted_ids_json=?').run('["forged"]');
  await d.repository.readState(); assert.deepEqual(d.state(), expected);
  const row = d.connection.prepare('SELECT operation_json FROM sharing_operations WHERE operation_id=?').get('floor');
  const changed = JSON.parse(row.operation_json); changed.payload.name = 'forged on disk';
  d.connection.prepare('UPDATE sharing_operations SET operation_json=? WHERE operation_id=?').run(JSON.stringify(changed), 'floor');
  await assert.rejects(d.repository.readState());
});
test('v2 unchanged latest roster cannot conceal a modified historical membership after warming the authority cache', async t => {
  const f = await fixture(), d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  await d.repository.readState();
  f.archive[0].body.members[0].devices[0].joinedKeyVersion = 99;
  await assert.rejects(d.repository.readState());
});
test('v2 exact projection reuse rechecks both pending local delivery and current account authority', async t => {
  const f = await fixture(), d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  assert.equal((await d.repository.readState()).assessment.pendingOutboxIds.length, 4);
  d.connection.prepare('DELETE FROM sharing_outbox WHERE operation_id=?').run('floor');
  assert.equal((await d.repository.readState()).assessment.pendingOutboxIds.length, 3);
  d.stopWrites(); await assert.rejects(d.repository.readState(), /account changed/u);
});

test('private refreshes reuse unchanged shared planning while new facts tampering and revoked access still take effect', async t => {
  const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
  const f = await fixture(), d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  let queries = 0; const read = d.repository.readState.bind(d.repository);
  d.repository.readState = async () => { const state = await read(); const topic = state.assessment.view.topic;
    state.assessment.view.topic = (...args) => { queries++; return topic(...args); }; return state; };
  let sequence = 0; const controller = createV2GroupController(d.repository, { makeId: () => `cache-edit-${++sequence}`, now: () => new Date('2026-10-27T01:00:00Z'), sync: async () => {} });
  const range = { from: '2026-10-27', through: '2026-11-30', asOfDate: '2026-10-27' };
  const first = await controller.readModel(range); const count = first.plan.occurrences.length; assert.ok(count > 0);
  const coldQueries = queries; assert.ok(coldQueries > 0); first.plan.occurrences.length = 0; first.plan.chores[0].name = 'mutated return'; queries = 0;
  const second = await controller.readModel(range); assert.equal(second.plan.occurrences.length, count); assert.equal(second.plan.chores[0].name, '床を掃除する');
  assert.ok(queries < coldQueries / 2, 'private-only refresh must not repeat the common scheduler queries');
  await controller.actions.patchChore('floor', { name: '変更済みの床掃除' });
  assert.equal((await controller.readModel(range)).plan.chores[0].name, '変更済みの床掃除');
  d.stopWrites(); await assert.rejects(controller.readModel(range), /account changed/);
});

test('copying an already isolated query keeps one isolation boundary and preserves callback and result protection', async () => {
  const { readFileSync } = await import('node:fs'); const ts = await import('typescript'); const vm = await import('node:vm');
  let copies = 0;
  const measuredObject = new Proxy(Object, { get(target, name) { if (name === 'defineProperty') return (...args) => { copies++; return Object.defineProperty(...args); }; return Reflect.get(target, name); } });
  const { outputText } = ts.transpileModule(readFileSync(new URL('../src/platform/storage/isolated-projection-value.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, { exports, Object: measuredObject, Map, Set, WeakMap, Date, Error, Reflect });
  const isolate = exports.isolatedProjectionValue;
  const facts = [{ id: 'one', payload: { enabled: true } }, { id: 'two', payload: { enabled: true } }];
  let allowed = true;
  const original = { select: predicate => { if (!allowed) throw new Error('revoked'); return facts.filter(predicate); } }, first = isolate(original);
  let many = first; for (let i = 0; i < 32; i++) many = isolate(many);
  const filter = isolate(record => { record.payload.enabled = false; return true; });
  copies = 0; const once = first.select(filter); const firstCost = copies;
  copies = 0; const repeated = many.select(filter); const repeatedCost = copies;
  assert.equal(repeatedCost, firstCost, 're-copying protected methods must not nest identical input/output clone layers');
  repeated[0].payload.enabled = false; once.length = 0;
  assert.equal(facts[0].payload.enabled, true); assert.equal(facts.length, 2);
  assert.equal(many.select(() => true)[0].payload.enabled, true);
  allowed = false; assert.throws(() => many.select(() => true), /revoked/, 'flattening copy boundaries must retain the actual authorization wrapper');
});
