import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const { anchorForMonthlyDay } = await import('../src/features/calendar/monthly-day.ts');
const selection = await import('../src/features/settings/chore-source-selection.ts');

test('monthly day selection retains 31 independently of a shorter starting month', () => {
  assert.equal(anchorForMonthlyDay('2026-11-14', 31), '2026-12-31');
  assert.equal(anchorForMonthlyDay('2028-02-01', 29), '2028-02-29');
  assert.equal(anchorForMonthlyDay('2027-02-01', 29), '2027-03-29');
  assert.throws(() => anchorForMonthlyDay('2026-11-14', 0));
});
test('chore settings remember the destination only inside the same account group and generation', () => {
  const group = { userId: 'ui-review', groupId: 'home', localGeneration: 1 };
  const scope = selection.choreSourceScope(group); selection.rememberChoreSource(scope, 'group');
  assert.equal(selection.readChoreSource(scope), 'group');
  for (const changed of [{ ...group, userId: 'other' }, { ...group, groupId: 'other' }, { ...group, localGeneration: 2 }])
    assert.equal(selection.readChoreSource(selection.choreSourceScope(changed)), 'personal');
});
for (const platform of ['ios', 'android']) test(`${platform} first run finishes from required choices without permission prompts or optional setup`, async t => {
  const db = createDatabase(); t.after(() => db.connection.close()); await repository.initializeLocalDatabase(db.database);
  const snapshot = await repository.loadPlannerSnapshot(db.database, '2026-11-14'); let completed = 0, permission = 0, back;
  const ui = screenHarness('src/features/onboarding/first-run-setup.tsx', { platform, exportName: 'FirstRunSetup', database: db.database,
    effect: callback => callback(), effectDependencies: true, hardwareBackListener: callback => { back = callback; },
    props: { snapshot, onComplete: async () => { completed++; } }, mocks: {
      '@/platform/notifications/expo-local-notification-gateway': { ExpoLocalNotificationGateway: class { requestPermission() { permission++; return Promise.resolve(true); } } },
    } }); t.after(() => ui.unmount());
  await ui.press('選択をすべて外す'); await ui.press('次へ');
  assert.match(ui.button('時間帯・上限を変更').props.accessibilityValue.text, /休日以外、19–21時・1日の上限なし/u);
  assert.match(ui.button('時間帯・上限を変更').props.accessibilityValue.text, /休日、9–19時・1日の上限なし/u);
  await ui.press('時間帯・上限を変更');
  await ui.press('30分'); await ui.press('20–22時');
  if (platform === 'android') { assert.equal(back(), true); await ui.flush(); }
  else await ui.press('設定を続ける');
  assert.match(ui.button('時間帯・上限を変更').props.accessibilityValue.text, /休日以外、20–22時・1日30分まで/u);
  await ui.press('設定して始める');
  assert.equal(completed, 1); assert.equal(permission, 0);
  const saved = await repository.loadPlannerSnapshot(db.database, snapshot.today);
  assert.equal(saved.settings.setupCompleted, true); assert.equal(saved.settings.notificationsEnabled, false);
  assert.equal(saved.chores.some(chore => chore.enabled), false); assert.deepEqual(saved.wasteSchedules, []);
  const prefs = await repository.loadPersonalPlacementPreferences(db.database);
  assert.equal(prefs.dayTypes.workday.maximumMinutes, 30);
  assert.deepEqual(prefs.dayTypes.workday.allowedBands, [{ startMinute: 1200, endMinute: 1320 }]);
  assert.deepEqual(prefs.dayTypes.holiday.allowedBands, [{ startMinute: 540, endMinute: 1140 }]);
});
test('first run saves time preferences atomically and never replays them after setup was committed', async t => {
  const db = createDatabase(); t.after(() => db.connection.close()); await repository.initializeLocalDatabase(db.database);
  const base = { frequencyMode: 'balanced', restDays: [6, 7], enabledChoreIds: [], previousDates: {}, weatherLocation: null,
    dayTypes: { workday: { maximumMinutes: 30 }, holiday: { maximumMinutes: 60 } } };
  const run = db.database.runAsync; let reject = true;
  db.database.runAsync = async (sql, ...args) => { if (reject && sql.includes('UPDATE household_settings SET frequency_mode')) throw new Error('synthetic write failure'); return run(sql, ...args); };
  await assert.rejects(repository.completeFirstSetup(db.database, base), /synthetic/);
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM personal_adaptive_preferences').get().n, 0);
  reject = false; await repository.completeFirstSetup(db.database, base);
  await repository.completeFirstSetup(db.database, { ...base, dayTypes: { workday: { maximumMinutes: 999 }, holiday: {} } });
  assert.equal((await repository.loadPersonalPlacementPreferences(db.database)).dayTypes.workday.maximumMinutes, 30);
});

test('first run opens home automatically after a temporary post-save read failure without saving twice', async t => {
  const db = createDatabase(); t.after(() => db.connection.close()); await repository.initializeLocalDatabase(db.database);
  const snapshot = await repository.loadPlannerSnapshot(db.database, '2026-11-14');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0, opens = 0;
  const ui = screenHarness('src/features/onboarding/first-run-setup.tsx', { exportName: 'FirstRunSetupForm',
    effect: effect => effect(), effectDependencies: true, props: { snapshot, initialPage: 'rhythm', persist: async () => { writes++; },
      onComplete: async () => { if (++opens === 1) throw new Error('temporary local read failure'); } } });
  t.after(() => ui.unmount());
  await ui.press('設定して始める');
  assert.equal(writes, 1); assert.equal(opens, 1);
  assert.match(ui.text(), /家事を読み込んでいます/u);
  assert.doesNotMatch(ui.text(), /再読込/u);
  t.mock.timers.tick(400); await ui.flush();
  assert.equal(writes, 1); assert.equal(opens, 2);
});

test('the shared home setup route saves in the personal database and returns to the existing home', async t => {
  const db = createDatabase();
  t.after(() => db.connection.close());
  await repository.initializeLocalDatabase(db.database);
  const today = '2026-11-14';
  let snapshot = await repository.loadPlannerSnapshot(db.database, today);
  const workspace = { ready: true, userId: 'qa-user', startupDisplay: { record: { userId: 'qa-user', groupId: 'qa-group' } } };
  const navigation = [];
  const ui = screenHarness('src/app/settings.tsx', { layoutEffect: effect => effect(), effectDependencies: true, mocks: {
    '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: workspace } },
    '@/features/google-sync/background-task': {},
    '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
    '@/platform/google-tasks/google-sign-in-gateway': { hasGoogleTasksSession: async () => false },
    '@/hooks/use-planner-data': { usePlannerData: options => {
      assert.deepEqual(options, { personal: true });
      return { database: db.database, snapshot, error: null, readError: () => null, readSnapshot: () => snapshot,
        refresh: async () => { snapshot = await repository.loadPlannerSnapshot(db.database, today); } };
    } },
    'expo-router': { useLocalSearchParams: () => ({ section: 'personal-setup' }),
      router: { canGoBack: () => true, back: () => navigation.push('back') }, Redirect: 'Redirect' },
  } });
  t.after(() => ui.unmount());
  assert.equal(snapshot.settings.setupCompleted, false);
  await ui.press('次へ');
  await ui.press('設定して始める');
  assert.equal(snapshot.settings.setupCompleted, true);
  assert.deepEqual(navigation, ['back']);
});

test('first run keeps the selected weather region after leaving an unfinished replacement search', async t => {
  const db = createDatabase(); t.after(() => db.connection.close());
  await repository.initializeLocalDatabase(db.database);
  const snapshot = await repository.loadPlannerSnapshot(db.database, '2026-11-14');
  const { searchJapaneseMunicipalities } = await import('../src/features/weather/municipality-search.ts');
  const region = searchJapaneseMunicipalities('横浜市').find(candidate => candidate.name === '横浜市');
  assert.ok(region);
  const ui = screenHarness('src/features/onboarding/first-run-setup.tsx', { exportName: 'FirstRunSetup', database: db.database,
    props: { snapshot, onComplete: async () => {} }, mocks: {
      '@/features/weather/use-municipality-suggestions': { useMunicipalitySuggestions: (query, enabled) => ({
        candidates: enabled ? searchJapaneseMunicipalities(query) : [], status: 'results',
      }) },
    } });
  t.after(() => ui.unmount());
  await ui.press('次へ');
  await ui.press('天気予報');
  await ui.change('天気予報に使う市区町村', `横浜${'　'.repeat(120)}神奈川県`);
  await ui.press(region.label);
  await ui.press('地域を変更');
  await ui.change('天気予報に使う市区町村', '札幌市');
  await ui.press('変更せずに戻る');
  await ui.press('天気予報');
  assert.ok(ui.text().includes(region.label));
  await ui.press('この地域で戻る');
  await ui.press('設定して始める');
  const saved = await repository.loadPlannerSnapshot(db.database, snapshot.today);
  assert.equal(saved.settings.weatherLocation?.municipalityId, region.id);
  assert.equal(saved.settings.weatherLocation?.region, region.name);
});
