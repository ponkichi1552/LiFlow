import { openCalendarDay } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { localDateFromDate, weekdayOf } from '../src/domain/scheduling/local-date.ts';
import { calendarWasteLabel } from '../src/features/waste/type-appearance.ts';
import { HELP_SECTIONS } from '../src/features/help/help-content.ts';

const repository = await import('../src/platform/storage/repository.ts');
const today = localDateFromDate(new Date());
const checkbox = (screen, label) => screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label);
const settingsMocks = {
  '@/features/google-sync/background-task': {},
  '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
  '@/platform/google-tasks/google-sign-in-gateway': {},
};

test('calendar waste names omit every kana variant without changing registered names', () => {
  for (const suffix of ['ゴミ', 'ごみ', 'ゴみ', 'ごミ']) {
    assert.equal(calendarWasteLabel(`可燃${suffix}`), '可燃');
    assert.equal(calendarWasteLabel(`粗大${suffix}`), '粗大');
    assert.equal(calendarWasteLabel(`独自${suffix}`), '独自');
  }
  assert.equal(calendarWasteLabel('びん'), 'びん');
  assert.equal(calendarWasteLabel('容器包装プラスチック'), '容器プラ');
});

test('waste check hides only one occurrence on home and calendar can restore all recurrence modes', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    let snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const chore = snapshot.chores.find((item) => item.id === 'floor-cleaning') ?? snapshot.chores[0];
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id], previousDates: {}, weatherLocation: null });
    const schedules = [
      { id: 'weekly', label: '可燃ごみ', recurrence: 'weekly', collectionWeekdays: [weekdayOf(today)] },
      { id: 'biweekly', label: '缶', recurrence: 'biweekly', collectionWeekdays: [weekdayOf(today)], anchorDate: today },
      { id: 'monthly', label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: Number(today.slice(-2)) },
    ];
    for (const schedule of schedules) await repository.saveWeeklyWasteSchedule(h.database, schedule);
    const refresh = async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); };
    await refresh();
    const options = { database: h.database, snapshot: () => snapshot, refresh };
    const home = screenHarness('src/app/(tabs)/index.tsx', options);
    const calendar = screenHarness('src/app/(tabs)/explore.tsx', options);
    for (const shortName of ['可燃', '粗大']) {
      assert.ok(calendar.nodes().some((node) => node.type === 'Text' && node.children.includes(shortName)), 'calendar cells must use the compact name');
    }
    assert.ok(!home.text().includes('今回だけ非表示') && !home.text().includes('今日のゴミ収集'));
    await openCalendarDay(calendar, today);
    const originalCount = snapshot.completions.length;
    for (const schedule of schedules) {
      const hideLabel = `${schedule.label}の${today}のゴミ出しを非表示`;
      const homeCheck = checkbox(home, hideLabel);
      assert.ok(homeCheck, schedule.label);
      homeCheck.props.onPress(); await home.flush(); calendar.render();
      assert.ok(!checkbox(home, hideLabel));
      assert.ok(snapshot.hiddenWasteOccurrenceKeys.includes(`${schedule.id}:${today}`));
      assert.ok(snapshot.upcomingWasteDates.some((item) => item.scheduleId === schedule.id && item.date > today), 'the next collection must remain');
      const restore = checkbox(calendar, `${schedule.label}の${today}のゴミ出しを再表示`);
      assert.equal(restore.props.accessibilityState.checked, true);
      restore.props.onPress(); await calendar.flush(); home.render();
      assert.ok(checkbox(home, hideLabel));
      assert.equal(snapshot.completions.length, originalCount, 'hiding waste must not create a chore completion');
      assert.equal(snapshot.wasteSchedules.find((item) => item.id === schedule.id).label, schedule.label);
    }
    const roles = calendar.nodes().filter((node) => node.props.accessibilityRole === 'checkbox');
    assert.ok(roles[0].props.accessibilityLabel.includes('ゴミ出し'), 'waste cards come before chores');
    assert.ok(roles.at(-1).props.accessibilityLabel.includes(chore.name), 'chore card remains below waste');
  } finally { h.connection.close(); }
});

test('waste checks reject duplicate taps and remain visible after a failed save', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const snapshot = await repository.loadPlannerSnapshot(h.database, today);
    snapshot.settings.setupCompleted = true;
    snapshot.upcomingWasteDates = [{ scheduleId: 'weekly', label: '可燃ごみ', date: today }];
    let release;
    let writes = 0;
    const screen = screenHarness('src/app/(tabs)/index.tsx', { snapshot: () => snapshot, database: h.database,
      mocks: { '@/platform/storage/repository': { setWasteOccurrenceHidden: async () => {
        writes++; await new Promise((resolve) => { release = resolve; }); throw new Error('write failed');
      } } },
    });
    const label = `可燃ごみの${today}のゴミ出しを非表示`;
    const control = checkbox(screen, label);
    control.props.onPress(); control.props.onPress(); await screen.flush();
    assert.equal(writes, 1, 'in-flight guard must work before a rerender');
    assert.equal(checkbox(screen, label).props.disabled, true);
    release(); await screen.flush();
    assert.equal(checkbox(screen, label).props.disabled, false);
    assert.ok(screen.text().includes('ゴミ出しの表示を保存できませんでした'));
    assert.deepEqual(snapshot.hiddenWasteOccurrenceKeys, []);
  } finally { h.connection.close(); }
});

test('help starts with headings only and every section opens and closes independently', async () => {
  const screen = screenHarness('src/app/help.tsx');
  const accessibleText = () => screen.nodes().filter((node) => node.type === 'Text').map((node) => node.children.join('')).join('');
  for (const section of HELP_SECTIONS) {
    assert.ok(!accessibleText().includes(section.paragraphs[0]));
    await screen.press(`${section.title}を開く`);
    for (const paragraph of section.paragraphs) assert.ok(accessibleText().includes(paragraph));
    await screen.press(`${section.title}を閉じる`);
    assert.ok(!accessibleText().includes(section.paragraphs[0]));
  }
  assert.ok(HELP_SECTIONS.length > 0);
});

test('settings retain working weather and location attribution', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const urls = [];
    const screen = screenHarness('src/app/settings.tsx', { database: h.database, snapshot: () => snapshot,
      mocks: settingsMocks });
    // Inspect and exercise the shared credit links with the actual linking API mocked at its boundary.
    const credits = screenHarness('src/components/data-credits.tsx', { exportName: 'DataCredits',
      mocks: { 'react-native': { Text: 'Text', View: 'View', Pressable: 'Pressable', StyleSheet: { create: (value) => value }, Linking: { openURL: async (url) => { urls.push(url); } } } } });
    assert.equal(credits.nodes().filter((node) => node.props.accessibilityRole === 'link').length, 0);
    await credits.press('クレジットを開く');
    for (const link of credits.nodes().filter((node) => node.props.accessibilityRole === 'link')) await link.props.onPress();
    assert.deepEqual(urls, ['https://open-meteo.com/', 'https://www.geonames.org/', 'https://creativecommons.org/licenses/by/4.0/']);
    screen.button('クレジットを開く');
    const setup = screenHarness('src/features/onboarding/first-run-setup.tsx', { exportName: 'FirstRunSetup', database: h.database, props: { snapshot, onComplete() {} } });
    await setup.press('次へ'); await setup.press('次へ'); await setup.press('選択をすべて外す');
    await setup.press('次へ'); await setup.press('前回の時期はスキップ');
    assert.ok(setup.text().includes('GeoNames') && setup.text().includes('Open-Meteo'), 'region search needs attribution before setup is finished too');
  } finally { h.connection.close(); }
});

test('appliance details virtualize long instructions and return by popping to their originating list', async () => {
  const tasks = Array.from({ length: 10 }, (_, index) => ({ name: `作業${index}`, steps: Array(20).fill('公式の手順'), tools: [], safetyCautions: [], evidence: [] }));
  const context = { appliance: { id: 'saved', manufacturer: 'Dyson', displayName: 'V12', modelNumber: 'SV20', officialManualUrl: 'https://www.dyson.co.jp/support', analysis: { tasks, analyzedAt: '2026-10-26T00:00:00Z' } }, chores: [] };
  for (const returnTo of ['/manual', '/chores']) {
    const calls = [];
    const screen = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'ApplianceDetailContent', props: { context, returnTo }, navigate: (...args) => calls.push(args) });
    const list = screen.nodes().find((node) => node.type === 'FlatList');
    assert.equal(list.props.data.length, 10);
    assert.equal(list.props.initialNumToRender, 1); assert.equal(list.props.maxToRenderPerBatch, 1);
    const dock = screen.nodes().find(node => node.props.testID === 'appliance-detail-back-dock');
    assert.ok(dock, 'the return action must remain outside the scrolling instructions');
    assert.ok(screen.text().includes('作業0') && !screen.text().includes('作業9'), 'do not mount every long task during navigation');
    await screen.press('一覧へ戻る');
    assert.deepEqual(calls, [['dismissTo', returnTo]], 'return must pop rather than push/replace');
    const last = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'ApplianceDetailContent', props: { context, returnTo },
      mocks: { 'react-native': { FlatList: (props) => props.renderItem({ item: props.data.at(-1), index: 9 }), Text: 'Text', View: 'View', Pressable: 'Pressable', StyleSheet: { create: (value) => value }, Linking: {} } } });
    assert.ok(last.text().includes('作業9'), 'all items remain available when the list renders them');
    last.button('一覧へ戻る');
    const analysis = screenHarness('src/app/(tabs)/manual/appliance-care.tsx', { params: { returnTo }, navigate: (...args) => calls.push(args), mocks: { '@/features/appliance-care/api-client': {} } });
    await analysis.press('前の画面に戻る');
    assert.deepEqual(calls.at(-1), ['dismissTo', returnTo]);
  }
});

test('appliance focus reads ignore stale results and retain mounted content on refresh failure', async () => {
  let focused;
  const pending = [];
  const context = { appliance: { id: 'saved', manufacturer: 'Dyson', displayName: 'V12', modelNumber: 'SV20', officialManualUrl: 'https://www.dyson.co.jp/support', analysis: { tasks: [], analyzedAt: '2026-10-26T00:00:00Z' } }, chores: [] };
  const screen = screenHarness('src/app/(tabs)/manual/appliances/[id]/index.tsx', {
    params: { id: 'saved', returnTo: '/manual' }, focusEffect: (callback) => { focused = callback; },
    mocks: { '@/platform/storage/repository': { loadApplianceCareReviewContext: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } },
  });
  const leave = focused(); leave(); pending[0].resolve(context); await screen.flush();
  assert.ok(screen.text().includes('読み込んでいます'), 'leaving must cancel state application');
  const stop = focused(); pending[1].resolve(context); await screen.flush();
  assert.ok(screen.text().includes('お手入れ方法')); stop();
  focused(); screen.render();
  assert.ok(screen.nodes().some((node) => node.type === 'FlatList'), 'refocus must not unmount the existing list');
  pending[2].reject(new Error('read failed')); await screen.flush();
  assert.ok(screen.text().includes('読み込めませんでした') && screen.text().includes('お手入れ方法'));
});
