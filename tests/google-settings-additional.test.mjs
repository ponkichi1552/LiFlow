import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

test('Google settings ignore delayed control data from a replaced group runtime or personal database', async t => {
  await t.test('shared runtime', async () => {
    let release;
    const old = { readControl: () => new Promise(resolve => { release = () => resolve({ enabled: true, revision: 1, accountLabel: 'OLD_ACCOUNT', calendarLabel: 'OLD_CALENDAR', calendarId: 'old' }); }) };
    const current = { readControl: async () => ({ enabled: true, revision: 1, accountLabel: 'CURRENT_ACCOUNT', calendarLabel: 'CURRENT_CALENDAR', calendarId: 'current' }) };
    const props = { runtime: old, onBack() {} };
    const screen = screenHarness('src/features/calendar/shared-google-settings.tsx', { exportName: 'SharedGoogleCalendarSettings', props,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn() });
    try { props.runtime = current; screen.render(); await screen.flush(); release(); await screen.flush(); assert.match(screen.text(), /CURRENT_ACCOUNT/); assert.doesNotMatch(screen.text(), /OLD_ACCOUNT/); }
    finally { release?.(); screen.unmount(); }
  });
  await t.test('personal database', async () => {
    let release; const old = {}, current = {};
    const runtime = db => ({ readControl: async () => db === current ? new Promise(resolve => { release = () => resolve({ enabled: true, calendars: [{ id: 'current', summary: 'CURRENT_CALENDAR' }], targetCalendarId: 'current' }); })
      : { enabled: true, calendars: [{ id: 'old', summary: 'OLD_CALENDAR' }], targetCalendarId: 'old' }, readConflicts: async () => [] });
    const props = { database: old };
    const screen = screenHarness('src/features/calendar/personal-google-settings.tsx', { exportName: 'PersonalGoogleCalendarSettings', props,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
        '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: runtime },
        '../../platform/storage/calendar-events': { subscribeLocalCalendar: () => () => {} },
      } });
    try { await screen.flush(); assert.match(screen.text(), /OLD_CALENDAR/); props.database = current; screen.render(); await screen.flush(); assert.doesNotMatch(screen.text(), /OLD_CALENDAR/); release(); await screen.flush(); assert.match(screen.text(), /CURRENT_CALENDAR/); }
    finally { release?.(); screen.unmount(); }
  });
});
