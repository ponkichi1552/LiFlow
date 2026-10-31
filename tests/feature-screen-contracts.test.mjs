import { withUploadedManual } from './helpers/sharing-v2-appliance.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { scrollCalendarToDate, openCalendarDay } from './helpers/calendar-ui.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { localDateFromDate, formatJapaneseDate } from '../src/domain/scheduling/local-date.ts';

const repository = await import('../src/platform/storage/repository.ts');
const today = localDateFromDate(new Date());

async function initialContext() {
  const h = createDatabase();
  await repository.initializeLocalDatabase(h.database);
  const snapshot = await repository.loadPlannerSnapshot(h.database, today);
  return { ...h, snapshot };
}

async function reachWasteStep(screen) {
  await screen.press('次へ'); await screen.press('次へ');
  await screen.press('選択をすべて外す');
  await screen.press('次へ'); await screen.press('前回の時期はスキップ'); await screen.press('次へ');
  assert.ok(screen.text().includes('ゴミ収集日を設定'), 'onboarding must retain its waste setup step');
}

test('feature screen contract: onboarding can register weekly, biweekly and monthly waste then reach home', async () => {
  const h = await initialContext();
  try {
    let completed = 0;
    const screen = screenHarness('src/features/onboarding/first-run-setup.tsx', {
      exportName: 'FirstRunSetup', database: h.database,
      props: { snapshot: h.snapshot, onComplete: async () => { completed++; } },
    });
    await reachWasteStep(screen);
    await screen.change('ゴミの種類', 'かね'); await screen.press('可燃ごみを選択'); await screen.press('火曜'); await screen.press('収集日を追加');
    await screen.change('ゴミの種類', 'びん'); await screen.press('びんを選択'); await screen.press('隔週'); await screen.press('木曜'); await screen.press('収集日を追加');
    await screen.change('ゴミの種類', 'そだい'); await screen.press('粗大ごみを選択'); await screen.press('毎月'); await screen.change('毎月の収集日', '31'); await screen.press('収集日を追加');
    await screen.press('設定して始める');
    assert.equal(completed, 1);
    const saved = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(saved.settings.setupCompleted, true);
    assert.deepEqual(saved.wasteSchedules.map((schedule) => schedule.recurrence).sort(), ['biweekly', 'monthly', 'weekly']);
    assert.equal(saved.chores.filter((chore) => chore.enabled).length, 0);
  } finally { h.connection.close(); }
});

test('feature screen contract: waste onboarding can be skipped', async () => {
  const h = await initialContext();
  try {
    let completed = 0;
    const screen = screenHarness('src/features/onboarding/first-run-setup.tsx', {
      exportName: 'FirstRunSetup', database: h.database,
      props: { snapshot: h.snapshot, onComplete: async () => { completed++; } },
    });
    await reachWasteStep(screen);
    await screen.press('ゴミ収集日はスキップして始める');
    const saved = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(completed, 1); assert.equal(saved.settings.setupCompleted, true); assert.equal(saved.wasteSchedules.length, 0);
  } finally { h.connection.close(); }
});

test('feature screen contract: waste settings keep live kana suggestions, recurrence controls and collapsed upcoming list', async () => {
  const h = await initialContext();
  try {
    let snapshot = h.snapshot;
    const screen = screenHarness('src/app/waste.tsx', {
      database: h.database, snapshot: () => snapshot,
      refresh: async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); },
    });
    screen.button('次の収集日を開く');
    assert.ok(!screen.text().includes('例外日について'));
    await screen.change('ゴミの種類', 'かね');
    screen.button('可燃ごみを選択');
    await screen.press('可燃ごみを選択'); await screen.press('火曜'); await screen.press('収集日を追加');
    await screen.press('編集'); await screen.press('毎月'); await screen.change('毎月の収集日', '31'); await screen.press('変更を保存');
    assert.equal(snapshot.wasteSchedules.length, 1); assert.equal(snapshot.wasteSchedules[0].recurrence, 'monthly');
    await screen.press('次の収集日を開く');
    screen.button('次の収集日を閉じる'); assert.ok(screen.text().includes('今回は表示しない'));
    await screen.press('次の収集日を閉じる');
    screen.button('次の収集日を開く');
  } finally { h.connection.close(); }
});

test('feature screen contract: calendar renders weekly labels in headers and monthly labels on dates without resetting selected date', async () => {
  const h = await initialContext();
  try {
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'weekly', label: '可燃ごみ', collectionWeekdays: [2] });
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'monthly', label: '粗大ごみ', collectionWeekdays: [], recurrence: 'monthly', monthlyDay: 28 });
    const snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const screen = screenHarness('src/app/(tabs)/explore.tsx', { database: h.database, snapshot: () => snapshot });
    assert.ok(screen.nodes().some((node) => node.props.accessibilityLabel === '火曜日、可燃ごみ'));
    assert.ok(screen.nodes().some((node) => node.type === 'Pressable' && node.props.accessibilityLabel?.includes('粗大ごみ')));
    const firstDay = `${today.slice(0, 7)}-01`;
    await openCalendarDay(screen, firstDay, { chores: false }); await screen.press('月表示に戻る');
    const nextMonth = `${Number(today.slice(0, 4)) + (today.slice(5, 7) === '12' ? 1 : 0)}-${String(Number(today.slice(5, 7)) % 12 + 1).padStart(2, '0')}-01`;
    await scrollCalendarToDate(screen, nextMonth); await scrollCalendarToDate(screen, firstDay);
    const retained = screen.nodes().find(node => node.props.accessibilityLabel?.startsWith(`${formatJapaneseDate(firstDay, { year: true })}、`));
    assert.equal(retained.props.accessibilityState.selected, true);
    assert.ok(!screen.text().includes('を含む実施期間'), 'browsing weeks does not expand chore periods');
  } finally { h.connection.close(); }
});

test('feature screen contract: individual settings enable unknown chores and home completion/undo/disable stay consistent', async () => {
  const h = await initialContext();
  try {
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
    let snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const chore = snapshot.chores.find((item) => item.load === 'normal' && !item.archived);
    const shared = { database: h.database, snapshot: () => snapshot,
      refresh: async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); } };
    const settings = screenHarness('src/app/chores/[id].tsx', { ...shared, params: { id: chore.id } });
    const enabledSwitch = () => settings.nodes().find((node) => node.type === 'Switch');
    enabledSwitch().props.onValueChange(true); settings.render();
    await settings.change('家事周期の日数', '17'); await settings.endEditing('家事周期の日数');
    const home = screenHarness('src/app/(tabs)/index.tsx', shared);
    const checkbox = (verb) => home.nodes().find((node) => node.props.accessibilityLabel === `${chore.name}を${verb}`);
    assert.ok(checkbox('完了'), 'enabled unknown chore must immediately appear on home');
    checkbox('完了').props.onPress(); await home.flush();
    assert.ok(checkbox('未完了に戻す'));
    enabledSwitch().props.onValueChange(false); await settings.flush();
    home.render(); assert.ok(!checkbox('完了') && !checkbox('未完了に戻す'), 'disabled chores must disappear from active cards');
    assert.equal(snapshot.completions.length, 1);
    enabledSwitch().props.onValueChange(true); settings.render(); await settings.change('家事周期の日数', '30'); await settings.endEditing('家事周期の日数');
    home.render(); assert.ok(checkbox('未完了に戻す'));
    checkbox('未完了に戻す').props.onPress(); await home.flush();
    assert.ok(checkbox('完了')); assert.ok(!checkbox('未完了に戻す'));
    assert.equal(snapshot.chores.find((item) => item.id === chore.id).recommendedCycleDays, 30);
  } finally { h.connection.close(); }
});

test('feature screen contract: verified appliance analysis auto-saves maker intervals and Japanese category ids', async () => {
  const h = await initialContext();
  try {
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
    const tasks = [
      { name: 'フィルターを洗う', recommendedIntervalDays: 30, recommendedConditions: [], steps: ['電源を切る'], tools: ['布'], safetyCautions: ['乾燥させる'], evidence: [{ url: 'https://www.dyson.co.jp/support' }] },
      { name: '汚れを拭く', steps: ['布で拭く'], tools: ['布'], safetyCautions: [], evidence: [{ url: 'https://www.dyson.co.jp/support' }] },
    ];
    const verified = { status: 'verified', product: { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', category: 'vacuum_cleaner' },
      officialSources: { manualUrl: 'https://www.dyson.co.jp/support' },
      analysis: { manufacturer: 'Dyson', model: 'SV20', analyzedAt: new Date().toISOString(), requiresUserReview: true, tasks } };
    let sent;
    const screen = screenHarness('src/app/(tabs)/manual/appliance-care.tsx', { database: h.database,
      mocks: { '@/features/appliance-care/api-client': { analyzeApplianceCareRequest: async (request) => { sent = request; return withUploadedManual(verified, request.manual); } } },
    });
    await screen.change('メーカー名', 'Dyson'); await screen.change('製品名', 'V12'); await screen.change('型番', 'SV20');
    await screen.change('カテゴリ（任意）', 'そうじ'); await screen.press('掃除機を選択');
    await screen.press('取扱説明書PDFを選ぶ'); await screen.flush(); await screen.press('このPDFを利用・解析・共有できることを確認した');
    await screen.press('選択したPDFを解析');
    assert.equal(sent.category, 'vacuum_cleaner');
    const saved = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(saved.appliances.length, 1, 'analysis must save without an additional button press');
    const care = saved.chores.filter((chore) => chore.applianceId === saved.appliances[0].id);
    assert.equal(care.length, 1); assert.equal(care[0].manufacturerRecommendedIntervalDays, 30); assert.equal(care[0].enabled, true);
    assert.ok(saved.scheduleEntries.some((entry) => entry.choreId === care[0].id), 'maker intervals must reach the actual Scheduler');
    screen.button('保存した家電のお手入れ詳細を開く');
    assert.ok(screen.text().includes('カテゴリ：掃除機'));
    await screen.change('フィルターを洗うの周期', '45'); await screen.press('周期の変更を保存');
    const updated = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(updated.appliances.length, 1, 'cycle edits must not duplicate appliance');
    assert.equal(updated.chores.find((chore) => chore.id === care[0].id).userIntervalDays, 45);
    await screen.change('フィルターを洗うの周期', ''); await screen.press('周期の変更を保存');
    const reset = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(reset.chores.find((chore) => chore.id === care[0].id).userIntervalDays, undefined, 'clearing an override must restore the maker interval');
    await screen.change('汚れを拭くの周期', '14'); await screen.press('周期の変更を保存');
    let noMaker = (await repository.loadPlannerSnapshot(h.database, today)).chores.find((chore) => chore.applianceTaskName === '汚れを拭く');
    assert.equal(noMaker.enabled, true);
    await screen.change('汚れを拭くの周期', ''); await screen.press('周期の変更を保存');
    noMaker = (await repository.loadPlannerSnapshot(h.database, today)).chores.find((chore) => chore.id === noMaker.id);
    assert.equal(noMaker.enabled, false); assert.equal(noMaker.requiresCycleSelection, true); assert.equal(noMaker.userIntervalDays, undefined);
    await screen.change('汚れを拭くの周期', '7'); await screen.press('周期の変更を保存');
    noMaker = (await repository.loadPlannerSnapshot(h.database, today)).chores.find((chore) => chore.id === noMaker.id);
    assert.equal(noMaker.enabled, true, 'setting a previously missing interval must make the task schedulable');
  } finally { h.connection.close(); }
});

test('feature screen contract guard rejects a virtual removal of the waste onboarding step', async () => {
  const h = await initialContext();
  try {
    const screen = screenHarness('src/features/onboarding/first-run-setup.tsx', {
      exportName: 'FirstRunSetup', database: h.database,
      props: { snapshot: h.snapshot, onComplete: async () => {} },
      transformSource: (path, source) => path.endsWith('first-run-setup.tsx') ? source.replace('const setupStepCount = 6;', 'const setupStepCount = 5;') : source,
    });
    await assert.rejects(reachWasteStep(screen), /missing button: 次へ/u);
  } finally { h.connection.close(); }
});

test('feature screen contract: chore categories, kana heading search and trivia collection remain usable', async () => {
  const h = await initialContext();
  try {
    const screen = screenHarness('src/app/(tabs)/guide.tsx', { database: h.database, snapshot: () => h.snapshot });
    const count = h.snapshot.chores.filter((chore) => !chore.archived && chore.category === 'キッチン').length;
    await screen.press(`キッチン、${count}件`);
    assert.ok(!screen.text().includes('に分類されている家事です。'), 'redundant category copy stays removed');
    assert.equal(screen.nodes().filter((node) => node.props.accessibilityLabel?.endsWith('の説明を開く')).length, count, 'expanded categories show their own chore headings inline');
    await screen.press(`キッチン、${count}件`);
    await screen.change('家事名を検索', 'こんろ');
    const first = screen.nodes().find((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.endsWith('の説明を開く'));
    assert.ok(first.props.accessibilityLabel.startsWith('コンロ'), 'kana heading matches must come first');
    await screen.press(first.props.accessibilityLabel);
    assert.ok(screen.text().includes('注意事項') && screen.text().includes('豆知識'));
    assert.ok(!screen.text().includes('手順、必要な道具、注意事項を確認できます。'), 'obsolete detail header must not return');
    await screen.press('前の画面に戻る'); await screen.change('家事名を検索', '');
    const triviaCount = h.snapshot.chores.flatMap((chore) => chore.trivia ?? []).length;
    await screen.press(`豆知識、${triviaCount}件の豆知識`);
    assert.ok(screen.text().includes('見出しを選択'));
    const heading = screen.nodes().find((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('、') && node.props.accessibilityLabel !== '家事一覧に戻る');
    assert.ok(heading); await screen.press(heading.props.accessibilityLabel);
    screen.button('豆知識一覧に戻る');
  } finally { h.connection.close(); }
});

for (const [returnTo, expected] of [['home', '/'], ['calendar', '/(tabs)/explore']]) {
  test(`feature screen contract: guide detail returns to ${returnTo}`, async () => {
    const h = await initialContext();
    try {
      const calls = [];
      const screen = screenHarness('src/app/(tabs)/guide.tsx', { database: h.database, snapshot: () => h.snapshot,
        params: { choreId: h.snapshot.chores.find((item) => !item.archived).id, returnTo }, navigate: (...args) => calls.push(args) });
      await screen.press('前の画面に戻る'); assert.deepEqual(calls, [['navigate', expected]]);
    } finally { h.connection.close(); }
  });
}

test('feature screen contract: accordion exposes its expanded state and toggles in both directions', async () => {
  const props = { title: '生活リズム', expanded: true, onToggle: () => { props.expanded = !props.expanded; }, children: '本文' };
  const screen = screenHarness('src/components/accordion-section.tsx', { exportName: 'AccordionSection', props });
  assert.equal(screen.button('生活リズムを閉じる').props.accessibilityState.expanded, true);
  await screen.press('生活リズムを閉じる');
  assert.equal(screen.button('生活リズムを開く').props.accessibilityState.expanded, false);
  await screen.press('生活リズムを開く');
  assert.equal(screen.button('生活リズムを閉じる').props.accessibilityState.expanded, true);
});
