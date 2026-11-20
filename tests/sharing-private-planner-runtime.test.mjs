import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateCalendarRuntimeFixture } from './helpers/private-calendar-runtime.mjs';
import { createPrivatePlannerPreferenceStore } from '../src/features/sharing/private-planner/preference-store.ts';
import { createPrivatePreferenceSync } from '../src/features/sharing/private-planner/preference-sync.ts';
import { privatePreferenceCursor } from '../src/features/sharing/private-planner/preference-crypto.ts';

test('private planner normal runtime reads only its protected profile without creating Calendar identity keys consent or cloud writes', async t => {
  const f = privateCalendarRuntimeFixture(t);
  f.port.plannerPreferences = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.f.vault, exclusive: f.f.exclusive,
    assertOwner: owner => assert.equal(f.f.state.currentUser, owner) });
  const runtime = f.open(); assert.equal(await runtime.readPlannerPreferences(), null);
  const saved = await f.port.plannerPreferences.save(0, { timeZone: 'Asia/Tokyo', restDays: [2], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 }, allowedBands: [] });
  assert.deepEqual(await runtime.readPlannerPreferences(), saved); assert.equal(await f.f.secrets.publicState(f.userId), null);
  assert.equal(f.state.googleReads, 0); assert.equal(f.state.restores, 0); assert.deepEqual(f.state.consents, []); assert.equal(f.transport.history.length, 0);
});

test('private planner normal runtime rejects a foreign profile and account changes after a protected read', async t => {
  const f = privateCalendarRuntimeFixture(t);
  f.port.plannerPreferences = { read: async () => ({ ownerUserId: 'foreign' }) }; await assert.rejects(() => f.open().readPlannerPreferences(), /本人/u);
  f.port.plannerPreferences = { read: async () => { f.f.state.currentUser = 'foreign'; return null; } };
  await assert.rejects(() => f.open().readPlannerPreferences(), /owner changed/u); assert.equal(f.state.googleReads, 0); assert.equal(f.transport.history.length, 0);
});
test('private planner automatic synchronization runs independently when Calendar acquisition fails and never requests another permission', async t => {
  const h = privateCalendarRuntimeFixture(t); const runtime = h.open(); await h.devices.initializeFirstDevice(); await h.connect(runtime);
  let synced = 0; h.port.plannerSync = { synchronize: async (_force, assertBudget) => { assertBudget(); synced++; return { kind: 'sent' }; } };
  h.port.queryGoogle = async () => { throw new Error('controlled Calendar failure'); };
  await assert.rejects(() => runtime.refreshData(), /controlled Calendar failure/u); assert.equal(synced, 1); assert.equal(h.state.consents.length, 1);
});
test('private planner synchronization failure cannot block a valid Calendar refresh or change its scope', async t => {
  const h = privateCalendarRuntimeFixture(t); const runtime = h.open(); await h.devices.initializeFirstDevice(); await h.connect(runtime);
  let calls = 0; h.port.plannerSync = { synchronize: async () => { calls++; throw new Error('controlled preference failure'); } };
  assert.equal((await runtime.refreshData()).kind, 'published'); assert.equal(calls, 1); assert.equal(h.state.googleReads, 1);
  assert.equal((await runtime.readForPlan()).ownerUserId, h.userId);
});

test('private preferences retry at the saved time and acknowledge durable data with Calendar disabled', async t => {
  const h = privateCalendarRuntimeFixture(t);
  await h.devices.initializeFirstDevice();
  const store = createPrivatePlannerPreferenceStore({ ownerUserId: h.userId, vault: h.f.vault, exclusive: h.f.exclusive,
    assertOwner: owner => assert.equal(h.f.state.currentUser, owner) });
  await store.save(0, { timeZone: 'Asia/Tokyo', restDays: [2], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 }, allowedBands: [] });
  let reads = 0;
  let published;
  const receipts = [];
  h.port.plannerSync = createPrivatePreferenceSync({ ownerUserId: h.userId, assertOwner: h.port.assertOwner, store, secrets: h.f.secrets,
    crypto: h.port.crypto, now: h.port.now, randomFraction: () => 0.5, cloud: {
      async read() { if (++reads === 1) throw new Error('temporary preferences transport failure'); return published ?? null; },
      async publish(_authority, value) { published = value; },
      async confirmDelivery(_authority, digest) {
        if (digest) receipts.push({ digest, saved: (await store.readSyncState()).baseline?.cursor.digest });
      },
    } });
  const runtime = h.open();
  assert.deepEqual(await runtime.synchronizeAutomatically(), { kind: 'waiting', retryAt: null });
  const retryAt = (await store.readSyncState()).retry?.nextAt;
  assert.ok(retryAt > h.state.now);
  assert.deepEqual(await runtime.synchronizeAutomatically(), { kind: 'waiting', retryAt });
  assert.equal(reads, 1);
  h.state.now = retryAt;
  assert.deepEqual(await runtime.synchronizeAutomatically(), { kind: 'disabled' });
  const digest = privatePreferenceCursor(published).digest;
  await t.waitFor(() => assert.deepEqual(receipts, [{ digest, saved: digest }]));
  assert.equal(reads, 2);
  assert.equal(h.state.googleReads, 0);
  assert.deepEqual(h.state.consents, []);
});
test('private planner manual synchronization uses the approved device check and never retrieves Google Calendar or Tasks', async t => {
  const h = privateCalendarRuntimeFixture(t); let calls = 0; h.port.plannerSync = { synchronize: async (force, ensure) => { assert.equal(force, true); ensure(); calls++; return { kind: 'sent' }; } };
  const runtime = h.open(); assert.equal((await runtime.syncPlannerPreferences()).kind, 'unavailable'); assert.equal(calls, 0);
  await h.devices.initializeFirstDevice(); assert.equal((await runtime.syncPlannerPreferences()).kind, 'sent'); assert.equal(calls, 1);
  assert.equal(h.state.googleReads, 0); assert.equal(h.state.restores, 0); assert.deepEqual(h.state.consents, []);
});
test('private planner foreground listener failures cannot detach the healthy Calendar listener and both subscriptions close cleanly', async t => {
  const h = privateCalendarRuntimeFixture(t); await h.devices.initializeFirstDevice(); let calendarStopped = 0; let plannerStopped = 0; let plannerFailed;
  h.port.cloud.watch = () => () => calendarStopped++;
  h.port.plannerSync = { synchronize: async () => ({ kind: 'unchanged' }), store: { subscribe: () => () => {} },
    cloud: { watch: (_changed, failed) => { plannerFailed = failed; return () => plannerStopped++; } } };
  const runtime = h.open(); const stop = runtime.observeRemote();
  const end = Date.now() + 5000; while (!plannerFailed && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(plannerFailed);
  plannerFailed(); for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(plannerStopped, 1); assert.equal(calendarStopped, 0); stop(); assert.equal(calendarStopped, 1); assert.equal(plannerStopped, 1);
});
