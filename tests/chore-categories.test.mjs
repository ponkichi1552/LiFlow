import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
const { groupChores } = await import('../src/domain/chores/chore-groups.ts');
const { choreCategoryOrder, choreDisplayCategory, choreFamilies } = await import('../src/domain/chores/chore-presentation.ts');
const { createPersonalChoreDefinitions, PERSONAL_CHORE_CATALOG } = await import('../src/domain/chores/personal-catalog.ts');
const { createHouseholdChoreDefinitions } = await import('../src/domain/chores/catalog.ts');

test('display categories retain every private and shared chore exactly once without rewriting source identity settings or categories', () => {
  for (const source of [createPersonalChoreDefinitions('private'), createHouseholdChoreDefinitions('shared').map(chore => ({ ...chore, id: `group.${chore.id}` }))]) {
    const before = structuredClone(source); source.forEach(Object.freeze); Object.freeze(source);
    const groups = groupChores(source); const rows = groups.flatMap(([, rows]) => rows);
    assert.equal(rows.length, source.length); assert.equal(new Set(rows.map(row => row.id)).size, source.length);
    assert.deepEqual(new Set(rows.map(row => row.id)), new Set(source.map(row => row.id)));
    assert.ok(groups.every(([category]) => choreCategoryOrder.includes(category)));
    assert.deepEqual(source, before); for (const row of rows) assert.equal(source.find(original => original.id === row.id), row);
    assert.equal(groups.some(([category]) => category.includes('初期値')), false);
  }
  const catalogue = createPersonalChoreDefinitions('private');
  const custom = { id: 'my-appliance', name: 'メーカー指定のお手入れ', category: '家電', applianceId: 'registered', enabled: false };
  const groups = groupChores([...catalogue, custom]);
  assert.equal(groups.filter(([name]) => name === '家電・設備').length, 1);
  assert.equal(groups.find(([name]) => name === '家電・設備')[1].includes(custom), true);
});

test('split candidates follow only their explicit parent and missing archived or ambiguous parents never hide surviving jobs', () => {
  const rows = createPersonalChoreDefinitions('private'); const groups = groupChores([...rows].reverse());
  for (const recipe of PERSONAL_CHORE_CATALOG.filter(recipe => recipe.splitParentId)) {
    const child = rows.find(row => row.id === recipe.id); if (!child) continue;
    const family = groups.flatMap(([, rows]) => choreFamilies(rows)).find(family => family.chore.id === recipe.splitParentId);
    assert.ok(family.children.includes(child)); assert.equal(choreDisplayCategory(child), choreDisplayCategory(family.chore));
  }
  const parent = rows.find(row => row.name === '浴室の清掃'); const child = rows.find(row => row.name === '浴槽だけの清掃');
  const stranger = { ...parent, id: 'custom', personalRecipeId: undefined };
  assert.equal(choreFamilies([child, stranger])[0].chore, child);
  assert.deepEqual(groupChores([{ ...parent, archived: true }, child]).flatMap(([, rows]) => rows), [child]);
  const duplicate = { ...parent, id: 'custom-copy' };
  assert.ok(choreFamilies([parent, duplicate, child]).some(family => family.chore === child));
  const category = { id: 'unknown', name: '本人の作業', category: '自分の分類' };
  assert.equal(choreDisplayCategory(category), '自分の分類');
  const entrance = rows.find(row => row.name === '玄関の床掃除'); const cabinet = rows.find(row => row.name === '靴箱内部の清掃');
  const entranceRows = groups.find(([category]) => category === '部屋・玄関')[1];
  assert.equal(entranceRows[entranceRows.indexOf(entrance) + 1], cabinet);
  const entranceFamilies = choreFamilies(entranceRows);
  assert.equal(entranceFamilies.find(family => family.chore === entrance).children.length, 0);
  assert.ok(entranceFamilies.some(family => family.chore === cabinet));
});

for (const platform of ['ios', 'android']) test(`${platform} settings book keeps one category outside scrolling chapters and opens explicit split destinations while refusing a failed collapse`, async () => {
  const definitions = createPersonalChoreDefinitions('private');
  const parent = definitions.find(chore => chore.name === '部屋の清掃');
  const child = definitions.find(chore => chore.name === '部屋の床だけの清掃');
  const bath = definitions.find(chore => chore.name === '浴室の清掃');
  const effects = []; let allow = false; let attempts = 0;
  const props = { chores: [parent, child, bath], title: '家事ごとの設定', selectedId: parent.id, collapseSplits: true,
    onBack() {}, beforeCollapse: async chore => { assert.equal(chore.id, child.id); attempts++; return allow; },
    renderChore: chore => chore.id === child.id ? `分割設定:${chore.id}` : chore.name };
  const screen = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform, props, effect: callback => effects.push(callback), layoutEffect: callback => callback() });
  for (const effect of effects.splice(0)) effect();
  assert.equal(screen.text().includes(`分割設定:${child.id}`), false);
  await screen.press(`${child.name}の設定を開く`); assert.ok(screen.text().includes(`分割設定:${child.id}`));
  await screen.press(`${child.name}の設定を閉じる`); assert.equal(attempts, 1); assert.ok(screen.text().includes(`分割設定:${child.id}`));
  allow = true; await screen.press(`${child.name}の設定を閉じる`); assert.equal(screen.text().includes(`分割設定:${child.id}`), false);
  const list = screen.nodes().find(node => node.type === 'FlatList');
  const descendantText = node => typeof node === 'string' ? node : (node.children ?? []).map(descendantText).join('');
  assert.equal(descendantText(list).includes('部屋・玄関'), false);
  const badge = screen.nodes().find(node => node.type === 'View' && node.props.onLayout && descendantText(node).includes('部屋・玄関'));
  badge.props.onLayout({ nativeEvent: { layout: { height: 64 } } }); await screen.flush();
  await screen.press(`${child.name}へ移動`);
  const destination = screen.nodes().find(node => node.type === 'FlatList');
  assert.equal(destination.props.data[0].id, child.id);
  const category = () => screen.nodes().find(node => node.props.accessibilityRole === 'header').children.join('');
  list.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: bath }] });
  screen.render(); assert.equal(category(), '部屋・玄関', 'a detached list cannot overwrite the category after a jump');
  destination.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: child }, { isViewable: true, item: bath }] });
  screen.render(); assert.equal(category(), '部屋・玄関');
  destination.props.onViewableItemsChanged({ viewableItems: [{ isViewable: false, item: child }, { isViewable: true, item: bath }] });
  screen.render(); assert.equal(category(), '浴室・トイレ');
  const direct = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform, props: { ...props, selectedId: child.id } });
  assert.ok(direct.text().includes(`分割設定:${child.id}`));
  const directList = direct.nodes().find(node => node.type === 'FlatList');
  assert.equal(directList.props.data[0].id, child.id); assert.equal(directList.props.initialScrollIndex, undefined);
});

for (const platform of ['ios', 'android']) test(`${platform} nested split controls show active children and preview parent exclusion then restore both switches after a failed save`, async () => {
  const definitions = createPersonalChoreDefinitions('private');
  const parent = definitions.find(chore => chore.name === '浴室の清掃');
  const child = definitions.find(chore => chore.name === '浴槽だけの清掃');
  const sibling = definitions.find(chore => chore.name === '浴室排水口の洗浄');
  let reject; const saved = []; const pending = [];
  const screen = screenHarness('src/features/settings/chore-toggle-list.tsx', { exportName: 'ChoreToggleList', platform, props: {
    chores: [parent, child, sibling], personalSelection: true, expanded: new Set(['浴室・トイレ']), setExpanded() {}, onOpen() {},
    onPendingChange: value => pending.push(value), save: async (ids, enabled) => { saved.push({ ids, enabled }); await new Promise((_, fail) => { reject = fail; }); },
  } });
  const toggle = name => screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === `${name}を有効にする`);
  assert.equal(toggle(child.name), undefined);
  await screen.press(`${parent.name}の細かな家事を開く`);
  toggle(child.name).props.onPress(); await screen.flush();
  assert.equal(toggle(parent.name).props.accessibilityState.checked, false); assert.equal(toggle(child.name).props.accessibilityState.checked, true); assert.equal(toggle(sibling.name).props.accessibilityState.checked, false);
  assert.deepEqual(saved, [{ ids: [child.id], enabled: true }]); assert.deepEqual(pending, [true]);
  reject(new Error('保存失敗')); await screen.flush();
  assert.equal(toggle(parent.name).props.accessibilityState.checked, true); assert.equal(toggle(child.name).props.accessibilityState.checked, false);
  assert.match(screen.text(), /保存失敗/u); assert.deepEqual(pending, [true, false]);
  const active = screenHarness('src/features/settings/chore-toggle-list.tsx', { exportName: 'ChoreToggleList', platform, props: {
    chores: [{ ...parent, enabled: false }, { ...child, enabled: true }, sibling], expanded: new Set(['浴室・トイレ']), setExpanded() {}, onOpen() {}, save: async () => {},
  } });
  assert.equal(active.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === `${child.name}を有効にする`).props.accessibilityState.checked, true);
  assert.match(active.text(), /分けて管理中/u);
});
