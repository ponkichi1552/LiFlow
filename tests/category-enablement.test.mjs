import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
for (const platform of ['ios', 'android']) test(`${platform} category rows report partial enablement without redundant bulk buttons`, async () => {
  let opened; const chores = [false, true, false].map((enabled, index) => ({ id: String(index), name: `家事${index}`, category: '水回り', enabled }));
  const props = { chores, expanded: new Set(['水回り']), setExpanded() {}, onOpen: id => { opened = id; }, save: async () => {} };
  const screen = screenHarness('src/features/settings/chore-toggle-list.tsx', { exportName: 'ChoreToggleList', platform, props });
  assert.ok(screen.text().includes('1/3')); assert.equal(screen.nodes().filter(node => node.type === 'Switch').length, 3);
  assert.equal(screen.nodes().some(node => /すべて有効|すべて無効|個別に選ぶ/u.test(node.props.accessibilityLabel ?? '')), false);
  await screen.press('家事1の個別設定'); assert.equal(opened, '1');
});
