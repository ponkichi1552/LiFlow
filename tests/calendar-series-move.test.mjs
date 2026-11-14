import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarSeriesMovedDraft, calendarOccurrenceDraft } from '../src/features/calendar/direct-actions.ts';
import { rebasedCalendarExceptionDate, rebasedCalendarExceptions } from '../src/domain/calendar/exception-slots.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';

const parent = extra => ({ ...newEventDraft('2026-11-01', 'Asia/Tokyo'), title: '会議', recurrence: 'weekly', id: 'series', revision: 4, ...extra });

test('moving a later repeating occurrence shifts its original parent once and keeps the held proof and until date', () => {
  const series = parent({ untilDate: '2027-01-03' });
  const occurrence = projectCalendarEvents([series], [], '2026-11-15', '2026-11-15')[0];
  const draft = { ...calendarOccurrenceDraft(occurrence, true), audience: 'group', groupId: 'group', basisRevision: 'held-series-and-exception-proof' };
  const moved = calendarSeriesMovedDraft(draft, series, { day: '2026-11-16', minute: 570 }, 'Asia/Tokyo');
  assert.equal(moved.value.startDate, '2026-11-02'); assert.equal(moved.value.startMinute, 570); assert.equal(moved.value.endMinute, 630);
  assert.equal(moved.value.untilDate, '2027-01-04'); assert.equal(moved.scope, 'series'); assert.equal(moved.anchorDate, null);
  assert.equal(moved.revision, 4); assert.equal(moved.exceptionRevision, 0); assert.equal(moved.basisRevision, draft.basisRevision);
  assert.equal(series.startDate, '2026-11-01'); assert.equal(draft.scope, 'one');
});

test('whole-series moves rotate custom weekdays and convert the displayed displacement back to the source zone', () => {
  const series = parent({ recurrence: 'custom', customRecurrence: { unit: 'week', interval: 2, weekdays: [0, 3] }, timeZone: 'America/New_York' });
  const occurrence = projectCalendarEvents([series], [], '2026-11-15', '2026-11-15')[0];
  const moved = calendarSeriesMovedDraft(calendarOccurrenceDraft(occurrence, true), series, { day: '2026-11-16', minute: 0 }, 'Asia/Tokyo');
  assert.equal(moved.value.timeZone, 'America/New_York'); assert.equal(moved.value.startDate, '2026-11-01');
  assert.equal(moved.value.startMinute, 600); assert.deepEqual(moved.value.customRecurrence.weekdays, [0, 3]);
  const shifted = calendarSeriesMovedDraft(calendarOccurrenceDraft(occurrence, true), series, { day: '2026-11-17', minute: 0 }, 'Asia/Tokyo');
  assert.equal(shifted.value.startDate, '2026-11-02'); assert.deepEqual(shifted.value.customRecurrence.weekdays, [1, 4]);
});

test('exception slots follow monthly occurrence order while explicit dates deletion and unrelated events stay unchanged', () => {
  const series = parent({ startDate: '2026-01-31', endDate: '2026-01-31', recurrence: 'monthly' });
  const moved = { ...series, startDate: '2026-02-01', endDate: '2026-02-01' };
  assert.equal(rebasedCalendarExceptionDate(series, moved, '2026-03-31'), '2026-03-01');
  const body = { ...newEventDraft('2026-04-05', 'Asia/Tokyo'), title: '個別変更' };
  const exceptions = [{ eventId: series.id, anchorDate: '2026-03-31', override: body, revision: 3 },
    { eventId: series.id, anchorDate: '2026-05-31', override: null, revision: 1 },
    { eventId: 'other', anchorDate: '2026-03-31', override: body, revision: 2 }];
  const result = rebasedCalendarExceptions(series, moved, exceptions);
  assert.equal(result[0].anchorDate, '2026-03-01'); assert.equal(result[0].override, body); assert.equal(result[0].revision, 3);
  assert.equal(result[1].anchorDate, '2026-04-01'); assert.equal(result[1].override, null); assert.equal(result[2], exceptions[2]);
  const projected = projectCalendarEvents([moved], result, '2026-03-01', '2026-04-30');
  assert.deepEqual(projected.map(row => row.startDate), ['2026-04-05']);
});

test('shortened or changed recurrence keeps detached individual edits visible and editable rather than fabricating normal occurrences', () => {
  const series = parent(); const next = { ...series, recurrence: 'monthly' };
  const body = { ...newEventDraft('2026-11-20', 'Asia/Tokyo'), title: '個別変更' };
  const result = rebasedCalendarExceptions(series, next, [{ eventId: series.id, anchorDate: '2026-11-08', override: body, revision: 2 }]);
  assert.equal(result[0].anchorDate, '2026-11-08'); assert.equal(result[0].detached, true);
  assert.equal(projectCalendarEvents([next], result, '2026-11-20', '2026-11-20')[0].title, body.title);
  const shortened = { ...series, startDate: '2026-11-02', endDate: '2026-11-02', untilDate: '2026-11-02' };
  assert.equal(rebasedCalendarExceptionDate(series, shortened, '2026-11-15'), '2026-11-15');
});
