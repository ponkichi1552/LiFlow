import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
const range = { from: '2026-10-27', through: '2026-10-27', asOfDate: '2026-10-27' };
for (const platform of ['ios', 'android']) test(`${platform} shared settings can return immediately while loading without flashing a separate synchronization panel`, async () => {
  let focus; let backs = 0;
  const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
    props: { purpose: 'workspace', view: 'configuration', loadSession: () => new Promise(() => {}), onBack: () => backs++, onConfiguration() {}, onHistory() {} },
    focusEffect: callback => { focus = callback; } });
  const leave = focus(); await screen.flush();
  assert.ok(screen.text().includes('家事ごとの設定'));
  assert.equal(screen.text().includes('端末に保存した変更は、接続後に共有します。'), false);
  await screen.press('前の画面に戻る'); assert.equal(backs, 1);
  leave(); screen.unmount();
});
for (const platform of ['ios', 'android']) test(`${platform} shared settings use one fixed-audience document and retain invalid cadence input after virtual chapters unmount`, async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  const initial = seeds(); initial[2].payload.category = '水回り';
  await d.repository.commit([...initial, draft('add-a', 'chore', 'zz-extra-a', { name: '別の家事A', category: '水回り', enabled: false }), draft('add-b', 'chore', 'zz-extra-b', { name: '別の家事B', category: '屋外', enabled: false })]);
  let id = 0; const controller = createV2GroupController(d.repository, { makeId: () => `book-${++id}`, now, sync: async () => {} });
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now, readPreferences: () => { throw new Error('private preferences must not open'); } });
  const effects = []; let backs = 0;
  const props = { model: await session.readModel({ management: true, choreSettings: true }), session, choreId: 'floor', groupName: '家族', onBack: () => backs++,
    onSaved: async () => { props.model = await session.readModel({ management: true, choreSettings: true }); } };
  const screen = screenHarness('src/features/sharing/v2-ui/chore-settings-book.tsx', { exportName: 'V2ChoreSettingsBook', platform, props,
    flatListItemHeight: 1000, effect: callback => effects.push(callback), layoutEffect: callback => callback() });
  const load = async () => { for (const effect of effects.splice(0)) effect(); for (let i = 0; i < 8; i++) await screen.flush(); };
  await load(); assert.equal(screen.text().split('グループ用').length - 1, 1);
  assert.equal(screen.text().includes('周期・担当の設定へ'), false); assert.equal(screen.text().includes('日時変更の権限へ'), false);
  await screen.change('共有家事の周期', 'invalid'); await screen.endEditing('共有家事の周期');
  const scroll = offset => { screen.nodes().find(node => node.type === 'FlatList').props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } }); screen.render(); };
  scroll(3000); await load(); assert.equal(screen.nodes().some(node => node.type === 'TextInput' && node.props.accessibilityLabel === '共有家事の周期'), false);
  scroll(0); await load(); const field = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '共有家事の周期');
  assert.equal(field.props.value, 'invalid'); await screen.press('前の画面に戻る'); assert.equal(backs, 0);
  assert.equal((await controller.readModel(range)).configurations.find(row => row.choreId === 'floor').configuration.intervalDays, 7);
  await screen.change('共有家事の周期', '17'); await screen.endEditing('共有家事の周期');
  for (let i = 0; i < 10; i++) await screen.flush();
  assert.equal((await controller.readModel(range)).configurations.find(row => row.choreId === 'floor').configuration.intervalDays, 17);
  await screen.press('前の画面に戻る'); assert.equal(backs, 1);
});

test('connected shared settings read one authenticated snapshot and scrolling never rebuilds the same repository state for each chapter', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  await d.repository.commit([...seeds(), ...Array.from({ length: 30 }, (_, index) => draft(`extra-${index}`, 'chore', `extra-${index}`, { name: `家事${index}`, enabled: false }))]);
  let reads = 0; const repository = { ...d.repository, readState: async () => { reads++; return d.repository.readState(); } };
  const controller = createV2GroupController(repository, { makeId: () => 'unused', now, sync: async () => {} });
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now, readPreferences: () => { throw new Error('private read'); } });
  const model = await session.readModel({ management: true, choreSettings: true });
  assert.equal(reads, 1); assert.equal(model.choreDetails.length, 31); assert.equal(model.choreDateRights.length, 31);
  const effects = []; const screen = screenHarness('src/features/sharing/v2-ui/chore-settings-book.tsx', { exportName: 'V2ChoreSettingsBook',
    props: { model, session, choreId: 'floor', groupName: '家族', onBack() {}, onSaved: async () => {} }, flatListItemHeight: 1000,
    effect: callback => effects.push(callback), layoutEffect: callback => callback() });
  for (const offset of [0, 4000, 16000, 29000, 0]) {
    screen.nodes().find(node => node.type === 'FlatList').props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } }); screen.render();
    for (const effect of effects.splice(0)) effect(); await screen.flush();
  }
  assert.equal(reads, 1, 'mounting and scrolling chapters must use the captured model');
  const single = await controller.readModel(range, { detailChoreId: 'floor', permissionsChoreId: 'floor' });
  assert.deepEqual(model.choreDetails.find(row => row.choreId === 'floor'), single.choreDetails[0]);
  assert.deepEqual(model.choreDateRights.find(row => row.choreId === 'floor'), single.dateRights);
  await assert.rejects(session.readModel({ choreSettings: true }), /編集画面/u);
});
