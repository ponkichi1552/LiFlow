import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import { fixture, seeds, scope } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import * as storeModule from '../src/platform/storage/sharing-v2-reminders.ts';
import * as runtimeModule from '../src/features/sharing/v2/reminder-runtime.ts';
import * as screenModule from '../src/features/sharing/v2-ui/screen-session.ts';
import * as overlayModule from '../src/features/sharing/v2-ui/private-overlay.ts';
import * as ownerModule from '../src/features/sharing/v2-ui/owner-preferences.ts';
import * as reconciliation from '../src/features/notifications/reconcile-local-notifications.ts';
import * as identity from '../src/features/sharing/v2/native-identity.ts';
import * as personalPlan from '../src/features/sharing/v2/personal-plan.ts';
import * as cryptoModule from '../src/features/sharing/crypto.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import * as completionNotices from '../src/features/sharing/v2/completion-notices.ts';
import * as localDate from '../src/domain/scheduling/local-date.ts';
import * as localCalendarPlanning from '../src/features/calendar/private-availability.ts';
import * as sharedCalendarPlanning from '../src/features/calendar/shared-events.ts';
import * as privateCalendarAvailability from '../src/features/sharing/v2/private-availability.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
const personalCatalog = await import('../src/domain/chores/personal-catalog.ts');
const sharedAdaptive = await import('../src/features/planner/shared-adaptive-load.ts');

async function setup() {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds());
  const calls = []; const scheduled = new Map(); let active = true; let failPersonal = false; let completionCalls = 0; let events = [];
  const guard = () => { if (!active) throw new Error('account changed'); };
  const gateway = { maximumScheduledRequests: 60, async requestPermission() { calls.push('request-permission'); return true; }, async hasPermission() { return true; },
    async getScheduledRequests() { return [...scheduled.values()]; }, async schedule(request) { scheduled.set(request.key, request); return request.key; }, async cancel(key) { scheduled.delete(key); } };
  const personal = { async closeAsync() { calls.push('personal-close'); } };
  const controller = createV2GroupController(d.repository, { now: () => new Date(), makeId: () => 'unused-id', sync: async () => {} });
  const nativeMocks = {
    'expo-sqlite': { async openDatabaseAsync(name, options) { assert.equal(name, 'housework.db'); assert.equal(options.useNewConnection, true); calls.push('personal-open'); return personal; } },
    '../storage/planning-input-revision': { readPlanningInputRevision: async () => 0 },
    '../storage/repository': { async readPersonalPlannerOverlaySnapshot(db, now) { assert.equal(db, personal); calls.push('personal-read'); if (failPersonal) { active = false; }
      return { today: sharedLocalDate(now, 'Asia/Tokyo'), timeZone: 'Asia/Tokyo', snapshot: { household: { id: 'local-household' },
        settings: { frequencyMode: 'balanced', restDays: [], heavyDailyLimit: 1, normalDailyLimit: 2, setupCompleted: true }, chores: [], scheduleEntries: [], completions: [] } }; } },
    '../storage/sharing-v2-reminders': storeModule, '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
    '../../features/sharing/v2/reminder-runtime': runtimeModule, '../../features/sharing/v2-ui/screen-session': screenModule,
    '../../features/sharing/v2-ui/private-overlay': overlayModule, '../../features/sharing/v2-ui/owner-preferences': ownerModule,
    '../../features/sharing/v2/personal-plan': personalPlan, '../../features/sharing/crypto': cryptoModule,
    '../../domain/chores/personal-catalog': personalCatalog,
    '../../features/planner/shared-adaptive-load': sharedAdaptive,
    '../storage/calendar-events': { readLocalCalendar: async () => ({ events, exceptions: [] }) },
    '../../features/calendar/private-availability': localCalendarPlanning,
    '../../features/calendar/shared-events': sharedCalendarPlanning,
    '../../features/sharing/v2/private-availability': privateCalendarAvailability,
    '../../features/notifications/reconcile-local-notifications': reconciliation, '../../features/sharing/v2/native-identity': identity,
    '../../features/sharing/v2/completion-notices': completionNotices, '../../domain/scheduling/local-date': localDate,
    'react-native': { Platform: { OS: process.env.HOUSEWORK_TEST_PLATFORM ?? 'ios' } },
    'expo-notifications': { AndroidImportance: { DEFAULT: 3 }, setNotificationChannelAsync: async () => {},
      scheduleNotificationAsync: async request => { calls.push(['immediate', request]); return request.identifier; },
      getPresentedNotificationsAsync: async () => [], dismissNotificationAsync: async () => {}, cancelScheduledNotificationAsync: async key => scheduled.delete(key) },
    './private-calendar-runtime': { openPrivateCalendarRuntime(uid) { assert.equal(uid, scope.userId); guard(); calls.push('local-calendar');
      return { subscribe: () => () => {}, async readPlannerPreferences() { guard(); return null; }, async readForPlan() { guard(); return null; }, async readOwnCalendar() { throw new Error('notification rendering must not acquire Google'); } }; } },
    './v2-completion-notices': { createNativeV2CompletionNotices(input) { assert.equal(input.repository, d.repository); return { synchronize: async () => { completionCalls++; } }; },
      clearInactiveV2CompletionNotices: async () => {}, clearV2CompletionNoticesForScope: async () => {} },
  };
  nativeMocks['./v2-immediate-notices'] = loadNativeModule('src/platform/sharing/v2-immediate-notices.ts', nativeMocks);
  nativeMocks['./v2-local-planning'] = loadNativeModule('src/platform/sharing/v2-local-planning.ts', nativeMocks);
  const module = loadNativeModule('src/platform/sharing/v2-reminders.ts', nativeMocks);
  const runtime = module.createNativeV2Reminders({ ...scope, database: d.database, repository: d.repository, controller, assertAccess: guard });
  return { f, d, module, runtime, controller, calls, scheduled, setEvents(value) { events = value; },
    readPlanning: now => nativeMocks['./v2-local-planning'].readV2LocalPlanning({ userId: scope.userId, assertAccess: guard }, now),
    completionCalls: () => completionCalls, stopDuringPersonalRead() { failPersonal = true; }, close() { d.connection.close(); } };
}

test('native shared Tasks and reminders include app calendar revisions and agree with screen recommendations without Google authorization', async () => {
  const h = await setup(); try {
    await h.d.repository.commit([{ operationId: 'heavy-local', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { load: 'heavy' } }]);
    const instant = new Date('2026-10-31T01:00:00Z'); const range = { from: '2026-11-01', through: '2026-11-09', asOfDate: '2026-10-31' };
    const model = await h.controller.readModel(range); const common = JSON.stringify(model.plan);
    const baseline = await h.readPlanning(instant); const first = baseline.personalize(model.plan).recommendations.find(row => row.date === '2026-11-03'); assert.ok(first);
    h.setEvents([{ ...newEventDraft('2026-11-03', 'Asia/Tokyo'), title: '非公開の予定', allDay: true, id: 'native-local-event', revision: 1 }]);
    const changed = await h.readPlanning(instant); assert.notEqual(changed.revision, baseline.revision);
    const taskPlan = changed.personalize(model.plan); assert.notEqual(taskPlan.recommendations.find(row => row.subjectOccurrenceId === first.subjectOccurrenceId).date, first.date);
    const session = screenModule.createV2ScreenSession({ controller: { readModel: async () => model }, userId: scope.userId, groupId: scope.groupId, now: () => instant,
      readPreferences: () => changed.preferences, privateTasks: changed.privateTasks, calendar: changed.calendar, localCalendar: changed.localCalendar });
    assert.deepEqual((await session.readModel()).personal, taskPlan); assert.equal(JSON.stringify(model.plan), common);
    assert.equal(JSON.stringify(taskPlan).includes('非公開の予定'), false); assert.equal(h.scheduled.size, 0);
  } finally { h.close(); }
});

test('native v2 reminders default off without permission, personal-data read or OAuth, then reuse owner-only planning', async () => {
  const h = await setup(); try {
    await h.runtime.synchronize(); assert.deepEqual(h.calls, []);
    await h.runtime.store.save(0, { enabled: true, hour: 10, minute: 0 }); await h.runtime.synchronize(); assert.ok(h.scheduled.size > 0);
    assert.equal(h.calls.filter(row=>row==='personal-read').length, 1); assert.equal(h.calls.filter(row=>row==='personal-open').length,h.calls.filter(row=>row==='personal-close').length);
    assert.ok([...h.scheduled.values()].every(row => row.key.startsWith(identity.v2NotificationPrefix(scope.userId, scope.groupId))));
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0, 'v2 stays out of legacy planner rows');
    assert.equal(h.calls.includes('request-permission'), false);
  } finally { h.close(); }
});

test('native shared Tasks and reminders use the same shared all-day calendar input as the screen without modifying formal chore dates', async () => {
  const h = await setup(); try {
    await h.d.repository.commit([{ operationId: 'heavy-shared', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { load: 'heavy' } }]);
    const instant = new Date('2026-10-31T01:00:00Z'); const range = { from: '2026-11-01', through: '2026-11-09', asOfDate: '2026-10-31' };
    const initial = await h.controller.readModel(range); const local = await h.readPlanning(instant);
    const original = local.personalize(initial.plan, initial.calendar).recommendations.find(row => row.date === '2026-11-03'); assert.ok(original);
    await h.controller.actions.saveCalendarEvent({ scope: 'series', anchorDate: null,
      value: { ...newEventDraft('2026-11-03', 'Asia/Tokyo'), title: 'Shared busy day', allDay: true }, category: { id: 'personal', name: '共有', color: '#348DC2', revision: 1 } });
    const model = await h.controller.readModel(range);
    const taskPlan = local.personalize(model.plan, model.calendar);
    assert.notEqual(taskPlan.recommendations.find(row => row.subjectOccurrenceId === original.subjectOccurrenceId).date, original.date);
    const session = screenModule.createV2ScreenSession({ controller: { readModel: async () => model }, userId: scope.userId, groupId: scope.groupId, now: () => instant,
      readPreferences: () => local.preferences, privateTasks: local.privateTasks, calendar: local.calendar, localCalendar: local.localCalendar });
    assert.deepEqual((await session.readModel()).personal, taskPlan);
    assert.deepEqual(model.plan.occurrences, initial.plan.occurrences);
    assert.equal(JSON.stringify(taskPlan).includes('Shared busy day'), false);
    assert.equal(h.calls.includes('request-permission'), false);
  } finally { h.close(); }
});

test('native v2 reminders close the personal handle and reject account changes during private read before native writes', async () => {
  const h = await setup(); try {
    await h.runtime.store.save(0, { enabled: true, hour: 10, minute: 0 }); h.stopDuringPersonalRead();
    await assert.rejects(h.runtime.synchronize(), /account changed/u); assert.deepEqual(h.calls, ['personal-open', 'local-calendar', 'personal-read', 'personal-close']); assert.equal(h.scheduled.size, 0);
  } finally { h.close(); }
});

test('native v2 cleanup retains valid current-account scopes and never cancels personal or v1 notifications', async () => {
  const h = await setup(); try {
    const valid = identity.v2NotificationPrefix(scope.userId, scope.groupId) + 'today'; const stale = identity.v2NotificationPrefix('previous-account', scope.groupId) + 'today';
    for (const key of [valid, stale, 'housework-digest:today', 'liflow-group-digest:' + 'a'.repeat(64) + ':today']) h.scheduled.set(key, { key, title: '', body: '', fireAt: '2026-10-30T00:00:00Z' });
    await h.module.clearInactiveV2Reminders([scope]); assert.equal(h.scheduled.has(stale), false); assert.equal(h.scheduled.size, 3); assert.ok(h.scheduled.has(valid));
    await assert.rejects(h.module.clearInactiveV2Reminders([], () => { throw new Error('superseded account'); }), /superseded account/u); assert.equal(h.scheduled.size, 3);
    await h.module.clearV2RemindersForScope(scope.userId, scope.groupId); assert.equal(h.scheduled.size, 2);
  } finally { h.close(); }
});

test('shared worker retains completion delivery without producing load alerts or reading private planning twice', async () => {
  const h = await setup(); try {
    await h.runtime.store.save(0, { enabled: true, hour: 10, minute: 0 });
    await h.runtime.synchronize();
    assert.equal(h.completionCalls(), 1);
    assert.equal(h.calls.filter(call => call === 'personal-read').length, 1);
    assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'immediate').length, 0);
    assert.ok([...h.scheduled.values()].every(row => row.key.startsWith(identity.v2NotificationPrefix(scope.userId, scope.groupId))));
  } finally { h.close(); }
});
