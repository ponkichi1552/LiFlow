import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialDisplayGate } from '../src/features/planner/initial-display-gate.ts';
import { createWorkspaceDisplayStore } from '../src/features/sharing/v2-ui/workspace-display-store.ts';

// A group binding is an object owned by the current authenticated session, not a saved group ID.
test('automatic startup work waits for the same local display attempt while resume does not wait again', async () => {
  const gate = createInitialDisplayGate(); const workspace = {}; let ran = false;
  const first = gate.wait(workspace); const work = first.promise.then(ready => { ran = ready; });
  await Promise.resolve(); assert.equal(ran, false);
  gate.complete(workspace); await work; assert.equal(ran, true);
  assert.equal(await gate.wait(workspace).promise, true);
});
test('backgrounding or changing workspace cancels pending startup work and an old display cannot release a new account', async () => {
  const gate = createInitialDisplayGate(); const previous = {}, next = {};
  const old = gate.wait(previous); const current = gate.wait(next); old.cancel();
  assert.equal(await old.promise, false); gate.complete(previous);
  let finished = false; current.promise.then(() => { finished = true; }); await Promise.resolve(); assert.equal(finished, false);
  current.cancel(); assert.equal(await current.promise, false);
});
test('the home does not wait for an idle calendar prefetch and prepared months remain reusable', async () => {
  const options = []; let release;
  const clock = () => new Date('2026-10-31T10:00:00Z');
  const model = { plan: { range: { asOfDate: '2026-10-31' }, timeZone: 'Asia/Tokyo' } };
  const store = createWorkspaceDisplayStore(async () => ({ readModel: async value => {
    options.push(value); if (value.calendarMonth) await new Promise(resolve => { release = resolve; }); return model;
  } }), clock);
  const home = await store.read(); assert.equal(options[0].calendarMonth, undefined);
  const calendar = store.read({ calendarMonth: 'current' });
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve(); assert.equal(typeof release, 'function');
  assert.equal((await store.read({ waste: true })).model, home.model);
  release(); await calendar; await store.read({ calendarMonth: 'current' }); assert.equal(options.length, 2);
});
