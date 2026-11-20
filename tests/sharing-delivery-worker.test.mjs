import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSharedDeliveryWorker, pruneDeliveryRequests } from '../server/account-device-api/src/sharing-delivery-worker.mjs';
import { Timestamp } from 'firebase/firestore';
import { createDeviceIdentity, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { recoveryReceiptInput } from '../src/features/sharing/delivery-proof.ts';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';

const device = await createDeviceIdentity(sharingTestCrypto);
const projectId = 'demo-liflow-sharing';

function recoveryCleanupFixture(scope = 'sharingGroups/unit-sweep-group') {
  const [collection, scopeId] = scope.split('/');
  const policy = { schemaVersion: 2, enrollmentId: 'a'.repeat(64), enabled: true, ttlMs: 86400_000 };
  const claim = { authorityJson: 'verified-fixture', devices: [{ userId: 'receiver', identity: device }],
    scope: { projectId, kind: collection === 'sharingGroups' ? 'shared' : 'private', scopeId,
      enrollmentId: policy.enrollmentId, authorityDigest: 'b'.repeat(64), keyVersion: 1 } };
  const records = new Map([[scope, { rosterJson: claim.authorityJson, authorityJson: claim.authorityJson, keyVersion: 1 }],
    [scope + '/deliveryControl/policy', policy]]), queries = [], deletes = new Map();
  let clock = 1_800_000_000_000, batchNumber = 0, failBatch = 0, afterErase, documentReads = 0;
  const ref = path => ({ path, id: path.split('/').at(-1), collection: name => query(`${path}/${name}`),
    async delete() { deletes.set(path, (deletes.get(path) ?? 0) + 1); records.delete(path); } });
  const snapshot = path => ({ id: path.split('/').at(-1), ref: ref(path), exists: records.has(path), data: () => records.get(path) });
  function query(path, order, maximum = Infinity, selected, direction = 'asc') {
    return { doc: id => ref(`${path}/${id}`), orderBy: (field, direction) => query(path, field, maximum, selected, direction),
      limit: count => query(path, order, count, selected, direction), select: (...fields) => query(path, order, maximum, fields, direction),
      async get() {
        const rows = [...records].filter(([name, value]) => name.startsWith(`${path}/`) && name.split('/').length === path.split('/').length + 1
          && (!order || order in value));
        rows.sort((a, b) => (direction === 'desc' ? -1 : 1) * (Number(a[1][order]) - Number(b[1][order])) || a[0].localeCompare(b[0]));
        const docs = rows.slice(0, maximum).map(([name]) => snapshot(name));
        queries.push({ path, returned: docs.length }); return { docs, size: docs.length };
      } };
  }
  const firestore = { collection: path => query(path), async runTransaction(work) {
    const targets = [];
    const result = await work({
      getAll: async (...refs) => { documentReads += refs.length; return refs.map(target => snapshot(target.path)); },
      get: target => { if (target.get) return target.get(); documentReads++; return snapshot(target.path); },
      update(target, update) { records.set(target.path, { ...records.get(target.path), ...update }); },
      delete: target => targets.push(target) });
    if (targets.length) {
      if (++batchNumber === failBatch) { failBatch = 0; throw new Error('synthetic interrupted erasure'); }
      for (const target of targets) await target.delete();
      const hook = afterErase; afterErase = undefined; hook?.();
    }
    return result;
  },
  };
  return { records, queries, deletes, documentReads: () => documentReads, now: () => clock, advance: ms => { clock += ms; }, failBatch: number => { failBatch = number; },
    afterErase: hook => { afterErase = hook; },
    async sweep() {
      const result = { active: true, deleted: 0, nextAt: null };
      await pruneDeliveryRequests(ref(scope), result, clock, firestore, claim);
      return result;
    },
    add(id, { age = 0, received = false, parts = 1 } = {}) {
      const path = `${scope}/deliveryRequests/${id}`;
      const createdAt = Timestamp.fromMillis(clock - age);
      const position = { kind: 'chunk', key: id, after: 0, through: 0, keyVersion: 1 };
      const receiptSignature = signSharedDocument(recoveryReceiptInput(claim.scope, 'receiver', device.deviceId, {
        id, ...position, createdSeconds: createdAt.seconds, createdNanoseconds: createdAt.nanoseconds }), device);
      records.set(path, { schemaVersion: 2, ...position, userId: 'receiver', deviceId: device.deviceId, createdAt,
        expiresAt: new Date(clock + 86400_000), ...(received ? { receiptSignature, receiptReportedAt: new Date(clock) } : {}) });
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

test('a full cleanup page reads shared controls once to seal it while still rechecking each deletion', async () => {
  const f = recoveryCleanupFixture();
  for (let i = 0; i < 32; i++) f.add(`received-${i}`, { received: true });
  assert.equal((await f.sweep()).deleted, 32);
  // Three scope documents plus 32 requests to seal, followed by two four-document checks per request.
  assert.equal(f.documentReads(), 35 + 2 * 4 * 32);
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

test('a recovery receipt for an older incarnation cannot erase a replacement request', async () => {
  const f = recoveryCleanupFixture();
  const path = f.add('renewed', { received: true });
  const original = f.records.get(path);
  f.records.set(path, { ...original, createdAt: Timestamp.fromMillis(original.createdAt.toMillis() + 1) });
  assert.equal((await f.sweep()).deleted, 0);
  assert.equal(f.records.get(path).receivedAt, undefined);
  assert.ok(f.records.has(path + '/responses/provider/parts/0'));
});

test('a resumed cleanup cannot delete a new request that reused an already cleared id', async () => {
  const f = recoveryCleanupFixture();
  const path = f.add('renewed', { received: true, parts: 70 });
  f.afterErase(() => {
    // Another sweep finished the sealed request and an approved receiver requested the artifact again.
    for (const key of f.records.keys()) if (key === path || key.startsWith(path + '/')) f.records.delete(key);
    f.advance(1);
    f.add('renewed');
  });
  assert.equal((await f.sweep()).deleted, 0);
  assert.equal(f.records.get(path).receivedAt, undefined);
  assert.ok(f.records.has(path + '/responses/provider/parts/0'));
});

test('a newly acquired recovery lock stops split response erasure between transactions', async () => {
  const scope = 'sharingGroups/unit-sweep-group', f = recoveryCleanupFixture(scope);
  const path = f.add('recovery-lock', { received: true, parts: 70 });
  const lock = scope + '/recoveryLocks/current';
  f.afterErase(() => f.records.set(lock, { keyVersion: 1 }));
  assert.equal((await f.sweep()).deleted, 0);
  assert.equal([...f.records.keys()].filter(key => key.startsWith(path + '/responses/provider/parts/')).length, 38);
  f.records.delete(lock);
  assert.equal((await f.sweep()).deleted, 1);
  assert.equal(f.records.has(path), false);
});

test('delivery worker refuses an implicit project, a mismatched project, and a production emulator before connecting', () => {
  const main = fileURLToPath(new URL('../server/account-device-api/src/sharing-delivery-main.mjs', import.meta.url));
  const target = { LIFLOW_FIREBASE_PROJECT_ID: 'demo-liflow-sharing' };
  for (const env of [{}, { ...target, GOOGLE_CLOUD_PROJECT: 'different-project' },
    { ...target, NODE_ENV: 'production', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8187' }]) {
    const output = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', main, '--status'],
      { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(output.status, 1); assert.equal(output.stdout, '');
    assert.equal(JSON.parse(output.stderr).event, 'delivery_worker_command_refused');
  }
});

test('the account device API refuses to mix real Firebase authority with isolated test services', () => {
  const entry = fileURLToPath(new URL('../server/account-device-api/src/index.mjs', import.meta.url));
  const demo = { LIFLOW_FIREBASE_PROJECT_ID: 'demo-liflow-sharing' };
  const both = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8187', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9102' };
  for (const env of [{ ...demo, FIREBASE_AUTH_EMULATOR_HOST: both.FIREBASE_AUTH_EMULATOR_HOST },
    { ...both, LIFLOW_FIREBASE_PROJECT_ID: 'synthetic-real-project' }, { ...demo, ...both, NODE_ENV: 'production' },
    { ...demo, ...both, GCLOUD_PROJECT: 'different-project' }]) {
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', entry],
      { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).event, 'account_device_service_startup_refused');
  }
});

test('delivery cleanup listeners retry actual failures without idle polling and shutdown cancels reconnection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = []; const target = { where() { return this; }, onSnapshot(changed, failed) {
    const observer = { changed, failed, closed: false }; listeners.push(observer); return () => { observer.closed = true; };
  } };
  const stop = startSharedDeliveryWorker({ collectionGroup: () => target }, undefined, projectId);
  try {
    listeners[0].changed({ docChanges: () => [] }); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 1);
    listeners[0].failed(); assert.equal(listeners[0].closed, true);
    t.mock.timers.tick(29_999); assert.equal(listeners.length, 1);
    t.mock.timers.tick(1); assert.equal(listeners.length, 2);
    listeners[1].changed({ docChanges: () => [] }); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 2);
    listeners[1].failed(); stop(); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 2);
  } finally { stop(); }
});

test('delivery worker stays alive when discovery disconnects before any scope is loaded', t => {
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    const timer = originalSetTimeout(...args);
    timers.push(timer);
    return timer;
  });
  let fail;
  const events = [];
  const discovery = { where() { return this; }, onSnapshot(_changed, failed) { fail = failed; return () => {}; } };
  const stop = startSharedDeliveryWorker({ collectionGroup: () => discovery }, event => events.push(event), projectId);
  try {
    fail({ code: 7, message: 'private diagnostic details' });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].hasRef(), true);
    assert.deepEqual(events, [{ event: 'shared_delivery_listener_retry', code: 7 }]);
  } finally { stop(); }
});

test('delivery discovery reconnect closes the listeners for a scope paused during the interruption', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observers = [];
  const source = { where() { return this; }, onSnapshot(changed, failed) {
    const subscription = { changed, failed, closed: false };
    observers.push(subscription);
    return () => { subscription.closed = true; };
  } };
  const root = { id: 'pause-during-disconnection', path: 'privateCalendars/pause-during-disconnection',
    parent: { id: 'privateCalendars' }, ...source, collection: () => source };
  const policy = { id: 'policy', ref: { parent: { parent: root } },
    data: () => ({ schemaVersion: 2, enabled: true, enrollmentId: 'a'.repeat(64), ttlMs: 86_400_000 }) };
  const db = { collectionGroup: () => source, collection: () => ({ doc: () => root }),
    runTransaction: async () => ({ deleted: 0, nextAt: null }) };
  const stop = startSharedDeliveryWorker(db, undefined, projectId);
  try {
    observers[0].changed({ docs: [policy], docChanges: () => [{ type: 'added', doc: policy }] });
    assert.equal(observers.length, 4);
    observers[0].failed();
    t.mock.timers.tick(30_000);
    observers[4].changed({ docs: [], docChanges: () => [] });
    assert.ok(observers.slice(1, 4).every(subscription => subscription.closed));
    assert.equal(observers[4].closed, false);
  } finally { stop(); }
});
