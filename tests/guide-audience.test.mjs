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
  const model = { plan: { groupId: 'group', chores: [sharedChore], occurrences: [], members: [] }, configurations: [], viewerUserId: 'owner', adminUserId: 'owner' };
  const writes = [];
  const screen = screenHarness('src/features/sharing/v2-ui/chore-book.tsx', { exportName: 'V2ChoreBook', platform,
    props: { model, personal: { snapshot, database: h.database, refresh: async () => {} }, selectedId: sharedChore.id, source: 'shared', hasTabBar: true,
      onBack() {}, onConfiguration() {}, groupName: 'house', actions: { patchChore: async (id, patch) => writes.push({ id, patch }) },
      perform: async work => { await work(); return { committed: true, refreshed: true }; } },
    mocks: { '../../../components/chore-book': { ChoreBook: props => ({ type: 'ChoreBook', props: { ...props, children: [props.titleAccessory(props.chores[0]), props.renderChore(props.chores[0])] } }) } },
  });
  const scope = () => screen.nodes().filter(node => node.props.accessibilityRole === 'radio');
  assert.equal(scope().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.accessibilityState.checked, true);
  let document = screen.nodes().find(node => node.type === 'ChoreBook'); assert.deepEqual(document.props.chores.map(chore => chore.id), [sharedChore.id]); assert.equal(document.props.hasTabBar, true);
  document.props.titleAccessory(sharedChore); screen.render(); assert.equal(scope().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.accessibilityState.checked, true);
  await screen.nodes().find(node => node.props.accessibilityLabel === '個人用の家事説明').props.onPress(); screen.render();
  document = screen.nodes().find(node => node.type === 'ChoreBook'); assert.ok(document.props.chores.some(chore => chore.id === privateChore.id)); assert.equal(document.props.selectedId, privateChore.id);
  assert.equal(writes.length, 0, 'changing the view cannot publish private settings');
  await screen.nodes().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.onPress(); screen.render();
  assert.equal(scope().find(node => node.props.accessibilityLabel === 'グループ用の家事説明').props.accessibilityState.checked, true);
  assert.equal(writes.length, 0); assert.equal((await loadPlannerSnapshot(h.database, '2026-10-31')).chores.find(chore => chore.id === privateChore.id).enabled, privateChore.enabled);
});
