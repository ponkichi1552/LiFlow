import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLocalNotifications } from '../src/features/notifications/reconcile-local-notifications.ts';

const request = (key, day = 1) => ({ key, title: key, body: '検査', fireAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z` });
function gateway(capacity) {
  const stored = new Map(); const calls = []; let permitted = true;
  return { maximumScheduledRequests: capacity, stored, calls, permission(value) { permitted = value; }, async requestPermission() { return permitted; }, async hasPermission() { return permitted; },
    async getScheduledRequests() { return [...stored.values()]; }, async schedule(row) { calls.push(['schedule', row.key]); if (!stored.has(row.key)) assert.ok(capacity === undefined || stored.size < capacity); stored.set(row.key, row); return row.key; },
    async cancel(key) { calls.push(['cancel', key]); stored.delete(key); } };
}

test('local notification domains share an app-wide capacity and retain other domains unchanged', async () => {
  const g = gateway(60);
  for (let i = 0; i < 31; i++) g.stored.set(`personal:${i}`, request(`personal:${i}`));
  await reconcileLocalNotifications(g, { prefix: 'v2:', enabled: true, desired: Array.from({ length: 31 }, (_, i) => request(`v2:${i}`, i + 1)) });
  assert.equal(g.stored.size, 60); assert.equal([...g.stored.keys()].filter(key => key.startsWith('personal:')).length, 31);
  assert.equal([...g.stored.keys()].filter(key => key.startsWith('v2:')).length, 29);
  assert.equal(g.stored.has('v2:30'), false);
});

test('parallel scopes cannot overbook native capacity or cancel each other’s pending notifications', async () => {
  const g = gateway(4); let release; const wait = new Promise(resolve => { release = resolve; }); const original = g.schedule; let first = true;
  g.schedule = async row => { if (first) { first = false; await wait; } return original(row); };
  const a = reconcileLocalNotifications(g, { prefix: 'a:', enabled: true, desired: [request('a:1'), request('a:2')] });
  const b = reconcileLocalNotifications(g, { prefix: 'b:', enabled: true, desired: [request('b:1'), request('b:2'), request('b:3')] });
  release(); await Promise.all([a, b]); assert.equal(g.stored.size, 4); assert.ok(g.stored.has('a:1') && g.stored.has('b:1')); assert.deepEqual(g.calls.filter(call => call[0] === 'cancel'), []);
});

test('capacity-limited replacement frees its own obsolete keys before creating and retries a partial OS failure', async () => {
  const g = gateway(2); g.stored.set('a:old', request('a:old')); g.stored.set('other', request('other'));
  let fail = true; const original = g.cancel; g.cancel = async key => { if (fail) { fail = false; throw new Error('OS rejected cancellation'); } return original(key); };
  const input = { prefix: 'a:', enabled: true, desired: [request('a:new')] };
  await assert.rejects(reconcileLocalNotifications(g, input), error => error.result.failed === 1 && /OS rejected/u.test(error.cause.message)); assert.equal(g.stored.size, 2); assert.ok(!g.stored.has('a:new'));
  await reconcileLocalNotifications(g, input); assert.ok(g.stored.has('a:new') && g.stored.has('other')); assert.equal(g.stored.size, 2);
  assert.deepEqual(g.calls.slice(-2), [['cancel', 'a:old'], ['schedule', 'a:new']]);
});

test('notification results distinguish unchanged publication deadline permission and native capacity exclusions without exposing content', async () => {
  const g = gateway(3); g.stored.set('other:one', request('other:one'));
  g.schedulingDeadline = async () => Date.parse(request('a:boundary', 4).fireAt);
  const input = { prefix: 'a:', enabled: true, desired: [1, 2, 3, 4].map(day => request(`a:${day}`, day)) };
  const first = await reconcileLocalNotifications(g, input);
  assert.deepEqual(first, { scheduled: 2, unchanged: 0, cancelled: 0, deadlineExcluded: 1, capacityExcluded: 1, permissionExcluded: 0, failed: 0 });
  const second = await reconcileLocalNotifications(g, input); assert.equal(second.unchanged, 2); assert.equal(second.scheduled, 0);
  g.permission(false); const denied = await reconcileLocalNotifications(g, input);
  assert.equal(denied.permissionExcluded, 4); assert.equal(denied.cancelled, 2); assert.equal(g.stored.has('other:one'), true);
  assert.ok(Object.values(first).every(Number.isSafeInteger), 'diagnostic results carry counts, not private notification payloads');
});

test('permission changes cancel only this scope, and an unchanged plan creates no native writes', async () => {
  const g = gateway(); const input = { prefix: 'a:', enabled: true, desired: [request('a:one')] };
  g.stored.set('other', request('other')); await reconcileLocalNotifications(g, input); g.calls.length = 0;
  await reconcileLocalNotifications(g, input); assert.deepEqual(g.calls, []);
  g.permission(false); await reconcileLocalNotifications(g, input); assert.deepEqual([...g.stored.keys()], ['other']);
});

test('a superseded queued plan cannot write native reminders and a failed scope does not poison other scopes', async () => {
  const g = gateway(); let active = true;
  const first = reconcileLocalNotifications(g, { prefix: 'a:', enabled: true, desired: [request('a:one')], assertCurrent() { if (!active) throw new Error('superseded'); } });
  active = false; await assert.rejects(first, /superseded/u); assert.equal(g.stored.size, 0);
  await reconcileLocalNotifications(g, { prefix: 'b:', enabled: true, desired: [request('b:one')] }); assert.deepEqual([...g.stored.keys()], ['b:one']);
  await assert.rejects(reconcileLocalNotifications(g, { prefix: 'b:', enabled: true, desired: [request('a:wrong')] }), /保存先/u);
});

test('a caller cannot mutate a queued notification into another scope after validation', async () => {
  const g = gateway(); let release; const wait = new Promise(resolve => { release = resolve; }); let entered;
  const ready = new Promise(resolve => { entered = resolve; }); const schedule = g.schedule; let first = true;
  g.schedule = async row => { if (first) { first = false; entered(); await wait; } return schedule(row); };
  const before = reconcileLocalNotifications(g, { prefix: 'first:', enabled: true, desired: [request('first:one')] }); await ready;
  const mutable = request('second:one'); mutable.data = { kind: 'safe' };
  const input = { prefix: 'second:', enabled: true, desired: [mutable] }; const queued = reconcileLocalNotifications(g, input);
  mutable.key = 'foreign:injected'; mutable.data.kind = 'changed'; input.prefix = 'foreign:'; input.enabled = false;
  release(); await before; await queued;
  assert.ok(g.stored.has('second:one')); assert.equal(g.stored.get('second:one').data.kind, 'safe'); assert.ok(!g.stored.has('foreign:injected'));
});
