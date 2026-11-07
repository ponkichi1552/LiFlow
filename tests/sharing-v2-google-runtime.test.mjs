import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { now } from './helpers/sharing-v2-repository-fixture.mjs';
const { createV2GoogleTaskRuntime } = await import('../src/features/sharing/v2/google-tasks-runtime.ts');
const { withGoogleSyncOperation } = await import('../src/features/google-sync/operation-lock.ts');
const turn = () => new Promise(setImmediate);

test('manual synchronization joining a background full-scan deferral gets its own foreground pass',async()=>{
  const h=await googleFixture();let release,entered;let prepared=0;
  const gate=new Promise(resolve=>{release=resolve;}),start=new Promise(resolve=>{entered=resolve;});
  const runtime=createV2GoogleTaskRuntime({store:h.store,now,assertAccess:h.scope.assertAccess,
    currentSubject:async()=> 'synthetic-google-subject',token:async()=> 'test',restoreAccount:async()=>assert.fail(),authorizeTasks:async()=>assert.fail(),
    preparePlan:async()=>{if(++prepared===1){entered();await gate;}},createApi:()=>h.api});
  try{await h.connect();const background=runtime.synchronize({deltaOnly:true});await start;
    const manual=runtime.synchronize({force:true,deltaOnly:false});release();
    assert.equal((await background).foregroundRequired,true);const result=await manual;assert.equal(result.kind,'success');assert.equal(result.created,3);assert.equal(prepared,2);
  }finally{release?.();await withGoogleSyncOperation(async()=>{});h.close();}
});

for (const scenario of [
  { name: 'foreground automatic Tasks completes after serialized input preparation exceeds fifteen seconds', foreground: true, elapsed: 28_000, success: true },
  { name: 'explicit worker deadline still bounds foreground automatic Tasks', foreground: true, elapsed: 20_000, explicitBudget: 15_000, success: false },
  { name: 'background automatic Tasks retains its short default deadline', foreground: false, elapsed: 20_000, success: false },
]) test(scenario.name, async () => {
  const h = await googleFixture(); let elapsed = 0; let tokenReads = 0;
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, budgetNow: () => elapsed,
    defaultBudgetMs: () => scenario.foreground ? 100_000 : 15_000, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => { tokenReads++; return 'synthetic-token'; },
    restoreAccount: async () => { throw new Error('automatic sync must not select an account'); },
    authorizeTasks: async () => { throw new Error('automatic sync must not request consent'); },
    preparePlan: async () => { elapsed = scenario.elapsed; }, createApi: () => h.api });
  try {
    await h.connect();
    const result = await runtime.synchronize({ localChange: true, ...(scenario.explicitBudget ? { budgetMs: scenario.explicitBudget } : {}) });
    if (scenario.success) {
      assert.equal(result.kind, 'success'); assert.equal(result.created, 3); assert.equal(tokenReads, 1);
    } else {
      assert.deepEqual(result, { kind: 'retry', code: 'timeout' }); assert.equal(tokenReads, 0); assert.equal(h.tasks.size, 0);
    }
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('longer foreground automatic Tasks budget does not bypass provider backoff or required authentication', async () => {
  for (const status of ['retryPending', 'authRequired']) {
    const h = await googleFixture(); let tokenReads = 0; let preparations = 0;
    const runtime = createV2GoogleTaskRuntime({ store: h.store, now, defaultBudgetMs: () => 100_000, assertAccess: h.scope.assertAccess,
      currentSubject: async () => 'synthetic-google-subject', token: async () => { tokenReads++; return 'synthetic-token'; },
      restoreAccount: async () => { throw new Error('no interactive selection'); },
      authorizeTasks: async () => { throw new Error('no interactive consent'); }, preparePlan:async()=>{preparations++;}, createApi: () => h.api });
    try {
      await h.connect(); const control = await h.store.readControl();
      await h.store.saveSyncState({ ...control.state, status, nextRetryAt: new Date(now().getTime() + 60_000).toISOString() }, control.revision);
      assert.deepEqual(await runtime.synchronize({ localChange: true }), { kind: 'success', skipped: true });
      assert.equal(tokenReads, 0); assert.equal(preparations,0); assert.equal(h.tasks.size, 0); assert.equal((await h.store.readControl()).state.status, status);
    } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
  }
});

test('foreground automatic Tasks propagates completion and Undo despite a recent success while retaining remote IDs', async () => {
  const h = await googleFixture(); let elapsed = 0;
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, budgetNow: () => elapsed,
    defaultBudgetMs: () => 100_000, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('automatic sync must not select an account'); },
    authorizeTasks: async () => { throw new Error('automatic sync must not request consent'); },
    preparePlan: async () => { elapsed += 28_000; }, createApi: () => h.api });
  try {
    await h.connect(); assert.equal((await runtime.synchronize({ force: true })).kind, 'success');
    const ids = [...h.tasks.keys()]; const item = (await h.entries())[0];
    const [done] = await h.actions.complete(item.target);
    assert.equal((await runtime.synchronize({ localChange: true })).kind, 'success');
    const linked = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(h.tasks.get(linked.googleTaskId).status, 'completed');
    await h.actions.undo(done.operationId);
    assert.equal((await runtime.synchronize({ localChange: true })).kind, 'success');
    assert.equal(h.tasks.get(linked.googleTaskId).status, 'needsAction');
    assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).pendingStatus, undefined);
    assert.deepEqual([...h.tasks.keys()], ids);
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

async function setup() {
  const h = await googleFixture(); const calls = []; let subject = 'synthetic-google-subject'; let currentContext;
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    restoreAccount: async () => { calls.push('restore'); return { subject, label: '検査用のGoogle' }; },
    currentSubject: async () => subject, authorizeTasks: async () => { calls.push('authorize'); }, token: async expected => { assert.equal(expected, subject); calls.push('token'); return 'synthetic-token'; },
    preparePlan: async () => { calls.push('prepare'); }, createApi: context => { currentContext = context; return h.api; },
  });
  return { ...h, runtime, nativeCalls: calls, account(value) { subject = value; }, context: () => currentContext };
}

test('v2 Tasks runtime stays offline and never restores OAuth or reads private planner input when unconfigured', async () => {
  const h = await setup(); try {
    assert.equal((await h.runtime.readControl()).state, null);
    assert.deepEqual(await h.runtime.synchronize(), { kind: 'success', skipped: true });
    assert.deepEqual(h.nativeCalls, []); assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});

test('v2 Tasks connection requires explicit account review and grants only the reviewed account without auto-sync', async () => {
  const h = await setup(); try {
    const review = await h.runtime.reviewConnection(); assert.deepEqual(h.nativeCalls, ['restore']); assert.equal((await h.runtime.readControl()).state, null);
    await h.runtime.connect(review); assert.deepEqual(h.nativeCalls, ['restore', 'authorize']); assert.equal((await h.runtime.readControl()).state.enabled, true); assert.equal(h.tasks.size, 0);
    const result = await h.runtime.synchronize({ force: true }); assert.equal(result.kind, 'success'); assert.equal(result.created, 3);
    assert.deepEqual(h.nativeCalls, ['restore', 'authorize', 'prepare', 'token']);
  } finally { h.close(); }
});

test('v2 Tasks refuses an account switched after review before requesting a grant or saving a binding', async () => {
  const h = await setup(); try {
    const review = await h.runtime.reviewConnection(); h.account('different-subject');
    await assert.rejects(h.runtime.connect(review), { code: 'google_account_mismatch' }); assert.deepEqual(h.nativeCalls, ['restore']);
    assert.equal((await h.runtime.readControl()).state, null);
  } finally { h.close(); }
});

test('v2 Tasks coalesces100 simultaneous syncs, recovers a fresh interrupted marker and keeps the same remote IDs', async () => {
  const h = await setup(); try {
    await h.connect(); const attempts = Array.from({ length: 100 }, () => h.runtime.synchronize({ force: true }));
    assert.equal(new Set(attempts).size, 1); assert.equal((await attempts[0]).created, 3);
    assert.equal(h.nativeCalls.filter(value => value === 'token').length, 1);
    const ids = [...h.tasks.keys()]; const before = await h.store.readControl();
    await h.store.saveSyncState({ ...before.state, status: 'syncing', lastAttemptAt: now().toISOString() }, before.revision);
    h.calls.length = 0; const restored = await h.runtime.synchronize({ force: true }); assert.equal(restored.kind, 'success');
    assert.equal(restored.skipped, undefined); assert.deepEqual([...h.tasks.keys()], ids); assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test('automatic shared Tasks recovers a fresh interrupted first sync before links exist and sends the queued completion', async () => {
  const h = await setup();
  try {
    await h.connect(); const control = await h.store.readControl();
    await h.store.saveSyncState({ ...control.state, status: 'syncing', lastAttemptAt: now().toISOString() }, control.revision);
    const item = (await h.entries())[0]; const [done] = await h.actions.complete(item.target);
    assert.equal((await h.links()).length, 0, 'the previous process stopped before its first mapping');
    assert.equal(await h.store.hasPendingLocalChanges(), false, 'unmapped completions cannot rely on an existing link status');
    const result = await h.runtime.synchronize({ localChange: true });
    assert.equal(result.kind, 'success'); assert.equal(result.skipped, undefined); assert.equal(result.created, 3);
    const linked = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(h.tasks.get(linked.googleTaskId).status, 'completed');
    const ids = [...h.tasks.keys()]; await h.actions.undo(done.operationId);
    assert.equal((await h.runtime.synchronize({ localChange: true })).kind, 'success');
    assert.equal(h.tasks.get(linked.googleTaskId).status, 'needsAction'); assert.deepEqual([...h.tasks.keys()], ids);
    assert.equal((await h.store.readControl()).state.status, 'idle');
    assert.deepEqual(h.nativeCalls.filter(call => call === 'restore' || call === 'authorize'), []);
  } finally { await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('v2 Tasks detects a Native account switch during HTTP before importing or storing old-account results', async () => {
  const h = await setup(); try {
    await h.connect(); h.hooks.beforeRead = async () => { h.account('different-subject'); };
    const result = await h.runtime.synchronize({ force: true }); assert.deepEqual(result, { kind: 'authRequired', code: 'google_account_mismatch' });
    assert.equal(h.tasks.size, 0); assert.equal((await h.links()).length, 0); assert.equal((await h.store.readControl()).state.accountSubject, 'synthetic-google-subject');
  } finally { h.close(); }
});

test('v2 Tasks receives a local undo during PATCH and follows it up before its shared sync promise finishes', async () => {
  const h = await setup(); try {
    await h.connect(); await h.runtime.synchronize({ force: true }); const item = (await h.entries())[0]; const [done] = await h.actions.complete(item.target);
    h.hooks.afterPatch = async () => { delete h.hooks.afterPatch; await h.actions.undo(done.operationId); h.runtime.synchronize({ localChange: true }); };
    assert.equal((await h.runtime.synchronize({ force: true })).kind, 'success');
    const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(link.pendingStatus, undefined); assert.equal(h.tasks.get(link.googleTaskId).status, 'needsAction');
  } finally { h.close(); }
});

test('v2 Tasks timeout bounds its caller while a late HTTP result remains fenced and coalesced until it settles', async () => {
  const h = await setup(); let release; let started; const ready = new Promise(resolve => { started = resolve; });
  try {
    await h.connect(); const waiting = new Promise(resolve => { release = resolve; });
    h.hooks.beforeRead = async () => { started(); await waiting; };
    const first = h.runtime.synchronize({ force: true, budgetMs: 1000 }); await ready;
    const joined = h.runtime.synchronize({ budgetMs: 20 }); assert.equal(first, joined);
    assert.deepEqual(await first, { kind: 'retry', code: 'timeout' }); assert.equal(h.context().budget.signal.aborted, true);
    assert.equal(h.runtime.synchronize(), first, 'late requests do not open a second sync beside an unsettled operation');
    release(); for (let i = 0; i < 20; i++) await turn(); assert.equal(h.tasks.size, 0); assert.equal((await h.store.readControl()).state.status, 'retryPending');
  } finally { release?.(); h.close(); }
});

test('v2 manual Tasks sync waits for an expired automatic pass to settle then uses its own remaining budget', async () => {
  const h = await googleFixture(); let release; let entered; let preparations = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('no interactive account selection'); },
    authorizeTasks: async () => { throw new Error('no interactive consent'); }, createApi: () => h.api,
    preparePlan: async () => { if (++preparations === 1) { entered(); await waiting; } } });
  let automatic; let manual;
  try {
    await h.connect(); automatic = runtime.synchronize({ budgetMs: 40 }); await ready;
    manual = runtime.synchronize({ force: true, budgetMs: 1_000 });
    assert.deepEqual(await automatic, { kind: 'retry', code: 'timeout' });
    assert.equal(h.tasks.size, 0, 'a new attempt cannot run beside unfinished input preparation');
    release();
    const result = await manual;
    assert.equal(result.kind, 'success'); assert.equal(result.created, 3);
    assert.equal(preparations, 2);
  } finally { release?.(); await automatic?.catch(() => undefined); await manual?.catch(() => undefined);
    await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('an ordinary automatic Tasks observer cannot shorten a foreground manual budget', async () => {
  const h = await googleFixture(); let elapsed = 0; let release; let entered;
  const ready = new Promise(resolve => { entered = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, budgetNow: () => elapsed, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('no interactive account selection'); },
    authorizeTasks: async () => { throw new Error('no interactive consent'); }, createApi: () => h.api,
    preparePlan: async () => { entered(); await waiting; } });
  let manual;
  try {
    await h.connect(); manual = runtime.synchronize({ force: true }); await ready;
    assert.equal(runtime.synchronize(), manual);
    elapsed = 20_000; release();
    const result = await manual;
    assert.equal(result.kind, 'success'); assert.equal(result.created, 3);
  } finally { release?.(); await manual?.catch(() => undefined); await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('an expired manual Tasks recovery cannot launch work when older preparation finally returns', async () => {
  const h = await googleFixture(); let release; let entered; let preparations = 0;
  const ready = new Promise(resolve => { entered = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('no interactive account selection'); },
    authorizeTasks: async () => { throw new Error('no interactive consent'); }, createApi: () => h.api,
    preparePlan: async () => { preparations++; entered(); await waiting; } });
  let automatic; let manual;
  try {
    await h.connect(); automatic = runtime.synchronize({ budgetMs: 30 }); await ready;
    manual = runtime.synchronize({ force: true, budgetMs: 70 });
    assert.deepEqual(await manual, { kind: 'retry', code: 'timeout' });
    release(); await withGoogleSyncOperation(async () => {}); await turn();
    assert.equal(preparations, 1); assert.equal(h.tasks.size, 0);
  } finally { release?.(); await automatic?.catch(() => undefined); await manual?.catch(() => undefined);
    await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('pausing shared Tasks cancels a queued manual recovery without starting another synchronization', async () => {
  const h = await googleFixture(); let release; let entered; let preparations = 0;
  const ready = new Promise(resolve => { entered = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('no interactive account selection'); },
    authorizeTasks: async () => { throw new Error('no interactive consent'); }, createApi: () => h.api,
    preparePlan: async () => { preparations++; entered(); await waiting; } });
  let automatic; let manual; let pause;
  try {
    await h.connect(); automatic = runtime.synchronize({ budgetMs: 30 }); await ready;
    manual = runtime.synchronize({ force: true, budgetMs: 1_000 }); await automatic;
    pause = runtime.pause((await runtime.readControl()).revision);
    assert.deepEqual(await manual, { kind: 'retry', code: 'timeout' });
    release(); await pause;
    assert.equal(preparations, 1); assert.equal(h.tasks.size, 0); assert.equal((await runtime.readControl()).state.enabled, false);
  } finally { release?.(); await automatic?.catch(() => undefined); await manual?.catch(() => undefined); await pause?.catch(() => undefined);
    await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('manual Tasks can recover an already expired manual pass without inheriting its old timeout', async () => {
  const h = await googleFixture(); let release; let entered; let preparations = 0;
  const ready = new Promise(resolve => { entered = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('no interactive account selection'); },
    authorizeTasks: async () => { throw new Error('no interactive consent'); }, createApi: () => h.api,
    preparePlan: async () => { if (++preparations === 1) { entered(); await waiting; } } });
  let first; let retry;
  try {
    await h.connect(); first = runtime.synchronize({ force: true, budgetMs: 30 }); await ready; await first;
    retry = runtime.synchronize({ force: true, budgetMs: 1_000 }); release();
    assert.equal((await retry).kind, 'success'); assert.equal(h.tasks.size, 3);
  } finally { release?.(); await first?.catch(() => undefined); await retry?.catch(() => undefined);
    await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('an explicit shorter deadline also constrains a coalesced manual Tasks recovery', async () => {
  const h = await googleFixture(); let release; let entered;
  const ready = new Promise(resolve => { entered = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
    restoreAccount: async () => { throw new Error('no interactive account selection'); },
    authorizeTasks: async () => { throw new Error('no interactive consent'); }, createApi: () => h.api,
    preparePlan: async () => { entered(); await waiting; } });
  let first; let manual;
  try {
    await h.connect(); first = runtime.synchronize({ budgetMs: 100 }); await ready;
    manual = runtime.synchronize({ force: true, budgetMs: 1_000 });
    assert.equal(runtime.synchronize({ force: true, budgetMs: 10 }), manual);
    const result = await Promise.race([manual, new Promise(resolve => setTimeout(() => resolve('missed-deadline'), 150))]);
    assert.deepEqual(result, { kind: 'retry', code: 'timeout' });
    release(); await first; assert.equal(h.tasks.size, 0);
  } finally { release?.(); await first?.catch(() => undefined); await manual?.catch(() => undefined);
    await withGoogleSyncOperation(async () => {}); h.close(); }
});

test('v2 Tasks pause stops an in-flight budget, keeps mappings, and never signs out another Google workspace', async () => {
  const h = await setup(); let release; let started; const ready = new Promise(resolve => { started = resolve; });
  try {
    await h.connect(); await h.runtime.synchronize({ force: true }); const links = await h.links();
    const waiting = new Promise(resolve => { release = resolve; }); h.hooks.beforeRead = async () => { started(); await waiting; };
    const work = h.runtime.synchronize({ force: true }); await ready; const control = await h.store.readControl(); const stop = h.runtime.pause(control.revision, true);
    assert.equal(h.context().budget.signal.aborted, true); release(); await work; await stop;
    const after = await h.store.readControl(); assert.equal(after.state.enabled, false); assert.equal(after.state.disconnected, true);
    assert.deepEqual(await h.links(), links); assert.equal(h.nativeCalls.some(call => call.includes('sign-out')), false);
    assert.deepEqual(await h.runtime.synchronize(), { kind: 'success', skipped: true });
  } finally { release?.(); h.close(); }
});

test('v2 Tasks uses the shared region day for its fourteen-day window when the device day differs', async () => {
  const prior = process.env.TZ; process.env.TZ = 'UTC';
  const clock = () => new Date('2026-10-26T16:00:00.000Z');
  const h = await googleFixture({ clock });
  try {
    await h.connect();
    const runtime = createV2GoogleTaskRuntime({ store: h.store, now: clock, assertAccess: h.scope.assertAccess,
      currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
      restoreAccount: async () => { throw new Error('No interactive OAuth in automatic sync'); },
      authorizeTasks: async () => { throw new Error('No interactive OAuth in automatic sync'); }, createApi: () => h.api });
    const result = await runtime.synchronize({ force: true });
    assert.equal(result.kind, 'success'); assert.equal(result.created, 3);
    assert.ok([...h.tasks.values()].some(task => task.due.startsWith('2026-11-10')));
  } finally { h.close(); if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});

test('v2 Tasks native identity deadlines release synchronization and fence late replies', async t => {
for (const nativeRead of [1, 2, 3, 4]) await t.test(`readonly native identity read ${nativeRead}`, async () => {
  const h = await googleFixture(); let release; let entered; let hang = true; let calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const native = new Promise(resolve => { release = resolve; });
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    currentSubject: async () => { if (hang && ++calls === nativeRead) { entered(); return native; } return 'synthetic-google-subject'; },
    restoreAccount: async () => { throw new Error('automatic sync must not request account selection'); },
    authorizeTasks: async () => { throw new Error('automatic sync must not request consent'); },
    token: async () => 'synthetic-token', createApi: () => h.api });
  let first;
  try {
    await h.connect(); first = runtime.synchronize({ force: true, budgetMs: 100 }); await ready;
    assert.deepEqual(await first, { kind: 'retry', code: 'timeout' });
    for (let i = 0; i < 30; i++) await turn();
    hang = false;
    const recovered = runtime.synchronize({ force: true, budgetMs: 1_000 });
    assert.notEqual(recovered, first, 'a readonly native promise must not retain the shared synchronization lock after its deadline');
    const result = await recovered;
    assert.equal(result.kind, 'success'); assert.equal(result.created, 3);
    const links = await h.links(); const control = await h.store.readControl();
    release('late-foreign-google-subject');
    for (let i = 0; i < 30; i++) await turn();
    assert.deepEqual(await h.links(), links); assert.deepEqual(await h.store.readControl(), control);
    assert.equal(h.tasks.size, 3, 'late native identity must not create or import another task');
  } finally {
    release?.('synthetic-google-subject');
    await first?.catch(() => undefined);
    await withGoogleSyncOperation(async () => {});
    h.close();
  }
});
});
