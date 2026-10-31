import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { scrollCalendarToDate } from './helpers/calendar-ui.mjs';

for (const platform of ['ios', 'android']) {
  const make = (extra = {}) => screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', layoutEffect: effect => effect(), props: {
    today: '2026-10-31', selectedDate: '2026-12-10', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null, ...extra,
  } });
  test(`${platform} Today remains available and preserves each calendar view while moving to the current date`, async () => {
    for (const [button, id] of [['1日表示', 'calendar-timeline'], ['2日表示', 'calendar-timeline'], ['リスト表示', 'calendar-agenda']]) {
      const screen = make(); await screen.press(button); await screen.press('今日'); await screen.flush();
      assert.equal(screen.button(button).props.accessibilityState.selected, true);
      assert.ok(screen.nodes().some(node => node.props.testID === id)); assert.match(screen.text(), /10月31日/u);
      if (button === '2日表示') assert.match(screen.text(), /11月1日/u);
    }
    const year = make(); await year.press('年表示に戻る'); await year.press('次の年'); await year.press('今日'); await year.flush();
    assert.ok(year.nodes().some(node => node.props.testID === 'calendar-year'));
    assert.equal(year.nodes().filter(node => /^2026年\d+月を表示$/u.test(node.props.accessibilityLabel ?? '')).length, 12);
  });
  test(`${platform} swiping the mode strip changes views without moving the selected date`, async () => {
    const selected = []; const screen = make({ onSelectDate: date => selected.push(date) }); await screen.press('1日表示');
    const swipe = { dx: -80, dy: 2, x0: 200, moveX: 120, numberActiveTouches: 1 };
    const strip = () => screen.nodes().find(node => node.props.testID === 'calendar-view-modes');
    strip().props.onTouchStart();
    assert.equal(strip().props.onMoveShouldSetPanResponderCapture(null, swipe), true);
    strip().props.onPanResponderRelease(null, swipe); screen.render(); assert.equal(screen.button('2日表示').props.accessibilityState.selected, true);
    strip().props.onPanResponderRelease(null, swipe); screen.render(); assert.equal(screen.button('リスト表示').props.accessibilityState.selected, true);
    assert.deepEqual(selected, [], 'a view choice does not silently select a different civil date');
  });
  test(`${platform} month cells distinguish unavailable partial and zero while total and pending remain separate`, async () => {
    const screen = make({ selectedDate: '2026-10-31', dayInfo: date => date === '2026-10-31' ? { loaded: true, total: 3, pending: 1 }
      : date === '2026-10-30' ? { loaded: true, total: 2, pending: 2, partial: true }
        : date === '2026-10-29' ? { loaded: true, total: 0, pending: 0 } : { loaded: false } });
    await scrollCalendarToDate(screen, '2026-10-31');
    const labels = screen.nodes().map(node => node.props.accessibilityLabel ?? '').filter(label => label.includes('2026年10月'));
    assert.ok(labels.some(label => label.includes('31日') && label.includes('家事3件') && label.includes('未完了1件')));
    assert.ok(labels.some(label => label.includes('30日') && label.includes('一部は未取得')));
    assert.ok(screen.text().includes('家事なし')); assert.ok(screen.text().includes('未取得'));
  });
}
