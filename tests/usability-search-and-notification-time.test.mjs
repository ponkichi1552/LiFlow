import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCalendarWithChores } from '../src/features/calendar/search.ts';
import { calendarChoreDisplayThrough } from '../src/features/calendar/chore-display-range.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const { readPersonalSettingsView } = await import('../src/platform/storage/personal-settings-view.ts');
const { createDailyHouseworkDigestRequests, syncDailyHouseworkDigest } = await import('../src/features/notifications/daily-housework-digest.ts');
const today = '2026-11-15';
const flush = async ui => { for (let i = 0; i < 16; i++) await ui.flush(); };
const dailyChores = count => Array.from({ length: count }, (_, i) => ({ key: `daily:${i}`, title: '食器を洗う', date: addDays(today, i), source: i % 2 ? 'shared' : 'personal' }));

test('calendar search keeps todays and tomorrows daily chores before distant matches within the supported horizon', () => {
  const chores = []; for (let day = today; day <= calendarChoreDisplayThrough(today); day = addDays(day, 1)) chores.push({ key: day, title: '食器を洗う', date: day, source: 'personal' });
  const before = structuredClone(chores), result = searchCalendarWithChores([], chores, '食器 を洗う', 60, today);
  assert.equal(chores.length, 78); assert.equal(result.matches.length, 60); assert.equal(result.more, true);
  assert.equal(result.matches[0].date, today); assert.equal(result.matches[1].date, addDays(today, 1)); assert.deepEqual(chores, before);
});

test('calendar search ranks nearby past and future results deterministically without hiding older matches', () => {
  const rows = [10, -1, -10, 1, 0].map(offset => ({ key: String(offset), title: '確認', date: addDays(today, offset), source: 'personal' }));
  const result = searchCalendarWithChores([], rows, '確認', Infinity, today);
  assert.deepEqual(result.matches.map(row => row.key), ['0', '1', '-1', '10', '-10']); assert.equal(result.more, false);
});

test('personal housework notification time saves atomically without changing enablement or another household', async t => {
  const h = createDatabase(), other = createDatabase(); t.after(() => { h.connection.close(); other.connection.close(); });
  await repository.initializeLocalDatabase(h.database); await repository.initializeLocalDatabase(other.database);
  const otherBefore = await readPersonalSettingsView(other.database);
  const before = await readPersonalSettingsView(h.database);
  await repository.setHouseworkNotificationTime(h.database, 18 * 60 + 30);
  const after = await readPersonalSettingsView(h.database);
  assert.deepEqual(after.settings, { ...before.settings, notificationHour: 18, notificationMinute: 30 });
  assert.deepEqual((await readPersonalSettingsView(other.database)).settings, otherBefore.settings);
  const changes = await h.database.getFirstAsync('SELECT total_changes() AS count');
  await repository.setHouseworkNotificationTime(h.database, 18 * 60 + 30);
  assert.deepEqual(await h.database.getFirstAsync('SELECT total_changes() AS count'), changes, 'saving the same clock does not rewrite its metadata');
  for (const value of [-1, 1440, 3.5, '600', NaN, Infinity]) await assert.rejects(repository.setHouseworkNotificationTime(h.database, value));
  assert.deepEqual((await readPersonalSettingsView(h.database)).settings, after.settings);
  await h.database.execAsync('CREATE TABLE sharing_v2_binding (singleton INTEGER PRIMARY KEY)');
  await assert.rejects(repository.setHouseworkNotificationTime(h.database, 10), /個人/u);
  assert.equal((await h.database.getFirstAsync('SELECT notification_hour FROM household_settings WHERE household_id=?', repository.LOCAL_HOUSEHOLD_ID)).notification_hour, 18);
});

test('changing the personal digest time replaces only its reservations and repeated reconciliation stays quiet', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const requests = new Map([['foreign', { key: 'foreign', title: 'Other account', body: 'Keep', fireAt: '2026-11-16T00:00:00.000Z', data: {} }]]);
  const writes = [], cancellations = [];
  const gateway = { hasPermission: async () => true, getScheduledRequests: async () => [...requests.values()],
    schedule: async request => { writes.push(request.key); requests.set(request.key, request); return request.key; },
    cancel: async key => { cancellations.push(key); requests.delete(key); } };
  const now = new Date('2026-11-15T00:00:00Z');
  const snapshot = async () => ({ timeZone: 'Asia/Tokyo', scheduleEntries: [{ id: 'entry', householdId: repository.LOCAL_HOUSEHOLD_ID, choreId: 'one', cycleBaseDate: today,
    suggestedDate: today, windowStart: today, windowEnd: today, status: 'inWindow', assignedMemberIds: [] }], chores: [{ id: 'one', name: '掃除' }], completions: [],
    settings: { ...(await readPersonalSettingsView(h.database)).settings, notificationsEnabled: true, setupCompleted: true } });
  await syncDailyHouseworkDigest(gateway, await snapshot(), now); writes.length = 0;
  await repository.setHouseworkNotificationTime(h.database, 18 * 60 + 30); const next = await snapshot();
  assert.equal(createDailyHouseworkDigestRequests(next, now)[0].fireAt, '2026-11-15T09:30:00.000Z');
  await syncDailyHouseworkDigest(gateway, next, now); assert.ok(writes.length); assert.ok(requests.has('foreign')); assert.equal(cancellations.includes('foreign'), false);
  writes.length = 0; cancellations.length = 0; await syncDailyHouseworkDigest(gateway, next, now);
  assert.deepEqual(writes, []); assert.deepEqual(cancellations, []);
});

for (const [platform, names] of [
  ['ios', { search: 'ios calendar search scrolls or explicitly loads every matching page and selects the original chore without writes',
    clock: 'ios personal notification time commits only on confirmation without requesting permission and retains failed saves',
    words: 'ios chore library accepts spaced reversed and width normalized terms while retaining its category expansion' }],
  ['android', { search: 'android calendar search scrolls or explicitly loads every matching page and selects the original chore without writes',
    clock: 'android personal notification time commits only on confirmation without requesting permission and retains failed saves',
    words: 'android chore library accepts spaced reversed and width normalized terms while retaining its category expansion' }],
]) {
  test(names.search, async t => {
    const chores = dailyChores(150), before = structuredClone(chores), selected = [];
    const ui = screenHarness('src/features/calendar/calendar-search.tsx', { exportName: 'CalendarSearch', platform, flatListItemHeight: 64,
      props: { focusDate: today, local: { snapshot: { events: [], exceptions: [], categories: [] }, loading: false, error: null }, chores,
        onClose() {}, onSelect: value => selected.push(value), resolveSelection: () => { throw new Error('A chore is not an editable appointment'); } } });
    t.after(() => ui.unmount()); await ui.change('予定を検索', '食器');
    const list = () => ui.nodes().find(node => node.type === 'FlatList');
    assert.equal(list().props.data.length, 60); assert.equal(list().props.data[0].date, today);
    assert.equal(typeof list().props.onEndReached, 'function'); list().props.onEndReached(); await ui.flush(); assert.equal(list().props.data.length, 120);
    await ui.press('続きを表示'); assert.equal(list().props.data.length, 150); assert.equal(ui.text().includes('検索語を追加して絞り込めます。'), false);
    await ui.change('予定を検索', '食器 を洗う'); assert.equal(list().props.data.length, 60, 'a new query starts at its first page');
    list().props.onEndReached(); await ui.flush(); await ui.press('続きを表示'); assert.equal(list().props.data.length, 150);
    list().props.onScroll({ nativeEvent: { contentOffset: { y: 149 * 64 } } }); await ui.flush();
    const last = ui.nodes().filter(node => node.props.accessibilityLabel === '食器を洗うの検索結果を開く').at(-1); last.props.onPress(); await ui.flush();
    if (platform === 'ios') { ui.nodes().find(node => node.type === 'Modal').props.onDismiss(); await ui.flush(); }
    assert.deepEqual(selected, [{ date: chores.at(-1).date, minute: null, choreKey: chores.at(-1).key, timedChoreId: undefined }]);
    assert.deepEqual(chores, before);
  });

  test(names.words, async t => {
    const chores = [{ id: 'one', name: 'トイレの清掃', category: '追加した家事', description: '布で拭く', instructions: [], tools: [], cautions: [] },
      { id: 'two', name: 'キッチンの清掃', category: '追加した家事', description: '布で拭く', instructions: [], tools: [], cautions: [] }];
    const ui = screenHarness('src/features/chores/chore-library.tsx', { exportName: 'ChoreLibrary', platform, props: { chores, onOpen() {} } });
    t.after(() => ui.unmount()); await ui.press('追加した家事、2件');
    for (const query of ['トイレ 清掃', '清掃　といれ', 'ﾄｲﾚ\t清掃']) {
      await ui.change('家事名を検索', query);
      assert.deepEqual(ui.nodes().filter(node => node.props.accessibilityLabel?.endsWith('の説明を開く')).map(node => node.props.accessibilityLabel), ['トイレの清掃の説明を開く']);
    }
    await ui.change('家事名を検索', ''); assert.equal(ui.button('追加した家事、2件').props.accessibilityState.expanded, true);
  });

  test(names.clock, async t => {
    const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database); await repository.setNotificationsEnabled(h.database, true);
    let snapshot = { ...await readPersonalSettingsView(h.database), today, timeZone: 'Asia/Tokyo' }, picker, permissionCalls = 0, failing = true;
    const refresh = async () => { snapshot = { ...snapshot, ...await readPersonalSettingsView(h.database) }; };
    const ui = screenHarness('src/app/settings.tsx', { platform, database: h.database, params: { section: 'general' }, snapshot: () => snapshot,
      refresh, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), datePicker: value => { picker = value; }, mocks: {
        '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { userId: null, active: null } } },
        '@/platform/storage/repository': { ...repository, setHouseworkNotificationTime: async (...args) => { if (failing) throw new Error('synthetic disk failure'); return repository.setHouseworkNotificationTime(...args); } },
        '@/features/google-sync/background-task': {}, '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
        '@/platform/google-tasks/google-sign-in-gateway': { hasGoogleTasksSession: async () => false },
        '@/platform/notifications/expo-local-notification-gateway': { ExpoLocalNotificationGateway: class { async requestPermission() { permissionCalls++; return true; } } },
      } }); t.after(() => ui.unmount()); await flush(ui);
    const pick = async () => { await ui.press('家事の通知時刻を選択'); const value = new Date('2026-11-15T18:30:00Z');
      if (platform === 'ios') {
        ui.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({}, value); ui.render();
        assert.equal((await readPersonalSettingsView(h.database)).settings.notificationHour, 9);
        await ui.press('家事の通知時刻の選択を完了');
      } else picker.onValueChange({}, value);
      await flush(ui);
    };
    await pick(); assert.match(ui.text(), /通知時刻を変更できませんでした/u); assert.equal(snapshot.settings.notificationHour, 9);
    failing = false; await pick(); assert.equal(snapshot.settings.notificationHour, 18); assert.equal(snapshot.settings.notificationMinute, 30);
    assert.equal(snapshot.settings.notificationsEnabled, true); assert.equal(permissionCalls, 0);
  });
}
