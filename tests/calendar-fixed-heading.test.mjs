import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
const descendants = node => [node, ...(node.children ?? []).filter(child => typeof child === 'object').flatMap(descendants)];
for (const platform of ['ios', 'android']) test(`${platform} timeline date and chore controls remain outside the native scrolling content in both day modes`, async () => {
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-10-31', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 2, total: 2, minutes: 45 }), renderChores: day => `手順:${day}`,
  } });
  for (const [mode, days] of [['1日表示', 1], ['2日表示', 2]]) {
    await screen.press(mode);
    const header = screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading'); const list = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
    assert.ok(header && list); assert.equal(descendants(list).includes(header), false);
    const toggles = descendants(header).filter(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('の家事を'));
    assert.equal(toggles.length, days); const calls = []; list.props.ref.current = { scrollToOffset: value => calls.push(value) };
    if (toggles[0].props.accessibilityState.expanded) { await toggles[0].props.onPress(); await screen.flush(); }
    await screen.nodes().find(node => node.props.accessibilityLabel === toggles[0].props.accessibilityLabel?.replace('閉じる', '開く')).props.onPress(); await screen.flush(); assert.ok(screen.text().includes('手順:2026-10-31')); assert.equal(calls.at(-1).offset, 0);
    list.props.onScroll?.({ nativeEvent: { contentOffset: { y: 800, x: 0 } } }); screen.render();
    const stillFixed = screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading'); assert.ok(stillFixed);
  }
});
