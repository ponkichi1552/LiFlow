import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

const entries = () => Array.from({ length: 64 }, (_, i) => ({ id: `hint-${i}`, chore: { name: i ? 'キッチンの清掃' : '部屋の清掃' },
  trivia: { title: i ? `台所の豆知識 ${i}` : '床のほこり', body: i ? '油汚れを拭く。' : '乾いたモップを使う。' } }));

for (const [platform, names] of [
  ['ios', { search: 'ios trivia finds headings chore names and body terms without eagerly mounting every article',
    position: 'ios trivia keeps its native list mounted during article navigation and only resets scroll for a changed query',
    guard: 'ios trivia article rejects mismatched household group and account scopes without reading another article',
    route: 'ios trivia article back preserves its search while returning to the chore library clears it without writes' }],
  ['android', { search: 'android trivia finds headings chore names and body terms without eagerly mounting every article',
    position: 'android trivia keeps its native list mounted during article navigation and only resets scroll for a changed query',
    guard: 'android trivia article rejects mismatched household group and account scopes without reading another article',
    route: 'android trivia article back preserves its search while returning to the chore library clears it without writes' }],
]) {
  test(names.search, async t => {
    const items = entries(), before = structuredClone(items), opened = [], back = [];
    const ui = screenHarness('src/features/chores/trivia-library.tsx', { exportName: 'TriviaLibrary', platform,
      props: { items, onOpen: id => opened.push(id), onBack: () => back.push(true) } }); t.after(() => ui.unmount());
    const list = () => ui.nodes().find(node => node.type === 'FlatList');
    assert.equal(list().props.data.length, items.length);
    assert.ok(ui.nodes().filter(node => node.props.accessibilityLabel?.includes('、キッチンの清掃')).length < items.length / 2);
    for (const query of ['もっぷ　部屋', '部屋 ﾓｯﾌﾟ', '床 ほこり']) {
      await ui.change('豆知識を検索', query); assert.deepEqual(list().props.data.map(item => item.id), ['hint-0']);
    }
    await ui.press('床のほこり、部屋の清掃'); assert.deepEqual(opened, ['hint-0']);
    await ui.change('豆知識を検索', 'どこにもない語'); assert.match(ui.text(), /一致する豆知識はありません/u);
    await ui.change('豆知識を検索', ''); assert.equal(list().props.data.length, items.length);
    await ui.press('家事一覧に戻る'); assert.deepEqual(back, [true]); assert.deepEqual(items, before);
  });

  test(names.position, async t => {
    const opened = [], moves = [];
    const ui = screenHarness('src/features/chores/trivia-library.tsx', { exportName: 'TriviaLibrary', platform, flatListItemHeight: 100,
      props: { items: entries(), onOpen: id => opened.push(id), onBack() {} } }); t.after(() => ui.unmount());
    const list = () => ui.nodes().find(node => node.type === 'FlatList'); const native = { scrollToOffset: value => moves.push(value) };
    list().props.ref.current = native; list().props.onScroll({ nativeEvent: { contentOffset: { y: 3000 } } }); await ui.flush();
    const label = ui.nodes().find(node => node.props.accessibilityLabel?.startsWith('台所の豆知識 30、')).props.accessibilityLabel;
    await ui.press(label); assert.deepEqual(opened, ['hint-30']); assert.equal(list().props.ref.current, native);
    ui.button(label); assert.deepEqual(moves, [], 'opening an article does not replace or scroll the native list');
    await ui.change('豆知識を検索', '床'); assert.deepEqual(moves, [{ offset: 0, animated: false }]);
  });

  test(names.guard, () => {
    const chores = [{ id: 'same-id', trivia: [{ id: 'hint', title: '同じIDの記事', body: '対象の記事本文' }] }];
    const params = { id: 'same-id:hint', householdId: 'original-household', groupId: 'group-a', userId: 'user-a' };
    const workspace = { userId: 'user-a', active: { groupId: 'group-a' } };
    for (const mismatch of ['household', 'group', 'account', 'active-group', 'none']) {
      const snapshot = { household: { id: mismatch === 'household' ? 'other-household' : params.householdId }, chores, settings: {},
        sharing: { groupId: mismatch === 'group' ? 'group-b' : 'group-a' } };
      const current = { ...workspace, ...(mismatch === 'account' ? { userId: 'user-b' } : {}), ...(mismatch === 'active-group' ? { active: { groupId: 'group-b' } } : {}) };
      const ui = screenHarness('src/app/trivia.tsx', { platform, snapshot: () => snapshot, params,
        mocks: { '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: current } } } });
      try {
        assert.equal(ui.text().includes('対象の記事本文'), mismatch === 'none', mismatch);
        if (mismatch !== 'none') assert.match(ui.text(), /見つかりません/u);
      } finally { ui.unmount(); }
    }
  });

  test(names.route, async t => {
    const chore = { id: 'one', name: '部屋の清掃', category: '部屋・玄関', enabled: true, recommendedCycleDays: 7, estimatedMinutes: 15,
      description: '部屋を拭く', instructions: ['拭く'], tools: [], cautions: [], trivia: [entries()[0].trivia, entries()[1].trivia] };
    const snapshot = { household: { id: 'local-household' }, chores: [chore], settings: { frequencyMode: 'balanced' } }, before = structuredClone(snapshot);
    const routes = []; const ui = screenHarness('src/app/(tabs)/guide.tsx', { platform, snapshot: () => snapshot, navigate: (...args) => routes.push(args),
      mocks: { '@/components/workspace-tab': { WorkspaceTab: ({ children }) => children } } }); t.after(() => ui.unmount());
    await ui.press('豆知識、2件の豆知識'); await ui.change('豆知識を検索', 'もっぷ 部屋'); await ui.press('床のほこり、部屋の清掃');
    const [kind, route] = routes.at(-1); assert.equal(kind, 'push'); assert.equal(route.pathname, '/trivia');
    const article = screenHarness('src/app/trivia.tsx', { platform, snapshot: () => snapshot, params: route.params, navigate: (...args) => routes.push(args) });
    try { assert.match(article.text(), /乾いたモップを使う/u); await article.press('豆知識一覧に戻る'); assert.equal(routes.at(-1)[0], 'back'); }
    finally { article.unmount(); }
    assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '豆知識を検索').props.value, 'もっぷ 部屋');
    await ui.press('家事一覧に戻る'); ui.button('豆知識、2件の豆知識');
    await ui.press('豆知識、2件の豆知識'); assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '豆知識を検索').props.value, '');
    assert.deepEqual(snapshot, before);
  });
}
