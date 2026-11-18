import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemandWorker } from '../src/features/google-sync/demand-worker.ts';

const flush = () => new Promise(setImmediate);

test('settled synchronization makes no idle requests and only a new signal can start another pass', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  const worker = createDemandWorker({ active: () => true, run: async () => { calls++; return false; } });
  try {
    worker.request(); await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(86_400_000); await flush(); assert.equal(calls, 1);
    worker.request(); await flush(); assert.equal(calls, 2);
    t.mock.timers.tick(86_400_000); await flush(); assert.equal(calls, 2);
  } finally { worker.stop(); }
});

test('unfinished synchronization retries with backoff while settled work stops all retry traffic', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  const worker = createDemandWorker({ active: () => true, run: async () => { calls++; if (calls === 1) throw new Error('offline'); return calls === 2; } });
  try {
    worker.request(); await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(29_999); await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
    t.mock.timers.tick(59_999); await flush(); assert.equal(calls, 2);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, 3);
    t.mock.timers.tick(86_400_000); await flush(); assert.equal(calls, 3);
  } finally { worker.stop(); }
});

test('synchronization honors an existing provider retry deadline instead of checking it every fixed interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const schedule = globalThis.setTimeout;
  const maximumDelay = 2_147_483_647;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => schedule(callback, delay > maximumDelay ? 1 : delay));
  for (const duration of [3_600_000, 32 * 86_400_000]) {
    let calls = 0;
    const retryAt = Date.now() + duration;
    const worker = createDemandWorker({ active: () => true, run: async () => ++calls === 1 ? { retryAt } : false });
    try {
      worker.request(); await flush();
      if (duration > maximumDelay) {
        t.mock.timers.tick(maximumDelay); await flush();
        assert.equal(calls, 1, 'a far future deadline cannot overflow into an immediate sync');
      }
      t.mock.timers.tick(retryAt - Date.now() - 1); await flush(); assert.equal(calls, 1);
      t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
    } finally { worker.stop(); }
  }
});

test('concurrent synchronization signals coalesce without losing a change that arrived during a pass', async () => {
  let finish; let calls = 0;
  const worker = createDemandWorker({ active: () => true, run: async () => { calls++; if (calls === 1) await new Promise(resolve => { finish = resolve; }); return false; } });
  try {
    worker.request(); worker.request(); worker.request(); assert.equal(calls, 1);
    finish(); await flush(); assert.equal(calls, 2);
    await flush(); assert.equal(calls, 2);
  } finally { worker.stop(); }
});

test('backgrounding and stopping synchronization prevent late retries and old-account signals from making requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let active = true; let calls = 0;
  const worker = createDemandWorker({ active: () => active, run: async () => { calls++; return true; } });
  worker.request(); await flush(); active = false;
  t.mock.timers.tick(60_000); worker.request(); await flush(); assert.equal(calls, 1);
  active = true; worker.request(); await flush(); assert.equal(calls, 2);
  worker.stop(); t.mock.timers.tick(86_400_000); worker.request(); await flush(); assert.equal(calls, 2);
});
