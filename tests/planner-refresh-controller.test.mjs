import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlannerRefreshController } from '../src/features/planner/refresh-controller.ts';
import { AdaptiveOwnerInputsChangedError } from '../src/platform/storage/adaptive-owner-inputs.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const retryOwnerDrift = error => error instanceof AdaptiveOwnerInputsChangedError;

test('a captured owner-input change retries one local read without an error flash or duplicate weather and native output', async () => {
  const retry = deferred(); const calls = [], published = [], states = []; let ready = false, weatherReads = 0;
  const controller = createPlannerRefreshController({
    load: async (ids, force) => {
      calls.push({ ids, force });
      if (calls.length === 1) throw new AdaptiveOwnerInputsChangedError();
      return { snapshot: await retry.promise, canPublishWidget: true };
    },
    retryLoadOnError: retryOwnerDrift,
    weather: async () => { weatherReads++; return null; }, publish: snapshot => published.push(snapshot),
  });
  controller.subscribe(() => states.push(controller.getSnapshot()));
  void controller.waitForInitialRead().then(() => { ready = true; });
  const pending = controller.refresh({ widgetCompletionIds: ['durable-action'], force: true });
  await new Promise(setImmediate);
  assert.equal(ready, false); assert.deepEqual(states, []); assert.equal(weatherReads, 0);
  assert.deepEqual(calls, [ { ids: ['durable-action'], force: true }, { ids: ['durable-action'], force: true } ]);
  retry.resolve('current settings'); await pending;
  assert.equal(ready, true); assert.deepEqual(published, ['current settings']); assert.equal(weatherReads, 1);
  assert.equal(controller.getSnapshot().error, null); assert.equal(states.length, 1);
});

test('persistent owner-input drift retries only once and retains an existing usable snapshot', async () => {
  let calls = 0, fail = false; const published = [];
  const controller = createPlannerRefreshController({
    load: async () => { calls++; if (fail) throw new AdaptiveOwnerInputsChangedError(); return { snapshot: 'saved', canPublishWidget: true }; },
    retryLoadOnError: retryOwnerDrift, weather: async () => null, publish: snapshot => published.push(snapshot),
  });
  await controller.refresh(); fail = true; await controller.refresh();
  assert.equal(calls, 3); assert.deepEqual(published, ['saved']);
  assert.equal(controller.getSnapshot().snapshot, 'saved');
  assert.equal(controller.getSnapshot().error, new AdaptiveOwnerInputsChangedError().message);
});

test('owner-read recovery never retries access revocation or an untyped error and still discards revoked content', async () => {
  for (const error of [Object.assign(new Error('access revoked'), { code: 'sharing/access-denied' }),
    new Error(new AdaptiveOwnerInputsChangedError().message)]) {
    let calls = 0, fail = false;
    const controller = createPlannerRefreshController({
      load: async () => { calls++; if (fail) throw error; return { snapshot: 'saved', canPublishWidget: false }; },
      retryLoadOnError: retryOwnerDrift, discardSnapshotOnError: value => value.code === 'sharing/access-denied',
      weather: async () => null, publish() {},
    });
    await controller.refresh(); fail = true; await controller.refresh();
    assert.equal(calls, 2); assert.equal(controller.getSnapshot().error, error.message);
    assert.equal(controller.getSnapshot().snapshot, error.code ? null : 'saved');
  }
});

test('a superseding refresh or invalidation cancels owner-read recovery and never publishes the obsolete attempt', async () => {
  for (const phase of ['superseded-before-retry', 'invalidated-before-retry', 'invalidated-during-retry']) {
    const first = deferred(), retry = deferred(); const calls = [], published = []; let weatherReads = 0;
    const controller = createPlannerRefreshController({
      load: async ids => {
        calls.push(ids);
        if (calls.length === 1) { await first.promise; throw new AdaptiveOwnerInputsChangedError(); }
        if (phase === 'invalidated-during-retry') await retry.promise;
        return { snapshot: 'current', canPublishWidget: false };
      },
      retryLoadOnError: retryOwnerDrift, weather: async () => { weatherReads++; return null; }, publish: snapshot => published.push(snapshot),
    });
    const pending = controller.refresh({ widgetCompletionIds: ['old'] }); await Promise.resolve();
    if (phase === 'superseded-before-retry') void controller.refresh({ widgetCompletionIds: ['new'] });
    if (phase === 'invalidated-before-retry') controller.invalidate();
    first.resolve(); await new Promise(setImmediate);
    if (phase === 'invalidated-during-retry') { controller.invalidate(); retry.resolve(); }
    await pending;
    assert.deepEqual(calls, phase === 'superseded-before-retry' ? [['old'], ['new']]
      : phase === 'invalidated-before-retry' ? [['old']] : [['old'], ['old']]);
    assert.deepEqual(published, phase === 'superseded-before-retry' ? ['current'] : []);
    assert.equal(weatherReads, phase === 'superseded-before-retry' ? 1 : 0);
    assert.equal(controller.getSnapshot().error, null);
  }
});

test('foreground observers wait for the existing first local read without starting or duplicating it', async () => {
  const read = deferred(); let loads = 0; let ready = false;
  const controller = createPlannerRefreshController({ load: async () => { loads++; return { snapshot: await read.promise, canPublishWidget: false }; },
    weather: async () => null, publish() {} });
  void controller.waitForInitialRead().then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false); assert.equal(loads, 0);
  const pending = controller.refresh(); await Promise.resolve(); assert.equal(ready, false); assert.equal(loads, 1);
  read.resolve('local content'); await pending; assert.equal(ready, true); assert.equal(loads, 1);
  await controller.waitForInitialRead(); assert.equal(controller.getSnapshot().snapshot, 'local content');
});

test('a failed local attempt releases independent recovery while a cancelled stale read does not', async () => {
  const read = deferred(); let ready = false; let loads = 0;
  const controller = createPlannerRefreshController({ load: async () => { if (++loads === 1) await read.promise; throw new Error('local read failed'); },
    weather: async () => null, publish() {} });
  void controller.waitForInitialRead().then(() => { ready = true; });
  const pending = controller.refresh(); await Promise.resolve(); controller.invalidate(); read.resolve(); await pending;
  assert.equal(ready, false);
  await controller.refresh(); assert.equal(ready, true); assert.equal(controller.getSnapshot().error, 'local read failed');
});

test('concurrent refreshes share one load and merge widget actions', async () => {
  const calls = [], published = [];
  const controller = createPlannerRefreshController({
    load: async (ids, force) => { calls.push({ ids, force }); return { snapshot: { revision: 1 }, canPublishWidget: true }; },
    weather: async () => null, publish: (snapshot) => published.push(snapshot),
  });
  await Promise.all([controller.refresh({ widgetCompletionIds: ['one'] }),
    controller.refresh({ widgetCompletionIds: ['two'] }), controller.refresh()]);
  assert.deepEqual(calls, [{ ids: ['one', 'two'], force: true }]);
  assert.equal(published.length, 1);
  assert.equal(controller.getSnapshot().loading, false);
});

test('a mutation during load queues one new read and never publishes the stale result', async () => {
  const first = deferred(); let loads = 0; const published = [];
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot: ++loads === 1 ? await first.promise : 'new', canPublishWidget: true }),
    weather: async () => null, publish: (snapshot) => published.push(snapshot),
  });
  const earlier = controller.refresh();
  await Promise.resolve();
  const later = controller.refresh();
  first.resolve('old');
  await Promise.all([earlier, later]);
  assert.equal(loads, 2);
  assert.deepEqual(published, ['new']);
});

test('unchanged cached snapshots do not publish effects again; widget recovery still publishes', async () => {
  const snapshot = {}; let canPublishWidget = false; const published = [];
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot, canPublishWidget }), weather: async () => null,
    publish: (_snapshot, canPublish) => published.push(canPublish),
  });
  await controller.refresh(); await controller.refresh();
  assert.deepEqual(published, [false]);
  canPublishWidget = true;
  await controller.refresh();
  assert.deepEqual(published, [false, true]);
});

test('a late weather result cannot publish over a newer snapshot or after invalidation', async () => {
  const delayed = deferred(); const published = []; let generation = 0; let oldCanCommit;
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot: ++generation, canPublishWidget: true }),
    weather: async (_snapshot, canCommit) => { if (generation === 1) { oldCanCommit = canCommit; return delayed.promise; } return null; },
    publish: (snapshot) => published.push(snapshot),
  });
  await controller.refresh(); await controller.refresh();
  assert.equal(oldCanCommit(), false);
  delayed.resolve('stale weather');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(published, [1, 2]);
  controller.invalidate();
  assert.equal(oldCanCommit(), false);
});

test('a failed output update keeps the screen usable and retries for the same cached snapshot', async () => {
  const snapshot = {}; let attempts = 0;
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot, canPublishWidget: true }), weather: async () => null,
    publish: async () => { if (++attempts === 1) throw new Error('temporary output failure'); },
  });
  await controller.refresh();
  assert.equal(controller.getSnapshot().snapshot, snapshot);
  assert.equal(controller.getSnapshot().error, null);
  await controller.refresh();
  assert.equal(attempts, 2);
});

test('invalidation before a queued refresh starts prevents reads and native output publication', async () => {
  const reads = [], published = [];
  const controller = createPlannerRefreshController({
    load: async (ids) => { reads.push(ids); return { snapshot: 'departed group', canPublishWidget: true }; },
    weather: async () => null, publish: (snapshot) => published.push(snapshot),
  });
  const pending = controller.refresh({ widgetCompletionIds: ['old-action'] });
  controller.invalidate();
  await pending;
  assert.deepEqual(reads, [], 'an unmounted or backgrounded provider must not start its queued database read');
  assert.deepEqual(published, [], 'a departed group must not recreate its cancelled reminders');
});

test('invalidation discards both an in-flight result and an older queued refresh without losing the next resume', async () => {
  const first = deferred(); const reads = [], published = [];
  const controller = createPlannerRefreshController({
    load: async (ids) => {
      reads.push(ids);
      return { snapshot: reads.length === 1 ? await first.promise : 'resumed', canPublishWidget: true };
    },
    weather: async () => null, publish: (snapshot) => published.push(snapshot),
  });
  const running = controller.refresh({ widgetCompletionIds: ['in-flight'] });
  await Promise.resolve();
  const queued = controller.refresh({ widgetCompletionIds: ['before-background'] });
  controller.invalidate();
  first.resolve('stale');
  await Promise.all([running, queued]);
  assert.deepEqual(reads, [['in-flight']]);
  assert.deepEqual(published, []);
  await controller.refresh({ widgetCompletionIds: ['after-resume'], force: true });
  assert.deepEqual(reads, [['in-flight'], ['after-resume']]);
  assert.deepEqual(published, ['resumed']);
});

test('a fresh refresh immediately after invalidation runs with only the current workspace request', async () => {
  const reads = [], published = [];
  const controller = createPlannerRefreshController({
    load: async (ids) => { reads.push(ids); return { snapshot: 'current', canPublishWidget: true }; },
    weather: async () => null, publish: (snapshot) => published.push(snapshot),
  });
  const previous = controller.refresh({ widgetCompletionIds: ['obsolete'] });
  controller.invalidate();
  const current = controller.refresh({ widgetCompletionIds: ['current'] });
  await Promise.all([previous, current]);
  assert.deepEqual(reads, [['current']]);
  assert.deepEqual(published, ['current']);
});

test('invalidation from a snapshot subscriber stops native publication and weather without suppressing a later same-snapshot resume', async () => {
  const snapshot = {}; const published = []; let weatherReads = 0, first = true;
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot, canPublishWidget: true }),
    weather: async () => { weatherReads++; return null; },
    publish: (value) => published.push(value),
  });
  controller.subscribe(() => { if (first) { first = false; controller.invalidate(); } });
  await controller.refresh();
  assert.deepEqual(published, [], 'a synchronous unmount cannot be followed by old notification or widget output');
  assert.equal(weatherReads, 0);
  await controller.refresh();
  assert.deepEqual(published, [snapshot], 'skipping a cancelled output must not mark it as already published');
  assert.equal(weatherReads, 1);
});
