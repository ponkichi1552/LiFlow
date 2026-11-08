import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const { readPersonalSettingsView } = await import('../src/platform/storage/personal-settings-view.ts');
const { searchJapaneseMunicipalities } = await import('../src/features/weather/municipality-search.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const repository = await import('../src/platform/storage/repository.ts');
const flush = async screen => { for (let i = 0; i < 12; i++) await screen.flush(); };

for (const platform of ['ios', 'android']) {
  test(`${platform} general settings expose all controls in one page and preserve saves and drafts across appearance changes`, async t => {
    const h = createDatabase(); await repository.initializeLocalDatabase(h.database); await repository.setNotificationsEnabled(h.database, false);
    let snapshot = { ...await readPersonalSettingsView(h.database), today: '2026-11-08', timeZone: 'Asia/Tokyo' };
    const refresh = async () => { snapshot = { ...snapshot, ...await readPersonalSettingsView(h.database) }; };
    let permissions = 0, googleReads = 0, datePicker; const routes = [], appearance = [];
    const candidate = searchJapaneseMunicipalities('横浜市')[0]; assert.ok(candidate);
    const screen = screenHarness('src/app/settings.tsx', { platform, database: h.database, params: { section: 'general' },
      snapshot: () => snapshot, refresh, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(),
      navigate: (...args) => routes.push(args), setAppAppearance: value => appearance.push(value), datePicker: value => { datePicker = value; }, mocks: {
        '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { userId: null, active: null } } },
        '@/features/google-sync/background-task': {},
        '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
        '@/platform/google-tasks/google-sign-in-gateway': { hasGoogleTasksSession: async () => { googleReads++; return false; } },
        '@/platform/notifications/expo-local-notification-gateway': { ExpoLocalNotificationGateway: class { async requestPermission() { permissions++; return true; } } },
        '@/features/weather/use-municipality-suggestions': { useMunicipalitySuggestions: (_query, enabled) => ({ status: 'idle', candidates: enabled ? [candidate] : [] }) },
      } });
    t.after(() => { screen.unmount(); h.connection.close(); }); await flush(screen);
    for (const title of ['表示', '通知・ウィジェット', '天気予報・洗濯', '誕生日', 'このアプリについて']) {
      assert.ok(screen.nodes().some(node => node.props.accessibilityRole === 'header' && node.props.children === title));
    }
    assert.equal(permissions, 0); assert.equal(googleReads, 0); assert.deepEqual(routes, []);
    const query = '横浜市'; await screen.change('天気予報に使う市区町村', query); await screen.press('ダーク'); await flush(screen);
    assert.deepEqual(appearance, ['dark']); assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '天気予報に使う市区町村').props.value, query);
    await screen.press(`地域 ${candidate.label} を選択`); await flush(screen);
    assert.equal(snapshot.settings.weatherLocation.municipalityId, candidate.id);
    const notify = screen.nodes().find(node => node.props.accessibilityLabel === '家事の通知を受け取る'); notify.props.onPress(); await flush(screen);
    assert.equal(permissions, 1); assert.equal(snapshot.settings.notificationsEnabled, true);
    await screen.press('自分の誕生日を選択');
    if (platform === 'ios') {
      screen.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({}, new Date('2000-02-29T12:00:00Z')); screen.render();
      await screen.press('自分の誕生日の選択を完了');
    } else datePicker.onValueChange({}, new Date('2000-02-29T12:00:00Z'));
    await flush(screen);
    assert.ok((await readLocalCalendar(h.database)).events.some(event => event.title === '誕生日' && event.birthday && event.startDate === '2000-02-29'));
    assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'link').length, 3);
    assert.equal(googleReads, 0); assert.deepEqual(routes, []);
  });

  test(`${platform} inline group notification settings only read the current account and reject stale actions`, async t => {
    const calls = []; let load;
    const runtime = { store: { read: async () => { calls.push('read'); return {}; }, save: async () => { calls.push('save'); return {}; } },
      requestPermission: async () => { calls.push('permission'); return true; }, permissionStatus: async () => true,
      synchronize: async () => ({ skippedDates: [] }), clear: async () => ({}) };
    const active = { protocol: 2, userId: 'owner', groupId: 'group', identity: { deviceId: 'device' }, reminders: async () => { calls.push('load'); return runtime; } };
    const context = { _currentValue: { userId: 'owner', active } };
    const screen = screenHarness('src/features/settings/general-group-notifications.tsx', { exportName: 'GeneralGroupNotifications', platform,
      effectDependencies: true, layoutEffect: fn => fn(), mocks: {
        '../../contexts/workspace-context': { WorkspaceContext: context },
        '../sharing/v2-ui/reminder-screen': { V2ReminderScreen: props => { assert.equal(props.embedded, true); load = props.load; return null; } },
      } });
    t.after(() => screen.unmount()); const firstLoad = load;
    assert.deepEqual(calls, []); const session = await load(); await session.store.read(); assert.deepEqual(calls, ['load', 'read']);
    context._currentValue = { userId: 'other', active }; screen.render(); calls.length = 0;
    await assert.rejects(firstLoad(), /参加状態/u); await assert.rejects(session.store.save(0, {}), /参加状態/u);
    await assert.rejects(session.requestPermission(), /参加状態/u); assert.deepEqual(calls, []);
  });
}
