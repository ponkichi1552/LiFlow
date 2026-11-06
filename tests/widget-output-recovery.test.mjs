import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createPlannerRefreshController } from '../src/features/planner/refresh-controller.ts';
import { withLocalNotificationOperation } from '../src/features/notifications/reconcile-local-notifications.ts';
import * as localDate from '../src/domain/scheduling/local-date.ts';
import * as groupClock from '../src/features/sharing/group-clock.ts';

function widgetFixture() {
  const locked = { phase: 'locked', userId: 'owner' }; let state = locked;
  const writes = []; let read = async () => []; let fail = false;
  const module = loadNativeModule('src/platform/widgets/expo-widget-gateway.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '../subscription/runtime': { subscriptionRequired: true, subscriptionAccessDeadline: async () => Date.now() + 60_000, subscriptionSnapshot: () => state },
    '@/platform/widgets/NextChoreWidget': { __esModule: true, default: {
      async getTimeline() { return read(); },
      updateSnapshot(props) { if (fail) throw new Error('synthetic native failure'); writes.push({ props }); },
      updateTimeline(entries) { if (fail) throw new Error('synthetic native failure'); writes.push({ entries }); },
    } },
  });
  return { ...module, locked, writes, active() { state = { phase: 'active', userId: 'owner' }; }, lock() { state = locked; },
    read(next) { read = next; }, fail(next) { fail = next; } };
}
const snapshot = { chores: [{ id: 'round', name: '家事', completed: false }], remainingCount: 0, updatedAt: '2026-11-05T00:00:00Z' };

test('a delayed expiry widget read cannot overwrite a renewed publication and real expiry invalidates identical content', async () => {
  const h = widgetFixture(); let enter; let release;
  const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  h.read(async () => { enter(); await gate; return []; });
  const locking = h.lockSubscriptionWidget(); await entered;
  h.active(); const renewed = h.expoWidgetGateway.updateNextChore(snapshot); release(); await Promise.all([locking, renewed]);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].entries[0].props.chores[0].id, 'round');
  h.lock(); await h.lockSubscriptionWidget(); assert.equal(h.writes.at(-1).props.subscriptionLocked, true);
  h.active(); await h.expoWidgetGateway.updateNextChore(snapshot);
  assert.equal(h.writes.length, 3, 'a native lock invalidates the prior normal signature');
});

test('a native widget output failure reaches the refresh controller and retries unchanged cached content without hiding the screen', async () => {
  const h = widgetFixture(); h.active(); h.fail(true);
  const publish = loadNativeModule('src/features/widgets/publish-today-widget-snapshot.ts', {
    '@/domain/scheduling/local-date': localDate,
    '../sharing/group-clock.ts': groupClock,
    '@/platform/widgets/expo-widget-gateway': { expoWidgetGateway: h.expoWidgetGateway },
    '@/features/widgets/today-widget-snapshot': { createTodayWidgetSnapshot: () => snapshot },
  }).publishTodayWidgetSnapshot;
  const cached = { chores: [], scheduleEntries: [], completions: [] }; let notifications = 0;
  const controller = createPlannerRefreshController({ load: async () => ({ snapshot: cached, canPublishWidget: true }), weather: async () => null,
    publish: async value => { const results = await Promise.allSettled([publish(value), Promise.resolve().then(() => { notifications++; })]);
      if (results[0].status === 'rejected') throw results[0].reason; } });
  await controller.refresh(); await new Promise(setImmediate);
  assert.equal(controller.getSnapshot().snapshot, cached); assert.equal(controller.getSnapshot().error, null); assert.equal(notifications, 1);
  h.fail(false); await controller.refresh(); await new Promise(setImmediate);
  assert.equal(h.writes.length, 1); assert.equal(notifications, 2);
});

function stopFixture() {
  const state = { value: { phase: 'locked', userId: 'first' } }; const pending = new Set(['one', 'two']);
  const cancelled = []; let locks = 0; let failList = false; let failLock = false; let failCancel = true; let afterList;
  const gateway = { async getScheduledRequests() { if (failList) throw new Error('list failed'); const list = [...pending].map(key => ({ key })); await afterList?.(); return list; },
    async cancel(key) { cancelled.push(key); if (key === 'one' && failCancel) throw new Error('cancel failed'); pending.delete(key); } };
  const stop = loadNativeModule('src/platform/subscription/stop-expired-features.ts', {
    './runtime': { subscriptionSnapshot: () => state.value },
    '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
    '../../features/notifications/reconcile-local-notifications': { withLocalNotificationOperation },
    '../widgets/expo-widget-gateway': { async lockSubscriptionWidget() { locks++; if (failLock) throw new Error('lock failed'); } },
  }).stopExpiredSubscriptionFeatures;
  return { state, pending, cancelled, stop, locks: () => locks,
    recover() { failCancel = false; failList = false; failLock = false; },
    failList() { failList = true; }, failLock() { failLock = true; }, afterList(value) { afterList = value; } };
}

test('expiry cancellation attempts independent notifications and widget outputs and retries only remaining native reservations', async () => {
  const h = stopFixture(); await assert.rejects(h.stop(), /cancel failed/);
  assert.deepEqual(h.cancelled, ['one', 'two']); assert.equal(h.locks(), 1); assert.deepEqual([...h.pending], ['one']);
  h.recover(); await h.stop(); assert.deepEqual(h.cancelled, ['one', 'two', 'one']); assert.equal(h.locks(), 2);
});

test('a failed notification listing still locks the widget and widget failure does not prevent notification cleanup', async () => {
  const h = stopFixture(); h.failList(); await assert.rejects(h.stop(), /list failed/); assert.equal(h.locks(), 1);
  h.recover(); h.failLock(); await assert.rejects(h.stop(), /lock failed/); assert.equal(h.pending.size, 0);
  h.recover(); await h.stop(); assert.equal(h.locks(), 3);
});

test('an old expiry cleanup cannot cancel renewed or another accounts notifications after its delayed native read', async () => {
  for (const phase of ['active', 'locked']) {
    const h = stopFixture(); let enter; let release;
    const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    h.afterList(async () => { enter(); await gate; }); const stopping = h.stop(); await entered;
    h.state.value = { phase, userId: 'second' }; release(); await stopping;
    assert.deepEqual(h.cancelled, []); assert.equal(h.pending.size, 2);
    h.afterList(undefined); h.recover(); if (phase === 'locked') { await h.stop(); assert.equal(h.pending.size, 0); }
  }
});
