import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';
const { createGoogleOperationBudget, withinGoogleOperationBudget } = await import('../src/features/google-sync/operation-budget.ts');
const { createGoogleTasksApi } = await import('../src/platform/google-tasks/google-tasks-api.ts');
const { createCalendarFreeBusyClient } = await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');
const { refreshCalendarWithDependencies } = await import('../src/features/google-sync/calendar-coordinator.ts');
const { syncGoogleTasksWithDependencies } = await import('../src/features/google-sync/coordinator.ts');
const { withGoogleSyncOperation } = await import('../src/features/google-sync/operation-lock.ts');
const { createV2GoogleTaskRuntime } = await import('../src/features/sharing/v2/google-tasks-runtime.ts');

const flush = () => new Promise(resolve => setImmediate(resolve));
const now = new Date('2026-11-05T01:00:00Z');
const range = { from: '2026-11-05', through: '2026-11-06', timeZone: 'Asia/Tokyo',
  timeMin: '2026-11-04T15:00:00Z', timeMax: '2026-11-06T15:00:00Z' };

test('an expired queued v2 Tasks run never resumes private preparation or authorization after another Google operation ends', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let unblock; let controls = 0; let preparations = 0; let tokens = 0;
  const preceding = withGoogleSyncOperation(() => new Promise(resolve => { unblock = resolve; })); await flush();
  const runtime = createV2GoogleTaskRuntime({ store: { port: {}, readControl: async () => { controls++;
    return { revision: 1, state: { enabled: true, disconnected: false, accountSubject: 'subject' } }; } },
    assertAccess: () => {}, currentSubject: async () => 'subject', restoreAccount: async () => ({ subject: 'subject', label: 'test' }),
    authorizeTasks: async () => { throw new Error('must not authorize'); }, token: async () => { tokens++; return 'synthetic'; },
    preparePlan: async () => { preparations++; }, createApi: () => ({}), now: () => now });
  const pending = runtime.synchronize({ force: true, budgetMs: 1000 }); await flush(); context.mock.timers.tick(1000);
  assert.deepEqual(await pending, { kind: 'retry', code: 'timeout' }); unblock(); await preceding; await flush();
  assert.equal(controls, 0); assert.equal(preparations, 0); assert.equal(tokens, 0);
});

test('all Tasks pages share one caller budget and a late fetch cannot read a body or start another page', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createGoogleOperationBudget(15_000);
  let first; let second; let requests = 0; let bodyReads = 0;
  const api = createGoogleTasksApi(async () => {
    requests++;
    return new Promise(resolve => { if (requests === 1) first = resolve; else second = resolve; });
  }, undefined, { budget });
  try {
    const call = api.listTasks('token', 'list');
    const rejection = assert.rejects(call, error => error.name === 'AbortError' && error.code === 'timeout' && !error.requestNotSent);
    context.mock.timers.tick(9_000);
    first(Response.json({ items: [{ id: 'first' }], nextPageToken: 'next' })); await flush();
    assert.equal(requests, 2);
    context.mock.timers.tick(6_000); await rejection;
    second({ ok: true, status: 200, json: async () => { bodyReads++; return { nextPageToken: 'third' }; } });
    await flush(); assert.equal(bodyReads, 0); assert.equal(requests, 2);
  } finally { budget.close(); }
});

for (const kind of ['success', 'error', 'multipart']) test(`the total Tasks budget also bounds an ignored ${kind} body deadline`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createGoogleOperationBudget(1_000);
  const api = createGoogleTasksApi(async () => ({ ok: kind !== 'error', status: kind === 'error' ? 503 : 200,
    headers: new Headers({ 'Content-Type': 'multipart/mixed; boundary=stalled' }),
    json: () => new Promise(() => {}), text: () => new Promise(() => {}) }), undefined, { budget });
  try {
    const call = kind === 'multipart' ? api.createTasksBatch('token', 'list', [{ title: '掃除', due: '2026-11-05T00:00:00Z' }])
      : api.listTaskLists('token');
    const rejection = assert.rejects(call, error => error.name === 'AbortError');
    await flush(); context.mock.timers.tick(1_000); await rejection;
  } finally { budget.close(); }
});

test('an expired queued Google sync returns on time and never starts OAuth or changes persisted state later', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let unblock; let reads = 0;
  const preceding = withGoogleSyncOperation(() => new Promise(resolve => { unblock = resolve; }));
  await flush();
  const budget = createGoogleOperationBudget(1_000);
  try {
    const result = syncGoogleTasksWithDependencies({ budget, loadState: async () => { reads++; throw new Error('must not read'); } }, { now, force: true });
    context.mock.timers.tick(1_000); assert.deepEqual(await result, { kind: 'retry', code: 'timeout' });
    unblock(); await preceding; await flush(); assert.equal(reads, 0);
  } finally { budget.close(); unblock?.(); }
});

test('a credential operation that ignores cancellation cannot continue Tasks work after its budget expires', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createGoogleOperationBudget(1_000); let token; let requests = 0; const states = [];
  const dependencies = { budget, loadState: async () => ({ enabled: true, status: 'idle', retryCount: 0 }),
    saveState: async state => { states.push(state.status); },
    getAccessToken: () => withinGoogleOperationBudget(budget, () => new Promise(resolve => { token = resolve; })),
    api: createGoogleTasksApi(async () => { requests++; throw new Error('must not send'); }, undefined, { budget }) };
  try {
    const run = syncGoogleTasksWithDependencies(dependencies, { now, force: true });
    await flush(); context.mock.timers.tick(1_000); assert.deepEqual(await run, { kind: 'retry', code: 'timeout' });
    await flush(); token('late-token'); await flush();
    assert.equal(requests, 0); assert.deepEqual(states, ['syncing', 'retryPending']);
  } finally { budget.close(); }
});

for (const blocked of ['credentials', 'FreeBusy']) test(`an expired Calendar ${blocked} wait cannot commit late coverage or regenerate a plan`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createGoogleOperationBudget(1_000); let resolve; let commits = 0; let planning = 0; const states = [];
  const stall = () => new Promise(done => { resolve = done; });
  try {
    const run = refreshCalendarWithDependencies({
      loadState: async () => ({ enabled: true, status: 'idle', retryCount: 0 }), saveState: async value => states.push(value.status),
      getAccessToken: blocked === 'credentials' ? stall : async () => 'token',
      client: { query: blocked === 'FreeBusy' ? stall : async () => [] },
      commitSuccess: async () => { commits++; },
      readPlanningSignatures: async () => { planning++; return { current: 'new', applied: 'old' }; },
      regeneratePlanner: async () => { planning++; return true; },
    }, { now, range, force: true, budget });
    await flush(); context.mock.timers.tick(1_000);
    assert.deepEqual(await run, { kind: 'retryPending', plannerChanged: false });
    resolve(blocked === 'credentials' ? 'late-token' : []); await flush();
    assert.equal(commits, 0); assert.equal(planning, 0); assert.deepEqual(states, ['syncing', 'retryPending']);
  } finally { budget.close(); }
});

for (const blocked of ['fetch', 'body']) test(`FreeBusy stops even when its native ${blocked} ignores abort`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let finish; let bodyReads = 0; let requests = 0;
  const response = { ok: true, status: 200, headers: new Headers(), json: () => {
    bodyReads++; return blocked === 'body' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ calendars: { primary: { busy: [] } } });
  } };
  const client = createCalendarFreeBusyClient(async () => {
    requests++; return blocked === 'fetch' ? new Promise(resolve => { finish = resolve; }) : response;
  });
  const run = client.query('token', range, { timeoutMs: 1_000 });
  const rejection = assert.rejects(run, error => error.code === 'calendar_timeout');
  await flush(); context.mock.timers.tick(1_000); await rejection;
  finish(blocked === 'fetch' ? response : { calendars: { primary: { busy: [] } } }); await flush();
  assert.equal(requests, 1); assert.equal(bodyReads, blocked === 'fetch' ? 0 : 1);
});
