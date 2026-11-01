import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { choreInAudience } from '../src/features/chores/audience-selection.ts';
const { initializeLocalDatabase, loadPlannerSnapshot } = await import('../src/platform/storage/repository.ts');

const radio = (screen, label) => {
  const node = screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === label);
  assert.ok(node, `missing audience: ${label}`); return node;
};
const record = { userId: 'owner', groupId, status: 'active' };
const workspaceContext = context => ({ '../contexts/workspace-context': { WorkspaceContext: context } });

for (const platform of ['ios', 'android']) {
  test(`${platform} detailed settings switch audiences only after saving and open the matching independent chore`, async t => {
    const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const data = { database: h.database, snapshot: await loadPlannerSnapshot(h.database, '2026-11-01'), loading: false, error: null,
      refresh: async () => { data.snapshot = await loadPlannerSnapshot(h.database, '2026-11-01'); } };
    const chore = data.snapshot.chores.find(row => !row.archived && !row.requiresCycleSelection);
    const navigation = [], context = { _currentValue: { userId: 'owner', group: record } };
    const screen = screenHarness('src/app/settings/chore/[id].tsx', { platform,
      params: { id: 'foreign-shared-id', source: 'personal', matchName: chore.name, matchCategory: chore.category }, personalData: () => data,
      mocks: workspaceContext(context), navigate: (method, destination) => {
        assert.equal(data.snapshot.chores.find(row => row.id === chore.id).recommendedCycleDays, 17, 'persist before navigation');
        navigation.push({ method, destination });
      } });
    assert.equal(radio(screen, '個人用の家事設定').props.accessibilityState.checked, true);
    assert.equal(screen.nodes().find(node => node.type === 'ChoreBook').props.selectedId, chore.id);
    await screen.change('家事周期の日数', '17');
    await radio(screen, 'グループ用の家事設定').props.onPress(); await screen.flush();
    assert.deepEqual(navigation, [{ method: 'replace', destination: { pathname: '/sharing/chore-settings/[id]', params: {
      id: chore.id, groupId, matchName: chore.name, matchCategory: chore.category,
    } } }]);
    assert.equal(h.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='sharing_operations'").get().n, 0,
      'a personal save and audience navigation never create a shared ledger');
    screen.unmount();
  });

  test(`${platform} invalid personal drafts and changed memberships block a detailed settings audience switch`, async t => {
    const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const data = { database: h.database, snapshot: await loadPlannerSnapshot(h.database, '2026-11-01'), loading: true, error: null,
      refresh: async () => { data.snapshot = await loadPlannerSnapshot(h.database, '2026-11-01'); } };
    const chore = data.snapshot.chores.find(row => !row.archived && !row.requiresCycleSelection);
    const context = { _currentValue: { userId: 'owner', group: { ...record } } }, navigation = [];
    const screen = screenHarness('src/app/settings/chore/[id].tsx', { platform, params: { id: chore.id, source: 'personal' },
      personalData: () => data, layoutEffect: callback => callback(), mocks: workspaceContext(context), navigate: (...args) => navigation.push(args) });
    await screen.change('家事周期の日数', 'invalid');
    await radio(screen, 'グループ用の家事設定').props.onPress(); await screen.flush();
    assert.equal(navigation.length, 0); assert.ok(screen.text().includes('数値に入力の誤り'));
    assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '家事周期の日数').props.value, 'invalid');
    await screen.change('家事周期の日数', '17');
    const oldSwitch = radio(screen, 'グループ用の家事設定').props.onPress;
    context._currentValue = { userId: 'different-user', group: { ...record } }; screen.render();
    await oldSwitch(); await screen.flush(); assert.equal(navigation.length, 0);
    assert.ok(screen.text().includes('所属グループが変わりました'));
    screen.unmount();
  });

  test(`${platform} shared detailed settings retain invalid drafts and save only the group before switching to personal`, async t => {
    const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
    let sequence = 0; const controller = createV2GroupController(d.repository, { makeId: () => `audience-${++sequence}`, now, sync: async () => {} });
    const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now, readPreferences: () => { throw new Error('must not read personal settings'); } });
    const navigation = []; const props = { model: await session.readModel({ management: true, choreSettings: true }), session,
      choreId: 'foreign-personal-id', selection: { name: '床を掃除する', category: '水回り' }, groupName: '家族', onBack() {},
      onSaved: async () => { props.model = await session.readModel({ management: true, choreSettings: true }); } };
    const effects = []; const screen = screenHarness('src/features/sharing/v2-ui/chore-settings-book.tsx', { exportName: 'V2ChoreSettingsBook', platform, props,
      effect: callback => effects.push(callback), layoutEffect: callback => callback(), mocks: workspaceContext({ _currentValue: { userId: 'owner', group: record } }),
      navigate: (...args) => navigation.push(args) });
    for (const effect of effects.splice(0)) effect(); await screen.flush();
    assert.equal(radio(screen, 'グループ用の家事設定').props.accessibilityState.checked, true);
    await screen.change('共有家事の周期', 'invalid');
    await radio(screen, '個人用の家事設定').props.onPress(); await screen.flush(); assert.equal(navigation.length, 0);
    assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '共有家事の周期').props.value, 'invalid');
    await screen.change('共有家事の周期', '19');
    await radio(screen, '個人用の家事設定').props.onPress(); await screen.flush();
    assert.equal((await session.readModel({ management: true, choreSettings: true })).configurations.find(row => row.choreId === 'floor').configuration.intervalDays, 19);
    assert.deepEqual(navigation, [['replace', { pathname: '/settings/chore/[id]', params: {
      id: 'floor', source: 'personal', matchName: '床を掃除する', matchCategory: props.model.plan.chores[0].category,
    } }]]);
    assert.equal(d.connection.prepare('SELECT count(*) AS n FROM chore_definitions').get().n, 0);
    screen.unmount();
  });

  test(`${platform} unjoined detailed settings do not offer a personal group switch`, async t => {
    const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const snapshot = await loadPlannerSnapshot(h.database, '2026-11-01');
    const screen = screenHarness('src/app/settings/chore/[id].tsx', { platform, params: { id: snapshot.chores[0].id, source: 'personal' },
      personalData: () => ({ database: h.database, snapshot, refresh: async () => {}, loading: false }), mocks: workspaceContext({ _currentValue: null }) });
    assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'radio').length, 0);
    screen.unmount();
  });
}

test('audience matching skips archived chores and falls back within the visible category without copying data', () => {
  const rows = [{ id: 'archived', name: '床', category: '居室', archived: true }, { id: 'kitchen', name: '台所', category: 'キッチン' },
    { id: 'room', name: '棚', category: '居室' }];
  const before = structuredClone(rows);
  assert.equal(choreInAudience(rows, { name: '床', category: '居室' }), 'room');
  assert.equal(choreInAudience(rows, { name: '台所', category: '居室' }), 'kitchen');
  assert.equal(choreInAudience([], { name: '床', category: '居室' }), undefined); assert.deepEqual(rows, before);
});
