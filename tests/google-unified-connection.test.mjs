import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

const account = { subject: 'google-owner', label: 'SYNTHETIC_ACCOUNT', authorized: true };
const settle = async screen => { for (let n = 0; n < 12; n++) await screen.flush(); };
const toggle = async (screen, label) => {
  const node = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label);
  assert.ok(node, label); assert.equal(Boolean(node.props.disabled), false); await node.props.onPress(); await settle(screen);
};
const hook = value => ({ useGoogleConnection: () => value });
const connected = () => ({ account, ready: true, loading: false, busy: false, reconnect: async () => assert.fail('feature toggle reopened authorization') });

for (const platform of ['ios', 'android']) {
  test(`${platform} unified connection authorizes once without enabling features and rejects stale completion after navigation`, async t => {
    const calls = []; let resolve; let current = null;
    const props = { database: {}, children: 'FEATURES' };
    const screen = screenHarness('src/features/settings/google-connection.tsx', { exportName: 'GoogleConnectionProvider', platform, props,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
        '../../platform/google-tasks/google-sign-in-gateway': { readGoogleSyncConnection: async () => current,
          authorizeGoogleSyncConnection: async () => { calls.push('authorize'); return await new Promise(done => { resolve = done; }); } },
        '../google-sync/account-switch': { activateCurrentGoogleTaskAccount: async (db, subject) => { assert.equal(db, props.database); assert.equal(subject, account.subject); calls.push('bind'); } },
      } });
    t.after(() => screen.unmount()); await settle(screen); assert.deepEqual(calls, []);
    const pending = screen.button('Googleと接続').props.onPress(); void pending; await settle(screen);
    const action = screen.button('Googleと接続中…'); assert.equal(action.props.disabled, true); action.props.onPress(); await settle(screen);
    assert.deepEqual(calls, ['authorize']); current = account; resolve(account); await settle(screen);
    assert.deepEqual(calls, ['authorize', 'bind']); assert.match(screen.text(), /Googleと接続済み/u);
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'Googleと接続'), false);

    current = null;
    const abandoned = screenHarness('src/features/settings/google-connection.tsx', { exportName: 'GoogleConnectionProvider', platform, props,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
        '../../platform/google-tasks/google-sign-in-gateway': { readGoogleSyncConnection: async () => null,
          authorizeGoogleSyncConnection: async () => await new Promise(done => { resolve = done; }) },
        '../google-sync/account-switch': { activateCurrentGoogleTaskAccount: async () => assert.fail('abandoned connection activated data') },
      } });
    await settle(abandoned); abandoned.button('Googleと接続').props.onPress(); await settle(abandoned); abandoned.unmount(); resolve(account); await settle(abandoned);
  });

  test(`${platform} unified connection cancellation and partial permission failures keep feature access closed without automatic retries`, async t => {
    for (const name of ['GoogleAuthorizationCancelledError', 'CalendarPermissionRequiredError']) {
      let attempts = 0;
      const screen = screenHarness('src/features/settings/google-connection.tsx', { exportName: 'GoogleConnectionProvider', platform, props: { database: {} },
        effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
          '../../platform/google-tasks/google-sign-in-gateway': { readGoogleSyncConnection: async () => null,
            authorizeGoogleSyncConnection: async () => { attempts++; throw Object.assign(new Error('synthetic failure'), { name }); } },
          '../google-sync/account-switch': { activateCurrentGoogleTaskAccount: async () => assert.fail('unconfirmed account bound') },
        } });
      t.after(() => screen.unmount()); await settle(screen); await screen.press('Googleと接続'); await settle(screen);
      assert.equal(attempts, 1); screen.button('Googleと接続'); assert.doesNotMatch(screen.text(), /接続済み/u);
    }
  });

  test(`${platform} unified shared Tasks checkbox uses revision-bound connect and pause without a second account review UI`, async t => {
    let control = { revision: 0, label: null, state: null }; const calls = []; let finishSync;
    const runtime = { readControl: async () => control,
      reviewConnection: async () => { calls.push('read-binding'); return { ...account, connectionRevision: control.revision }; },
      connect: async review => { assert.equal(review.subject, account.subject); assert.equal(review.connectionRevision, control.revision);
        calls.push('connect'); control = { revision: control.revision + 1, label: account.label, state: { accountSubject: account.subject, enabled: true } }; },
      pause: async revision => { assert.equal(revision, control.revision); calls.push('pause'); control = { ...control, revision: revision + 1, state: { ...control.state, enabled: false } }; },
      synchronize: async () => { calls.push('sync'); return await new Promise(resolve => { finishSync = resolve; }); } };
    const screen = screenHarness('src/features/sharing/v2-ui/google-tasks-screen.tsx', { exportName: 'V2GoogleTasksScreen', platform,
      props: { embedded: true, load: async () => runtime, onBack() {} }, effectDependencies: true, effect: fn => fn(),
      mocks: { '../../settings/google-connection': hook(connected()) } });
    t.after(() => screen.unmount()); await settle(screen); assert.deepEqual(calls, []);
    await toggle(screen, '共有家事をGoogle Tasksと同期'); assert.deepEqual(calls, ['read-binding', 'connect', 'sync']);
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'このアカウントで連携'), false);
    await toggle(screen, '共有家事をGoogle Tasksと同期'); assert.deepEqual(calls, ['read-binding', 'connect', 'sync', 'pause']);
    finishSync({ kind: 'success' }); await settle(screen);
    assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '共有家事をGoogle Tasksと同期').props.accessibilityState.checked, false);
  });

  test(`${platform} unified personal Tasks stays OFF until chosen and disables new activation without a Google connection`, async t => {
    const connection = connected(); const calls = [];
    const props = { state: null, busy: false, loaded: true, shared: true, onToggle: value => calls.push(value), onSync: () => calls.push('sync') };
    const screen = screenHarness('src/features/settings/personal-google-tasks-settings.tsx', { exportName: 'AccountPersonalGoogleTasks', platform, props,
      mocks: { './google-connection': hook(connection) } });
    t.after(() => screen.unmount()); assert.deepEqual(calls, []); assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === '今すぐ同期'), false);
    await toggle(screen, 'Google Tasksの自動同期'); assert.deepEqual(calls, [true]);
    connection.ready = false; screen.render(); const disabled = screen.nodes().find(node => node.props.accessibilityLabel === 'Google Tasksの自動同期');
    assert.equal(disabled.props.disabled, true); disabled.props.onPress(); assert.deepEqual(calls, [true]);
    props.state = { enabled: true, accountSubject: account.subject, status: 'idle' }; screen.render();
    await toggle(screen, 'Google Tasksの自動同期'); assert.deepEqual(calls, [true, false]);
  });

  test(`${platform} unified personal Calendar toggles use the existing account without another consent button`, async t => {
    const calls = []; let control = { enabled: false, subject: '', generation: 0, calendars: [] }; let leased = false;
    const operation = { get busy() { return leased; }, acquire: () => { if (leased) return false; leased = true; return true; }, release: () => { leased = false; } };
    const connection = { ...connected(), reconnect: async () => { assert.equal(leased, false, 'shared authentication must not nest the account lock'); calls.push('reauthenticate'); return true; } };
    const runtime = { readControl: async () => control, readConflicts: async () => [], isConnected: async () => control.enabled && !control.authRequired,
      prepareConnection: async () => { calls.push('prepare'); return { account }; }, connect: async () => { calls.push('connect'); control = { ...control, enabled: true, authRequired: false, subject: account.subject, generation: 1 }; },
      disable: async () => { calls.push('disable'); control = { ...control, enabled: false }; }, sync: async () => { calls.push('sync'); } };
    const screen = screenHarness('src/features/calendar/personal-google-settings.tsx', { exportName: 'PersonalGoogleCalendarSettings', platform,
      props: { database: {}, embedded: true }, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
        '../settings/google-connection': hook(connection), '../settings/account-operation': { useAccountOperation: () => operation }, '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => runtime },
        '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
        '../google-sync/background-task': { registerGoogleSyncBackgroundTask: async () => calls.push('register') },
      } });
    t.after(() => screen.unmount()); await settle(screen); assert.deepEqual(calls, []);
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'Googleと接続'), false);
    await toggle(screen, 'Googleカレンダーと個人予定を双方向同期'); assert.deepEqual(calls, ['prepare', 'connect', 'register', 'sync']);
    control.authRequired = true; screen.render(); await screen.press('Googleに再接続'); await settle(screen);
    assert.deepEqual(calls.slice(-5), ['reauthenticate', 'prepare', 'connect', 'register', 'sync']); assert.equal(control.authRequired, false);
    await toggle(screen, 'Googleカレンダーと個人予定を双方向同期'); assert.equal(calls.at(-1), 'disable');
  });

  test(`${platform} unified shared Calendar toggle keeps OFF inert and reuses the existing or primary writable destination`, async t => {
    let control = { enabled: false, revision: 0 }; const calls = []; let finishSync;
    const review = { revision: 0, account, calendars: [{ id: 'other', summary: 'OTHER' }, { id: 'primary', summary: 'PRIMARY', primary: true }] };
    const runtime = { readControl: async () => control, prepareConnection: async () => { calls.push('prepare'); return review; },
      connect: async (actual, id) => { assert.equal(actual, review); calls.push(['connect', id]); control = { revision: 1, enabled: true, subject: account.subject }; },
      disable: async revision => { assert.equal(revision, 1); calls.push('disable'); control = { ...control, revision: 2, enabled: false }; },
      synchronize: async () => { calls.push('sync'); return await new Promise(resolve => { finishSync = resolve; }); } };
    const screen = screenHarness('src/features/calendar/shared-google-settings.tsx', { exportName: 'SharedGoogleCalendarSettings', platform,
      props: { embedded: true, runtime, onBack() {} }, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(),
      mocks: { '../settings/google-connection': hook(connected()) } });
    t.after(() => screen.unmount()); await settle(screen); assert.deepEqual(calls, []);
    await toggle(screen, '共有予定をGoogleカレンダーに追加'); assert.deepEqual(calls, ['prepare', ['connect', 'primary'], 'sync']);
    assert.doesNotMatch(screen.text(), /追加先を選択/u);
    await toggle(screen, '共有予定をGoogleカレンダーに追加'); assert.equal(calls.at(-1), 'disable');
    finishSync({ kind: 'success' }); await settle(screen);
    assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '共有予定をGoogleカレンダーに追加').props.accessibilityState.checked, false);
  });

  test(`${platform} unified availability toggle retains main-device authority and uses the connected Google account without another confirmation`, async t => {
    const calls = []; let finishSync; const device = { phase: 'approved', deviceId: 'main', mainDeviceId: 'main', authorityDigest: 'authority' };
    let view = { connected: false, sourceSubject: null, device };
    const runtime = { readSettings: async () => view, checkGoogleAccount: async () => account,
      connectCurrentSource: async (subject, digest) => { assert.equal(subject, account.subject); assert.equal(digest, 'authority'); calls.push('connect'); view = { ...view, connected: true, sourceSubject: subject }; return { kind: 'ready' }; },
      disableSource: async digest => { assert.equal(digest, 'authority'); calls.push('disable'); view = { ...view, connected: false, sourceSubject: null }; return { kind: 'ready' }; },
      refreshData: async () => { calls.push('refresh'); return await new Promise(resolve => { finishSync = resolve; }); } };
    const screen = screenHarness('src/features/sharing/private-calendar/source-screen.tsx', { exportName: 'PrivateCalendarSourceScreen', platform,
      props: { embedded: true, loadRuntime: async () => runtime, onBack() {}, onDevices() {} }, effectDependencies: true, effect: fn => fn(),
      mocks: { '../../settings/google-connection': hook(connected()) } });
    t.after(() => screen.unmount()); await settle(screen); assert.deepEqual(calls, []);
    await toggle(screen, '空き時間を端末間で同期'); assert.deepEqual(calls, ['connect', 'refresh']);
    await toggle(screen, '空き時間を端末間で同期'); assert.deepEqual(calls, ['connect', 'refresh', 'disable']);
    finishSync({ kind: 'published' }); await settle(screen); assert.doesNotMatch(screen.text(), /空き時間を更新しました/u);
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'Googleアカウントを確認'), false);
  });
}
