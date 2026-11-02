import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';

const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
function makeController(d) { let id = 0; return createV2GroupController(d.repository, { now, makeId: () => `${d.options.userId}-detail-ui-${++id}`, sync: async () => {} }); }
async function setup(userId = 'owner') {
  const f = await fixture(); const owner = await f.device(); const d = userId === 'owner' ? owner : await f.device('member', f.member);
  const initial = seeds(); Object.assign(initial[2].payload, { description: '床掃除の説明', instructions: ['共通の手順'],
    procedureSections: [{ title: '準備', steps: ['道具を用意する'] }], tools: ['モップ'], cautions: ['床材を確認する'], sourceNotes: ['https://example.org/manual'] });
  await owner.repository.commit(initial); if (d !== owner) await receive(d, await loadSharedFacts(owner.database, groupId));
  const controller = makeController(d);
  return { f, owner, d, controller, close: () => { d.connection.close(); if (d !== owner) owner.connection.close(); } };
}
async function editor(f, platform) {
  const pendingEffects = []; const cleanups = []; let focus; let left = 0;
  const props = { model: await f.controller.readModel(range, { detailChoreId: 'floor' }), choreId: 'floor', controller: f.controller, onBack: () => { left++; },
    onSaved: async () => { props.model = await f.controller.readModel(range, { detailChoreId: 'floor' }); } };
  const screen = screenHarness('src/features/sharing/v2-ui/chore-details-editor.tsx', { exportName: 'V2ChoreDetailsEditor', platform, props,
    effect: (callback) => pendingEffects.push(callback), focusEffect: (callback) => { focus = callback; } });
  const commit = () => { for (const effect of pendingEffects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); } };
  const settle = async (predicate = () => true) => { for (let i = 0; i < 30; i++) { commit(); await screen.flush(); if (predicate()) return; } assert.fail(screen.text()); };
  const leave = focus?.(); commit(); await settle();
  return { screen, props, commit, settle, left: () => left, close: async () => {
    if (screen.text().includes('入力を最新の内容に戻す')) await screen.press('入力を最新の内容に戻す');
    leave?.(); for (const cleanup of cleanups) cleanup(); await screen.flush();
  } };
}
const input = (screen, label) => { const node = screen.nodes().find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === label); assert.ok(node, label); return node; };

for (const platform of ['ios', 'android']) {
  test(`${platform} shared detail forms autosave member edits and preserve grouped procedures during multiple inputs before a repaint`, async () => {
    const f = await setup('member'); const ui = await editor(f, platform);
    try {
      const before = ui.props.model.plan.chores.find((chore) => chore.id === 'floor');
      await ui.screen.change('共有家事の名前', 'メンバーが編集した名前'); await ui.screen.endEditing('共有家事の名前');
      await ui.settle(() => ui.screen.text().includes('端末に保存しました'));
      await ui.screen.press('家事の手順を開く'); await ui.settle();
      const title = input(ui.screen, '手順の区分1の見出し'); const steps = input(ui.screen, '手順の区分1（1行に1手順）');
      title.props.onChangeText('拭き掃除'); steps.props.onChangeText('床を拭く\n乾かす\n'); await steps.props.onEndEditing();
      await ui.settle(() => ui.screen.text().includes('端末に保存しました'));
      const after = (await f.controller.readModel(range)).plan.chores.find((chore) => chore.id === 'floor');
      assert.equal(after.name, 'メンバーが編集した名前'); assert.deepEqual(after.procedureSections, [{ title: '拭き掃除', steps: ['床を拭く', '乾かす'] }]);
      assert.equal(input(ui.screen, '手順の区分1（1行に1手順）').props.value, '床を拭く\n乾かす\n');
      for (const field of ['instructions', 'tools', 'cautions', 'sourceNotes', 'enabled', 'frequencyDaysByMode']) assert.deepEqual(after[field], before[field]);
      assert.equal(ui.screen.text().includes('周期・担当の設定へ'), false);
      assert.ok((await loadSharedFacts(f.d.database, groupId)).some((fact) => fact.operation.authorUserId === 'member' && fact.operation.payload.procedureSections));
      await ui.screen.press('戻る'); await ui.settle(); assert.equal(ui.left(), 1);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} shared detail input cannot overwrite an authenticated edit received after render and before the input event`, async () => {
    const f = await setup(); const ui = await editor(f, platform);
    try {
      await f.controller.actions.patchChore('floor', { name: '別の画面で保存された名前' });
      ui.props.model = await f.controller.readModel(range, { detailChoreId: 'floor' }); ui.screen.render();
      const oldInput = input(ui.screen, '共有家事の名前'); ui.commit();
      oldInput.props.onChangeText('古い画面で入力した名前'); await oldInput.props.onEndEditing();
      await ui.settle(() => ui.screen.text().includes('別の変更が届いています'));
      assert.equal((await f.controller.readModel(range)).plan.chores.find((chore) => chore.id === 'floor').name, '別の画面で保存された名前');
      assert.equal(input(ui.screen, '共有家事の名前').props.value, '古い画面で入力した名前');
      await ui.screen.press('入力を最新の内容に戻す'); await ui.settle();
      assert.equal(input(ui.screen, '共有家事の名前').props.value, '別の画面で保存された名前');
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} shared detail conflicts require opening a candidate and explicitly resolving its currently displayed sources`, async () => {
    const f = await setup(); const member = await f.f.device('member', f.f.member); let ui;
    try {
      await receive(member, await loadSharedFacts(f.owner.database, groupId)); const other = makeController(member);
      const source = (await f.controller.readModel(range, { detailChoreId: 'floor' })).choreDetails[0].fields.name;
      const basisOperationIds = source.candidates.map((candidate) => candidate.operationId);
      await f.controller.actions.patchChoreDetails('floor', [{ field: 'name', value: '候補の名前A', basisOperationIds }]);
      await other.actions.patchChoreDetails('floor', [{ field: 'name', value: '候補の名前B', basisOperationIds }]);
      await receive(f.owner, await loadSharedFacts(member.database, groupId)); ui = await editor(f, platform);
      const conflict = ui.props.model.choreDetails[0].fields.name; assert.equal(conflict.kind, 'conflict');
      assert.equal(ui.screen.nodes().some((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '共有家事の名前'), false);
      assert.equal(ui.screen.nodes().some((node) => node.props.accessibilityRole === 'button' && node.children?.join('') === '候補1で解決する'), false);
      const button = ui.screen.nodes().find((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith('候補1 · ')); assert.ok(button);
      await button.props.onPress(); await ui.screen.flush(); assert.ok(ui.screen.text().includes(conflict.candidates[0].value));
      await ui.screen.press('候補1で解決する'); await ui.settle(() => ui.screen.text().includes('端末に保存しました'));
      assert.equal(input(ui.screen, '共有家事の名前').props.value, conflict.candidates[0].value);
      assert.equal((await f.controller.readModel(range)).plan.chores.find((chore) => chore.id === 'floor').enabled, true);
    } finally { await ui?.close(); member.connection.close(); f.close(); }
  });

  test(`${platform} shared chore creation discloses its audience and saves the latest input once without activating a schedule`, async () => {
    const f = await setup('member'); let created; const props = { actions: f.controller.actions, busy: false, run: async (work) => { await work(); }, onCreated: (id) => { created = id; }, onBack: () => {} };
    try {
      const screen = screenHarness('src/features/sharing/v2-ui/add-chore.tsx', { exportName: 'V2AddChore', platform, props });
      const before = await listSharingOutbox(f.d.database, groupId); assert.match(screen.text(), /グループ全員に公開/u);
      await screen.press('この内容を共有家事に追加'); assert.match(screen.text(), /家事名は1/u); assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
      const button = screen.button('この内容を共有家事に追加'); input(screen, '追加する共有家事の名前').props.onChangeText('描画前に入力した共有家事');
      input(screen, '追加する手順（1行に1手順）').props.onChangeText('準備する\n片付ける'); button.props.onPress(); button.props.onPress();
      for (let i = 0; i < 30 && !created; i++) await screen.flush(); assert.ok(created);
      const model = await f.controller.readModel(range); const chore = model.plan.chores.find((row) => row.id === created);
      assert.equal(chore.name, '描画前に入力した共有家事'); assert.deepEqual(chore.instructions, ['準備する', '片付ける']); assert.equal(chore.enabled, false);
      assert.equal(model.plan.occurrences.some((round) => round.choreId === created), false);
      assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 1);
    } finally { f.close(); }
  });

  test(`${platform} shared chore catalogs virtualize a thousand rows and keep ordinary members out of cadence controls`, async () => {
    const f = await setup('member');
    try {
      const model = await f.controller.readModel(range); model.plan.chores = Array.from({ length: 1000 }, (_, index) => ({ ...model.plan.chores[0], id: `ui-only-${index}`, name: `共有家事${index}` }));
      const opened = []; const props = { model, busy: false, onDetails: (id) => opened.push(id), onConfiguration: () => { throw new Error('member cadence entry'); }, onAdd: () => {} };
      const screen = screenHarness('src/features/sharing/v2-ui/chore-list.tsx', { exportName: 'V2ChoreList', platform, props });
      await screen.press(`${model.plan.chores[0].category}、1000件`);
      const list = screen.nodes().find((node) => node.type === 'FlatList'); assert.equal(list.props.data.filter(row => row.kind === 'chore').length, 1000); assert.ok(list.props.initialNumToRender < 1000);
      assert.equal(list.props.keyboardShouldPersistTaps, 'handled', 'a filtered edit action receives the first tap while the keyboard is open');
      assert.equal(list.props.keyboardDismissMode, 'on-drag', 'dragging the catalog can reveal a keyboard-covered result');
      assert.equal(list.props.automaticallyAdjustKeyboardInsets, platform === 'ios', 'Android adjustResize must not receive a second inset correction');
      assert.ok(screen.nodes().filter(node => node.props.accessibilityLabel?.endsWith('の説明を開く')).length < 1000);
      assert.equal(screen.nodes().some(node => node.props.accessibilityLabel?.includes('の名前・手順を編集')), false);
      assert.equal(screen.nodes().some((node) => node.props.accessibilityLabel?.includes('の周期・担当の設定')), false);
      await screen.change('家事名を検索', '共有家事999'); await screen.press('共有家事999の説明を開く'); assert.deepEqual(opened, ['ui-only-999']);
    } finally { f.close(); }
  });

  test(`${platform} a saved shared chore is opened again after navigation fails without creating a duplicate`, async () => {
    const f = await setup('member'); let opens = 0; const ids = [];
    const props = { actions: f.controller.actions, busy: false, run: async (work) => { await work(); },
      onCreated: (id) => { ids.push(id); if (++opens === 1) throw new Error('route failed'); }, onBack: () => {} };
    try {
      const screen = screenHarness('src/features/sharing/v2-ui/add-chore.tsx', { exportName: 'V2AddChore', platform, props });
      const before = await listSharingOutbox(f.d.database, groupId);
      await screen.change('追加する共有家事の名前', '移動を再試行する家事'); await screen.press('この内容を共有家事に追加');
      for (let i = 0; i < 30 && opens === 0; i++) await screen.flush(); await screen.flush();
      assert.match(screen.text(), /追加済み/u); assert.equal(input(screen, '追加する共有家事の名前').props.editable, false);
      await screen.press('追加済みの家事を開く'); await screen.flush();
      assert.equal(opens, 2); assert.equal(ids[0], ids[1]);
      assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 1);
      assert.equal((await f.controller.readModel(range)).plan.chores.filter((row) => row.name === '移動を再試行する家事').length, 1);
    } finally { f.close(); }
  });

  test(`${platform} shared round guides retain grouped steps tools cautions without reference links and edit the same shared chore`, async () => {
    const f = await setup('member'); let focus; const opened = []; const links = [];
    try {
      const session = createV2ScreenSession({ controller: f.controller, groupId, userId: 'member', now,
        readPreferences: () => ({ ownerUserId: 'member', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      const model = await session.readModel(); const round = model.plan.occurrences.find((entry) => entry.choreId === 'floor');
      const before = await listSharingOutbox(f.d.database, groupId);
      const props = { purpose: 'workspace', view: 'round', occurrenceId: round.id, subjectId: round.subjects[0].id, loadSession: async () => session,
        onBack: () => {}, onConfiguration: () => {}, onHistory: () => {}, onDetails: (id) => opened.push(id) };
      const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform, props,
        focusEffect: (callback) => { focus = callback; }, openURL: (url) => links.push(url) });
      const leave = focus(); for (let i = 0; i < 30 && !screen.text().includes('床掃除の説明'); i++) await screen.flush();
      for (const value of ['床掃除の説明', '準備', '道具を用意する', 'モップ', '床材を確認する']) assert.ok(screen.text().includes(value), screen.text());
      assert.equal(screen.text().includes('共通の手順'), false);
      assert.equal(screen.nodes().some(node => node.props.accessibilityLabel?.startsWith('参照元を開く：')), false);
      assert.deepEqual(links, []);
      await screen.press('家事の手順を閉じる');
      assert.equal(screen.nodes().some((node) => node.type === 'Text' && node.children?.includes('道具を用意する')), false);
      await screen.press('家事の手順を開く'); await screen.press('家事名・手順を編集'); assert.deepEqual(opened, ['floor']);
      assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before); leave();
    } finally { f.close(); }
  });
}

test('v2 management reads do not depend on personal preferences, private chores or a recommendation calculation', async () => {
  const f = await setup(); let preferences = 0; let privateReads = 0;
  try {
    const session = createV2ScreenSession({ controller: f.controller, groupId, userId: 'owner', now,
      readPreferences: () => { preferences++; throw new Error('private unavailable'); }, privateTasks: { read: async () => { privateReads++; throw new Error('private unavailable'); } } });
    const model = await session.readModel({ management: true, detailChoreId: 'floor' });
    assert.equal(model.choreDetails.length, 1); assert.equal(model.personal, undefined); assert.equal(model.privateOverlay, undefined);
    assert.equal(preferences, 0); assert.equal(privateReads, 0); assert.equal(model.plan.range.from, model.plan.range.through);
    const rights = await session.readModel({ management: true, permissionsChoreId: 'floor' });
    assert.equal(rights.dateRights.choreId, 'floor'); assert.ok(rights.groupPolicy); assert.equal(preferences, 0); assert.equal(privateReads, 0);
    await assert.rejects(session.readModel({ management: true, calendarMonth: 'current' }), /同時/u);
  } finally { f.close(); }
});
