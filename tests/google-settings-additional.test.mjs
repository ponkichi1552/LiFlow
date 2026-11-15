import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) test(`${platform} Calendar settings ignore an older failed read after the new account status succeeds`, async t => {
  const database = {}; let changed; let rejectOld; let reads = 0;
  const current = { enabled: true, subject: 'current', generation: 2, calendars: [], error: null };
  const runtime = { readControl: () => ++reads === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve(current),
    readConflicts: async () => [], isConnected: async () => true };
  const ui = screenHarness('src/features/calendar/personal-google-settings.tsx', { exportName: 'PersonalGoogleCalendarSettings', platform,
    props: { database, embedded: true }, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => runtime },
      '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
      '../google-sync/account-change-events': { subscribeToGoogleAccountChanges: (_db, callback) => { changed = callback; return () => {}; } },
    } });
  t.after(() => ui.unmount()); await ui.flush(); assert.equal(typeof rejectOld, 'function'); assert.equal(typeof changed, 'function');
  changed(); await ui.flush(); ui.button('今すぐ同期');
  rejectOld(new Error('previous account generation changed')); await ui.flush();
  ui.button('今すぐ同期'); assert.doesNotMatch(ui.text(), /接続設定を読み込めません/);
  assert.equal(reads, 2, 'a superseded read must not add a retry or network operation');
});

for (const platform of ['ios', 'android']) test(`${platform} Calendar status recovery clears a current load error while retaining independent action errors`, async t => {
  let readFails = true; let statusChanged; let reads = 0;
  const control = { enabled: true, subject: 'current', generation: 1, calendars: [], error: null };
  const runtime = { readControl: async () => { reads++; if (readFails) throw new Error('temporarily unavailable'); return control; },
    readConflicts: async () => [], isConnected: async () => true, sync: async () => { throw new Error('変更は未送信です。'); } };
  const ui = screenHarness('src/features/calendar/personal-google-settings.tsx', { exportName: 'PersonalGoogleCalendarSettings', platform,
    props: { database: {}, embedded: true }, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => runtime },
      '../../platform/storage/calendar-events': { subscribeLocalCalendar: (_db, callback) => { statusChanged = callback; return () => {}; } },
    } });
  t.after(() => ui.unmount()); await ui.flush(); assert.match(ui.text(), /接続設定を読み込めません/);
  readFails = false; statusChanged('syncStatus'); await ui.flush(); ui.button('今すぐ同期');
  assert.doesNotMatch(ui.text(), /接続設定を読み込めません/);
  await ui.press('今すぐ同期'); assert.match(ui.text(), /変更は未送信です/);
  statusChanged('syncStatus'); await ui.flush(); assert.match(ui.text(), /変更は未送信です/);
  assert.equal(reads, 3, 'status events alone recover the read without polling');
});

for (const platform of ['ios', 'android']) test(`${platform} Calendar settings replace the connected action immediately after account logout without reopening the page`, async () => {
  const database = {}; let listener; let stopped = false;
  let control = { enabled: true, subject: 'original', generation: 1, calendars: [], error: null };
  let nativeConnected = true; let lateGrant;
  const runtime = { readControl: async () => control, readConflicts: async () => [],
    isConnected: async () => nativeConnected,
  };
  const screen = screenHarness('src/features/calendar/personal-google-settings.tsx', { exportName: 'PersonalGoogleCalendarSettings', platform,
    props: { database, embedded: true }, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => runtime },
      '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
      '../google-sync/account-change-events': { subscribeToGoogleAccountChanges: (db, callback) => { assert.equal(db, database); listener = callback; return () => { stopped = true; }; } },
    } });
  try {
    await screen.flush(); screen.button('今すぐ同期');
    assert.equal(typeof listener, 'function');
    // A status read that started before logout must not restore a connected action later.
    runtime.isConnected = () => new Promise(resolve => { lateGrant = resolve; }); listener(); await screen.flush();
    assert.equal(typeof lateGrant, 'function');
    nativeConnected = false; runtime.isConnected = async () => nativeConnected;
    control = { ...control, enabled: false, generation: 2 }; listener(); await screen.flush();
    screen.button('Googleと接続'); assert.doesNotMatch(screen.text(), /今すぐ同期|最終同期/);
    lateGrant(true); await screen.flush(); screen.button('Googleと接続'); assert.doesNotMatch(screen.text(), /今すぐ同期/);
    control = { ...control, enabled: true, subject: 'other', generation: 3 }; nativeConnected = true; listener(); await screen.flush();
    screen.button('今すぐ同期');
  } finally { lateGrant?.(false); screen.unmount(); }
  assert.equal(stopped, true);
});

for (const platform of ['ios', 'android']) test(`${platform} Calendar authentication errors reconnect through explicit account selection and preserve the connection on cancellation`, async () => {
  let control = { enabled: true, subject: 'old', generation: 1, calendars: [], error: '以前連携したGoogleアカウントを選択してください。' };
  const calls = []; let rejectSelection; let finishSelection; let locked = false; let releases = 0;
  const runtime = { readControl: async () => control, readConflicts: async () => [],
    isConnected: async current => current.subject === 'selected',
    prepareConnection: async () => { calls.push('authorize-calendar'); return { generation: control.generation }; },
    connect: async review => { calls.push('connect'); assert.equal(review.generation, control.generation); control = { ...control, subject: 'selected', generation: control.generation + 1, error: null }; },
    sync: async () => { calls.push('sync'); return { kind: 'success', received: 0, sent: 0 }; } };
  const screen = screenHarness('src/features/calendar/personal-google-settings.tsx', { exportName: 'PersonalGoogleCalendarSettings', platform,
    props: { database: {}, embedded: true }, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => runtime },
      '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
      '../settings/account-operation': { useAccountOperation: () => ({ get busy() { return locked; }, acquire() { if (locked) return false; locked = true; return true; }, release() { locked = false; releases++; } }) },
      '../google-sync/account-switch': { changeGoogleAccount: async () => { calls.push('select-account'); await new Promise((resolve, reject) => { finishSelection = resolve; rejectSelection = reject; }); } },
      '../google-sync/background-task': { registerGoogleSyncBackgroundTask: async () => { calls.push('register-background'); } },
    } });
  try {
    await screen.flush(); assert.doesNotMatch(screen.text(), /今すぐ同期/); const reconnect = screen.button('Googleに再接続').props.onPress;
    reconnect(); reconnect(); await screen.flush(); assert.deepEqual(calls, ['select-account']); assert.equal(locked, true);
    const cancellation = new Error('cancelled'); cancellation.name = 'GoogleAuthorizationCancelledError'; rejectSelection(cancellation); await screen.flush();
    assert.equal(control.subject, 'old'); assert.equal(control.enabled, true); assert.equal(locked, false); assert.equal(releases, 1);
    await reconnect(); await screen.flush();
    // Account selection is intentionally kept pending until the native UI completes.
    finishSelection(); await screen.flush(); await screen.flush();
    assert.deepEqual(calls, ['select-account', 'select-account', 'authorize-calendar', 'connect', 'register-background', 'sync']);
    assert.equal(control.subject, 'selected'); assert.equal(locked, false); assert.equal(releases, 2);
    screen.button('今すぐ同期'); assert.doesNotMatch(screen.text(), /Googleに再接続/);
  } finally { finishSelection?.(); screen.unmount(); }
});

test('Google settings ignore delayed control data from a replaced group runtime or personal database', async t => {
  await t.test('shared runtime', async () => {
    let release;
    const old = { readControl: () => new Promise(resolve => { release = () => resolve({ enabled: true, revision: 1, accountLabel: 'OLD_ACCOUNT', calendarLabel: 'OLD_CALENDAR', calendarId: 'old' }); }) };
    const current = { readControl: async () => ({ enabled: true, revision: 1, accountLabel: 'CURRENT_ACCOUNT', calendarLabel: 'CURRENT_CALENDAR', calendarId: 'current' }) };
    const props = { runtime: old, onBack() {} };
    const screen = screenHarness('src/features/calendar/shared-google-settings.tsx', { exportName: 'SharedGoogleCalendarSettings', props,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn() });
    try { props.runtime = current; screen.render(); await screen.flush(); release(); await screen.flush(); assert.match(screen.text(), /CURRENT_ACCOUNT/); assert.doesNotMatch(screen.text(), /OLD_ACCOUNT/); }
    finally { release?.(); screen.unmount(); }
  });
  await t.test('personal database', async () => {
    let release; const old = {}, current = {};
    const runtime = db => ({ readControl: async () => db === current ? new Promise(resolve => { release = () => resolve({ enabled: true, calendars: [{ id: 'current', summary: 'CURRENT_CALENDAR' }], targetCalendarId: 'current' }); })
      : { enabled: true, calendars: [{ id: 'old', summary: 'OLD_CALENDAR' }], targetCalendarId: 'old' }, readConflicts: async () => [], isConnected: async () => false });
    const props = { database: old };
    const screen = screenHarness('src/features/calendar/personal-google-settings.tsx', { exportName: 'PersonalGoogleCalendarSettings', props,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
        '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: runtime },
        '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
      } });
    try { await screen.flush(); assert.match(screen.text(), /OLD_CALENDAR/); props.database = current; screen.render(); await screen.flush(); assert.doesNotMatch(screen.text(), /OLD_CALENDAR/); release(); await screen.flush(); assert.match(screen.text(), /CURRENT_CALENDAR/); }
    finally { release?.(); screen.unmount(); }
  });
});
