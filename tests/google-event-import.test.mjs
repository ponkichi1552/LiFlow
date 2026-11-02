import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleImportedEvent, GoogleEventExpansionRequired } from '../src/features/calendar/google-event-import.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';

const timed = { id: 'remote', summary: '授業', start: { dateTime: '2026-10-30T09:00:00+09:00', timeZone: 'Asia/Tokyo' },
  end: { dateTime: '2026-10-30T10:00:00+09:00', timeZone: 'Asia/Tokyo' } };
test('Google all-day exclusive endings become the exact inclusive local period and timed timezone clocks stay unchanged', () => {
  const day = googleImportedEvent({ id: 'day', summary: '旅行', start: { date: '2026-10-30' }, end: { date: '2026-11-02' } }, 'personal');
  assert.equal(day.startDate, '2026-10-30'); assert.equal(day.endDate, '2026-11-01'); assert.equal(day.allDay, true);
  assert.equal(googleEventBody(day).end.date, '2026-11-02');
  const event = googleImportedEvent(timed, 'school'); assert.equal(event.startMinute, 540); assert.equal(event.endMinute, 600);
  assert.equal(event.timeZone, 'Asia/Tokyo'); assert.equal(event.categoryId, 'school');
});
test('all supported native recurrence forms round-trip through Google without changing occurrence dates', () => {
  const base = { ...newEventDraft('2026-10-30', 'Asia/Tokyo'), title: '家族の予定', untilDate: '2027-03-30' };
  const variants = ['none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly'].map(recurrence => ({ ...base, recurrence }));
  variants.push({ ...base, recurrence: 'custom', customRecurrence: { unit: 'week', interval: 2, weekdays: [0, 5] } },
    { ...base, recurrence: 'custom', customRecurrence: { unit: 'month', interval: 2, on: 'weekday', ordinal: -1, weekday: 5 } },
    { ...base, recurrence: 'custom', customRecurrence: { unit: 'day', interval: 3 } });
  for (const original of variants) {
    const body = googleEventBody(original); const imported = googleImportedEvent({ id: 'roundtrip', ...body }, 'personal');
    const dates = value => projectCalendarEvents([{ ...value, id: 'one', revision: 1 }], [], '2026-10-30', '2027-03-31').map(row => [row.startDate, row.endDate, row.startMinute, row.endMinute]);
    assert.deepEqual(dates(imported), dates(original), JSON.stringify(original.customRecurrence ?? original.recurrence));
  }
});
test('unsupported Google recurrence semantics require server instances instead of being silently rewritten', () => {
  for (const recurrence of [['RRULE:FREQ=DAILY;COUNT=3'], ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15'], ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;WKST=MO'],
    ['RRULE:FREQ=WEEKLY;BYDAY=MO'], ['RRULE:FREQ=DAILY', 'EXDATE:20261101T000000Z'], ['RRULE:FREQ=DAILY;INTERVAL=0'], ['RRULE:FREQ=DAILY;FREQ=MONTHLY']]) {
    assert.throws(() => googleImportedEvent({ ...timed, recurrence }, 'personal'), GoogleEventExpansionRequired);
  }
  assert.throws(() => googleImportedEvent({ ...timed, start: { ...timed.start, dateTime: '2026-10-30T09:00:30+09:00' } }, 'personal'), GoogleEventExpansionRequired);
  assert.throws(() => googleImportedEvent({ ...timed, recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261101T235959Z'], eventType: 'outOfOffice' }, 'personal'), GoogleEventExpansionRequired);
});
test('Google UNTIL that excludes the last local start cannot invent an additional occurrence', () => {
  assert.throws(() => googleImportedEvent({ ...timed, recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261101T235959Z'] }, 'personal'), GoogleEventExpansionRequired);
  const valid = googleImportedEvent({ ...timed, recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261102T000000Z'] }, 'personal');
  assert.equal(valid.untilDate, '2026-11-02');
});
