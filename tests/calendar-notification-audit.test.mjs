import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { calendarNotificationRequests, CALENDAR_NOTIFICATION_PREFIX } from '../src/features/calendar/calendar-notifications.ts';
import { calendarReminderMinutes, calendarReminderScope } from '../src/features/calendar/reminder-preferences.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

const event = (id, date, timeZone, fields = {}) => ({ ...newEventDraft(date, timeZone), id, revision: 1, title: id, ...fields });

test('calendar day-before notices use the previous civil day and all-day reminders use the real start of a midnight gap', () => {
  const first = event('spring', '2026-03-09', 'America/New_York', { startMinute: 30, endMinute: 60 });
  const second = event('midnight-gap', '2018-11-04', 'America/Sao_Paulo', { allDay: true });
  const reminders = (source, minutes, now) => calendarNotificationRequests({
    enabled: true, rules: [{ scope: 'personal', eventId: source.id, anchorDate: null, minutes }],
  }, [{ scope: 'personal', events: [source], exceptions: [] }], Date.parse(now)).map(row => row.fireAt);
  assert.deepEqual(reminders(first, 1440, '2026-03-07T00:00:00Z'), ['2026-03-08T05:30:00.000Z']);
  assert.deepEqual(reminders(second, 0, '2018-11-03T00:00:00Z'), ['2018-11-04T03:00:00.000Z']);
  assert.deepEqual(reminders(second, 1440, '2018-11-02T00:00:00Z'), ['2018-11-03T03:00:00.000Z']);
  const skipped = event('skipped-date', '2011-12-30', 'Pacific/Apia', { allDay: true });
  assert.deepEqual(reminders(skipped, 1440, '2011-12-28T00:00:00Z'), []);
  const timedGap = event('timed-gap', '2026-03-09', 'America/New_York', { startMinute: 150, endMinute: 180 });
  assert.deepEqual(reminders(timedGap, 1440, '2026-03-07T00:00:00Z'), ['2026-03-08T06:30:00.000Z']);
  const timedFold = event('timed-fold', '2026-11-02', 'America/New_York', { startMinute: 90, endMinute: 120 });
  assert.deepEqual(reminders(timedFold, 1440, '2026-10-31T00:00:00Z'), ['2026-11-01T06:30:00.000Z']);
});

test('calendar notification search keeps the same 32 earliest keys without expanding all dense recurrence days', () => {
  const from = '2026-11-19', end = '2027-01-19', now = Date.parse(`${from}T00:00:00Z`);
  const scope = calendarReminderScope('test-account', 'test-group');
  let projections = 0;
  const events = Array.from({ length: 60 }, (_, index) => ({
    ...event(`dense-${index}`, from, 'UTC', { recurrence: 'daily', startMinute: 400 + index % 7, endMinute: 700 }),
    get title() { projections++; return `dense ${index}`; },
  }));
  const exceptions = [{ eventId: 'dense-4', anchorDate: from, revision: 1, override: null }, {
    eventId: 'dense-12', anchorDate: '2026-12-30', revision: 1,
    override: event('override', '2026-11-20', 'UTC', { startMinute: 90, endMinute: 100 }),
  }];
  const settings = { enabled: true, rules: events.flatMap((row, index) => [
    { scope, eventId: row.id, anchorDate: null, minutes: [0, 10, 60, 1440][index % 4] },
    { scope, eventId: row.id, anchorDate: '2026-11-20', minutes: index % 7 === 0 ? null : 10 },
  ]) };
  const reference = projectCalendarEvents(events, exceptions, from, end).flatMap(row => {
    const minutes = calendarReminderMinutes(settings, scope, row.eventId, row.anchorDate);
    const at = minutes === null ? 0 : Date.parse(row.startDate) + (row.startMinute - minutes) * 60000;
    return at > now ? [[at, CALENDAR_NOTIFICATION_PREFIX + sharedDocumentDigest([scope, row.eventId, row.anchorDate])]] : [];
  }).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, 32);
  projections = 0;
  const actual = calendarNotificationRequests(settings, [{ scope, events, exceptions }], now).map(row => [Date.parse(row.fireAt), row.key]);
  assert.deepEqual(actual, reference);
  assert.ok(projections < events.length * 15, `projected ${projections} daily occurrences for 32 reminders`);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} calendar reconciliation keeps existing notices through only the current shared workspace restoration`, async t => {
    const scope = calendarReminderScope('viewer', 'shared'), foreign = calendarReminderScope('other', 'shared');
    const record = { groupId: 'shared', userId: 'viewer', status: 'active' };
    const active = { protocol: 2, groupId: 'shared', userId: 'viewer', record: async () => record };
    const pending = scope => ({
      key: CALENDAR_NOTIFICATION_PREFIX + sharedDocumentDigest([scope, 'meeting', '2026-11-20']),
      data: { kind: 'calendar-event', scope, eventId: 'meeting', anchorDate: '2026-11-20' },
      title: '予定', body: '予定', fireAt: '2026-11-20T01:00:00Z',
    });
    const own = pending(scope), other = pending(foreign);
    const list = new Map([[own.key, own], [other.key, other]]);
    const gateway = { maximumScheduledRequests: 32, hasPermission: async () => true, getScheduledRequests: async () => [...list.values()],
      schedule: async row => { list.set(row.key, row); return row.key; }, cancel: async key => { list.delete(key); } };
    const personal = { snapshot: { events: [], exceptions: [] }, loading: false, error: null };
    const reminder = { settings: { enabled: true, rules: [scope, foreign].map(scope => ({ scope, eventId: 'meeting', anchorDate: null, minutes: 10 })) } };
    const workspace = { ready: true, userId: 'viewer', active: null, group: record, restoration: 'waiting' };
    let prepared;
    const display = { peek: () => prepared, subscribe: () => () => {} };
    const screen = screenHarness('src/features/calendar/calendar-notification-bridge.tsx', { exportName: 'CalendarNotificationBridge', platform,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
        '../../hooks/use-planner-data': { usePlannerData: () => ({ database: {} }) },
        '../../hooks/use-workspace': { useWorkspace: () => workspace },
        './use-local-calendar': { useLocalCalendar: () => personal },
        './use-calendar-reminders': { useCalendarReminders: () => reminder },
        '../sharing/v2-ui/workspace-data': { useWorkspaceDisplay: () => display },
        '../../platform/notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
        'expo-notifications': { addNotificationResponseReceivedListener: () => ({ remove() {} }), getLastNotificationResponse: () => null },
      } });
    t.after(() => screen.unmount());
    for (let i = 0; i < 12; i++) await screen.flush();
    assert.deepEqual([...list.keys()], [own.key], 'restoring known scope keeps only its own prior notification');
    workspace.active = active; workspace.restoration = null;
    for (let i = 0; i < 12; i++) await screen.flush();
    assert.deepEqual([...list.keys()], [own.key], 'a verified membership without display data still preserves that reminder');
    prepared = { model: { viewerUserId: 'viewer', plan: { groupId: 'shared', timeZone: 'UTC' }, calendar: [] } };
    for (let i = 0; i < 12; i++) await screen.flush();
    assert.deepEqual([...list.keys()], [], 'a definitive empty calendar deletes its old reminder');
    list.set(own.key, own); workspace.userId = 'other'; workspace.group = null; workspace.active = null; workspace.restoration = 'waiting';
    for (let i = 0; i < 12; i++) await screen.flush();
    assert.deepEqual([...list.keys()], [], 'restoring a different account must remove prior account notification metadata');
  });
}

test('a large local history schedules from its own notification horizon and resolves a previously delivered day outside the visible month', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-19T00:00:00Z') });
  const calendar = { database: {}, historyLimited: true, snapshot: { events: [], exceptions: [] }, loading: false, error: null };
  const upcoming = event('upcoming', '2026-12-01', 'UTC');
  const old = event('prior', '2026-05-09', 'UTC');
  const moved = { eventId: old.id, anchorDate: old.startDate, revision: 2, override: event('moved', '2026-09-14', 'UTC') };
  const workspace = { ready: true, userId: null, active: null, group: null };
  const prefs = { settings: { enabled: true, rules: [{ scope: 'personal', eventId: upcoming.id, anchorDate: null, minutes: 10 }] } };
  const display = { peek: () => undefined, subscribe: () => () => {} };
  const scheduled = new Map(), reads = [], navigations = [];
  let receive;
  const screen = screenHarness('src/features/calendar/calendar-notification-bridge.tsx', { exportName: 'CalendarNotificationBridge',
    effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      'expo-router': { router: { navigate: value => navigations.push(value) } },
      'expo-notifications': { addNotificationResponseReceivedListener: callback => { receive = callback; return { remove() {} }; },
        getLastNotificationResponse: () => null },
      '../../hooks/use-planner-data': { usePlannerData: () => ({ database: calendar.database }) },
      '../../hooks/use-workspace': { useWorkspace: () => workspace },
      './use-local-calendar': { useLocalCalendar: () => calendar },
      './use-calendar-reminders': { useCalendarReminders: () => prefs },
      '../sharing/v2-ui/workspace-data': { useWorkspaceDisplay: () => display },
      '../../platform/storage/calendar-events': {
        subscribeLocalCalendar: () => () => {},
        async readLocalCalendarEventSource(database, range, target) {
          assert.equal(database, calendar.database);
          reads.push(range ?? target);
          if (target) return { events: [old], exceptions: [moved] };
          return { events: [old, upcoming].filter(row => row.startDate >= range.from && row.startDate <= range.through), exceptions: [] };
        },
      },
      '../../platform/notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: {
        hasPermission: async () => true, getScheduledRequests: async () => [...scheduled.values()],
        schedule: async request => { scheduled.set(request.key, request); return request.key; }, cancel: async key => { scheduled.delete(key); },
      } },
    } });
  t.after(() => screen.unmount());
  for (let i = 0; i < 12; i++) await screen.flush();
  assert.deepEqual([...scheduled.values()].map(row => row.data.eventId), ['upcoming']);
  assert.deepEqual(reads, [{ from: '2026-11-17', through: '2027-01-22' }]);
  const response = { actionIdentifier: 'default', notification: { request: { identifier: 'old-reminder', content: { data: {
    kind: 'calendar-event', scope: 'personal', eventId: 'prior', anchorDate: old.startDate, date: old.startDate,
  } } } } };
  receive(response); receive(response);
  for (let i = 0; i < 12; i++) await screen.flush();
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].params.calendarDate, '2026-09-14');
  assert.deepEqual(reads.slice(1), [{ eventId: old.id, anchorDate: old.startDate }]);
});
