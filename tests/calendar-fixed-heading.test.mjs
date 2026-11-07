import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
const descendants = node => [node, ...(node.children ?? []).filter(child => typeof child === 'object').flatMap(descendants)];
for (const platform of ['ios', 'android']) test(`${platform} short calendar cards never cover the next editable event in either day mode`, async () => {
  const day = '2026-10-30';
  const events = [[540, 630], [634, 635], [645, 735]].map(([startMinute, endMinute], i) => ({
    ...newEventDraft(day, 'Asia/Tokyo'), id: `card-${i}`, title: `予定${i}`, revision: 1, startMinute, endMinute,
  }));
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: day, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null,
    local: { database: {}, snapshot: { events, exceptions: [], categories: [], drafts: [], draft: null }, loading: false, error: null, refresh: async () => {} },
  } });
  for (const mode of ['1日表示', '2日表示']) {
    await selectCalendarView(screen, mode);
    const cards = events.map(row => screen.button(`${row.title}を編集`));
    const rectangles = cards.map(card => {
      const style = Object.assign({}, ...card.props.style.flat(Infinity).filter(value => value && typeof value === 'object'));
      return { top: style.top, bottom: style.top + style.height, left: parseFloat(style.left), right: parseFloat(style.left) + parseFloat(style.width) };
    });
    for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
      const a = rectangles[i], b = rectangles[j];
      if (a.top < b.bottom && b.top < a.bottom) assert.ok(a.right <= b.left || b.right <= a.left, `card ${i} covers card ${j} in ${mode}`);
    }
  }
  screen.unmount();
});
for (const platform of ['ios', 'android']) test(`${platform} timeline date and chore controls remain outside the native scrolling content in both day modes`, async () => {
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-10-31', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 2, total: 2, minutes: 45 }), renderChores: day => `手順:${day}`,
  } });
  for (const [mode, days] of [['1日表示', 1], ['2日表示', 2]]) {
    await selectCalendarView(screen, mode);
    const header = screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading'); const list = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
    assert.ok(header && list); assert.equal(descendants(list).includes(header), false);
    const toggles = descendants(header).filter(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('の家事を'));
    assert.equal(toggles.length, days); const calls = []; list.props.ref.current = { scrollToOffset: value => calls.push(value) };
    if (toggles[0].props.accessibilityState.expanded) { await toggles[0].props.onPress(); await screen.flush(); }
    await screen.nodes().find(node => node.props.accessibilityLabel === toggles[0].props.accessibilityLabel?.replace('閉じる', '開く')).props.onPress(); await screen.flush(); assert.ok(screen.text().includes('手順:2026-10-31'));
    const pane = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores');
    assert.ok(pane); assert.equal(descendants(list).includes(pane), false);
    assert.equal(calls.length, 0, 'expanding the fixed list must not jump the timeline away from the appointments');
    list.props.onScroll?.({ nativeEvent: { contentOffset: { y: 800, x: 0 } } }); screen.render();
    const stillFixed = screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading'); assert.ok(stillFixed);
  }
});

for (const platform of ['ios', 'android']) test(`${platform} changing day modes keeps an already expanded chore list visible instead of scrolling past it`, async () => {
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-10-31', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 4, total: 4 }), renderChores: () => '洗面台の清掃',
  } });
  await selectCalendarView(screen, '1日表示'); await screen.press('2026年10月31日の家事を開く');
  await selectCalendarView(screen, '2日表示');
  const offsets = []; const list = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
  list.props.ref.current = { scrollToOffset: value => offsets.push(value.offset) };
  const top = descendants(list).find(node => node.type === 'View' && typeof node.props.onLayout === 'function');
  top.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
  list.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
  assert.equal(screen.button('2026年10月31日の家事を閉じる').props.accessibilityState.expanded, true);
  const pane = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores');
  assert.ok(pane); assert.equal(descendants(list).includes(pane), false);
  assert.ok(descendants(pane).some(node => node.children?.includes('洗面台の清掃')), 'the expanded list stays above the timeline after a mode change');
  screen.unmount();
});
