import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createCalendarDisplayStore } from '../src/features/calendar/display-store.ts';

test('calendar picker commits the latest native selection once even before React repaints', async t => {
  await t.test('custom wheel callback is one navigation', () => {
    let opened = 0;
    const screen = screenHarness('src/features/calendar/calendar-option-picker.tsx', { exportName: 'CalendarOptionPicker', platform: 'ios',
      props: { title: '繰り返し', value: 'daily', options: [{ value: 'daily', label: '毎日' }, { value: 'custom', label: 'カスタム' }], onSelect() {}, onClose() {}, onCustom() { opened++; } } });
    try { const wheel = screen.nodes().find(node => node.props.testID === 'calendar-option-wheel'); wheel.props.onValueChange('custom'); wheel.props.onValueChange('custom'); assert.equal(opened, 1); }
    finally { screen.unmount(); }
  });
  await t.test('year and month selection immediately followed by move uses both latest values', () => {
    const saved = [];
    const screen = screenHarness('src/features/calendar/month-picker.tsx', { exportName: 'CalendarMonthPicker', props: { month: '2026-11-01', onSelect: value => saved.push(value), onClose() {} } });
    try { const commit = screen.button('2026年11月へ移動'); screen.button('2027年').props.onPress(); screen.button('12月').props.onPress(); commit.props.onPress(); assert.deepEqual(saved, ['2027-12-01']); }
    finally { screen.unmount(); }
  });
});

test('a failed calendar preference observer cannot prevent other subscribers from receiving the committed selection', () => {
  const storage = new Map(); const store = createCalendarDisplayStore({ getItemSync: key => storage.get(key), setItemSync: (key, value) => storage.set(key, value) });
  let notified = 0; store.subscribe(() => { throw new Error('closed view'); }); store.subscribe(() => { notified++; });
  assert.doesNotThrow(() => store.select('two')); assert.equal(notified, 1); assert.equal(store.getSnapshot().detail, 'two');
});

test('calendar range requested before the global Google observer is ready is retained and delivered once', async () => {
  const effects = []; const requests = [];
  const screen = screenHarness('tests/fixtures/google-calendar-range-observer.tsx', { database: {}, effectDependencies: true,
    effect: fn => effects.push(fn), layoutEffect: fn => fn(), mocks: {
      '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
      '../planner/initial-display-gate': { waitForInitialFrame: async () => {} },
      '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => ({ requestRange: async (...args) => { requests.push(args); return false; }, sync: async () => ({ kind: 'success' }) }) },
    } });
  try { effects.forEach(effect => effect()); await screen.flush(); assert.deepEqual(requests, [['2028-01-01', '2028-01-31']]); }
  finally { screen.unmount(); }
});
