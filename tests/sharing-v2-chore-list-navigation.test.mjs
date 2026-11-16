import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) {
  test(`${platform} shared chore list addition discards native press events before its navigation callback`, () => {
    const calls = [];
    const screen = screenHarness('src/features/sharing/v2-ui/chore-list.tsx', {
      exportName: 'V2ChoreList', platform,
      props: {
        model: { plan: { groupId: 'synthetic-navigation-group', chores: [] } }, busy: false,
        onDetails() {}, onConfiguration() {}, onAdd: (...args) => { calls.push(args); },
      },
    });
    try {
      const add = screen.button('新しい共有家事を追加');
      assert.ok(add, 'the rendered shared list must offer its ordinary add action');
      const event = { nativeEvent: { target: 17, timestamp: 1234 }, currentTarget: 17 };
      add.props.onPress(event);
      assert.deepEqual(calls, [[]], 'a press event cannot become a calendar anchor date');
    } finally { screen.unmount(); }
  });
}
