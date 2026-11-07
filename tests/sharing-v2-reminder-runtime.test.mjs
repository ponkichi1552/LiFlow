import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, scope } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2ReminderStore } from '../src/platform/storage/sharing-v2-reminders.ts';
import { createV2ReminderRuntime } from '../src/features/sharing/v2/reminder-runtime.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { v2NotificationPrefix } from '../src/features/sharing/v2/native-identity.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { createV2ReminderEditor } from '../src/features/sharing/v2-ui/reminder-editor.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';

const instant = new Date('2026-10-27T00:00:00Z');
async function setup() {
  const f = await fixture(); const d = await f.device(); let active = true; let ids = 0; const calls = []; const stored = new Map();
  const guard = () => { if (!active) throw new Error('account changed'); };
  await d.repository.commit(seeds());
  const controller = createV2GroupController(d.repository, { now: () => instant, makeId: () => `reminder-${++ids}`, sync: async () => {} });
  const store = createV2ReminderStore(d.database, { ...scope, assertAccess: guard });
  const gateway = { maximumScheduledRequests: 60, async requestPermission() { calls.push(['permission']); return true; }, async hasPermission() { return true; },
    async getScheduledRequests() { return [...stored.values()]; }, async schedule(row) { calls.push(['schedule', row.key]); stored.set(row.key, row); return row.key; },
    async cancel(key) { calls.push(['cancel', key]); stored.delete(key); } };
  let reads = 0;
  const readModel = async () => { reads++; return controller.readModel({ from: '2026-10-22', through: '2026-11-26', asOfDate: '2026-10-27' }); };
  const input = { ...scope, store, gateway, assertAccess: guard, readModel, now: () => instant };
  return { f, d, controller, store, gateway, calls, stored, input, readModel, reads: () => reads, stop() { active = false; },
    runtime: createV2ReminderRuntime(input), close() { d.connection.close(); } };
}

test('a personal input change while native notification reads are pending discards the old plan before OS writes',async()=>{
  const h=await setup();let generation=0,reads=0,disposals=0;
  try{
    await h.store.save(0,{enabled:true,hour:10,minute:0});
    const oldRead=h.gateway.getScheduledRequests;h.gateway.getScheduledRequests=async()=>{generation=1;return oldRead();};
    const schedule=h.gateway.schedule;h.gateway.schedule=async row=>{assert.ok(reads>=2,'old input must not reach the OS');return schedule(row);};
    const runtime=createV2ReminderRuntime({...h.input,readModel:async()=>{const captured=generation;reads++;return{...await h.readModel(),assertPlanningCurrent:async()=>{if(captured!==generation)throw new Error('personal revision changed');},dispose:()=>{disposals++;}};}});
    await runtime.synchronize();assert.equal(reads,2);assert.equal(disposals,2);assert.ok(h.stored.size>0);
  }finally{h.close();}
});

test('denied notification permission skips personal planning while cleaning old reservations and continuing completion checks',async()=>{
  const h=await setup();let after=0;
  try{
    await h.store.save(0,{enabled:true,hour:10,minute:0});await h.runtime.synchronize();h.gateway.hasPermission=async()=>false;
    const runtime=createV2ReminderRuntime({...h.input,readModel:async()=>assert.fail('permission denied must not load private plans'),afterSynchronize:async()=>{after++;}});
    await runtime.synchronize();assert.equal(h.stored.size,0);assert.equal(after,1);
    h.gateway.hasPermission=async()=>{throw new Error('permission unavailable');};await assert.rejects(runtime.synchronize(),/unavailable/);
  }finally{h.close();}
});

test('v2 reminder settings are device-local, bound to real v2 SQLite, revision-checked and restart-compatible', async () => {
  const h = await setup(); try {
    const before = await h.d.repository.readState(); const value = await h.store.read(); assert.deepEqual(value.preferences, { enabled: false, hour: 9, minute: 0 }); assert.equal(value.revision, 0);
    assert.equal(h.calls.length, 0, 'reading preferences never requests OS permission or schedules');
    const saved = await h.store.save(0, { enabled: true, hour: 10, minute: 15 }); assert.equal(saved.revision, 1);
    assert.equal((await h.store.save(1, saved.preferences)).revision, 1);
    const restarted = createV2ReminderStore(h.d.database, { ...scope, assertAccess() {} }); assert.deepEqual(await restarted.read(), saved);
    await assert.rejects(h.store.save(0, { enabled: false, hour: 8, minute: 0 }), /読み直/u);
    const wrong = createV2ReminderStore(h.d.database, { ...scope, userId: 'member', assertAccess() {} }); await assert.rejects(wrong.read(), /保存先/u);
    const after = await h.d.repository.readState(); assert.deepEqual(after.replica, before.replica); assert.equal(after.assessment.pendingOutboxIds.length, before.assessment.pendingOutboxIds.length);
  } finally { h.close(); }
});

test('v2 reminders reconcile local completion and targeted undo without changing private/v1 reminders', async () => {
  const h = await setup(); try {
    h.stored.set('personal-reminder', { key: 'personal-reminder', title: 'private', body: '', fireAt: '2026-10-28T00:00:00Z' });
    await h.store.save(0, { enabled: true, hour: 10, minute: 0 }); await h.runtime.synchronize();
    const key = v2NotificationPrefix(scope.userId, scope.groupId) + '2026-10-27'; assert.ok(h.stored.has(key));
    const commands = await h.controller.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null });
    await h.runtime.synchronize(); assert.ok(!h.stored.has(key)); assert.ok(h.stored.has('personal-reminder'));
    await h.controller.actions.undo(commands[0].operationId); await h.runtime.synchronize(); assert.ok(h.stored.has(key)); assert.ok(h.stored.has('personal-reminder'));
    h.calls.length = 0; await h.runtime.synchronize(); assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});

test('v2 concurrent sync requests share a Promise and a mid-read preference change cannot schedule stale values', async () => {
  const h = await setup(); try {
    await h.store.save(0, { enabled: true, hour: 10, minute: 0 }); let entered; const ready = new Promise(resolve => { entered = resolve; }); let release;
    const wait = new Promise(resolve => { release = resolve; }); let first = true;
    const runtime = createV2ReminderRuntime({ ...h.input, readModel: async () => { if (first) { first = false; entered(); await wait; } return h.readModel(); } });
    const operation = runtime.synchronize(); await ready; assert.equal(runtime.synchronize(), operation);
    await h.store.save(1, { enabled: false, hour: 11, minute: 0 }); release(); await operation;
    assert.equal(h.stored.size, 0); assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});
test('v2 shared reminders and received-completion delivery share one coalesced worker budget', async () => {
  const h = await setup(); let release; let entered; const ready = new Promise(resolve => { entered = resolve; });
  try {
    let calls = 0; const budgets = []; const pending = new Promise(resolve => { release = resolve; });
    const runtime = createV2ReminderRuntime({ ...h.input, afterSynchronize: async remaining => { calls++; budgets.push(remaining); if (calls === 1) { entered(); await pending; } } });
    const work = runtime.synchronize(5000); await ready;
    assert.equal(runtime.synchronize(2000), work); release(); await work;
    assert.equal(calls, 2, 'one change while delivery runs receives one follow-up, not another worker');
    assert.ok(budgets.every(value => value > 0 && value <= 5000)); assert.ok(budgets[1] <= 2000);
    assert.equal(h.reads(), 0); assert.equal(h.calls.length, 0, 'neither feature requests permission or personal data while off');
  } finally { release?.(); h.close(); }
});

test('v2 group changes during native scheduling trigger a fresh plan and remove the stale reminder', async () => {
  const h = await setup(); try {
    await h.store.save(0, { enabled: true, hour: 10, minute: 0 }); const schedule = h.gateway.schedule; let first = true;
    h.gateway.schedule = async row => { await schedule(row); if (first) { first = false; await h.controller.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null }); } return row.key; };
    await h.runtime.synchronize(); assert.ok(h.reads() >= 2); assert.ok(!h.stored.has(v2NotificationPrefix(scope.userId, scope.groupId) + '2026-10-27'));
  } finally { h.close(); }
});

test('v2 removal stops future planning and may clear only its old native scope without reading group data', async () => {
  const h = await setup(); try {
    await h.store.save(0, { enabled: true, hour: 10, minute: 0 }); await h.runtime.synchronize(); assert.ok(h.stored.size > 0);
    h.stored.set('unrelated', { key: 'unrelated', title: '', body: '', fireAt: '2026-10-28T00:00:00Z' }); h.stop();
    await assert.rejects(h.runtime.synchronize(), /account changed/u); await h.runtime.clear(); assert.deepEqual([...h.stored.keys()], ['unrelated']);
    await assert.rejects(h.store.save(1, { enabled: false, hour: 10, minute: 0 }), /account changed/u);
  } finally { h.close(); }
});

test('v2 notification planning reuses the authenticated screen session with a bounded complete range', async () => {
  const h = await setup(); try {
    const session = createV2ScreenSession({ controller: h.controller, ...scope, now: () => instant,
      readPreferences: () => ({ ownerUserId: scope.userId, settings: { frequencyMode: 'standard', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } } }) });
    const model = await session.readModel({ reminders: true }); assert.deepEqual(model.plan.range, { from: '2026-10-22', through: '2026-11-26', asOfDate: '2026-10-27' });
    assert.equal(model.personal.viewerUserId, scope.userId); await assert.rejects(session.readModel({ reminders: true, management: true }), /同時/u);
  } finally { h.close(); }
});

test('a lost notification-settings save reply recovers its accepted revision without repeating a write', async () => {
  const h = await setup(); try {
    let lose = true; let writes = 0;
    const store = { ...h.store, async save(...args) { const result = await h.store.save(...args); writes++;
      if (lose) { lose = false; throw new Error('reply lost after commit'); } return result; } };
    const editor = createV2ReminderEditor({ store, saved: await h.store.read(), delayMs: 10_000 });
    editor.change({ hour: '19' }); assert.equal(await editor.flush(), false); assert.equal((await h.store.read()).revision, 1);
    assert.equal(await editor.flush(), true); assert.equal(editor.getSnapshot().revision, 1); assert.equal(editor.getSnapshot().hasDraft, false);
    assert.equal((await h.store.read()).revision, 1); assert.equal(writes, 2, 'second call acknowledges the existing row rather than advancing it');
  } finally { h.close(); }
});

test('a shorter worker budget fences an already running reminder operation before it reaches native writes', async () => {
  const h = await setup(); try {
    await h.store.save(0, { enabled: true, hour: 10, minute: 0 }); let clock = 0; let entered; let release;
    const ready = new Promise(resolve => { entered = resolve; }); const wait = new Promise(resolve => { release = resolve; });
    h.gateway.getScheduledRequests = async () => { entered(); await wait; return []; };
    const runtime = createV2ReminderRuntime({ ...h.input, budgetNow: () => clock }); const first = runtime.synchronize(15_000); await ready;
    assert.equal(runtime.synchronize(1000), first); clock = 1001; release(); await assert.rejects(first, /次回の同期/u); assert.equal(h.stored.size, 0); assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});

test('v2 reminders reject a legacy personal database before adding any v2 settings table or editing existing rows', async () => {
  const h = createDatabase(); try {
    await migrateLocalDatabase(h.database); await h.database.runAsync('INSERT INTO households VALUES (?, ?, ?)', 'local-household', '保持する個人データ', '2026-10-27T00:00:00Z');
    const before = h.connection.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const store = createV2ReminderStore(h.database, { ...scope, assertAccess() {} }); await assert.rejects(store.read());
    assert.deepEqual(h.connection.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), before);
    assert.equal(h.connection.prepare('SELECT name FROM households').get().name, '保持する個人データ');
  } finally { h.connection.close(); }
});
