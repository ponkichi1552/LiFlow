import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

function fakeDate(t, initial) {
  const RealDate = globalThis.Date; let instant = RealDate.parse(initial);
  class ClockDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  }
  globalThis.Date = ClockDate; t.after(() => { globalThis.Date = RealDate; });
  return text => { instant = RealDate.parse(text); };
}

for (const platform of ['ios', 'android']) test(`${platform} entering a calendar timeline uses the current minute after spending hours in month view`, async t => {
  const advance = fakeDate(t, '2026-10-31T00:12:00Z');
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-10-31', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 0 }), renderChores: () => null,
  } });
  advance('2026-10-31T06:47:30Z'); await screen.press('1日表示');
  assert.ok(screen.text().includes('現在 15:47'), 'the initial timeline layout must not use the clock captured when the month mounted');
  await screen.press('月表示に戻る'); advance('2026-10-31T10:03:00Z');
  await screen.press('2日表示'); assert.ok(screen.text().includes('現在 19:03'));
});

for (const platform of ['ios', 'android']) test(`${platform} calendar clock aligns one timer to the next minute pauses in background and cleans up after unmount`, t => {
  const advance = fakeDate(t, '2026-10-31T06:47:30Z');
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map(); let id = 0; let stateChanged; let removed = 0; let subscribe;
  globalThis.setTimeout = (callback, delay) => { const next = ++id; timers.set(next, { callback, delay }); return next; };
  globalThis.clearTimeout = timer => timers.delete(timer);
  t.after(() => { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; });
  screenHarness('tests/helpers/calendar-clock-probe.tsx', { platform, props: { inspect: value => { subscribe = value; } }, mocks: {
    'react-native': { AppState: { currentState: 'active', addEventListener: (event, callback) => {
      assert.equal(event, 'change'); stateChanged = callback; return { remove: () => { removed += 1; } };
    } } },
  } });
  let updates = 0; const stop = subscribe(() => { updates += 1; });
  assert.equal(timers.size, 1); const [firstId, first] = [...timers][0]; assert.equal(first.delay, 30_000);
  advance('2026-10-31T06:48:00Z'); timers.delete(firstId); first.callback();
  assert.equal(updates, 1); assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 60_000);
  const stale = [...timers.values()][0].callback;
  stateChanged('background'); assert.equal(timers.size, 0);
  advance('2026-10-31T10:03:45Z'); stale(); assert.equal(updates, 1); assert.equal(timers.size, 0);
  stateChanged('active'); assert.equal(updates, 2); assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 15_000);
  stateChanged('inactive'); assert.equal(timers.size, 0);
  stateChanged('active'); assert.equal(updates, 3); assert.equal(timers.size, 1);
  const late = [...timers.values()][0].callback;
  stop(); assert.equal(removed, 1); assert.equal(timers.size, 0);
  late(); stateChanged('active'); assert.equal(updates, 3); assert.equal(timers.size, 0);
});
