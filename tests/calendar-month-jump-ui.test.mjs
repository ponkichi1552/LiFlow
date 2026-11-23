import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { jumpCalendarMonth, selectCalendarView } from './helpers/calendar-ui.mjs';

for (const platform of ['ios', 'android']) {
  test(`${platform} month title opens a bounded year-month picker and jumping preserves detail mode and clamps the preferred day`, async () => {
    for (const mode of ['month', '1日表示', '2日表示', 'リスト表示']) {
      const dates = []; const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
        today: '2026-11-30', timeZone: 'Asia/Tokyo', onSelectDate: value => dates.push(value), dayInfo: () => ({ loaded: true, total: 2 }), renderChores: () => null,
      } });
      if (mode !== 'month') await selectCalendarView(screen, mode);
      await jumpCalendarMonth(screen, 2027, 2);
      assert.equal(dates.at(-1), '2027-02-28');
      const expected = mode === 'month' ? 'calendar-weeks' : mode === 'リスト表示' ? 'calendar-agenda' : 'calendar-timeline';
      assert.ok(screen.nodes().some(node => node.props.testID === expected), `${mode} remains selected`);
      assert.ok(!screen.nodes().some(node => node.type === 'Modal'));
    }
  });
  test(`${platform} a split-month first day keeps its weekday and selects the real date without adjacent-month duplicates`, () => {
    const selected = [];
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today: '2026-12-01', timeZone: 'Asia/Tokyo', onSelectDate: day => selected.push(day), dayInfo: () => ({ loaded: true, total: 2 }), renderChores: () => null,
    } });
    const first = screen.nodes().find(node => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('2026年12月1日、'));
    assert.ok(first);
    assert.equal(screen.nodes().filter(node => node.props.accessibilityLabel?.startsWith('2026年12月1日、')).length, 1);
    const list = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    const row = list.props.data.find(row => row.days.includes('2026-12-01'));
    assert.equal(row.days[1], null); assert.equal(row.days[2], '2026-12-01');
    first.props.onPress(); screen.render(); assert.equal(selected.at(-1), '2026-12-01');
  });
}
