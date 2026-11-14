import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

const tasks = Array.from({ length: 10 }, (_, index) => ({ name: `工程${index}`, steps: [`手順${index}`], tools: [], safetyCautions: [], evidence: [] }));
for (const platform of ['ios', 'android']) {
  test(`${platform} appliance index jumps to an unmounted task and final actions without changing reviewed data`, async t => {
    const original = structuredClone(tasks), calls = [];
    const screen = screenHarness('src/features/appliance-care/appliance-task-book.tsx', { exportName: 'ApplianceTaskBook', platform,
      effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
      props: { tasks, label: '掃除機', header: '保存した製品の説明', footer: '再解析・家電の操作',
        renderTask: task => task.steps[0], onBack: () => calls.push('back'), backAccessibilityLabel: '家電一覧へ戻る' } });
    t.after(() => screen.unmount());
    const list = () => screen.nodes().find(node => node.type === 'FlatList');
    assert.ok(screen.text().includes('手順0') && !screen.text().includes('手順8'));
    await screen.press('工程8へ移動');
    assert.equal(list().props.data[0].task.name, '工程8'); assert.ok(screen.text().includes('手順8'));
    const rail = screen.nodes().find(node => node.props.accessibilityLabel === 'お手入れの見出しを移動');
    assert.equal(rail.props.accessibilityValue.text, '工程8');
    await screen.press('家電の操作へ移動');
    assert.equal(list().props.data[0].id, 'appliance-actions'); assert.match(screen.text(), /再解析・家電の操作/u);
    await screen.press('工程0へ移動'); assert.equal(list().props.data[0].task.name, '工程0');
    await screen.press('家電一覧へ戻る'); assert.deepEqual(calls, ['back']); assert.deepEqual(tasks, original);
  });
  test(`${platform} appliance index follows the viewed task and scrubbing selects the touched heading`, async t => {
    const screen = screenHarness('src/features/appliance-care/appliance-task-book.tsx', { exportName: 'ApplianceTaskBook', platform,
      effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
      props: { tasks, label: '洗濯機', renderTask: task => task.steps[0], onBack() {} } });
    t.after(() => screen.unmount());
    let list = screen.nodes().find(node => node.type === 'FlatList');
    list.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: list.props.data[4] }] }); screen.render();
    let rail = screen.nodes().find(node => node.props.accessibilityLabel === 'お手入れの見出しを移動');
    assert.equal(rail.props.accessibilityValue.text, '工程4');
    rail.props.ref({ measureInWindow: callback => callback(0, 100, 40, 500) });
    rail.props.onLayout({ nativeEvent: { layout: { height: 500 } } }); screen.render();
    rail.props.onPanResponderGrant({ nativeEvent: { pageY: 540 } }, { moveY: 540 }); screen.render();
    list = screen.nodes().find(node => node.type === 'FlatList');
    assert.notEqual(list.props.data[0].task.name, '工程0'); assert.ok(screen.text().includes('洗濯機'));
    rail.props.onPanResponderRelease(); screen.render();
    assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === 'お手入れの見出しを移動').props.accessibilityValue.text, list.props.data[0].name);
  });
}
