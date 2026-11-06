import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
const { AdaptiveOwnerInputsChangedError } = await import('../src/platform/storage/adaptive-owner-inputs.ts');
const { sharedLocalDate } = await import('../src/features/sharing/group-clock.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const digest = await import('../src/features/planner/adaptive-digest.ts');
const timing = await import('../src/features/google-sync/calendar-timing.ts');

function runtime() {
  let reader; let user = 'owner'; let changed; let generation = 0; let privateRevision = 1; let dbVersion = 1; let shared = true; let delay;
  let calendarChanged; let busy = null; let connected = false;
  const calls = [];
  const value = () => ({ schemaVersion: 1, ownerUserId: user, revision: privateRevision, timeZone: 'Asia/Tokyo', restDays: [6, 7], allowedBands: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } });
  const preferences = { subscribe: fn => { changed = fn; return () => { calls.push('unsubscribe'); }; }, read: async () => { if (delay) await delay; return value(); } };
  const common = { initialized: true, groupId: 'group', timeZone: 'Asia/Tokyo', sourceHash: 'source', planHash: 'plan', range: {} };
  const workspace = { database: { getFirstAsync: async () => ({ data_version: dbVersion }) }, record: async () => { calls.push('record'); return { status: 'active' }; },
    session: { controller: { readModel: async range => { common.range = range({ timeZone: common.timeZone }); calls.push(['range', common.range]); return { plan: common, calendar: [] }; } } } };
  loadNativeModule('src/platform/sharing/adaptive-personal-runtime.ts', {
    './firebase-services': { isSharingConfigured: () => true, getSharingServices: () => ({ auth: { get currentUser() { return user ? { uid: user } : null; } } }) },
    './private-calendar-secrets': { nativePrivatePlannerPreferences: () => preferences },
    './workspaces': { readLocalAdaptiveWorkspace: async () => shared ? workspace : null, sharingLocalPlanningRevision: () => generation },
    '../storage/adaptive-owner-inputs': { setNativeAdaptiveOwnerReader: fn => { reader = fn; }, AdaptiveOwnerInputsChangedError },
    '../../domain/scheduling/local-date': { addDays }, '../../features/sharing/group-clock': { sharedLocalDate },
    '../../features/google-sync/planner-change-events': { notifyGooglePlannerChanges: () => calls.push('changed') },
    '../storage/calendar-event-rows': { readCalendarEventRows: async () => ({ events: [], exceptions: [] }) },
    './private-calendar-runtime': { openPrivateCalendarRuntime: () => ({ readForPlan: async () => busy,
      readSettings: async () => ({ ownerUserId: user, connected }), subscribe: fn => { calendarChanged = fn; return () => calls.push('stopCalendar'); } }) },
    '../../features/planner/adaptive-digest': digest, '../../features/google-sync/calendar-timing': timing,
    '../../features/sharing/v2/personal-plan': { buildV2PersonalPlan: (plan, input) => { calls.push(['personal', input]); return { groupId: plan.groupId, viewerUserId: input.viewerUserId, commonPlanHash: plan.planHash, recommendations: [], localHash: 'local' }; } },
    '../../features/calendar/private-availability': { createLocalCalendarAvailability: () => () => ({ conflict: { kind: 'clear' }, busyMinutes: 0 }) },
    '../../features/calendar/shared-events': { sharedCalendarAvailability: () => undefined },
    '../../features/sharing/v2/private-availability': { combinePrivateCalendarAvailability: first => first },
  });
  const database = { getFirstAsync: async sql => sql.includes('sqlite_master') ? { name: 'calendar_events' }
    : { frequency_mode: 'balanced', rest_days_json: '[6,7]', heavy_daily_limit: 1, normal_daily_limit: 2 } };
  return { read: () => reader(new Date('2026-11-05T01:00:00Z'), database), calls, preferences,
    user: value => { user = value; }, changed: () => changed(), sharedChanged: () => generation++,
    privateRevision: () => privateRevision++, dbChanged: () => dbVersion++, shared: value => { shared = value; }, delay: value => { delay = value; },
    calendar: value => { connected = true; busy = value; }, calendarChanged: () => calendarChanged() };
}

test('native owner adapter computes one stable full horizon with shared first and performs only injected local reads', async () => {
  const r = runtime(); const captured = await r.read();
  assert.equal(captured.ownerUserId, 'owner'); assert.equal(captured.common.groupId, 'group');
  assert.deepEqual(r.calls.find(row => Array.isArray(row) && row[0] === 'range')[1], { from: '2026-10-06', through: '2027-05-04', asOfDate: '2026-11-05' });
  const input = r.calls.find(row => Array.isArray(row) && row[0] === 'personal')[1]; assert.equal(input.privateLoad, undefined);
  await captured.assertCommitCurrent();
  r.dbChanged(); await assert.rejects(captured.assertCommitCurrent(), AdaptiveOwnerInputsChangedError);
});

test('native owner adapter invalidates saved projections after settings account or shared-input changes', async () => {
  for (const mutation of ['changed', 'sharedChanged', 'calendarChanged', 'user']) {
    const r = runtime(); const captured = await r.read(); r[mutation]('other');
    assert.throws(captured.assertCurrent, AdaptiveOwnerInputsChangedError);
  }
  const r = runtime(); const captured = await r.read(); r.privateRevision();
  await assert.rejects(captured.assertCommitCurrent(), AdaptiveOwnerInputsChangedError);
});

test('native owner calendar input also protects private-only planning and rejects silent protected-cache changes before commit', async () => {
  const r = runtime(); r.shared(false); r.calendar(null);
  const captured = await r.read(); assert.equal(captured.common, null);
  assert.deepEqual(captured.privateCalendar, { ownerUserId: 'owner', connected: true, cache: null, binding: null });
  r.calendar({ ownerUserId: 'owner', cache: { ownerUserId: 'owner' }, binding: { ownerUserId: 'owner' } });
  await assert.rejects(captured.assertCommitCurrent(), AdaptiveOwnerInputsChangedError);
});

test('native owner snapshot validity ends when its accepted busy cache becomes stale', async t => {
  const now = Date.parse('2026-11-05T01:00:00Z'); t.mock.timers.enable({ apis: ['Date'], now });
  const r = runtime(); r.shared(false);
  r.calendar({ ownerUserId: 'owner', cache: { ownerUserId: 'owner', fetchedAt: new Date(now).toISOString() }, binding: { ownerUserId: 'owner' } });
  const captured = await r.read(); captured.assertCurrent();
  t.mock.timers.tick(timing.CALENDAR_AVAILABILITY_MAX_AGE_MS + 1);
  assert.throws(captured.assertCurrent, AdaptiveOwnerInputsChangedError);
});

test('native owner adapter rejects an account switch during a protected read and anonymous use needs no preference or shared lookup', async () => {
  const r = runtime(); let release; r.delay(new Promise(resolve => { release = resolve; }));
  const pending = r.read(); r.user('other'); release(); await assert.rejects(pending, AdaptiveOwnerInputsChangedError);
  r.user(null); const anonymous = await r.read(); assert.equal(anonymous.ownerUserId, null); assert.equal(anonymous.common, null);
  assert.equal(r.calls.some(row => Array.isArray(row) && row[0] === 'range'), false);
});
