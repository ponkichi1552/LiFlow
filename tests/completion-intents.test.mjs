import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionIntents } from '../src/features/planner/completion-intents.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(options = {}) {
  let saved = structuredClone(options.saved ?? []), ordinal = 0, current = true, reads = 0;
  const applied = [], writes = [];
  const queue = createCompletionIntents({
    store: { load: options.load ?? (async () => structuredClone(saved)), save: options.save ?? (async rows => { saved = structuredClone(rows); writes.push(structuredClone(rows)); }) },
    capture: value => { if (!value || typeof value.chore !== 'string') throw new Error('invalid target'); return { chore: value.chore }; },
    makeId: () => `intent-${++ordinal}`, now: () => new Date('2026-11-02T04:00:00Z'), isCurrent: () => current,
    apply: options.apply ?? (async value => { applied.push(structuredClone(value)); }),
    refresh: options.refresh ?? (async () => { reads++; }),
  });
  return { queue, applied, writes, saved: () => saved, reads: () => reads, current: value => { current = value; } };
}

test('completion intents immediately show the last gesture while persistence and a previous write are blocked', async () => {
  const blocked = deferred(); const calls = []; let first = true;
  const h = fixture({ apply: async item => { calls.push(item); if (first) { first = false; await blocked.promise; } } });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); await tick();
  assert.equal(calls.length, 1);
  h.queue.request('bath', { chore: 'bath' }, false);
  assert.equal(h.queue.getSnapshot().values.get('bath'), false, 'no wait for the previous completion or a model read');
  h.queue.request('bath', { chore: 'bath' }, true); h.queue.request('floor', { chore: 'floor' }, true);
  assert.equal(h.queue.getSnapshot().values.get('bath'), true); assert.equal(h.queue.getSnapshot().values.get('floor'), true);
  blocked.resolve(); await tick(); await h.queue.settled();
  assert.deepEqual(calls.map(item => [item.key, item.completed]), [['bath', true], ['bath', true], ['floor', true]]);
  assert.equal(calls[1].id, 'intent-3', 'the intermediate undo was superseded before execution');
  assert.equal(h.queue.getSnapshot().pending.size, 0); assert.deepEqual(h.saved(), []);
});

test('completion intents never execute before the latest request is durably stored', async () => {
  const blocked = deferred(); const calls = []; const saved = [];
  const h = fixture({ save: async rows => { await blocked.promise; saved.push(structuredClone(rows)); }, apply: async item => { calls.push(item); } });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true);
  assert.equal(h.queue.getSnapshot().values.get('bath'), true);
  await tick(); assert.equal(calls.length, 0);
  h.queue.request('bath', { chore: 'bath' }, false); blocked.resolve(); await tick(); await h.queue.settled();
  assert.deepEqual(calls.map(item => item.completed), [false]); assert.ok(saved.length > 0);
});

test('completion intents retain the latest check during stale presentation reads and settle only after a fresh read', async () => {
  const blocked = deferred(); const h = fixture({ refresh: () => blocked.promise });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); await tick();
  assert.equal(h.queue.getSnapshot().values.get('bath'), true); assert.equal(h.saved()[0].status, 'committed');
  h.queue.request('bath', { chore: 'bath' }, false); await tick();
  assert.equal(h.queue.getSnapshot().values.get('bath'), false);
  blocked.resolve(); await tick(); await h.queue.settled();
  assert.equal(h.applied.at(-1).completed, false); assert.equal(h.queue.getSnapshot().pending.size, 0);
});

test('completion intents recover queued and committed requests after restart without fabricating successful history', async () => {
  const rows = [
    { id: 'saved-a', key: 'bath', target: { chore: 'bath' }, completed: true, createdAt: '2026-11-02T02:00:00Z', status: 'queued' },
    { id: 'saved-b', key: 'floor', target: { chore: 'floor' }, completed: false, createdAt: '2026-11-02T02:00:01Z', status: 'committed' },
  ];
  const h = fixture({ saved: rows }); await h.queue.activate(); await tick(); await h.queue.settled();
  assert.deepEqual(h.applied.map(item => item.id), ['saved-a']); assert.ok(h.reads() > 0); assert.deepEqual(h.saved(), []);
});

test('completion intents keep a successful write when the presentation refresh fails and retry only that read', async () => {
  let fail = true; const h = fixture({ refresh: async () => { if (fail) throw new Error('read failed'); } });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); await tick(); await h.queue.settled();
  assert.equal(h.applied.length, 1); assert.equal(h.queue.getSnapshot().values.get('bath'), true);
  assert.equal(h.saved()[0].status, 'committed'); assert.match(h.queue.getSnapshot().error, /保存済み/);
  fail = false; h.queue.retryRead(); await tick(); await h.queue.settled();
  assert.equal(h.applied.length, 1); assert.equal(h.queue.getSnapshot().pending.size, 0);
});

test('completion intents preserve authority failures as failed requests and do not block independent chores', async () => {
  const calls = []; const h = fixture({ apply: async item => { calls.push(item.key); if (item.key === 'bath') throw new Error('not authorized'); } });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); h.queue.request('floor', { chore: 'floor' }, true);
  await tick(); await h.queue.settled();
  assert.deepEqual(calls, ['bath', 'floor']); assert.equal(h.queue.getSnapshot().values.has('bath'), false);
  assert.equal(h.saved().find(item => item.key === 'bath').status, 'failed');
});

test('completion intents never execute for a different current account or workspace', async () => {
  const h = fixture(); await h.queue.activate(); h.current(false); h.queue.request('bath', { chore: 'bath' }, true);
  await tick(); assert.equal(h.applied.length, 0); assert.equal(h.queue.getSnapshot().values.size, 0);
});

test('completion intents merge restoration with a newer gesture without restoring an obsolete state', async () => {
  const blocked = deferred(); const h = fixture({ load: () => blocked.promise });
  const loading = h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, false);
  blocked.resolve([{ id: 'older', key: 'bath', target: { chore: 'bath' }, completed: true, createdAt: '2026-11-01T04:00:00Z', status: 'queued' }]);
  await loading; await tick(); await h.queue.settled(); assert.deepEqual(h.applied.map(item => item.completed), [false]);
});

test('completion intents validate the complete restored batch before accepting any request', async () => {
  const rows = [{ id: 'a', key: 'bath', target: { chore: 'bath' }, completed: true, createdAt: '2026-11-01T04:00:00Z', status: 'queued' },
    { id: 'b', key: 'floor', target: { chore: 17 }, completed: true, createdAt: '2026-11-01T04:00:00Z', status: 'queued' }];
  const h = fixture({ saved: rows }); await h.queue.activate(); await tick();
  assert.equal(h.applied.length, 0); assert.equal(h.queue.getSnapshot().restored, false); assert.equal(h.queue.getSnapshot().values.size, 0);
});

test('completion intents retry a temporarily unavailable protected store before accepting new writes', async () => {
  let reads = 0; const h = fixture({ load: async () => { if (++reads === 1) throw new Error('temporarily unavailable'); return []; } });
  await h.queue.activate(); assert.equal(h.queue.getSnapshot().restored, false);
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); await tick(); await h.queue.settled();
  assert.equal(h.applied.length, 1); assert.equal(reads, 2);
});

test('completion intents never roll back successful history when saving its acknowledgement fails', async () => {
  const blocked = deferred(); let saves = 0;
  const h = fixture({ save: async () => { if (++saves > 1) throw new Error('acknowledgement storage failed'); }, refresh: () => blocked.promise });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); await tick();
  assert.equal(h.applied.length, 1); assert.equal(h.queue.getSnapshot().values.get('bath'), true);
  assert.match(h.queue.getSnapshot().error, /保存済み/);
  blocked.resolve(); await tick(); await h.queue.settled(); assert.equal(h.applied.length, 1);
});

test('a burst of pending completion gestures coalesces protected storage writes as well as business writes', async () => {
  const blocked = deferred(); let saves = 0; const calls = [];
  const h = fixture({ save: async () => { saves++; if (saves === 1) await blocked.promise; }, apply: async item => { calls.push(item); } });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); await tick();
  for (let index = 0; index < 100; index++) h.queue.request('bath', { chore: 'bath' }, index % 2 === 0);
  assert.equal(h.queue.getSnapshot().values.get('bath'), false); blocked.resolve(); await tick(); await h.queue.settled();
  assert.deepEqual(calls.map(item => item.completed), [false]);
  assert.ok(saves <= 4, 'the latest request is saved once instead of rewriting 100 identical manifests');
});

test('committed completion requests remain quiet and recoverable when no visible screen needs a refresh', async () => {
  let visible = false; const h = fixture({ refresh: async () => visible ? undefined : false });
  await h.queue.activate(); h.queue.request('bath', { chore: 'bath' }, true); await tick(); await h.queue.settled();
  assert.equal(h.queue.getSnapshot().error, null); assert.equal(h.queue.getSnapshot().values.get('bath'), true);
  visible = true; h.queue.retryRead(); await tick(); await h.queue.settled(); assert.equal(h.queue.getSnapshot().pending.size, 0);
});
