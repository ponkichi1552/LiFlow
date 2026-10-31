import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { applianceResult } from './helpers/sharing-v2-appliance.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const checkbox = (screen, label) => screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label);
const reviewLabel = 'メーカー・型番・手順・注意事項を確認した';
async function settle(screen, predicate) { for (let n = 0; n < 40 && !predicate(); n++) await screen.flush(); assert.ok(predicate(), screen.text()); }
function controller(device) { let id = 0; return createV2GroupController(device.repository, { makeId: () => `appliance-ui-${device.options.userId}-${++id}`, now, sync: async () => {} }); }
async function receive(device, facts) { const checkpoint = await readSharingCheckpoint(device.database, groupId);
  await applyReceivedSharedFacts(device.database, groupId, facts, String(facts.length), device.repository.project, checkpoint.cursor, now().getTime(), device.repository.evidenceForServerReceipts(receiptsFor(facts))); }
async function setup() {
  const base = await fixture(); const device = await base.device(); await device.repository.commit(seeds()); const c = controller(device);
  let preferences = 0; let requests = []; let implementation = async () => applianceResult(); let failRead = false; let failAfterSave = false; const mounts = [];
  const decorated = { ...c, actions: { ...c.actions, reviewAppliance: async input => { const value = await c.actions.reviewAppliance(input); if (failAfterSave) { failAfterSave = false; failRead = true; } return value; } } };
  const source = createV2ScreenSession({ controller: decorated, groupId, userId: 'owner', now, readPreferences: () => { preferences++; throw new Error('No private planning in asset management'); } });
  const session = { ...source, readModel: options => { if (failRead) { failRead = false; throw new Error('injected view failure'); } return source.readModel(options); } };
  async function mount(platform, view = 'applianceReview', applianceId, bottomInset = 0, screenProps = {}) {
    let focus; const navigation = []; const effects = []; const blurListeners = new Set();
    const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { platform, exportName: 'V2GroupScreen',
      props: { purpose: 'workspace', view, applianceId, loadSession: async () => session, onBack: () => navigation.push(['back']), onConfiguration: id => navigation.push(['configuration', id]), onHistory() {},
        onAppliance: id => navigation.push(['appliance', id]), onApplianceReview: id => navigation.push(['review', id]), ...screenProps },
      focusEffect: callback => { focus = callback; },
      navigationListener: (event, listener) => { if (event === 'blur') blurListeners.add(listener); },
      navigationUnsubscribe: (event, listener) => { if (event === 'blur') blurListeners.delete(listener); },
      effect: callback => { const cleanup = callback(); if (cleanup) effects.push(cleanup); },
      mocks: { '../../appliance-care/api-client': { analyzeApplianceCareRequest: async (...args) => { requests.push(args[0]); return implementation(...args); } },
        'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, right: 0, left: 0, bottom: bottomInset }) } } });
    let leave = focus(); mounts.push(() => { leave(); effects.forEach(cleanup => cleanup()); });
    await settle(screen, () => screen.text().includes('対象の共有家電を表示できません') || screen.text().includes(view === 'appliances' ? '登録した家電' : view === 'appliance' ? '共有家電のお手入れ' : '選択したPDFを解析する'));
    if (view === 'applianceReview' && screen.text().includes('取扱説明書PDFを選ぶ')) { await screen.press('取扱説明書PDFを選ぶ'); await screen.flush(); await screen.press('このPDFを利用・解析・共有できることを確認した'); }
    return { screen, navigation, blur: () => { assert.ok(blurListeners.size > 0, 'the retained shared review must handle blur'); for (const listener of blurListeners) listener(); },
      refresh: async () => { leave(); leave = focus(); await screen.flush(); }, leave: () => { leave(); effects.forEach(cleanup => cleanup()); } };
  }
  const read = id => c.readModel(range, { appliances: true, applianceId: id });
  return { base, device, c, mount, read, preferences: () => preferences, requests: () => requests, analyzeWith: fn => { implementation = fn; }, failAfterNextSave: () => { failAfterSave = true; },
    async seed() { const result = applianceResult(); return c.actions.reviewAppliance({ reviewed: true, result, addTaskNames: result.analysis.tasks.map(task => task.name) }); },
    close() { mounts.forEach(cleanup => cleanup()); device.connection.close(); } };
}
async function analyze(screen) {
  await screen.change('メーカー', 'Dyson'); await screen.change('製品名', 'V12 Detect Slim'); await screen.change('型番', 'SV20'); await screen.press('選択したPDFを解析する');
  await settle(screen, () => Boolean(checkbox(screen, reviewLabel)));
}
for (const platform of ['ios', 'android']) {
  test(`${platform} shared appliance analysis waits for an explicit review and selected new tasks stay disabled with separate shared cadence`, async () => {
    const f = await setup();
    try {
      const { screen, navigation } = await f.mount(platform); assert.match(screen.text(), /解析APIとAI提供元へ送信します/u);
      const before = await listSharingOutbox(f.device.database, groupId); await analyze(screen);
      assert.equal(f.requests().length, 1); assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before);
      assert.equal(screen.button('確認した解析結果を共有する').props.accessibilityState.disabled, true);
      await checkbox(screen, '「フィルター清掃」を無効の共有家事として追加').props.onPress(); await screen.flush();
      await checkbox(screen, reviewLabel).props.onPress(); await screen.flush();
      const save = screen.button('確認した解析結果を共有する'); save.props.onPress(); save.props.onPress();
      await settle(screen, () => screen.text().includes('新しい家事1件は無効'));
      const model = await f.read(); assert.equal(model.appliances.rows.length, 1); assert.equal(model.plan.chores.filter(chore => chore.name.includes('フィルター')).length, 1);
      assert.equal(f.preferences(), 0); assert.equal(screen.text().includes('予定周期：30日'), false);
      await screen.press('保存した共有家電を開く'); assert.deepEqual(navigation.at(-1), ['appliance', model.appliances.rows[0].id]);
    } finally { f.close(); }
  });

  test(`${platform} a reviewed shared appliance saves the latest input and cancels without sharing partial or late analysis`, async () => {
    const f = await setup();
    try {
      let release; let aborted = false;
      f.analyzeWith((_request, _base, _timeout, _stage, signal) => new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { aborted = true; }); }));
      const mounted = await f.mount(platform); const { screen } = mounted;
      await screen.change('メーカー', 'Dyson'); await screen.change('製品名', 'V12'); await screen.change('型番', 'SV20');
      const button = screen.button('選択したPDFを解析する'); const input = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '型番');
      input.props.onChangeText('SV21'); button.props.onPress(); await screen.flush(); assert.equal(f.requests()[0].modelNumber, 'SV21');
      const before = await listSharingOutbox(f.device.database, groupId); await screen.press('解析を中止'); assert.equal(aborted, true);
      release(applianceResult()); await screen.flush(); assert.equal(checkbox(screen, reviewLabel), undefined); assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before);
      f.analyzeWith(async () => ({ status: 'ambiguous', candidates: [] })); await screen.press('選択したPDFを解析する');
      await settle(screen, () => screen.text().includes('製品を特定できませんでした'));
      assert.equal((await f.read()).appliances.rows.length, 0);
    } finally { f.close(); }
  });

  test(`${platform} a durable shared appliance review retries only its read after a failed refresh and preserves the saved identity`, async () => {
    const f = await setup();
    try {
      const { screen } = await f.mount(platform); await analyze(screen); await checkbox(screen, reviewLabel).props.onPress(); await screen.flush();
      f.failAfterNextSave(); await screen.press('確認した解析結果を共有する'); await settle(screen, () => screen.text().includes('端末に保存済みです'));
      const before = await listSharingOutbox(f.device.database, groupId); assert.equal((await f.read()).appliances.rows.length, 1);
      assert.equal(screen.button('選択したPDFを解析する').props.accessibilityState.disabled, true);
      await screen.press('保存済みの家電を再読込'); await settle(screen, () => !screen.text().includes('端末に保存済みです'));
      assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before); assert.equal(screen.nodes().some(node => node.children?.join('') === '確認した解析結果を共有する'), false);
    } finally { f.close(); }
  });

  test(`${platform} reanalysis keeps its originally displayed basis when another member changes the same appliance during review`, async () => {
    const f = await setup();
    try {
      const saved = await f.seed(); const mounted = await f.mount(platform, 'applianceReview', saved.applianceId); const { screen } = mounted;
      assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '型番').props.editable, false);
      await screen.press('選択したPDFを解析する'); await settle(screen, () => Boolean(checkbox(screen, reviewLabel)));
      const row = (await f.read(saved.applianceId)).appliances.detail.row; const result = applianceResult(); result.product.productName = '別端末で変更';
      await f.c.actions.reviewAppliance({ reviewed: true, result, selection: row.selection, addTaskNames: [] }); await mounted.refresh();
      const before = await listSharingOutbox(f.device.database, groupId); await checkbox(screen, reviewLabel).props.onPress(); await screen.flush(); await screen.press('確認した解析結果を共有する');
      await settle(screen, () => screen.text().includes('別の変更が届いています'));
      assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before); assert.equal((await f.read(saved.applianceId)).appliances.detail.appliance.productName, '別端末で変更');
    } finally { f.close(); }
  });

  test(`${platform} shared appliance deletion is confirmed separately and keeps linked chores while an explicit reviewed restore remains available`, async () => {
    const f = await setup();
    try {
      const saved = await f.seed(); const { screen } = await f.mount(platform, 'appliance', saved.applianceId); const before = await listSharingOutbox(f.device.database, groupId);
      await screen.press('この共有家電を削除'); assert.match(screen.text(), /登録済みの家事・周期・完了履歴は保持/u); assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before);
      await screen.press('共有家電の削除を確定'); await settle(screen, () => screen.text().includes('この家電は削除されています'));
      assert.equal((await f.read()).plan.chores.length, 3); assert.equal(screen.text().includes('予定周期：30日'), false);
      await screen.press('家電の候補1を確認'); await settle(screen, () => Boolean(checkbox(screen, reviewLabel)));
      await checkbox(screen, reviewLabel).props.onPress(); await screen.flush(); await screen.press('確認した内容で家電を残す');
      await settle(screen, () => !screen.text().includes('この家電は削除されています'));
      assert.ok((await f.read(saved.applianceId)).appliances.detail.appliance); assert.equal((await f.read()).plan.chores.length, 3);
    } finally { f.close(); }
  });

  test(`${platform} shared appliance conflicts expose a whole candidate before an explicit choice and never mix two analyses`, async () => {
    const f = await setup(); const member = await f.base.device('member', f.base.member);
    try {
      const saved = await f.seed(); await receive(member, await loadSharedFacts(f.device.database, groupId)); const b = controller(member); const row = (await f.read(saved.applianceId)).appliances.detail.row;
      const aResult = applianceResult(); aResult.analysis.tasks[0].steps = ['先行候補の手順']; const bResult = applianceResult(); bResult.analysis.tasks[0].steps = ['別候補の手順'];
      await f.c.actions.reviewAppliance({ reviewed: true, result: aResult, selection: row.selection, addTaskNames: [] });
      await b.actions.reviewAppliance({ reviewed: true, result: bResult, selection: row.selection, addTaskNames: [] }); await receive(f.device, await loadSharedFacts(member.database, groupId));
      const { screen } = await f.mount(platform, 'appliance', saved.applianceId); assert.equal(checkbox(screen, reviewLabel), undefined); assert.equal(screen.text().includes('先行候補の手順'), false);
      await screen.press('家電の候補1を確認'); await settle(screen, () => Boolean(checkbox(screen, reviewLabel)));
      const candidate = (await f.read(saved.applianceId)).appliances.detail.candidates[0]; assert.match(screen.text(), new RegExp(candidate.appliance.analysis.tasks[0].steps[0]));
      await checkbox(screen, reviewLabel).props.onPress(); await screen.flush(); await screen.press('この候補で競合を解決'); await settle(screen, () => screen.text().includes('端末に保存しました'));
      assert.equal((await f.read(saved.applianceId)).appliances.detail.source.kind, 'value');
    } finally { member.connection.close(); f.close(); }
  });

  test(`${platform} shared appliance review clearing an input invalidates an already enabled save handler before the next paint`, async () => {
    const f = await setup();
    try {
      const { screen } = await f.mount(platform); await analyze(screen); await checkbox(screen, reviewLabel).props.onPress(); await screen.flush();
      const save = screen.button('確認した解析結果を共有する'); const input = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '型番');
      const before = await listSharingOutbox(f.device.database, groupId); input.props.onChangeText('SV99'); save.props.onPress();
      await settle(screen, () => screen.text().includes('メーカー・型番・手順・注意事項を確認してください'));
      assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before); assert.equal((await f.read()).appliances.rows.length, 0);
    } finally { f.close(); }
  });

  test(`${platform} deleted shared appliances remain reachable behind a collapsed section without restoring anything on open`, async () => {
    const f = await setup();
    try {
      const saved = await f.seed(); const row = (await f.read(saved.applianceId)).appliances.detail.row; await f.c.actions.deleteAppliance(row.selection);
      const before = await listSharingOutbox(f.device.database, groupId); const { screen, navigation } = await f.mount(platform, 'appliances');
      assert.equal(screen.text().includes('の復元内容を確認'), false); await screen.press('削除した共有家電を開く');
      await screen.press(`「${row.displayName}」の復元内容を確認`); assert.deepEqual(navigation.at(-1), ['appliance', saved.applianceId]);
      assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before); assert.equal(f.preferences(), 0);
    } finally { f.close(); }
  });

  test(`${platform} appliance input for a different route never binds another previously loaded appliance`, async () => {
    const f = await setup();
    try {
      await f.seed(); const { screen } = await f.mount(platform, 'applianceReview', 'another-appliance');
      assert.match(screen.text(), /対象の共有家電を表示できません/u); assert.equal(screen.nodes().some(node => node.type === 'TextInput'), false);
      assert.equal(f.requests().length, 0);
    } finally { f.close(); }
  });

  test(`${platform} shared appliance details distinguish current AI instructions from an already edited chore and retain guarded product links`, async () => {
    const f = await setup();
    try {
      const saved = await f.seed(); const choreId = saved.createdChoreIds[0];
      const detail = (await f.c.readModel(range, { detailChoreId: choreId })).choreDetails[0];
      await f.c.actions.patchChoreDetails(choreId, [{ field: 'instructions', value: ['自分たちで変更した手順'], basisOperationIds: detail.fields.instructions.candidates.map(source => source.operationId) }]);
      const current = (await f.read(saved.applianceId)).appliances.detail; const result = applianceResult(); result.officialSources.productUrl = 'https://www.dyson.co.jp/v12';
      await f.c.actions.reviewAppliance({ reviewed: true, result, selection: current.row.selection, addTaskNames: [] });
      const { screen, navigation } = await f.mount(platform, 'appliance', saved.applianceId);
      assert.match(screen.text(), /登録済み家事の手順には違いがあります/u); assert.match(screen.text(), /公式製品情報を見る/u);
      const name = (await f.read()).plan.chores.find(row => row.id === choreId).name;
      await screen.press(`「${name}」の手順・設定`); assert.deepEqual(navigation.at(-1), ['configuration', choreId]);
      assert.deepEqual((await f.read()).plan.chores.find(row => row.id === choreId).instructions, ['自分たちで変更した手順']);
    } finally { f.close(); }
  });

  test(`${platform} shared appliance review leaves its final confirmation above the device bottom inset`, async () => {
    const f = await setup();
    try {
      const bottom = platform === 'android' ? 48 : 34; const { screen } = await f.mount(platform, 'applianceReview', undefined, bottom);
      await analyze(screen); const list = screen.nodes().find(node => node.type === 'FlatList');
      assert.ok(list.props.contentContainerStyle.paddingBottom >= bottom + 24);
      assert.equal(list.props.initialNumToRender, 1); assert.equal(list.props.maxToRenderPerBatch, 1); assert.equal(list.props.windowSize, 3);
      assert.equal(screen.button('確認した解析結果を共有する').props.accessibilityState.disabled, true);
    } finally { f.close(); }
  });

  test(`${platform} leaving a retained shared appliance review aborts polling and ignores a late result without preventing a fresh attempt`, async () => {
    const f = await setup();
    try {
      let finish; let finishNext; let signal; f.analyzeWith((_request, _base, _timeout, _stage, inputSignal) => { signal = inputSignal; return new Promise(resolve => { finish = resolve; }); });
      const mounted = await f.mount(platform); const { screen } = mounted;
      await screen.change('メーカー', 'Dyson'); await screen.change('製品名', 'V12'); await screen.change('型番', 'SV20'); await screen.press('選択したPDFを解析する');
      const before = await listSharingOutbox(f.device.database, groupId); assert.equal(signal.aborted, false); mounted.blur(); assert.equal(signal.aborted, true);
      await screen.flush(); assert.equal(screen.button('選択したPDFを解析する').props.accessibilityState.disabled, false, 'retry must not wait for a cancelled transport to settle');
      f.analyzeWith(() => new Promise(resolve => { finishNext = resolve; })); await screen.press('選択したPDFを解析する');
      finish(applianceResult()); await screen.flush(); assert.equal(checkbox(screen, reviewLabel), undefined);
      assert.equal(screen.button('選択したPDFを解析する').props.accessibilityState.disabled, true, 'the old finally cannot unlock the newer request');
      const newer = applianceResult(); newer.product.productName = '新しい解析結果'; finishNext(newer); await settle(screen, () => Boolean(checkbox(screen, reviewLabel)));
      assert.match(screen.text(), /新しい解析結果/u);
      assert.equal(f.requests().length, 2); assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before);
    } finally { f.close(); }
  });
}

test('shared and personal appliance task cards reuse source guarded instructions while a shared cadence slot still shows condition-only guidance', () => {
  const task = applianceResult().analysis.tasks[1];
  const screen = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'MaintenanceTaskCard',
    props: { task, manufacturer: 'Dyson', index: 1, schedule: '共有の設定は未構成' } });
  assert.match(screen.text(), /汚れが付いたとき/u); assert.match(screen.text(), /十分に乾燥させる/u); assert.equal(screen.text().includes('予定周期：'), false);
  assert.ok(screen.nodes().some(node => node.props.accessibilityRole === 'link'));
});

for (const platform of ['ios', 'android']) test(`${platform} the joined appliance tab composes private and shared rows without a mode switch or a shared write`, async () => {
  const f = await setup(); const personalCalls = [];
  try {
    const saved = await f.seed(); const model = await f.read(saved.applianceId);
    const privateAppliance = { ...model.appliances.detail.appliance, id: saved.applianceId, householdId: 'local-household', modelNumber: 'PRIVATE-MODEL', displayName: '本人だけの家電' };
    const before = await listSharingOutbox(f.device.database, groupId);
    const { screen, navigation } = await f.mount(platform, 'appliances', undefined, 0, {
      personalGuide: { snapshot: { appliances: [privateAppliance] } }, onPersonalAppliance: id => personalCalls.push(id), onAddPersonalAppliance() {},
    });
    assert.match(screen.text(), /2台/u); assert.equal(screen.text().includes('個人モード'), false);
    await screen.press('本人だけの家電のお手入れを開く（個人）'); assert.deepEqual(personalCalls, [saved.applianceId]); assert.equal(navigation.length, 0);
    await screen.press(`${model.appliances.rows[0].displayName}のお手入れを開く（グループ）`); assert.deepEqual(navigation.at(-1), ['appliance', saved.applianceId]);
    assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before); assert.equal(f.requests().length, 0);
  } finally { f.close(); }
});
