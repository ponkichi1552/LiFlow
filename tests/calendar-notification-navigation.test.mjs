import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CALENDAR_IDLE_RESET_MS } from '../src/features/calendar/display-store.ts';
import { CALENDAR_HELP_SEEN_KEY } from '../src/features/calendar/help-store.ts';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';

const today = '2026-11-18';
const targetDate = '2026-12-03';
const targetMinute = String(19 * 60);

function notificationCalendar(t, platform, selectedDate = today) {
  let now = Date.parse(`${today}T00:00:00Z`);
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const effects = [];
  const listeners = [];
  const dates = [];
  const options = {
    exportName: 'PlannerCalendar',
    platform,
    params: {},
    effectDependencies: true,
    focusDependencies: true,
    effect: setup => effects.push(setup),
    layoutEffect: setup => setup(),
    appStateListener: listener => listeners.push(listener),
    mocks: { 'expo-sqlite/kv-store': { __esModule: true, default: {
      getItemSync: key => key === CALENDAR_HELP_SEEN_KEY ? '1' : null, setItemSync() {},
    } } },
    props: {
      today, selectedDate, timeZone: 'Asia/Tokyo', onSelectDate: day => dates.push(day),
      dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
    },
  };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', options);
  t.after(() => screen.unmount());
  const commitEffects = () => { while (effects.length) effects.shift()(); };
  function render() { screen.render(); commitEffects(); }
  function setParams(params) { options.params = params; render(); }
  function runNavigation() { t.mock.timers.tick(0); render(); }
  function appState(state) { for (const listener of listeners) listener(state); render(); }
  const node = testID => screen.nodes().find(item => item.props.testID === testID);
  function measureTimeline() {
    const offsets = [];
    const timeline = node('calendar-timeline');
    assert.ok(timeline, 'calendar opens a time grid');
    timeline.props.ref.current = { scrollToOffset: ({ offset }) => offsets.push(offset) };
    timeline.props.onLayout({ nativeEvent: { layout: { height: 600 } } });
    node('calendar-timeline-days').props.onLayout({ nativeEvent: { layout: { height: 100 } } });
    t.mock.timers.tick(0);
    return offsets;
  }
  commitEffects();
  return { screen, dates, setParams, runNavigation, appState, node, measureTimeline, commitEffects,
    suspend() { appState('background'); now += CALENDAR_IDLE_RESET_MS + 1; } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} a reminder opens its date and time regardless of foreground event order after a minute away`, async t => {
    const calendar = notificationCalendar(t, platform);
    await selectCalendarView(calendar.screen, '2日表示');
    calendar.commitEffects();
    const morningOffset = calendar.measureTimeline().at(-1);
    for (const foregroundFirst of [false, true]) {
      calendar.suspend();
      if (foregroundFirst) {
        calendar.appState('active');
        assert.ok(calendar.node('calendar-weeks'), 'ordinary foregrounding still resets to month');
      }
      const day = foregroundFirst ? '2026-12-04' : targetDate;
      calendar.setParams({ calendarJump: `timed-${day}`, calendarDate: day, calendarMinute: targetMinute });
      calendar.runNavigation();
      if (!foregroundFirst) calendar.appState('active');
      assert.ok(calendar.node('calendar-timeline'), 'foregrounding must leave the explicit reminder destination visible');
      assert.equal(calendar.screen.button('カレンダーの表示を選択').props.accessibilityValue.text, '2日');
      assert.equal(calendar.dates.at(-1), day);
      const offsets = calendar.measureTimeline();
      assert.ok(offsets.at(-1) > morningOffset, 'the evening reminder is in view');
    }
  });

  test(`${platform} reminders recenter an already visible date without waiting for another layout`, async t => {
    const calendar = notificationCalendar(t, platform, targetDate);
    await selectCalendarView(calendar.screen, '1日表示');
    calendar.commitEffects();
    const offsets = calendar.measureTimeline();
    const initialOffset = offsets.at(-1);
    assert.ok(initialOffset > 0);
    calendar.setParams({ calendarJump: 'same-day-timed', calendarDate: targetDate, calendarMinute: targetMinute });
    calendar.runNavigation();
    assert.ok(offsets.at(-1) > initialOffset, 'the evening time opens on an already measured grid');
    calendar.setParams({ calendarJump: 'same-day-all-day', calendarDate: targetDate, calendarMinute: '' });
    calendar.runNavigation();
    assert.equal(offsets.at(-1), 0, 'an all-day reminder opens the top of the same date');
  });

  test(`${platform} incomplete or cancelled reminder deliveries retry and apply a completed jump only once`, t => {
    const calendar = notificationCalendar(t, platform);
    const route = { calendarJump: 'retry', calendarDate: targetDate, calendarMinute: targetMinute };
    calendar.setParams({ ...route, calendarMinute: undefined });
    calendar.runNavigation();
    assert.deepEqual(calendar.dates, []);
    calendar.setParams(route);
    calendar.setParams({});
    calendar.runNavigation();
    assert.deepEqual(calendar.dates, []);
    calendar.setParams(route);
    calendar.runNavigation();
    assert.deepEqual(calendar.dates, [targetDate]);
    calendar.setParams({});
    calendar.setParams(route);
    calendar.runNavigation();
    assert.deepEqual(calendar.dates, [targetDate]);
  });
}
