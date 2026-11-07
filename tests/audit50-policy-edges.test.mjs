import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSyncGoogleTasks } from '../src/features/google-sync/sync-policy.ts';
const { shouldRefreshCalendar } = await import('../src/features/google-sync/calendar-availability.ts');
const { automaticApplianceTasks } = await import('../src/features/appliance-care/auto-save-policy.ts');
const { wasteCalendarLabels } = await import('../src/features/waste/calendar-labels.ts');

test('audit50 a corrected clock cannot strand Tasks or Calendar retries behind a former future attempt', () => {
  const now = new Date('2026-11-07T10:00:00Z');
  const state = { enabled: true, status: 'retryPending', lastAttemptAt: '2026-11-07T12:00:00Z', nextRetryAt: '2026-11-07T13:00:00Z' };
  assert.equal(shouldSyncGoogleTasks(state, now), true); assert.equal(shouldRefreshCalendar(state, now), true);
  const normal = { ...state, lastAttemptAt: '2026-11-07T09:00:00Z', nextRetryAt: '2026-11-07T10:30:00Z' };
  assert.equal(shouldSyncGoogleTasks(normal, now), false); assert.equal(shouldRefreshCalendar(normal, now), false);
});

test('audit50 Japanese full width appliance cycle input behaves like the other numeric settings', () => {
  const analysis = { tasks: [{ name: 'お手入れ', recommendedIntervalDays: 7 }] };
  assert.equal(automaticApplianceTasks(analysis, { 0: '　３０　' })[0].userIntervalDays, 30);
});

test('audit50 hiding one weekly waste schedule does not hide another visible schedule with the same label', () => {
  const schedules = ['one', 'two'].map(id => ({ id, householdId: 'home', label: '缶', recurrence: 'weekly', collectionWeekdays: [6] }));
  const shown = wasteCalendarLabels(schedules, '2026-11-07', '2026-11-07', ['one:2026-11-07']);
  assert.deepEqual(shown.weeklyByColumn[6], ['缶']); assert.equal(shown.hiddenWeeklyByDate.has('2026-11-07'), false);
  assert.deepEqual(wasteCalendarLabels(schedules, '2026-11-07', '2026-11-07', ['one:2026-11-07', 'two:2026-11-07']).hiddenWeeklyByDate.get('2026-11-07'), ['缶']);
});
