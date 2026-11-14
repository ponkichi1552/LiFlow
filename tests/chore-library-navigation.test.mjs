import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

const chore = (id, name = id) => ({ id, name, category: '追加した家事', enabled: true, description: '布で拭く', instructions: [], tools: [], cautions: [] });

function controlledFrames() {
  const originalRequest = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
  const pending = new Map(); let sequence = 0;
  globalThis.requestAnimationFrame = callback => { const id = ++sequence; pending.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => pending.delete(id);
  return { flush() { const batch = [...pending.values()]; pending.clear(); batch.forEach(callback => callback(0)); },
    close() { globalThis.requestAnimationFrame = originalRequest; globalThis.cancelAnimationFrame = originalCancel; } };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} chore library searches only matching guides and retains expansion after clearing a kana query`, async t => {
    const rows = [chore('kitchen', 'キッチンの清掃'), chore('bath', '浴室の清掃')], before = structuredClone(rows), opened = [];
    const screen = screenHarness('src/features/chores/chore-library.tsx', { exportName: 'ChoreLibrary', platform,
      props: { chores: rows, onOpen: id => opened.push(id) } });
    t.after(() => screen.unmount());
    await screen.press('追加した家事、2件');
    await screen.change('家事名を検索', 'きっちん');
    assert.deepEqual(screen.nodes().filter(row => row.props.accessibilityLabel?.endsWith('の説明を開く')).map(row => row.props.accessibilityLabel), ['キッチンの清掃の説明を開く']);
    await screen.press('キッチンの清掃の説明を開く'); assert.deepEqual(opened, ['kitchen']);
    await screen.change('家事名を検索', '見つからない検索');
    assert.ok(screen.text().includes('一致する家事はありません。'));
    assert.equal(screen.nodes().some(row => row.props.accessibilityLabel?.endsWith('の説明を開く')), false);
    await screen.change('家事名を検索', '');
    assert.equal(screen.button('追加した家事、2件').props.accessibilityState.expanded, true);
    screen.button('浴室の清掃の説明を開く');
    assert.deepEqual(rows, before);
  });
  test(`${platform} chore book continues a backward gesture after restoring each preceding range and deduplicates boundary callbacks`, async t => {
    const frames = controlledFrames();
    const chores = Array.from({ length: 20 }, (_, index) => chore(`item-${index}`));
    const screen = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform,
      effect: callback => callback(), layoutEffect: callback => callback(), effectDependencies: true,
      props: { chores, selectedId: 'item-10', title: '家事の説明', onBack() {}, renderChore: row => row.name } });
    t.after(() => { screen.unmount(); frames.close(); });
    const list = () => screen.nodes().find(row => row.type === 'FlatList');
    const first = () => list().props.data[0].id;
    assert.equal(first(), 'item-10');
    list().props.onStartReached(); screen.render(); assert.equal(first(), 'item-10', 'opening the selected guide must not scroll or eagerly prepend');
    list().props.onScrollBeginDrag(); list().props.onScroll({ nativeEvent: { contentOffset: { y: -40 } } }); screen.render();
    const earlier = first(); assert.notEqual(earlier, 'item-10');
    for (let index = 0; index < 2; index++) list().props.renderItem({ item: list().props.data[index], index }).props.onLayout({ nativeEvent: { layout: { height: 500 } } });
    list().props.onStartReached(); list().props.onStartReached(); screen.render(); assert.equal(first(), earlier, 'repeated boundary callbacks cannot load over a pending anchor');
    frames.flush();
    list().props.onScroll({ nativeEvent: { contentOffset: { y: 1200 } } });
    list().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }); screen.render();
    assert.notEqual(first(), earlier, 'the same gesture can continue beyond the two newly loaded chapters');
    const continued = first(); list().props.onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } });
    list().props.onStartReached(); screen.render(); assert.equal(first(), continued, 'layout changes outside a user scroll do not move the document');
    assert.equal(new Set(list().props.data.map(row => row.id)).size, list().props.data.length);
  });
  test(`${platform} the guide keeps the selected chapter stable until backward scrolling and forwards native cell measurements`, t => {
    const chores = Array.from({ length: 50 }, (_, index) => chore(`chore-${index}`));
    const screen = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform,
      effect: callback => callback(), layoutEffect: callback => callback(), effectDependencies: true,
      props: { chores, selectedId: 'chore-30', title: '家事の説明', onBack() {}, renderChore: row => row.name } });
    t.after(() => screen.unmount());
    const list = () => screen.nodes().find(row => row.type === 'FlatList');
    assert.equal(list().props.data[0].id, 'chore-30');
    list().props.onLayout({ nativeEvent: { layout: { height: 600 } } });
    list().props.onScrollBeginDrag({ nativeEvent: { contentOffset: { y: 0 } } });
    list().props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } });
    list().props.onStartReached(); screen.render();
    assert.equal(list().props.data[0].id, 'chore-30', 'first paint and forward scrolling must retain the selected chapter');
    list().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }); screen.render();
    const preparedIds = list().props.data.map(row => row.id);
    assert.ok(preparedIds.indexOf('chore-30') > 0);
    assert.ok(preparedIds.length < chores.length, 'preparing previous chapters cannot mount the whole book');
    list().props.onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } });
    list().props.onScrollBeginDrag({ nativeEvent: { contentOffset: { y: 2000 } } });
    list().props.onStartReached(); screen.render();
    assert.deepEqual(list().props.data.map(row => row.id), preparedIds, 'the native anchor offset prevents a stale top-edge callback from loading unrelated chapters');
    const measured = [], focused = [];
    const cell = list().props.CellRendererComponent({ children: '家事の説明', onLayout: event => measured.push(event), onFocusCapture: event => focused.push(event) });
    cell.props.onLayout('measurement'); cell.props.onFocusCapture('focus');
    assert.deepEqual(measured, ['measurement']); assert.deepEqual(focused, ['focus']);
  });
  test(`${platform} a top-edge touch restores the measured preceding chapters without requiring native overscroll`, t => {
    const frames = controlledFrames();
    const chores = Array.from({ length: 20 }, (_, index) => chore(`row-${index}`));
    const screen = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform,
      effect: callback => callback(), layoutEffect: callback => callback(), effectDependencies: true,
      props: { chores, selectedId: 'row-10', title: '家事の説明', onBack() {}, renderChore: row => row.name } });
    t.after(() => { screen.unmount(); frames.close(); });
    const list = () => screen.nodes().find(row => row.type === 'FlatList'); const scrolls = [];
    list().props.ref.current = { scrollToOffset: value => scrolls.push(value) };
    list().props.onTouchStart({ nativeEvent: { pageY: 400 } });
    list().props.onTouchMove({ nativeEvent: { pageY: 440 } }); screen.render();
    assert.notEqual(list().props.data[0].id, 'row-10');
    const cells = list().props.data.slice(0, 2).map((item, index) => list().props.renderItem({ item, index }));
    cells[0].props.onLayout({ nativeEvent: { layout: { height: 200 } } }); assert.equal(scrolls.length, 0);
    cells[1].props.onLayout({ nativeEvent: { layout: { height: 600 } } });
    assert.equal(scrolls.length, 0, 'native receives its layout frame before any manual correction');
    frames.flush();
    const style = Object.assign({}, ...list().props.contentContainerStyle.flat(Infinity).filter(Boolean));
    assert.deepEqual(scrolls, [{ offset: 200 + 600 + 2 * style.gap - 40, animated: false }]);
    list().props.onTouchMove({ nativeEvent: { pageY: 460 } }); screen.render();
    assert.equal(scrolls.length, 1, 'a gesture restores its anchor once');
    list().props.onTouchEnd();
  });

  test(`${platform} native anchoring continues backward momentum without redundant scroll commands and cancels stale corrections on a jump`, t => {
    const frames = controlledFrames();
    const chores = Array.from({ length: 20 }, (_, index) => chore(`row-${index}`));
    const props = { chores, selectedId: 'row-10', title: '家事の説明', onBack() {}, renderChore: row => row.name };
    const screen = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform,
      effect: callback => callback(), layoutEffect: callback => callback(), effectDependencies: true, props });
    t.after(() => { screen.unmount(); frames.close(); });
    const list = () => screen.nodes().find(row => row.type === 'FlatList'); const scrolls = [];
    list().props.ref.current = { scrollToOffset: value => scrolls.push(value) };
    list().props.onTouchStart({ nativeEvent: { pageY: 400 } });
    list().props.onTouchMove({ nativeEvent: { pageY: 440 } }); screen.render();
    const measure = () => list().props.data.slice(0, 2).forEach((item, index) => list().props.renderItem({ item, index }).props.onLayout({ nativeEvent: { layout: { height: 500 } } }));
    measure(); list().props.onScroll({ nativeEvent: { contentOffset: { y: 1008 } } }); frames.flush();
    assert.deepEqual(scrolls, [], 'a redundant manual scroll would cancel momentum already preserved by native');
    const earlier = list().props.data[0].id;
    list().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }); screen.render();
    assert.notEqual(list().props.data[0].id, earlier);
    measure(); props.selectedId = 'row-15'; screen.render(); screen.render(); frames.flush();
    assert.equal(list().props.data[0].id, 'row-15'); assert.deepEqual(scrolls, [], 'a queued old-range correction cannot override an explicit chapter jump');
  });

  test(`${platform} retained guide chapters still update content and editing authority after heading changes`, t => {
    const chores = Array.from({ length: 6 }, (_, index) => chore(`row-${index}`));
    const props = { chores, selectedId: 'row-0', title: '家事の説明', onBack() {}, renderChore: row => `編集可能:${row.name}` };
    const screen = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform,
      effect: callback => callback(), layoutEffect: callback => callback(), effectDependencies: true, props });
    t.after(() => screen.unmount());
    const list = () => screen.nodes().find(row => row.type === 'FlatList');
    list().props.onViewableItemsChanged({ viewableItems: [{ item: chores[1], isViewable: true }] }); screen.render();
    props.chores = chores.map((row, index) => index === 0 ? { ...row, name: '変更後の家事名' } : row);
    props.renderChore = row => `読み取り専用:${row.name}`; props.header = '表示の取得に失敗'; screen.render();
    assert.ok(screen.text().includes('読み取り専用:変更後の家事名'));
    assert.equal(screen.text().includes('編集可能:'), false); assert.ok(screen.text().includes('表示の取得に失敗'));
  });
}
