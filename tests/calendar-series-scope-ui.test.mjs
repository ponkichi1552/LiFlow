import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { scrollCalendarToDate } from './helpers/calendar-ui.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { MONTH_HEADING_HEIGHT } from '../src/features/calendar/month-rows.ts';

for (const platform of ['ios', 'android']) test(`${platform} a month-end drag disables an unrepresentable series move and saves the chosen day once`, async t => {
  const day = '2026-04-30', target = '2026-05-01', timeZone = 'Asia/Tokyo';
  const event = { ...newEventDraft('2026-01-30', timeZone), id: 'eom', title: '月末の予定', recurrence: 'monthly', revision: 1 };
  const writes = [];
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, effect: fn => fn(), layoutEffect: fn => fn(), props: {
    today: day, timeZone, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
    local: { database: {}, snapshot: { events: [event], exceptions: [], categories: [], draft: null }, loading: false, error: null,
      saveEvent: async draft => { writes.push(draft); }, refresh: async () => {} },
  } });
  t.after(() => screen.unmount());
  const viewport = screen.nodes().find(node => node.props.testID === 'calendar-viewport');
  viewport.props.ref.current = { measureInWindow: callback => callback(10, 90, 350, 600) };
  viewport.props.onLayout({ nativeEvent: { layout: { height: 600 } }, currentTarget: 123 });
  await screen.flush(); await scrollCalendarToDate(screen, day);
  const { data } = screen.nodes().find(node => node.props.testID === 'calendar-weeks').props;
  const offset = data.find(row => row.days.includes(day)).offset;
  const point = date => {
    const row = data.find(row => row.days.includes(date));
    return { absoluteX: 10 + (row.days.indexOf(date) + .5) * 50,
      absoluteY: 90 + row.offset - offset + (row.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT) + 60, numberOfPointers: 1, handlerTag: 1 };
  };
  const start = point(day), end = point(target);
  const card = screen.button(`月末の予定、${day}の予定`);
  card.props.ref.current = { measureInWindow: callback => callback(start.absoluteX - 20, start.absoluteY - 12, 40, 24) };
  card.props.onPressIn({ nativeEvent: { pageX: start.absoluteX, pageY: start.absoluteY }, currentTarget: 456 });
  card.props.onLongPress();
  const controller = () => screen.nodes().find(node => node.type === 'NativeGestureDetector').props.gesture;
  controller().onActivate(start); await screen.flush();
  controller().onUpdate(end); controller().onDeactivate({ ...end, canceled: false }); controller().onFinalize();
  await screen.flush();
  assert.equal(screen.button('繰り返し全体').props.accessibilityState.disabled, true);
  assert.equal(screen.button('今後の予定すべて').props.accessibilityState.disabled, false);
  assert.deepEqual(writes, []);
  await screen.press('この予定だけ'); await screen.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].scope, 'one');
  assert.equal(writes[0].anchorDate, day);
  assert.equal(writes[0].value.startDate, target);
});
