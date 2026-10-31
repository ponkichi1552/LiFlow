import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { moveCalendarStart } from '../src/features/calendar/event-editing.ts';
import { newEventDraft, validateEventDraft } from '../src/features/calendar/events.ts';

const draft = () => ({ ...newEventDraft('2026-10-31', 'Asia/Tokyo'), title: '検査用の予定' });
test('moving a calendar start retains duration across same-day midnight multi-day and all-day changes', () => {
  assert.deepEqual(moveCalendarStart(draft(), { startMinute: 19 * 60 }), { ...draft(), startMinute: 19 * 60, endMinute: 20 * 60 });
  const midnight = moveCalendarStart(draft(), { startMinute: 23 * 60 + 30 });
  assert.equal(midnight.endDate, '2026-11-01'); assert.equal(midnight.endMinute, 30); validateEventDraft(midnight);
  const long = { ...draft(), endDate: '2026-11-02', endMinute: 12 * 60 };
  const shifted = moveCalendarStart(long, { startDate: '2026-12-10', startMinute: 20 * 60 });
  assert.equal(shifted.endDate, '2026-12-12'); assert.equal(shifted.endMinute, 23 * 60); validateEventDraft(shifted);
  const allDay = { ...draft(), allDay: true, endDate: '2026-11-02' };
  assert.equal(moveCalendarStart(allDay, { startDate: '2027-01-30' }).endDate, '2027-02-01');
  assert.equal(draft().startMinute, 540, 'editing does not mutate the existing event');
});

test('moving a start preserves elapsed time through DST and does not hide ambiguous or invalid input', () => {
  const spring = { ...draft(), timeZone: 'America/New_York', startDate: '2026-03-08', endDate: '2026-03-08', startMinute: 90, endMinute: 210 };
  const moved = moveCalendarStart(spring, { startMinute: 7 * 60 });
  assert.equal(moved.endMinute, 8 * 60, '01:30 to 03:30 across the spring transition is one elapsed hour'); validateEventDraft(moved);
  const fold = moveCalendarStart({ ...draft(), timeZone: 'America/New_York' }, { startDate: '2026-11-01', startMinute: 90 });
  assert.throws(() => validateEventDraft(fold), /夏時間/u);
  const invalid = { ...draft(), endMinute: 8 * 60 };
  assert.equal(moveCalendarStart(invalid, { startMinute: 19 * 60 }).endMinute, 8 * 60, 'an already invalid end remains visible for correction');
});
