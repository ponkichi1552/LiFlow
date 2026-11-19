import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { calendarSearchIndex, searchCalendarWithChores } from '../src/features/calendar/search.ts';
import { calendarNotificationRequests, calendarNotificationDestination, CALENDAR_NOTIFICATION_PREFIX } from '../src/features/calendar/calendar-notifications.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { reconcileLocalNotifications } from '../src/features/notifications/reconcile-local-notifications.ts';
import { readAdaptivePersonalInside } from '../src/platform/storage/adaptive-personal-chores.ts';
const repo = await import('../src/platform/storage/repository.ts');
const store = await import('../src/platform/storage/calendar-events.ts');
const reminders = await import('../src/platform/storage/calendar-reminders.ts');
const event = (id, patch = {}) => ({ ...newEventDraft('2026-11-14', 'Asia/Tokyo'), title: id, id, revision: 1, ...patch });
const now = Date.parse('2026-11-14T00:00:00Z');
async function setup(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await repo.initializeLocalDatabase(h.database); return h;
}
async function flush(ui) { for (let i = 0; i < 14; i++) await ui.flush(); }

test('calendar search includes dated personal and shared chores with normalized names without turning source rows into editable appointments', () => {
  const chores = [ { key: 'personal:1', title: 'シンクの掃除', date: '2026-11-14', source: 'personal' }, { key: 'shared:1', title: 'シンクの掃除', date: '2026-11-15', source: 'shared' } ];
  const index = calendarSearchIndex([event('予定')], []); const before = JSON.stringify([index, chores]);
  assert.deepEqual(searchCalendarWithChores(index, [...chores, chores[0]], 'しんく 掃除').matches.map(row => row.key), ['shared:1', 'personal:1']);
  assert.equal(searchCalendarWithChores(index, chores, '予定').matches[0].draft.eventId, '予定');
  assert.equal(searchCalendarWithChores(index, chores, '').matches.length, 0);
  assert.equal(searchCalendarWithChores(index, chores, '掃除', 1).more, true);
  assert.equal(JSON.stringify([index, chores]), before);
});
for (const platform of ['ios', 'android']) {
  test(`${platform} selecting a chore search result opens its date and chore section without opening an editor or writing data`, async () => {
    const local = { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [] }, loading: false, error: null, refresh: async () => {} };
    const selected = []; const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', props: {
      today: '2026-11-14', timeZone: 'Asia/Tokyo', local, onSelectDate: day => selected.push(day), dayInfo: () => ({ loaded: true, total: 1 }),
      renderChores: day => `CHORE:${day}`, searchChores: [{ key: 'personal:1', title: 'シンクの掃除', date: '2026-11-15', source: 'personal' }],
    } });
    try {
      await ui.press('予定を検索する'); await ui.change('予定を検索', 'シンク'); await ui.press('シンクの掃除の検索結果を開く');
      if (platform === 'ios') { ui.nodes().find(row => row.type === 'Modal').props.onDismiss(); await ui.flush(); }
      assert.ok(selected.includes('2026-11-15')); assert.match(ui.text(), /CHORE:2026-11-15/);
      assert.ok(!ui.nodes().some(row => row.props.accessibilityLabel === '予定を保存'));
    } finally { ui.unmount(); }
  });
  test(`${platform} known empty agenda days stay compact when waste uses a custom renderer`, async () => {
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', props: {
      today: '2026-11-14', selectedDate: '2026-11-14', timeZone: 'Asia/Tokyo', wasteSchedules: [],
      dayInfo: () => ({ loaded: true, total: 0, pending: 0 }), renderChores: () => null, renderWaste: () => null,
    } });
    try {
      await selectCalendarView(ui, 'リスト表示');
      assert.ok(ui.text().includes('予定なし'));
      assert.ok(!ui.nodes().some(node => node.props.accessibilityLabel?.includes('の家事を開く')));
    } finally { ui.unmount(); }
  });
  test(`${platform} agenda keeps existing events visible and waits for the local read before declaring an empty day`, async t => {
    const date = '2026-11-14';
    const existing = { ...newEventDraft(date, 'Asia/Tokyo'), id: 'existing', revision: 1, title: '保存済みの予定' };
    const local = { database: {}, snapshot: { events: [existing], exceptions: [], categories: [], drafts: [] }, loading: true, error: null, refresh: async () => {} };
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', props: {
      today: date, timeZone: 'Asia/Tokyo', local, wasteSchedules: [], dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
    } });
    t.after(() => ui.unmount());
    await selectCalendarView(ui, 'リスト表示');
    assert.match(ui.text(), /予定を読み込み中/u);
    assert.doesNotMatch(ui.text(), /予定なし/u);
    assert.ok(ui.button('保存済みの予定を編集'));
    local.loading = false; ui.render(); await ui.flush();
    assert.doesNotMatch(ui.text(), /予定を読み込み中/u);
    assert.match(ui.text(), /予定なし/u);
    assert.ok(ui.button('保存済みの予定を編集'));
  });
  test(`${platform} a read-only event can retry loading reminders and save only its own notification`, async t => {
    const h = await setup(t);
    const date = '2026-11-14';
    const value = { ...newEventDraft(date, 'Asia/Tokyo'), title: '閲覧のみの予定' };
    const eventId = await store.saveCalendarEvent(h.database, { expectedRevision: 0, value });
    await reminders.setCalendarNotificationsEnabled(h.database, true);
    const snapshot = await store.readLocalCalendar(h.database);
    const read = h.database.getAllAsync;
    let reads = 0;
    h.database.getAllAsync = async (sql, ...params) => {
      if (sql === 'SELECT * FROM calendar_notification_rules' && ++reads === 1) throw new Error('temporary SQLite read failure');
      return read(sql, ...params);
    };
    let saved = 0;
    const local = { database: h.database, snapshot, loading: false, error: null, refresh: async () => {}, canEditEvent: () => false };
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { platform, exportName: 'CalendarEditor',
      effectDependencies: true, effect: cb => cb(), props: { local, initial: { eventId, revision: 1, exceptionRevision: 0, scope: 'series', anchorDate: null, value },
        onClose() {}, onSaved() { saved++; } } });
    t.after(() => ui.unmount());
    await flush(ui);
    assert.match(ui.text(), /予定の詳細.*通知設定を読み込めませんでした/su);
    assert.equal(ui.button('予定の通知を保存').props.disabled, true);
    assert.equal(saved, 0);
    await ui.press('通知設定を再読み込み'); await flush(ui);
    assert.doesNotMatch(ui.text(), /通知設定を読み込めませんでした/u);
    assert.equal(reads, 2);
    await ui.press('予定の通知を選択');
    if (platform === 'ios') {
      ui.nodes().find(node => node.props.testID === 'calendar-option-wheel').props.onValueChange('10');
      await ui.press('予定の通知の選択を完了');
    } else await ui.press('10分前');
    await ui.press('予定の通知を保存'); await flush(ui);
    assert.equal(saved, 1);
    assert.equal(reminders.calendarReminderMinutes(await reminders.readCalendarReminders(h.database), 'personal', eventId, null), 10);
    assert.deepEqual((await store.readLocalCalendar(h.database)).events, snapshot.events);
  });
  test(`${platform} chore search candidates are loaded only when search opens`, async () => {
    const local = { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [] }, loading: false, error: null, refresh: async () => {} };
    let loads = 0; const selected = [];
    const props = {
      today: '2026-11-14', timeZone: 'Asia/Tokyo', local, onSelectDate: day => selected.push(day), dayInfo: () => ({ loaded: true, total: 1 }),
      renderChores: day => `CHORE:${day}`, loadSearchChores: () => { loads++; return [{ key: 'personal:lazy', title: '窓の掃除', date: '2026-11-15', source: 'personal' }]; },
    };
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', props });
    try {
      assert.equal(loads, 0, 'ordinary calendar rendering does not construct search candidates');
      await ui.press('予定を検索する'); assert.equal(loads, 1);
      await ui.change('予定を検索', '窓'); assert.equal(loads, 1);
      ui.button('窓の掃除の検索結果を開く');
      props.loadSearchChores = () => { loads++; return [{ key: 'personal:lazy', title: '窓の掃除', date: '2026-11-16', source: 'personal' }]; };
      await ui.flush(); assert.equal(loads, 2, 'an open search uses the changed chore source once');
      await ui.press('窓の掃除の検索結果を開く');
      if (platform === 'ios') { ui.nodes().find(row => row.type === 'Modal').props.onDismiss(); await ui.flush(); }
      assert.ok(selected.includes('2026-11-16')); assert.equal(loads, 2);
    } finally { ui.unmount(); }
  });
  test(`${platform} event notification choice saves atomically with the actual event while leaving housework notifications unchanged`, async t => {
    const h = await setup(t); const local = { database: h.database, snapshot: await store.readLocalCalendar(h.database), loading: false, error: null, refresh: async () => {} };
    let saved = 0; const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { platform, exportName: 'CalendarEditor', effectDependencies: true, effect: fn => fn(), props: {
      local, initial: { eventId: null, revision: 0, scope: 'series', anchorDate: null, exceptionRevision: 0, value: { ...newEventDraft('2026-11-15', 'Asia/Tokyo'), title: '打ち合わせ' } }, onClose() {}, onSaved() { saved++; },
    } });
    try {
      await flush(ui); await ui.press('予定の通知を選択');
      if (platform === 'ios') { ui.nodes().find(row => row.props.testID === 'calendar-option-wheel').props.onValueChange('10'); await ui.flush(); await ui.press('予定の通知の選択を完了'); }
      else await ui.press('10分前');
      await ui.press('予定を保存'); await flush(ui); assert.equal(saved, 1);
      const settings = await reminders.readCalendarReminders(h.database); assert.equal(settings.enabled, false); assert.equal(settings.rules[0].minutes, 10);
      const events = (await store.readLocalCalendar(h.database)).events; assert.equal(events.length, 1); assert.equal(settings.rules[0].eventId, events[0].id);
      const own = h.connection.prepare('SELECT notifications_enabled FROM household_settings').get(); assert.equal(own.notifications_enabled, 0);
    } finally { ui.unmount(); }
  });
}

test('calendar reminder preferences survive reopen and invalid timing rolls back event creation without altering housework settings', async t => {
  const h = await setup(t);
  await assert.rejects(store.saveCalendarEvent(h.database, { expectedRevision: 0, value: event('invalid'), reminderMinutes: 7 }), /通知/);
  assert.equal((await store.readLocalCalendar(h.database)).events.length, 0);
  const id = await store.saveCalendarEvent(h.database, { expectedRevision: 0, value: event('面談'), reminderMinutes: 10 });
  await reminders.setCalendarNotificationsEnabled(h.database, true);
  assert.equal((await reminders.readCalendarReminders(h.database)).rules[0].eventId, id);
  await repo.setNotificationsEnabled(h.database, true);
  await reminders.setCalendarNotificationsEnabled(h.database, false);
  assert.equal(h.connection.prepare('SELECT notifications_enabled FROM household_settings').get().notifications_enabled, 1);
  assert.equal((await reminders.readCalendarReminders(h.database)).rules[0].minutes, 10);
});
test('calendar notifications follow recurring overrides deletion timing and current account scope and exclude unselected events', () => {
  const base = event('面談', { recurrence: 'daily', startDate: '2026-11-14', endDate: '2026-11-14', startMinute: 600, endMinute: 660 });
  const exceptions = [{ eventId: base.id, anchorDate: '2026-11-15', revision: 1, override: null }, { eventId: base.id, anchorDate: '2026-11-16', revision: 1, override: { ...base, title: '移動した面談', startDate: '2026-11-17', endDate: '2026-11-17', startMinute: 720, endMinute: 780 } }];
  const settings = { enabled: true, rules: [{ scope: 'personal', eventId: base.id, anchorDate: null, minutes: 10 }] };
  const source = { scope: 'personal', events: [base, event('未指定')], exceptions };
  const rows = calendarNotificationRequests(settings, [source], now);
  assert.equal(rows[0].fireAt, '2026-11-14T00:50:00.000Z');
  assert.ok(!rows.some(row => row.data.anchorDate === '2026-11-15'));
  const moved = rows.find(row => row.data.anchorDate === '2026-11-16'); assert.equal(moved.title, '移動した面談'); assert.equal(moved.fireAt, '2026-11-17T02:50:00.000Z');
  assert.ok(!rows.some(row => row.title === '未指定')); assert.ok(rows.length <= 32);
  assert.deepEqual(calendarNotificationDestination(moved.data, [source], 'Asia/Tokyo'), { date: '2026-11-17', minute: 720 });
  assert.equal(calendarNotificationDestination(moved.data, [{ ...source, events: [] }], 'Asia/Tokyo'), null);
  const foreign = reminders.calendarReminderScope('other-user', 'group');
  assert.equal(calendarNotificationRequests({ enabled: true, rules: [{ ...settings.rules[0], scope: foreign }] }, [source], now).length, 0);
  assert.equal(calendarNotificationDestination({ ...moved.data, scope: foreign }, [source], 'Asia/Tokyo'), null);
  assert.deepEqual(calendarNotificationRequests({ ...settings, enabled: false }, [source], now), []);
});
test('calendar reconciliation cancels its stale notices after off or deletion while preserving housework and respecting native capacity', async () => {
  const requests = new Map([['housework-digest:2026-11-14', { key: 'housework-digest:2026-11-14', title: '家事', body: '', fireAt: '2026-11-14T12:00Z' }]]);
  const gateway = { maximumScheduledRequests: 3, hasPermission: async () => true, getScheduledRequests: async () => [...requests.values()], schedule: async row => { requests.set(row.key, row); return row.key; }, cancel: async key => { requests.delete(key); } };
  const source = { scope: 'personal', events: [event('面談', { recurrence: 'daily' })], exceptions: [] };
  const settings = { enabled: true, rules: [{ scope: 'personal', eventId: '面談', anchorDate: null, minutes: 0 }] };
  const desired = calendarNotificationRequests(settings, [source], now);
  const result = await reconcileLocalNotifications(gateway, { prefix: CALENDAR_NOTIFICATION_PREFIX, enabled: true, desired });
  assert.equal(result.scheduled, 2); assert.equal(requests.size, 3);
  await reconcileLocalNotifications(gateway, { prefix: CALENDAR_NOTIFICATION_PREFIX, enabled: false, desired: [] });
  assert.deepEqual([...requests.keys()], ['housework-digest:2026-11-14']);
});
test('pending personal chore date change retains the exact round cadence history and clock and rejects stale writes with retry safety', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); const h = await setup(t);
  await repo.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1,2,3,4,5,6,7], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
  const chore = await repo.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.create', name: '植物の水やり', date: '2026-11-15', repeat: true, intervalDays: 14,
    timing: { allDay: false, endDayOffset: 0, startMinute: 600, endMinute: 615, timeZone: 'Asia/Tokyo' } });
  const before = await repo.readPersonalCalendarChore(h.database, chore.id); const history = h.connection.prepare('SELECT COUNT(*) n FROM chore_completions').get().n;
  const command = { operationId: 'calendar-intent.change-date', choreId: chore.id, roundId: before.roundId, planRevision: before.planRevision, definition: before.signature, date: '2026-11-20', recordedAt: new Date(now).toISOString() };
  await repo.movePersonalChoreDate(h.database, command); await repo.movePersonalChoreDate(h.database, command);
  const after = await readAdaptivePersonalInside(h.database, chore.id); assert.equal(after.plan.id, before.roundId); assert.equal(after.plan.recommendedDate, command.date);
  assert.equal(after.plan.slot.start, Date.parse('2026-11-20T01:00:00Z')); assert.equal(after.plan.slot.end - after.plan.slot.start, 15 * 60_000);
  assert.equal((await repo.readPersonalCalendarChore(h.database, chore.id)).signature, before.signature); assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM chore_completions').get().n, history);
  await assert.rejects(repo.movePersonalChoreDate(h.database, { ...command, operationId: 'calendar-intent.stale', date: '2026-11-21' }), /更新/);
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).plan.recommendedDate, command.date);
});

test('manual seasonal occurrence dates persist across region refresh without moving the other work kind or creating completion history', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); const h = await setup(t);
  const definitions = (await repo.loadPlannerSnapshot(h.database)).chores;
  const chore = definitions.find(row => row.personalSchedulingKind === 'seasonal'); assert.ok(chore);
  await repo.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1,2,3,4,5,6,7], enabledChoreIds: [chore.id], previousDates: {}, weatherLocation: null });
  const before = (await repo.loadPlannerSnapshot(h.database)).scheduleEntries.filter(row => row.choreId === chore.id); assert.equal(before.length, 2);
  const selected = await repo.readPersonalChoreDate(h.database, chore.id, before[0].id);
  await repo.movePersonalChoreDate(h.database, { operationId: 'calendar-intent.seasonal', recordedAt: new Date(now).toISOString(), choreId: chore.id,
    roundId: selected.roundId, planRevision: selected.planRevision, definition: selected.signature, date: '2026-12-05' });
  const after = (await repo.loadPlannerSnapshot(h.database)).scheduleEntries.filter(row => row.choreId === chore.id);
  assert.equal(after.find(row => row.id === before[0].id).suggestedDate, '2026-12-05'); assert.deepEqual(after.find(row => row.id === before[1].id), before[1]);
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM chore_completions').get().n, 0);
});

for (const platform of ['ios', 'android']) test(`${platform} calendar notification switch requests permission only when enabling and denial leaves all saved notification settings intact`, async t => {
  const h = await setup(t); await repo.setNotificationsEnabled(h.database, true);
  let allowed = false; let requests = 0;
  const ui = screenHarness('src/features/calendar/calendar-notification-settings.tsx', { platform, exportName: 'CalendarNotificationSettings', effectDependencies: true, effect: fn => fn(), props: { database: h.database }, mocks: {
    '../../platform/notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: { requestPermission: async () => { requests++; return allowed; } } },
  } });
  try {
    await flush(ui);
    const checkbox = () => ui.nodes().find(node => node.props.accessibilityRole === 'checkbox');
    await checkbox().props.onPress(); await flush(ui);
    assert.equal(requests, 1); assert.equal((await reminders.readCalendarReminders(h.database)).enabled, false);
    assert.ok(ui.nodes().some(node => node.props.accessibilityRole === 'alert'));
    ui.button('端末の設定を開く');
    allowed = true; await checkbox().props.onPress(); await flush(ui); assert.equal((await reminders.readCalendarReminders(h.database)).enabled, true);
    await checkbox().props.onPress(); await flush(ui); assert.equal(requests, 2); assert.equal((await reminders.readCalendarReminders(h.database)).enabled, false);
    assert.equal(h.connection.prepare('SELECT notifications_enabled FROM household_settings').get().notifications_enabled, 1);
  } finally { ui.unmount(); }
});

test('calendar reminder reads cannot migrate or write a shared-only database', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); h.connection.exec('CREATE TABLE sharing_v2_binding(singleton INTEGER PRIMARY KEY,user_id TEXT,group_id TEXT)');
  const before = h.connection.serialize();
  await assert.rejects(reminders.readCalendarReminders(h.database), /個人の保存先/);
  await assert.rejects(reminders.setCalendarNotificationsEnabled(h.database, true), /個人の保存先/);
  await assert.rejects(reminders.saveCalendarReminder(h.database, { scope: 'personal', eventId: 'event.test', anchorDate: null, minutes: 10 }), /個人の保存先/);
  assert.deepEqual(h.connection.serialize(), before);
});
