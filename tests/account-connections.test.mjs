import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

const flush = async screen => { for (let n = 0; n < 8; n++) await screen.flush(); };
const text = children => ({ type: 'Text', props: { children } });
function connections(platform, group = true, signedIn = true) {
  const calls = []; const moves = []; const privateLoads = []; const sourceLoads = [];
  const tasks = { readControl: async () => { calls.push('readTasks'); return { revision: 0, label: null, state: null }; },
    reviewConnection: async () => { calls.push('review'); return { subject: 'subject', label: 'TEST_GOOGLE', connectionRevision: 0 }; },
    connect: async () => calls.push('connect'), pause: async () => calls.push('pause'), synchronize: async () => calls.push('synchronize') };
  const calendar = { readControl: async () => { calls.push('readCalendar'); return { enabled: false, revision: 0 }; },
    prepareConnection: async () => calls.push('prepareCalendar'), connect: async () => calls.push('connectCalendar') };
  const userId = signedIn ? 'owner' : null;
  let deviceView = { ownerUserId: userId, phase: 'unconfigured', deviceId: null, mainDeviceId: null, authorityDigest: null,
    revision: null, keyVersion: null, keyReady: false, devices: [], reference: null, request: null, pendingChange: null, pendingKeys: 0, cache: null };
  const devices = { observeConnections: () => () => {}, subscribe: () => () => {}, read: async () => { calls.push('readDevices'); return deviceView; }, initializeFirstDevice: async () => {
    calls.push('initializeDevice'); deviceView = { ...deviceView, phase: 'approved', deviceId: 'device', mainDeviceId: 'device', keyReady: true,
      authorityDigest: 'authority', devices: [{ deviceId: 'device' }], reference: { anchor: { rootDigest: 'root' } } }; return deviceView;
  } };
  const context = { _currentValue: { userId, active: group ? { protocol: 2, userId: 'owner', groupId: 'group', identity: { deviceId: 'device' },
    googleTasks: async () => { calls.push('loadTasks'); return tasks; }, googleCalendar: async () => { calls.push('loadCalendar'); return calendar; } } : null } };
  let personalCalendarRenders = 0; let taskOpenings = 0;
  const screen = screenHarness('src/features/settings/account-connections.tsx', { exportName: 'AccountConnections', platform,
    effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(),
    props: { database: {}, settings: { restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 }, personalTasks: text('PERSONAL_TASKS'),
      calendarOptions: text('CALENDAR_AVAILABILITY'), onTasksOpen: () => taskOpenings++ }, navigate: (...value) => moves.push(value), mocks: {
      '@/contexts/workspace-context': { WorkspaceContext: context },
      '../calendar/personal-google-settings': { PersonalGoogleCalendarSettings: () => { personalCalendarRenders++; return text('PERSONAL_CALENDAR'); } },
      '../sharing/private-calendar/source-screen': { PrivateCalendarSourceScreen: props => { sourceLoads.push(props); return text('PRIVATE_CALENDAR_SOURCE'); } },
      '../sharing/private-planner/preference-screen': { PrivatePreferenceScreen: props => { privateLoads.push(props.load); return text('PRIVATE_SETTINGS_SYNC'); } },
      '../../platform/sharing/private-calendar-secrets': { nativePrivatePlannerPreferences: uid => { calls.push(['privateStore', uid]); return {}; } },
      '../../platform/sharing/private-calendar-runtime': { openPrivateCalendarRuntime: uid => { calls.push(['privateRuntime', uid]); return {}; } },
      '../../platform/sharing/private-calendar-devices': { openPrivateCalendarDevices: uid => { calls.push(['deviceSession', uid]); return devices; } },
      '../google-sync/calendar-availability': { getDeviceTimeZone: () => 'Asia/Tokyo' },
    } });
  return { screen, calls, context, privateLoads, sourceLoads, moves, taskOpenings: () => taskOpenings, personalCalendarRenders: () => personalCalendarRenders };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} account connections display all related controls immediately without granting access`, async t => {
    const h = connections(platform); t.after(() => h.screen.unmount());
    assert.ok(h.personalCalendarRenders() > 0); assert.equal(h.privateLoads.length, 0);
    await flush(h.screen);
    assert.match(h.screen.text(), /PERSONAL_CALENDAR/u); assert.doesNotMatch(h.screen.text(), /CALENDAR_AVAILABILITY/u);
    assert.match(h.screen.text(), /PRIVATE_CALENDAR_SOURCE/u);
    assert.ok(h.screen.nodes().some(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === '共有予定をGoogleカレンダーに追加'));
    h.screen.button('同期を設定する');
    assert.match(h.screen.text(), /PERSONAL_TASKS/u); assert.match(h.screen.text(), /共有家事/u);
    assert.deepEqual(h.calls.filter(value => typeof value === 'string').sort(), ['loadCalendar', 'loadTasks', 'readCalendar', 'readDevices', 'readTasks']);
    assert.deepEqual(h.moves, []); assert.equal(h.taskOpenings(), 1);
    assert.equal(h.screen.nodes().some(node => node.props.accessibilityRole === 'button' && /(?:Googleカレンダー|Google Tasks|端末間同期)を(?:開く|閉じる)/u.test(node.props.accessibilityLabel ?? '')), false);
    assert.equal(h.screen.nodes().some(node => node.props.accessibilityLabel === '前の画面に戻る'), false);
  });

  test(`${platform} account connections preserve an unconfirmed Google review while editing neighboring controls`, async t => {
    const h = connections(platform); t.after(() => h.screen.unmount());
    await flush(h.screen);
    await h.screen.press('Googleアカウントを確認'); await flush(h.screen);
    assert.match(h.screen.text(), /TEST_GOOGLE/u); assert.equal(h.calls.includes('connect'), false);
    await h.screen.press('端末を追加'); await h.screen.change('端末の接続コード', 'unconfirmed draft');
    h.screen.render(); await flush(h.screen);
    h.screen.button('このアカウントで連携'); assert.equal(h.calls.filter(value => value === 'review').length, 1);
    assert.equal(h.calls.filter(value => value === 'readTasks').length, 2); assert.equal(h.calls.includes('connect'), false);
    assert.equal(h.calls.includes('initializeDevice'), false);
  });

  test(`${platform} private Calendar source and device setup remain in place with stale-account guards`, async t => {
    const h = connections(platform, false); t.after(() => h.screen.unmount());
    await flush(h.screen);
    const source = h.sourceLoads.at(-1); assert.equal(source.embedded, true); assert.match(h.screen.text(), /PRIVATE_CALENDAR_SOURCE/u);
    await source.loadRuntime(); assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'privateRuntime' && call[1] === 'owner'));
    h.screen.button('同期を設定する'); assert.deepEqual(h.moves, []);
    h.context._currentValue.userId = 'replacement'; h.screen.render(); await flush(h.screen); h.calls.length = 0;
    await assert.rejects(source.loadRuntime(), /アカウントが変わり/u); assert.deepEqual(h.calls, []);
  });

  test(`${platform} local and foreign-account connections never mount shared or protected settings`, async t => {
    const h = connections(platform, true, false); t.after(() => h.screen.unmount());
    await flush(h.screen);
    assert.equal(h.screen.nodes().some(node => node.props.accessibilityRole === 'header' && node.props.children === '端末間同期'), false);
    assert.doesNotMatch(h.screen.text(), /共有家事|共有予定をGoogle/u); assert.deepEqual(h.calls, []);
    assert.equal(h.privateLoads.length, 0);
    assert.match(h.screen.text(), /CALENDAR_AVAILABILITY/u); assert.equal(h.sourceLoads.length, 0);
  });

  test(`${platform} account device sync opens locally and rejects a stale owner before protected reads`, async t => {
    const h = connections(platform, false); t.after(() => h.screen.unmount());
    await flush(h.screen);
    assert.deepEqual(h.calls, [['deviceSession', 'owner'], 'readDevices']); assert.equal(h.privateLoads.length, 0);
    assert.equal(h.screen.nodes().some(node => node.props.accessibilityLabel === '同期する端末を管理'), false);
    assert.equal(h.calls.includes('initializeDevice'), false); await h.screen.press('同期を設定する'); await flush(h.screen);
    assert.equal(h.calls.filter(call => call === 'initializeDevice').length, 1);
    const load = h.privateLoads.at(-1); const session = await load();
    assert.deepEqual(session.defaults.restDays, [6, 7]); assert.deepEqual(session.defaults.allowedBands, []);
    assert.deepEqual(h.moves, []);
    assert.doesNotMatch(h.screen.text(), /信頼pin|空き時間のGoogle連携|接続情報/u);
    h.screen.button('接続コードを共有');
    h.context._currentValue.userId = 'replacement'; h.screen.render(); await flush(h.screen); h.calls.length = 0;
    await assert.rejects(load(), /アカウントが変わり/u); assert.deepEqual(h.calls, []);
  });

  test(`${platform} inline device setup retains its choice and draft across account rerenders without granting trust`, async t => {
    const h = connections(platform, false); t.after(() => h.screen.unmount());
    await flush(h.screen);
    await h.screen.press('端末を追加'); await h.screen.change('端末の接続コード', '{"draft":"unverified"}');
    h.screen.render(); await flush(h.screen);
    assert.equal(h.screen.nodes().find(node => node.props.accessibilityLabel === '端末の接続コード').props.value, '{"draft":"unverified"}');
    assert.deepEqual(h.calls, [['deviceSession', 'owner'], 'readDevices']); assert.equal(h.privateLoads.length, 0);
    assert.deepEqual(h.moves, []);
    assert.equal(h.screen.nodes().some(node => node.props.accessibilityLabel === '前の画面に戻る'), false);
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} embedded Calendar controls share the account lock without bypassing connection review`, async t => {
    for (const shared of [false, true]) await t.test(shared ? 'shared export' : 'personal calendar', async () => {
      let busy = true; let releases = 0; let resolve; const calls = [];
      const operation = { get busy() { return busy; }, acquire() { if (busy) return false; busy = true; return true; }, release() { busy = false; releases++; } };
      const runtime = { readControl: async () => ({ enabled: false, revision: 0, calendars: [] }), readConflicts: async () => [],
        prepareConnection: async () => { calls.push('review'); return new Promise(done => { resolve = done; }); },
        connect: async () => { calls.push('connect'); throw new Error('synthetic failure'); } };
      const file = shared ? 'src/features/calendar/shared-google-settings.tsx' : 'src/features/calendar/personal-google-settings.tsx';
      const screen = screenHarness(file, { exportName: shared ? 'SharedGoogleCalendarSettings' : 'PersonalGoogleCalendarSettings', platform,
        props: { embedded: true, runtime, database: {}, onBack() {} }, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
          '../settings/account-operation': { useAccountOperation: () => operation },
          '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => runtime },
          '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
        } });
      try {
        await flush(screen); const label = shared ? '共有予定をGoogleカレンダーに追加' : 'Googleカレンダーと個人予定を双方向同期';
        const toggle = () => screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label);
        assert.equal(toggle().props.accessibilityState.checked, false); assert.equal(toggle().props.disabled, true);
        busy = false; screen.render(); const staleToggle = toggle().props.onPress;
        busy = true; screen.render(); staleToggle(); await flush(screen); assert.deepEqual(calls, []);
        busy = false; screen.render(); toggle().props.onPress(); await flush(screen);
        assert.equal(busy, true); assert.deepEqual(calls, ['review']);
        resolve(shared ? { account: { label: 'REVIEWED_GOOGLE' }, calendars: [{ id: 'target', summary: 'REVIEWED_TARGET' }] } : {});
        await flush(screen); assert.equal(busy, false); assert.equal(releases, 1);
        if (shared) { assert.deepEqual(calls, ['review']); await screen.press('REVIEWED_TARGET'); await flush(screen); }
        assert.deepEqual(calls, ['review', 'connect']); assert.equal(busy, false);
      } finally { screen.unmount(); }
    });
  });

  test(`${platform} embedded Tasks shares the account-operation lock and releases it after failed and unmounted work`, async () => {
    let resolveReview; let busy = true; let releases = 0; let grants = 0;
    const operation = { get busy() { return busy; }, acquire() { if (busy) return false; busy = true; return true; }, release() { busy = false; releases++; } };
    const runtime = { readControl: async () => ({ revision: 0, label: null, state: null }), reviewConnection: async () => {
      grants++; return new Promise(resolve => { resolveReview = resolve; });
    } };
    const screen = screenHarness('src/features/sharing/v2-ui/google-tasks-screen.tsx', { exportName: 'V2GoogleTasksScreen', platform,
      effectDependencies: true, effect: fn => fn(), props: { embedded: true, load: async () => runtime, onBack() {} },
      mocks: { '../../settings/account-operation': { useAccountOperation: () => operation } } });
    await flush(screen); const stalePress = screen.button('Googleアカウントを確認').props.onPress;
    assert.equal(screen.button('Googleアカウントを確認').props.disabled, true);
    await stalePress(); await flush(screen); assert.equal(grants, 0); assert.equal(releases, 0);
    busy = false; screen.render(); const reviewing = stalePress(); await flush(screen);
    assert.equal(grants, 1); assert.equal(busy, true); await stalePress(); assert.equal(grants, 1);
    resolveReview({ subject: 'subject', label: 'GOOGLE', connectionRevision: 0 }); await reviewing; await flush(screen);
    assert.equal(busy, false); assert.equal(releases, 1);
    runtime.connect = async () => { throw new Error('synthetic failure'); };
    await screen.press('このアカウントで連携'); await flush(screen); assert.equal(busy, false); assert.equal(releases, 2);
    const pending = stalePress(); await flush(screen); screen.unmount(); assert.equal(busy, true);
    resolveReview({ subject: 'subject', label: 'GOOGLE', connectionRevision: 0 }); await pending;
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(busy, false); assert.equal(releases, 3);
  });
}
