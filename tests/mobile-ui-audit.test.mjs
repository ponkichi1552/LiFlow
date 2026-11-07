import { withUploadedManual } from './helpers/sharing-v2-appliance.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { localDateFromDate, weekdayOf } from '../src/domain/scheduling/local-date.ts';
import { applianceResult } from './helpers/sharing-v2-appliance.mjs';

const repository = await import('../src/platform/storage/repository.ts');
const { configurePersonalGoogleTaskSync } = await import('../src/features/google-sync/coordinator.ts');
const today = localDateFromDate(new Date());
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settingsMocks = {
  '@/features/google-sync/background-task': {},
  '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
  '@/platform/google-tasks/google-sign-in-gateway': { hasGoogleTasksSession: async () => false },
};
async function fixture() {
  const h = createDatabase();
  await repository.initializeLocalDatabase(h.database);
  let snapshot = await repository.loadPlannerSnapshot(h.database, today);
  const refresh = async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); };
  return { ...h, options: { database: h.database, snapshot: () => snapshot, refresh }, snapshot: () => snapshot };
}

for (const platform of ['ios', 'android']) test(`${platform} settings keep chore categories direct and infrequent controls collapsed with current summaries`, async () => {
  const h = await fixture();
  try {
    await repository.updatePlannerSettings(h.database, { frequencyMode: 'balanced', restDays: [6, 7], heavyDailyLimit: 2, normalDailyLimit: 2 });
    await repository.setNotificationsEnabled(h.database, true);
    await repository.saveWeatherLocation(h.database, { region: 'よこはま', displayName: '横浜市、神奈川県', latitude: 35.44, longitude: 139.64 }); await h.options.refresh();
    const screen = screenHarness('src/app/settings.tsx', { ...h.options, platform, mocks: { ...settingsMocks,
      '@/features/calendar/use-local-calendar': { useLocalCalendar: () => ({ snapshot: { events: [{ birthday: true }, { birthday: true }, { birthday: false }] }, loading: false, error: null }) },
    } });
    const hasControl = label => screen.nodes().some(node => node.props.accessibilityLabel === label);
    assert.equal(hasControl('家事ごとの設定を開く'), false);
    assert.ok(screen.button(`${h.snapshot().chores[0].category}の見出しを展開`));
    for (const title of ['生活リズム', '通知・ウィジェット', '天気予報・洗濯', '誕生日', 'Google連携']) {
      assert.equal(screen.button(`${title}を開く`).props.accessibilityState.expanded, false);
    }
    assert.equal(screen.button('生活リズムを開く').props.accessibilityValue.text, '適度・土日休み');
    assert.equal(screen.button('通知・ウィジェットを開く').props.accessibilityValue.text, '通知オン');
    assert.equal(screen.button('天気予報・洗濯を開く').props.accessibilityValue.text, '横浜市、神奈川県');
    assert.equal(screen.button('誕生日を開く').props.accessibilityValue.text, '2件');
    for (const label of ['こまめ · 短めの周期', '月曜日', '家事の通知を受け取る', '天気予報に使う市区町村', '誕生日を追加', 'Googleと接続']) assert.equal(hasControl(label), false);
    const initial = screen.nodes();
    for (const label of ['共有グループを管理', 'Google連携を開く']) assert.ok(initial.indexOf(screen.button(label)) < initial.indexOf(screen.button('誕生日を開く')), 'connections precede rarely edited birthdays');
    assert.ok(screen.button('クレジットを開く'), 'optional reference content stays collapsed');
    await screen.press('生活リズムを開く');
    assert.ok(screen.button('こまめ · 短めの周期')); assert.ok(screen.button('月曜日'));
    await screen.press('こまめ · 短めの周期'); await screen.press('生活リズムを閉じる');
    assert.equal(screen.button('生活リズムを開く').props.accessibilityValue.text, 'こまめ・土日休み');
    for (let n = 0; n < 40 && h.snapshot().settings.frequencyMode !== 'frequent'; n++) { await new Promise(resolve => setTimeout(resolve, 25)); await screen.flush(); }
    assert.equal((await repository.loadPlannerSnapshot(h.database, today)).settings.frequencyMode, 'frequent', 'collapsing does not discard or defer autosave');
    await screen.press('生活リズムを開く'); assert.equal(screen.button('こまめ · 短めの周期').props.accessibilityState.selected, true);
    await screen.press('通知・ウィジェットを開く'); assert.equal(hasControl('家事の通知を受け取る'), true);
    await screen.press('天気予報・洗濯を開く'); assert.equal(hasControl('天気予報に使う市区町村'), true);
    await screen.press('誕生日を開く'); assert.ok(screen.button('誕生日を追加'));
    await screen.press('Google連携を開く'); assert.ok(screen.button('Googleと接続'));
  } finally { h.connection.close(); }
});

test('waste editor rejects same-frame duplicate saves and keeps the draft available after failure', async () => {
  const pending = deferred(); const saved = [];
  const screen = screenHarness('src/features/waste/waste-schedule-editor.tsx', { exportName: 'WasteScheduleEditor', props: { onSubmit: async (value) => { saved.push(value); if (saved.length === 1) await pending.promise; } } });
  await screen.change('ゴミの種類', 'かん'); await screen.press('缶を選択'); await screen.press('月');
  const save = screen.button('収集日を追加'); save.props.onPress(); save.props.onPress(); await screen.flush();
  assert.equal(saved.length, 1);
  pending.reject(new Error('保存失敗')); await screen.flush();
  assert.ok(screen.text().includes('保存失敗'));
  assert.equal(screen.nodes().find((node) => node.type === 'TextInput').props.value, '缶');
  await screen.press('収集日を追加'); assert.equal(saved.length, 2);
  assert.equal(saved[1].label, '缶'); assert.deepEqual(saved[1].collectionWeekdays, [1]);
});

test('waste deletion and occurrence changes cannot overlap and unlock after a failure', async () => {
  const h = await fixture();
  try {
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'weekly', label: '可燃ごみ', recurrence: 'weekly', collectionWeekdays: [weekdayOf(today)] }); await h.options.refresh();
    const pending = deferred(); let deletions = 0; let hides = 0;
    const screen = screenHarness('src/app/waste.tsx', { ...h.options, mocks: { '@/platform/storage/repository': {
      deleteWeeklyWasteSchedule: async () => { deletions++; if (deletions === 1) await pending.promise; },
      setWasteOccurrenceHidden: async () => { hides++; },
    } } });
    await screen.press('次の収集日を開く');
    const remove = screen.button('削除'); const hide = screen.button('今回は表示しない');
    remove.props.onPress(); remove.props.onPress(); hide.props.onPress(); await screen.flush();
    assert.equal(deletions, 1); assert.equal(hides, 0);
    assert.equal(screen.button('編集').props.disabled, true);
    pending.reject(new Error('削除失敗')); await screen.flush();
    assert.ok(screen.text().includes('削除失敗')); assert.equal(screen.button('編集').props.disabled, false);
    await screen.press('今回は表示しない'); assert.equal(hides, 1);
    await screen.press('削除'); assert.equal(deletions, 2);
  } finally { h.connection.close(); }
});

for (const [section, choice, method] of [['生活リズム', 'こまめ · 短めの周期', 'updatePlannerSettings']]) {
  test(`settings ${section} saves once per interaction and can retry after a failed write`, async () => {
    const h = await fixture();
    try {
      const pending = deferred(); let writes = 0; const appStates = [];
      const screen = screenHarness('src/app/settings.tsx', { ...h.options, effect: callback => callback(), appStateListener: callback => { appStates.push(callback); }, mocks: { ...settingsMocks, '@/platform/storage/repository': { [method]: async () => { writes++; if (writes === 1) await pending.promise; } } } });
      await screen.press(`${section}を開く`);
      await screen.press(choice);
      for (const listener of appStates) { listener('background'); listener('background'); } await screen.flush();
      assert.equal(writes, 1);
      pending.reject(new Error('保存失敗')); await screen.flush(); assert.ok(screen.text().includes('保存失敗'));
      await screen.press('保存を再試行'); assert.equal(writes, 2);
    } finally { h.connection.close(); }
  });
}

test('notification permission denial does not enable notifications and a later attempt is allowed', async () => {
  const h = await fixture();
  try {
    await repository.setNotificationsEnabled(h.database, false); await h.options.refresh();
    const pending = deferred(); let requests = 0; const saved = [];
    const screen = screenHarness('src/app/settings.tsx', { ...h.options, mocks: { ...settingsMocks,
      '@/platform/notifications/expo-local-notification-gateway': { ExpoLocalNotificationGateway: class { async requestPermission() { requests++; return requests === 1 ? pending.promise : true; } } },
      '@/platform/storage/repository': { setNotificationsEnabled: async (db, enabled) => { saved.push(enabled); await repository.setNotificationsEnabled(db, enabled); } },
    } });
    await screen.press('通知・ウィジェットを開く');
    const control = screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '家事の通知を受け取る');
    control.props.onValueChange(true); control.props.onValueChange(true); await screen.flush(); assert.equal(requests, 1);
    pending.resolve(false); await screen.flush(); assert.deepEqual(saved, []); assert.ok(screen.text().includes('通知は有効になりませんでした'));
    assert.equal(h.snapshot().settings.notificationsEnabled, false);
    control.props.onValueChange(true); await screen.flush(); assert.equal(requests, 2); assert.deepEqual(saved, [true]);
    assert.equal(h.snapshot().settings.notificationsEnabled, true);
  } finally { h.connection.close(); }
});

test('Google connection cannot open duplicate authorization flows and retries after cancellation', async () => {
  const h = await fixture();
  try {
    const pending = deferred(); let authorizations = 0;
    const screen = screenHarness('src/app/settings.tsx', { ...h.options, mocks: { ...settingsMocks,
      '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: true }) },
      '@/platform/google-tasks/google-sign-in-gateway': { authorizeGoogleTasks: async () => { authorizations++; if (authorizations === 1) await pending.promise; throw Object.assign(new Error('cancelled'), { name: 'GoogleAuthorizationCancelledError' }); }, hasGoogleTasksSession: async () => false },
      '@/platform/storage/repository': { loadGoogleSyncState: async () => null, loadCalendarAvailabilityState: async () => null },
    } });
    await screen.press('Google連携を開く');
    const connect = screen.button('Googleと接続'); connect.props.onPress(); connect.props.onPress(); await screen.flush(); assert.equal(authorizations, 1);
    pending.resolve(); await screen.flush(); assert.ok(screen.text().includes('Googleとの接続をキャンセルしました'));
    await screen.press('Googleと接続'); assert.equal(authorizations, 2);
  } finally { h.connection.close(); }
});

test('connected Google settings serialize sync, pause, calendar permissions and disconnect without deleting remote tasks', async () => {
  const h = await fixture();
  try {
    let connected = false; let syncs = 0; let revoked = 0; let registrations = 0; let unregistrations = 0;
    let calendarState = { enabled: false, status: 'idle' }; const calendarChanges = []; const pending = deferred(); const effects = [];
    const screen = screenHarness('src/app/settings.tsx', { ...h.options, effect: (callback) => effects.push(callback), mocks: {
      '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: true }) },
      '@/features/google-sync/background-task': { registerGoogleSyncBackgroundTask: async () => { registrations++; }, unregisterGoogleSyncBackgroundTask: async () => { unregistrations++; } },
      '@/features/google-sync/coordinator': { configurePersonalGoogleTaskSync,
        syncGoogleTasks: async () => { syncs++; if (syncs === 2) await pending.promise; return { kind: 'success', created: 1, updated: 2, imported: 1 }; } },
      '@/platform/google-tasks/google-sign-in-gateway': {
        authorizeGoogleTasks: async () => { connected = true; }, hasGoogleTasksSession: async () => connected,
        getGoogleTasksAccessToken: async () => 'test-token', disconnectGoogleTasksSession: async () => { revoked++; connected = false; },
        authorizeGoogleCalendarAvailability: async () => false,
      },
      '@/features/google-sync/calendar-settings': { configureGoogleCalendarAvailability: async (_db, enabled) => {
        calendarChanges.push(enabled); calendarState = { enabled, status: enabled ? 'permissionRequired' : 'idle' }; return !enabled;
      } },
      '@/platform/storage/repository': { ...repository, loadCalendarAvailabilityState: async () => calendarState },
    } });
    // Run mount effects, then render their completed SQLite/session hydration.
    const cleanups = effects.map((callback) => callback()); await screen.flush();
    await screen.press('Google連携を開く');
    await screen.press('Googleと接続');
    assert.equal(syncs, 1); assert.equal(registrations, 1); assert.ok(screen.text().includes('接続し、同期しました'));
    const sync = screen.button('今すぐ同期'); const disconnect = screen.button('接続解除');
    sync.props.onPress(); sync.props.onPress(); disconnect.props.onPress(); await screen.flush();
    assert.equal(syncs, 2); assert.equal(revoked, 0);
    pending.resolve(); await screen.flush(); assert.ok(screen.text().includes('新規 1件・更新 2件・Googleから完了 1件'));
    const automatic = () => screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === 'Google Tasksの自動同期');
    automatic().props.onValueChange(false); await screen.flush();
    assert.equal((await repository.loadGoogleSyncState(h.database, repository.LOCAL_HOUSEHOLD_ID)).enabled, false);
    assert.ok(screen.text().includes('自動同期を一時停止しました'));
    automatic().props.onValueChange(true); await screen.flush(); assert.equal(syncs, 3);
    const calendar = screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === 'Googleカレンダーの予定を家事日調整に使う');
    calendar.props.onValueChange(true); await screen.flush(); assert.deepEqual(calendarChanges, [true]);
    assert.ok(screen.text().includes('追加の許可が必要')); assert.ok(screen.button('カレンダーの許可を確認'));
    await screen.press('接続解除'); assert.deepEqual(calendarChanges, [true, false]); assert.equal(revoked, 1);
    assert.ok(unregistrations >= 2); assert.ok(screen.text().includes('Google Tasks上の家事は残しています'));
    assert.equal((await repository.loadGoogleSyncState(h.database, repository.LOCAL_HOUSEHOLD_ID)).enabled, false);
    for (const cleanup of cleanups) cleanup?.();
  } finally { h.connection.close(); }
});

test('weather selection keeps the first pending candidate consistent and permits retry after a failure', async () => {
  const h = await fixture();
  try {
    const pending = deferred(); const saved = [];
    const { searchJapaneseMunicipalities } = await import('../src/features/weather/municipality-search.ts');
    const candidates = [searchJapaneseMunicipalities('横浜市').find(row => row.name === '横浜市'), searchJapaneseMunicipalities('横浜町')[0]];
    assert.ok(candidates.every(Boolean));
    const candidateLabel = index => `地域 ${candidates[index].label} を選択`;
    const screen = screenHarness('src/app/settings.tsx', { ...h.options, mocks: { ...settingsMocks,
      '@/features/weather/use-municipality-suggestions': { useMunicipalitySuggestions: () => ({ status: 'results', query: 'よこはま', error: null, candidates }) },
      '@/platform/storage/repository': { saveWeatherLocation: async (_db, value) => { saved.push(value); if (saved.length === 1) await pending.promise; } },
    } });
    await screen.press('天気予報・洗濯を開く');
    await screen.change('天気予報に使う市区町村', 'よこはま');
    const first = screen.button(candidateLabel(0)); const second = screen.button(candidateLabel(1));
    first.props.onPress(); second.props.onPress(); await screen.flush();
    assert.equal(saved.length, 1); assert.equal(saved[0].displayName, candidates[0].label);
    assert.equal(screen.button(candidateLabel(0)).props.accessibilityState.selected, true);
    assert.equal(screen.button(candidateLabel(1)).props.accessibilityState.selected, false);
    pending.reject(new Error('地域の保存失敗')); await screen.flush(); assert.ok(screen.text().includes('地域の保存失敗'));
    await screen.press(candidateLabel(1)); assert.equal(saved.length, 2); assert.equal(saved[1].displayName, candidates[1].label);
  } finally { h.connection.close(); }
});

test('closing weather stops hidden searches and reopening retains the location draft without searching again', async () => {
  const h = await fixture(); let searching = false;
  try {
    const screen = screenHarness('src/app/settings.tsx', { ...h.options, mocks: { ...settingsMocks,
      '@/features/weather/use-municipality-suggestions': { useMunicipalitySuggestions: (_query, enabled) => {
        searching = enabled; return { status: enabled ? 'searching' : 'idle', candidates: [] };
      } },
    } });
    assert.equal(searching, false);
    await screen.press('天気予報・洗濯を開く'); await screen.change('天気予報に使う市区町村', 'よこはま'); assert.equal(searching, true);
    await screen.press('天気予報・洗濯を閉じる'); assert.equal(searching, false);
    await screen.press('天気予報・洗濯を開く'); assert.equal(searching, false);
    assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '天気予報に使う市区町村').props.value, 'よこはま');
    assert.equal(h.snapshot().settings.weatherLocation, undefined, 'an unconfirmed search must not replace the saved location');
  } finally { h.connection.close(); }
});

test('collapsed Google settings distinguish pending hydration and failures from a disconnected account', async () => {
  const h = await fixture();
  try {
    for (const [status, session, expected] of [['authRequired', true, '再接続が必要'], ['error', true, '同期失敗'], ['retryPending', true, '再試行待ち'], ['idle', false, '再接続が必要'], ['idle', true, 'Tasks接続済み'], ['read-failed', true, '確認できません']]) {
      const effects = [];
      const screen = screenHarness('src/app/settings.tsx', { ...h.options, effect: callback => effects.push(callback), mocks: { ...settingsMocks,
        '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: true }) },
        '@/platform/google-tasks/google-sign-in-gateway': { hasGoogleTasksSession: async () => session },
        '@/platform/storage/repository': { loadGoogleSyncState: async () => { if (status === 'read-failed') throw new Error('read failed'); return { enabled: true, status }; }, loadCalendarAvailabilityState: async () => null },
      } });
      assert.equal(screen.button('Google連携を開く').props.accessibilityValue.text, '確認中');
      const cleanups = effects.splice(0).map(effect => effect()); await screen.flush();
      assert.equal(screen.button('Google連携を開く').props.accessibilityValue.text, expected);
      assert.equal(screen.button('Google連携を開く').props.accessibilityState.expanded, false);
      assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'Google Tasksの自動同期'), false);
      cleanups.forEach(cleanup => cleanup?.()); screen.unmount();
    }
  } finally { h.connection.close(); }
});

test('credits links remain accessible when expanded and hidden when collapsed', async () => {
  const h = await fixture();
  try {
    const screen = screenHarness('src/app/settings.tsx', { ...h.options, mocks: settingsMocks });
    const creditLinks = () => screen.nodes().filter((node) => node.props.accessibilityRole === 'link' && node.children.some((child) => child.children?.join('').includes('データライセンス')));
    assert.equal(creditLinks().length, 0);
    await screen.press('クレジットを開く'); assert.equal(creditLinks().length, 1);
    await screen.press('クレジットを閉じる'); assert.equal(creditLinks().length, 0);
  } finally { h.connection.close(); }
});

test('onboarding finish cannot initialize twice and a failed save keeps selections for retry', async () => {
  const h = await fixture();
  try {
    const pending = deferred(); const calls = []; let completed = 0;
    const screen = screenHarness('src/features/onboarding/first-run-setup.tsx', { exportName: 'FirstRunSetup', database: h.database, props: { snapshot: h.snapshot(), onComplete: async () => { completed++; } },
      mocks: { '@/platform/storage/repository': { ...repository, completeFirstSetup: async (_db, input) => { calls.push(input); if (calls.length === 1) await pending.promise; } } } });
    await screen.press('次へ'); await screen.press('次へ'); await screen.press('選択をすべて外す'); await screen.press('次へ'); await screen.press('前回の時期はスキップ'); await screen.press('次へ');
    const finish = screen.button('設定して始める'); const skip = screen.button('ゴミ収集日はスキップして始める'); finish.props.onPress(); skip.props.onPress(); await screen.flush();
    assert.equal(calls.length, 1); assert.equal(completed, 0);
    pending.reject(new Error('初期設定の保存失敗')); await screen.flush(); assert.ok(screen.text().includes('初期設定の保存失敗'));
    await screen.press('設定して始める'); assert.equal(calls.length, 2); assert.equal(completed, 1); assert.deepEqual(calls[0], calls[1]);
  } finally { h.connection.close(); }
});

async function verifyApplianceAbortOnLeave(leave) {
    const pending = deferred(); const retry = deferred(); let signal; let saved = 0; let blur; let requests = 0; const effects = []; const navigation = [];
    const screen = screenHarness('src/app/(tabs)/manual/appliance-care.tsx', { params: { returnTo: '/manual' }, effect: (callback) => effects.push(callback), navigate: (...args) => navigation.push(args),
      navigationListener: (event, listener) => { if (event === 'blur') blur = listener; }, mocks: {
      '@/features/appliance-care/api-client': { analyzeApplianceCareRequest: async (_request, _fetch, _baseUrl, _stage, requestSignal) => { signal = requestSignal; requests++; return requests === 1 ? pending.promise : retry.promise; } },
      '@/platform/storage/repository': { saveReviewedApplianceCare: async () => { saved++; } },
    } });
    const cleanups = effects.map((callback) => callback());
    await screen.change('メーカー名', 'Dyson'); await screen.change('製品名', 'V12'); await screen.change('型番', 'SV20');
    await screen.press('取扱説明書PDFを選ぶ'); await screen.flush(); await screen.press('このPDFを利用・解析・共有できることを確認した');
    await screen.press('選択したPDFを解析'); assert.equal(signal.aborted, false);
    if (leave === 'back') await screen.press('前の画面に戻る');
    else if (leave === 'blur') { assert.equal(typeof blur, 'function', 'a retained stack screen needs a native blur listener'); blur(); }
    else for (const cleanup of cleanups) cleanup?.();
    assert.equal(signal.aborted, true);
    if (leave === 'blur') {
      await screen.flush();
      assert.equal(screen.button('選択したPDFを解析').props.accessibilityState.disabled, false, 'an aborted retained screen must allow another request');
      await screen.press('選択したPDFを解析'); assert.equal(requests, 2); assert.equal(saved, 0);
      pending.resolve({ status: 'verified' }); await screen.flush();
      assert.equal(screen.button('解析しています…').props.accessibilityState.disabled, true, 'an old attempt cannot unlock a newer pending request');
      retry.resolve({ status: 'not_found', message: '入力を確認してください。' }); await screen.flush();
    } else { pending.resolve({ status: 'verified' }); await screen.flush(); }
    assert.equal(saved, 0); assert.ok(!screen.text().includes('メーカー公式情報で確認済み'));
    if (leave === 'back') assert.deepEqual(navigation, [['dismissTo', '/manual']]);
}
for (const leave of ['back', 'unmount']) {
  test(`appliance analysis aborts on ${leave} and ignores late results before saving`, () => verifyApplianceAbortOnLeave(leave));
}
test('appliance analysis aborts when a retained screen blurs and permits another request', () => verifyApplianceAbortOnLeave('blur'));

test('leaving a personal appliance during its committed save preserves the save lock until SQLite finishes', async () => {
  const f = await fixture(); const gate = deferred(); const done = deferred(); let blur; let signal; let requests = 0; let saves = 0; let screen; const cleanups = [];
  try {
    screen = screenHarness('src/app/(tabs)/manual/appliance-care.tsx', { ...f.options,
      effect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
      navigationListener: (event, listener) => { if (event === 'blur') blur = listener; }, mocks: {
        '@/features/appliance-care/api-client': { analyzeApplianceCareRequest: async (_request, _base, _timeout, _stage, inputSignal) => { requests++; signal = inputSignal; return withUploadedManual(applianceResult(), _request.manual); } },
        '@/platform/storage/repository': { ...repository, saveReviewedApplianceCare: async (...args) => {
          saves++; await gate.promise; try { return await repository.saveReviewedApplianceCare(...args); } finally { done.resolve(); }
        } },
      } });
    await screen.change('メーカー名', 'Dyson'); await screen.change('製品名', 'V12'); await screen.change('型番', 'SV20');
    await screen.press('取扱説明書PDFを選ぶ'); await screen.flush(); await screen.press('このPDFを利用・解析・共有できることを確認した');
    const originalStart = screen.button('選択したPDFを解析'); originalStart.props.onPress();
    for (let n = 0; n < 30 && saves === 0; n++) await screen.flush(); assert.equal(saves, 1); assert.equal(requests, 1);
    assert.equal(typeof blur, 'function'); blur(); await screen.flush();
    assert.equal(signal.aborted, false, 'a completed network request is detached before the local save begins');
    assert.equal(screen.button('解析しています…').props.accessibilityState.disabled, true);
    originalStart.props.onPress(); await screen.flush(); assert.equal(requests, 1); assert.equal(saves, 1);
    gate.resolve(); await done.promise;
    for (let n = 0; n < 30 && !screen.text().includes('解析結果を保存し'); n++) await screen.flush();
    assert.match(screen.text(), /解析結果を保存し/u); assert.equal(f.connection.prepare('SELECT COUNT(*) AS n FROM appliances').get().n, 1);
  } finally { gate.resolve(); if (saves) await done.promise; await screen?.flush(); cleanups.forEach(cleanup => cleanup()); f.connection.close(); }
});
