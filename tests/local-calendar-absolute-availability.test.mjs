import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { localCalendarAvailability } = await import('../src/features/calendar/local-availability.ts');
const { newEventDraft } = await import('../src/domain/calendar/events.ts');
const event = patch => ({ ...newEventDraft('2026-11-01', 'UTC'), id: 'test', revision: 1, title: '予定', ...patch });
test('the repeated DST hour remains busy even though the displayed start and end wall clocks are equal', () => {
  assert.deepEqual(localCalendarAvailability([event({ startMinute: 330, endMinute: 390 })], [], '2026-11-01', '2026-11-01', 'America/New_York'), { '2026-11-01': { busyMinutes: 60 } });
});
test('transparent Google events and birthdays do not block housework, and overlaps are unioned once', () => {
  const rows = [event({ startMinute: 60, endMinute: 120 }), event({ id: 'two', startMinute: 90, endMinute: 180 }), event({ id: 'transparent', allDay: true, blocksTime: false }), event({ id: 'birthday', allDay: true, birthday: true, recurrence: 'yearly' })];
  assert.deepEqual(localCalendarAvailability(rows, [], '2026-11-01', '2026-11-01', 'UTC'), { '2026-11-01': { busyMinutes: 120 } });
});
test('all-day civil dates and actual 23/25-hour days keep the same aggregation as Google FreeBusy', () => {
  const rows = [event({ allDay: true })];
  assert.deepEqual(localCalendarAvailability(rows, [], '2026-11-01', '2026-11-01', 'America/New_York'), { '2026-11-01': { busyMinutes: 1500 } });
  assert.deepEqual(localCalendarAvailability([event({ allDay: true, startDate: '2026-03-08', endDate: '2026-03-08' })], [], '2026-03-08', '2026-03-08', 'America/New_York'), { '2026-03-08': { busyMinutes: 1380 } });
});
