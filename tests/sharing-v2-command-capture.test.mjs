import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { guardV2GroupController } from '../src/features/sharing/v2/controller-access.ts';
import { loadSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { fixture, seeds, draft, groupId, now } from './helpers/sharing-v2-repository-fixture.mjs';

const range = () => ({ from: '2026-10-27', through: '2026-11-03', asOfDate: '2026-10-27' });
function gate() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }
function controller(device) { let id = 0; return createV2GroupController(device.repository, { makeId: () => `capture-${++id}`, now, sync: async () => {} }); }

test('v2 native command captures the reviewed nested edit before waiting for account authorization', async () => {
  const f = await fixture(); const d = await f.device(); const wait = gate();
  try {
    await d.repository.commit(seeds());
    const api = guardV2GroupController(controller(d), () => wait.promise);
    const edit = { name: 'タップ時の名前', instructions: ['確認した手順'] };
    const saving = api.actions.patchChore('floor', edit);
    edit.name = '未確認の名前'; edit.instructions[0] = '未確認の手順'; edit.instructions.push('追加');
    wait.release(); await saving;
    const facts = await loadSharedFacts(d.database, groupId); const saved = facts.find(fact => fact.operation.operationId === 'capture-1').operation;
    assert.deepEqual(saved.payload, { name: 'タップ時の名前', instructions: ['確認した手順'] });
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 5);
  } finally { wait.release(); d.connection.close(); }
});

test('v2 native model read captures its date range and detail selection before authorization yields', async () => {
  const f = await fixture(); const d = await f.device(); const wait = gate();
  try {
    await d.repository.commit(seeds());
    const api = guardV2GroupController(controller(d), () => wait.promise);
    const dates = range(); const options = { detailChoreId: 'floor' };
    const reading = api.readModel(dates, options);
    dates.from = '2027-01-01'; dates.through = '2027-01-08'; dates.asOfDate = '2027-01-01'; options.detailChoreId = 'other';
    wait.release(); const model = await reading;
    assert.equal(model.choreDetails[0]?.choreId, 'floor');
    assert.ok(model.plan.occurrences.some(item => item.anchorDate === '2026-10-27'));
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 4);
  } finally { wait.release(); d.connection.close(); }
});

test('v2 repository freezes a literal command page before SQLite waits without signing later caller edits', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    const page = [draft('original-intent', 'chore', 'floor', { name: '保存した名前', instructions: ['保存した手順'] })];
    const saving = d.repository.commit(page);
    page[0].payload.name = '後からの名前'; page[0].payload.instructions.push('後からの手順');
    page.push(draft('unconfirmed-addition', 'chore', 'other', { name: '追加された家事', enabled: false }));
    const created = await saving;
    assert.equal(created.length, 1); assert.equal(created[0].operationId, 'original-intent');
    assert.deepEqual(created[0].payload, { name: '保存した名前', instructions: ['保存した手順'] });
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 5);
  } finally { d.connection.close(); }
});

test('v2 native command still checks current authorization and cannot save captured input after revocation', async () => {
  const f = await fixture(); const d = await f.device(); const wait = gate();
  try {
    await d.repository.commit(seeds()); const before = d.state();
    const api = guardV2GroupController(controller(d), async () => { await wait.promise; throw new Error('access revoked'); });
    const saving = api.actions.patchChore('floor', { name: '保存しない' });
    wait.release(); await assert.rejects(saving, /access revoked/u);
    assert.deepEqual(d.state(), before); assert.equal((await listSharingOutbox(d.database, groupId)).length, 4);
  } finally { wait.release(); d.connection.close(); }
});

test('v2 lightweight calendar reads wait for live workspace authorization and reject revoked access', async () => {
  const f = await fixture(); const d = await f.device(); const wait = gate();
  try {
    await d.repository.commit(seeds()); let reads = 0; const original = controller(d);
    const api = guardV2GroupController({ ...original, readCalendar: async () => { reads++; return original.readCalendar(); } }, async editing => {
      assert.equal(editing, false); await wait.promise; throw new Error('access revoked');
    });
    const reading = api.readCalendar(); assert.equal(reads, 0); wait.release();
    await assert.rejects(reading, /access revoked/u); assert.equal(reads, 0);
    const allowed = guardV2GroupController(original, async editing => assert.equal(editing, false));
    assert.equal((await allowed.readCalendar()).groupId, groupId);
  } finally { wait.release(); d.connection.close(); }
});

test('v2 current-state builder output cannot change after it yields to a SQLite operation lookup', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    const page = [draft('builder-original', 'chore', 'floor', { name: '計算した名前', instructions: ['計算した手順'] })];
    const read = d.database.getFirstAsync; let intercepted = false;
    d.database.getFirstAsync = async (sql, ...args) => {
      if (!intercepted && sql.startsWith('SELECT operation_json FROM sharing_operations WHERE operation_id')) {
        intercepted = true; page[0].operationId = 'builder-changed'; page[0].payload.name = '後から変わった名前'; page[0].payload.instructions.push('後からの手順');
      }
      return read(sql, ...args);
    };
    const created = await d.repository.commitCurrent(async () => page);
    assert.equal(intercepted, true); assert.equal(created[0].operationId, 'builder-original');
    assert.deepEqual(created[0].payload, { name: '計算した名前', instructions: ['計算した手順'] });
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 5);
  } finally { d.connection.close(); }
});

test('v2 current-state command retains the original builder while waiting for its transaction', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    const input = { build: async () => [draft('reviewed-builder', 'chore', 'floor', { name: '選んだ処理' })] };
    const saving = d.repository.commit(input);
    input.build = async () => [draft('replacement-builder', 'chore', 'floor', { name: '差し替えた処理' })];
    const created = await saving; assert.equal(created.length, 1); assert.equal(created[0].operationId, 'reviewed-builder');
    assert.equal(created[0].payload.name, '選んだ処理');
  } finally { d.connection.close(); }
});

test('v2 captured commands preserve optional arguments and evaluate dynamic date ranges against the current group timezone', async () => {
  const f = await fixture(); const d = await f.device(); const wait = gate();
  try {
    await d.repository.commit(seeds()); const api = guardV2GroupController(controller(d), () => wait.promise);
    const saving = api.actions.patchChore('floor', { name: '省略値を保つ', instructions: undefined }, undefined);
    wait.release(); await saving; let zone;
    const model = await api.readModel(context => { zone = context.timeZone; return range(); }, { detailChoreId: 'floor', applianceId: undefined });
    assert.equal(zone, 'Asia/Tokyo'); assert.equal(model.choreDetails[0].fields.name.value, '省略値を保つ');
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 5);
  } finally { wait.release(); d.connection.close(); }
});
