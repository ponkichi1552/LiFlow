import assert from 'node:assert/strict';
import test from 'node:test';
import { startSharedDeliveryWorker, sweepSharedDeliveries, sweepPrivateDeliveries } from '../server/appliance-care-api/src/sharing-delivery-worker.mjs';

function recoveryCleanupFixture(scope = 'sharingGroups/unit-sweep-group') {
  const records = new Map(), queries = [], deletes = new Map(); let clock = 1_800_000_000_000, batchNumber = 0, failBatch = 0;
  const ref = path => ({ path, id: path.split('/').at(-1), collection: name => query(`${path}/${name}`),
    async delete() { deletes.set(path, (deletes.get(path) ?? 0) + 1); records.delete(path); } });
  const snapshot = path => ({ id: path.split('/').at(-1), ref: ref(path), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  function query(path, order, maximum = Infinity, selected) {
    return { doc: id => ref(`${path}/${id}`), orderBy: field => query(path, field, maximum, selected),
      limit: count => query(path, order, count, selected), select: (...fields) => query(path, order, maximum, fields),
      async get() {
        const rows = [...records].filter(([name, value]) => name.startsWith(`${path}/`) && name.split('/').length === path.split('/').length + 1
          && (!order || order in value));
        rows.sort((a, b) => Number(a[1][order]) - Number(b[1][order]) || a[0].localeCompare(b[0]));
        const docs = rows.slice(0, maximum).map(([name]) => snapshot(name));
        queries.push({ path, returned: docs.length }); return { docs };
      } };
  }
  const firestore = { collection: path => query(path),
    runTransaction: async work => work({ getAll: async (...refs) => refs.map(target => snapshot(target.path)),
      get: target => target.get ? target.get() : snapshot(target.path), update() { assert.fail('an inactive synthetic policy cannot be updated'); } }),
    batch() { const targets = []; return { delete: target => targets.push(target), async commit() {
      if (++batchNumber === failBatch) { failBatch = 0; throw new Error('synthetic interrupted erasure'); }
      for (const target of targets) await target.delete();
    } }; },
  };
  return { records, queries, deletes, now: () => clock, advance: ms => { clock += ms; }, failBatch: number => { failBatch = number; },
    sweep: () => scope.startsWith('privateCalendars/') ? sweepPrivateDeliveries(firestore, scope.split('/')[1], clock)
      : sweepSharedDeliveries(firestore, scope.split('/')[1], clock),
    add(id, { age = 0, received = false, parts = 1 } = {}) {
      const path = `${scope}/deliveryRequests/${id}`;
      records.set(path, { createdAt: new Date(clock - age), expiresAt: new Date(clock + 86400_000), ...(received ? { receivedAt: new Date(clock) } : {}) });
      records.set(`${path}/responses/provider`, { ready: true });
      for (let index = 0; index < parts; index++) records.set(`${path}/responses/provider/parts/${index}`, { index, data: 'synthetic-ciphertext' });
      return path;
    },
  };
}

test('received shared and private recovery bodies erase behind forty older unreceived requests while pending bodies survive until their expiry', async () => {
  for (const scope of ['sharingGroups/unit-sweep-group', 'privateCalendars/unit-user']) {
    const f = recoveryCleanupFixture(scope), pending = [];
    for (let i = 0; i < 40; i++) pending.push(f.add(`pending-${i}`, { age: 100_000 - i }));
    const received = f.add('received-new', { received: true, parts: 3 });
    await f.sweep();
    assert.equal([...f.records.keys()].some(path => path.startsWith(received)), false, 'durable receipt must not wait behind unrelated unreceived work');
    assert.ok(pending.every(path => f.records.has(path)), 'unreceived bodies remain before their individual deadline');
    const repeated = await f.sweep(); assert.equal(repeated.deleted, 0, 'a lost cleanup reply can be retried without another erasure');
    assert.equal(f.deletes.get(received), 1);
    f.advance(86400_000);
    for (let attempt = 0; attempt < 4 && pending.some(path => f.records.has(path)); attempt++) await f.sweep();
    assert.ok(pending.every(path => !f.records.has(path)), 'unreceived bodies remain subject to TTL');
  }
});

test('large received recovery backlogs make bounded progress and schedule another batch without spinning on live unreceived work', async () => {
  const f = recoveryCleanupFixture(), pending = [], received = [];
  for (let i = 0; i < 40; i++) pending.push(f.add(`pending-${i}`, { age: 100_000 - i }));
  for (let i = 0; i < 65; i++) received.push(f.add(`received-${i}`, { received: true }));
  const first = await f.sweep();
  const left = received.filter(path => f.records.has(path)).length;
  assert.ok(left > 0 && left < received.length, 'one sweep makes progress without scanning and erasing the entire backlog');
  assert.equal(first.nextAt, f.now(), 'a full useful batch must not wait for unrelated TTLs');
  for (let attempt = 0; attempt < 4 && received.some(path => f.records.has(path)); attempt++) await f.sweep();
  assert.ok(received.every(path => !f.records.has(path)));
  assert.ok(pending.every(path => f.records.has(path)));
  const idle = await f.sweep(); assert.equal(idle.deleted, 0); assert.ok(idle.nextAt > f.now(), 'only the pending TTL remains, not an immediate idle sweep');
});

test('expired recovery backlogs return bounded continuation until cleared and duplicate queue membership deletes each request once', async () => {
  const f = recoveryCleanupFixture(), expired = [];
  for (let i = 0; i < 65; i++) expired.push(f.add(`expired-${i}`));
  f.advance(86400_000);
  const first = await f.sweep(); assert.equal(first.nextAt, f.now());
  for (let attempt = 0; attempt < 4 && expired.some(path => f.records.has(path)); attempt++) await f.sweep();
  assert.ok(expired.every(path => !f.records.has(path)));
  const received = f.add('both-queues', { received: true }); await f.sweep(); assert.equal(f.deletes.get(received), 1);
});

test('an interrupted recovery part erasure keeps its received parent retryable and finishes only the remaining ciphertext', async () => {
  const f = recoveryCleanupFixture(), target = f.add('received', { received: true, parts: 70 });
  f.failBatch(2); await assert.rejects(f.sweep(), /synthetic interrupted erasure/);
  assert.ok(f.records.has(target)); assert.ok([...f.records.keys()].some(path => path.startsWith(`${target}/responses/`)));
  await f.sweep(); assert.equal([...f.records.keys()].some(path => path.startsWith(target)), false);
  assert.equal(f.deletes.get(target), 1);
});

test('delivery cleanup listeners retry actual failures without idle polling and shutdown cancels reconnection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = []; const target = { where() { return this; }, onSnapshot(changed, failed) {
    const observer = { changed, failed, closed: false }; listeners.push(observer); return () => { observer.closed = true; };
  } };
  const stop = startSharedDeliveryWorker({ collectionGroup: () => target });
  try {
    listeners[0].changed({ docChanges: () => [] }); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 1);
    listeners[0].failed(); assert.equal(listeners[0].closed, true);
    t.mock.timers.tick(29_999); assert.equal(listeners.length, 1);
    t.mock.timers.tick(1); assert.equal(listeners.length, 2);
    listeners[1].changed({ docChanges: () => [] }); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 2);
    listeners[1].failed(); stop(); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 2);
  } finally { stop(); }
});
