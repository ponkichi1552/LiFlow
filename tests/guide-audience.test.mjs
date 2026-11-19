import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase, loadPlannerSnapshot } = await import('../src/platform/storage/repository.ts');

for (const platform of ['ios', 'android']) test(`${platform} guide audience is explicit and scrolling cannot change the source of a planned chore`, async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const snapshot = await loadPlannerSnapshot(h.database, '2026-10-31'); const privateChore = snapshot.chores.find(chore => !chore.archived && !chore.requiresCycleSelection);
  const sharedChore = { ...privateChore, id: 'shared-identity', enabled: false };
  const model = { plan: { groupId: 'group', chores: [sharedChore], occurrences: [{ id: 'round', choreId: sharedChore.id, anchorDate: '2026-10-31', subjects: [{ id: 'subject', subjectUserId: 'owner' }] }], members: [] }, configurations: [], viewerUserId: 'owner', adminUserId: 'owner' };
  const writes = []; const opened = [];
  const screen = screenHarness('src/features/sharing/v2-ui/chore-book.tsx', { exportName: 'V2ChoreBook', platform,
    props: { model, personal: { snapshot, database: h.database, refresh: async () => {} }, selectedId: sharedChore.id, source: 'shared', hasTabBar: true,
      onBack() {}, onConfiguration: id => opened.push({ settings: id }), onRound: (...args) => opened.push({ round: args }), groupName: 'house', actions: { patchChore: async (id, patch) => writes.push({ id, patch }) },
      perform: async work => { await work(); return { committed: true, refreshed: true }; } },
    mocks: { '../../../components/chore-book': { ChoreBook: props => ({ type: 'ChoreBook', props: { ...props, children: [props.titleAccessory(props.chores[0]), props.renderChore(props.chores[0])] } }) } },
  });
  const scope = () => screen.nodes().filter(node => node.props.accessibilityRole === 'radio');
  assert.equal(scope().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.accessibilityState.checked, true);
  let document = screen.nodes().find(node => node.type === 'ChoreBook'); assert.deepEqual(document.props.chores.map(chore => chore.id), [sharedChore.id]); assert.equal(document.props.hasTabBar, true);
  assert.equal(screen.text().includes('日時・担当・実施状況'), false);
  assert.equal(screen.text().includes('実施を記録'), false);
  assert.deepEqual(opened, []);
  await screen.press('この家事の設定'); assert.deepEqual(opened, [{ settings: sharedChore.id }]);
  document.props.titleAccessory(sharedChore); screen.render(); assert.equal(scope().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.accessibilityState.checked, true);
  await screen.nodes().find(node => node.props.accessibilityLabel === '個人用の家事説明').props.onPress(); screen.render();
  document = screen.nodes().find(node => node.type === 'ChoreBook'); assert.ok(document.props.chores.some(chore => chore.id === privateChore.id)); assert.equal(document.props.selectedId, privateChore.id);
  assert.equal(writes.length, 0, 'changing the view cannot publish private settings');
  await screen.nodes().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.onPress(); screen.render();
  assert.equal(scope().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.accessibilityState.checked, true);
  assert.equal(writes.length, 0); assert.equal((await loadPlannerSnapshot(h.database, '2026-10-31')).chores.find(chore => chore.id === privateChore.id).enabled, privateChore.enabled);
});

for (const platform of ['ios', 'android']) test(`${platform} a custom guide without a counterpart cannot switch to an unrelated or empty guide`, async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const snapshot = await loadPlannerSnapshot(h.database, '2026-10-31');
  const original = { ...snapshot.chores[0], archived: false, id: 'personal-only', name: '鉢の水やり', category: '追加した家事', instructions: ['水をやる'], personalRecipeId: undefined };
  const unrelated = { ...original, id: 'shared-only', name: '別の家事' };
  const model = { plan: { groupId: 'group', chores: [unrelated, { ...unrelated, id: 'empty', name: original.name, instructions: [], description: '', tools: [], cautions: [], trivia: [] }], members: [] }, configurations: [], viewerUserId: 'owner', adminUserId: 'owner' };
  const screen = screenHarness('src/features/sharing/v2-ui/chore-book.tsx', { exportName: 'V2ChoreBook', platform,
    props: { model, personal: { snapshot: { ...snapshot, chores: [original] }, database: h.database, refresh: async () => {} }, selectedId: original.id, source: 'personal', onBack() {}, actions: {}, perform() {} },
    mocks: { '../../../components/chore-book': { ChoreBook: props => ({ type: 'ChoreBook', props: { ...props, children: props.titleAccessory(props.chores.find(row => row.id === props.selectedId)) } }) } } });
  t.after(() => screen.unmount());
  const other = screen.nodes().find(node => node.props.accessibilityLabel === 'グループ用の家事説明'); assert.equal(other.props.disabled, true);
  await other.props.onPress(); screen.render();
  assert.equal(screen.nodes().find(node => node.type === 'ChoreBook').props.selectedId, original.id);
});

for (const platform of ['ios', 'android']) test(`${platform} a scheduled custom chore without procedures opens its own details from a direct guide link`, t => {
  const custom = { id: 'scheduled-chore', name: '花に水をやる', category: '追加した家事', enabled: true, estimatedMinutes: 10,
    recommendedCycleDays: 7, description: '', instructions: [], procedureSections: [], tools: [], cautions: [] };
  const unrelated = { ...custom, id: 'other', name: '別の家事', instructions: ['別の手順'] };
  const model = { plan: { groupId: 'group', chores: [unrelated, custom] }, configurations: [], viewerUserId: 'member', adminUserId: 'owner' };
  const ui = screenHarness('src/features/sharing/v2-ui/chore-book.tsx', { exportName: 'V2ChoreBook', platform,
    props: { model, selectedId: custom.id, source: 'shared', onBack() {}, actions: {},
      perform: () => assert.fail('reading a guide cannot save shared changes') } });
  t.after(() => ui.unmount());
  assert.equal(ui.nodes().find(node => node.type === 'FlatList').props.data[0]?.id, custom.id);
  assert.match(ui.text(), /花に水をやる/u);
  assert.doesNotMatch(ui.text(), /この家事を表示できません/u);
});
