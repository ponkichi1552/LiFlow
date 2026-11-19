import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineEvents, timelineGroups } from '../src/features/calendar/layout.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
const event = (id, start, end) => ({ id, startDate: '2026-11-07', endDate: '2026-11-07', startMinute: start, endMinute: end, allDay: false });
test('dense calendar overlap assigns the same readable lanes without quadratic lane scans', t => {
  const rows = Array.from({ length: 2000 }, (_, n) => event(`event-${String(n).padStart(4, '0')}`, 540, 600));
  let probes = 0; const original = Array.prototype.findIndex;
  Array.prototype.findIndex = function (callback, receiver) { return original.call(this, (value, i, list) => { if (typeof value === 'number') probes++; return callback.call(receiver, value, i, list); }); };
  let result; try { result = timelineEvents(rows, '2026-11-07'); } finally { Array.prototype.findIndex = original; }
  assert.deepEqual(result.map(row => row.lane), rows.map((_, n) => n)); assert.ok(result.every(row => row.lanes === rows.length));
  t.diagnostic(`linear lane probes: ${probes}`); assert.ok(probes < 20_000);
  const mixed = timelineEvents([event('a', 0, 100), event('b', 10, 30), event('c', 40, 60), event('d', 100, 150), event('e', 151, 155), event('f', 160, 170)], '2026-11-07', 15);
  assert.deepEqual(mixed.map(row => [row.row.id, row.lane, row.lanes]), [['a', 0, 2], ['b', 1, 2], ['c', 1, 2], ['d', 0, 1], ['e', 0, 2], ['f', 1, 2]]);
});

test('a repeated fall-back hour event stays visible with its actual elapsed duration', () => {
  const source = { ...newEventDraft('2026-11-01', 'America/New_York'), id: 'fall-back', revision: 1,
    startMinute: 110, endMinute: 70 };
  const repeated = projectCalendarEvents([source], [], '2026-11-01', '2026-11-01')[0];
  assert.equal(repeated.timeIssue, 'fold');
  const overlaps = { ...event('after', 120, 150), startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'America/New_York' };
  const rows = timelineEvents([repeated, overlaps], '2026-11-01');
  const moved = rows.find(row => row.row.eventId === 'fall-back');
  assert.ok(moved, '01:50 EDT to 01:10 EST is a real 20-minute event');
  assert.equal(moved.start, 110); assert.equal(moved.end - moved.start, 20);
  assert.equal(moved.lanes, 2); assert.equal(rows.find(row => row.row.id === 'after').lane, 1);
});

test('overnight calendar previews stop at their actual end or half past midnight', () => {
  const day = '2026-11-07', next = '2026-11-08';
  const overnight = (id, endDate, endMinute) => ({ ...event(id, 1435, endMinute), endDate });
  const rows = [event('same-day', 1435, 1439), overnight('midnight', next, 0), overnight('five-past', next, 5),
    overnight('half-past', next, 30), overnight('morning', next, 380), overnight('more-days', '2026-11-09', 0)];
  const positions = new Map(timelineGroups(rows, day, 32, true).flat().map(row => [row.row.id, row]));
  assert.deepEqual(rows.map(row => positions.get(row.id).bottom), [1440, 1440, 1445, 1470, 1470, 1470]);
  assert.ok(positions.get('same-day').bottom - positions.get('same-day').top >= 32);
  assert.deepEqual([positions.get('five-past').row.startMinute, positions.get('five-past').row.endMinute], [1435, 5]);
  const nextDay = timelineGroups(rows, next, 32, true).flat();
  assert.ok(!nextDay.some(row => row.row.id === 'midnight'));
  assert.equal(nextDay.find(row => row.row.id === 'morning').end, 380);
  assert.equal(nextDay.find(row => row.row.id === 'more-days').end, 1440);
});
