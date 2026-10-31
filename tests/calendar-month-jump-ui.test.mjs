import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';

for (const platform of ['ios', 'android']) {
  test(`${platform} month title opens a bounded year-month picker and jumping preserves detail mode and clamps the preferred day`, async () => {
    for (const mode of ['month', '1日表示', '2日表示', 'リスト表示']) {
      const dates = []; const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
        today: '2026-11-30', timeZone: 'Asia/Tokyo', onSelectDate: value => dates.push(value), dayInfo: () => ({ loaded: true, total: 2 }), renderChores: () => null,
      } });
      if (mode !== 'month') await selectCalendarView(screen, mode);
      await screen.press('表示する年と月を選択'); await screen.press('2027年'); await screen.press('2月'); await screen.press('2027年2月へ移動');
      assert.equal(dates.at(-1), '2027-02-28');
      const expected = mode === 'month' ? 'calendar-weeks' : mode === 'リスト表示' ? 'calendar-agenda' : 'calendar-timeline';
      assert.ok(screen.nodes().some(node => node.props.testID === expected), `${mode} remains selected`);
      assert.ok(!screen.nodes().some(node => node.type === 'Modal'));
    }
  });
  test(`${platform} a split-month first day keeps its left edge and every month starts with a horizontal grid line`, () => {
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today: '2026-12-01', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 2 }), renderChores: () => null,
    } });
    const first = screen.nodes().find(node => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('2026年12月1日、'));
    assert.ok(first); const style = Object.assign({}, ...first.props.style.filter(Boolean)); assert.equal(style.borderLeftWidth, 1);
    const list = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    const row = list.props.data.find(row => row.days.includes('2026-12-01'));
    assert.equal(row.days[1], null); assert.equal(row.days[2], '2026-12-01');
    const monthStarts = screen.nodes().filter(node => node.type === 'View' && Array.isArray(node.props.style) && node.props.style.some(part => part?.borderTopWidth === 1));
    assert.ok(monthStarts.length > 0);
  });
}
