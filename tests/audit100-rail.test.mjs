import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

function rail() {
  const effects = []; const selected = [];
  const screen = screenHarness('src/components/chore-category-rail.tsx', { exportName: 'ChoreCategoryRail', layoutEffect: callback => effects.push(callback),
    props: { groups: [{ name: '水回り', chores: [{ id: 'first', name: '家事1' }, { id: 'second', name: '家事2' }] }], category: '水回り', onSelect: id => selected.push(id), onScrubChange() {} } });
  effects.splice(0).forEach(callback => callback());
  return { screen, selected, root: screen.nodes().find(node => node.props.onPanResponderGrant) };
}
test('audit100 an old asynchronous rail measurement cannot steer the next drag gesture', () => {
  const h = rail(); const measures = []; h.root.props.ref({ measureInWindow: callback => measures.push(callback) });
  h.root.props.onPanResponderGrant({ nativeEvent: { pageY: 250 } }, { moveY: 250 }); h.root.props.onPanResponderRelease();
  h.root.props.onPanResponderGrant({ nativeEvent: { pageY: 480 } }, { moveY: 480 });
  measures[0](0, 100, 40, 300); assert.deepEqual(h.selected, []);
  measures[1](0, 400, 40, 300); assert.deepEqual(h.selected, ['first']);
  h.root.props.onPanResponderRelease(); h.screen.unmount();
});
test('audit100 the first accessible rail increment starts at the first chore when no row is selected', () => {
  const h = rail(); h.root.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
  assert.deepEqual(h.selected, ['first']); h.screen.unmount();
});
