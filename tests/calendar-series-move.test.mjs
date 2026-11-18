import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarSeriesMovedDraft, calendarFutureMovedDraft, calendarOccurrenceDraft, CalendarMoveScopeRequiredError } from '../src/features/calendar/direct-actions.ts';
import { rebasedCalendarExceptionDate, rebasedCalendarExceptionDates, rebasedCalendarExceptions } from '../src/domain/calendar/exception-slots.ts';
import { calendarEventAnchors, isCalendarAnchor, newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';

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

test('whole-series month drags preserve the selected destination or stop before saving an unrepresentable day', () => {
  const series = parent({ startDate: '2026-01-15', endDate: '2026-01-15', recurrence: 'monthly' });
  const selected = projectCalendarEvents([series], [], '2026-03-15', '2026-03-15')[0];
  const moved = calendarSeriesMovedDraft(calendarOccurrenceDraft(selected, true), series, { day: '2026-03-16', minute: 540 }, 'Asia/Tokyo');
  const next = { ...moved.value, id: series.id, revision: series.revision + 1 };
  assert.ok(isCalendarAnchor(next, '2026-03-16'));
  assert.equal(next.startDate, '2026-01-16');
  const body = { ...newEventDraft('2026-04-05', 'Asia/Tokyo'), title: '個別変更' };
  const rebased = rebasedCalendarExceptions(series, next, [{ eventId: series.id, anchorDate: '2026-04-15', override: body, revision: 3 }]);
  assert.equal(rebased[0].anchorDate, '2026-04-16'); assert.equal(rebased[0].override, body);

  const day30 = parent({ startDate: '2026-01-30', endDate: '2026-01-30', recurrence: 'monthly' });
  const april30 = projectCalendarEvents([day30], [], '2026-04-30', '2026-04-30')[0];
  assert.throws(() => calendarSeriesMovedDraft(calendarOccurrenceDraft(april30, true), day30,
    { day: '2026-05-01', minute: 540 }, 'Asia/Tokyo'), /この予定だけ/u);

  const dst = parent({ startDate: '2026-03-01', endDate: '2026-03-01', startMinute: 150, endMinute: 180, timeZone: 'America/New_York' });
  const selectedAfterGap = projectCalendarEvents([dst], [], '2026-03-15', '2026-03-15')[0];
  const target = { day: '2026-03-22', minute: 150 };
  const draft = calendarOccurrenceDraft(selectedAfterGap, true);
  assert.throws(() => calendarSeriesMovedDraft(draft, dst, target, dst.timeZone), CalendarMoveScopeRequiredError);
  assert.equal(calendarFutureMovedDraft(draft, dst, target, dst.timeZone).value.startDate, target.day);
});

test('monthly ordinal drags derive the new rule from the selected occurrence, including last-weekday boundaries', () => {
  const secondTuesday = parent({ startDate: '2026-01-08', endDate: '2026-01-08', recurrence: 'custom',
    customRecurrence: { unit: 'month', interval: 1, on: 'weekday', ordinal: 2, weekday: 2 } });
  const selected = projectCalendarEvents([secondTuesday], [], '2026-04-14', '2026-04-14')[0];
  const clockOnly = calendarSeriesMovedDraft(calendarOccurrenceDraft(selected, true), secondTuesday,
    { day: '2026-04-14', minute: 600 }, 'Asia/Tokyo');
  assert.deepEqual(clockOnly.value.customRecurrence, { unit: 'month', interval: 1, on: 'weekday', ordinal: 2, weekday: 2 });
  assert.ok(isCalendarAnchor({ ...clockOnly.value, id: secondTuesday.id, revision: 5 }, selected.startDate));

  const fourthTuesday = { ...secondTuesday, customRecurrence: { unit: 'month', interval: 1, on: 'weekday', ordinal: 4, weekday: 2 } };
  const fourth = projectCalendarEvents([fourthTuesday], [], '2026-04-28', '2026-04-28')[0];
  const fourthClockOnly = calendarSeriesMovedDraft(calendarOccurrenceDraft(fourth, true), fourthTuesday,
    { day: '2026-04-28', minute: 600 }, 'Asia/Tokyo');
  assert.deepEqual(fourthClockOnly.value.customRecurrence, { unit: 'month', interval: 1, on: 'weekday', ordinal: 4, weekday: 2 },
    'in a four-week month, fourth and last coincide but the original fourth-week rule remains distinct');

  const lastTuesday = { ...secondTuesday, customRecurrence: { unit: 'month', interval: 1, on: 'weekday', ordinal: -1, weekday: 2 } };
  const lastDate = projectCalendarEvents([lastTuesday], [], '2026-04-28', '2026-04-28')[0];
  const toFirstFriday = calendarSeriesMovedDraft(calendarOccurrenceDraft(lastDate, true), lastTuesday,
    { day: '2026-05-01', minute: 540 }, 'Asia/Tokyo');
  assert.deepEqual(toFirstFriday.value.customRecurrence, { unit: 'month', interval: 1, on: 'weekday', ordinal: 1, weekday: 5 });
  assert.ok(isCalendarAnchor({ ...toFirstFriday.value, id: lastTuesday.id, revision: 5 }, '2026-05-01'));
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

test('batch exception rebasing preserves month slots with one ordered traversal across 144 historical edits', t => {
  const previous = parent({ startDate: '1900-01-31', endDate: '1900-01-31', recurrence: 'monthly' });
  const next = { ...previous, startDate: '1900-02-01', endDate: '1900-02-01' };
  const source = calendarEventAnchors(previous, previous.startDate, '2026-12-31');
  const target = calendarEventAnchors(next, next.startDate, '2026-12-31');
  const selected = Array.from({ length: 144 }, (_, index) => source[Math.floor(index * (source.length - 1) / 143)]);
  const expected = selected.map(anchor => { const ordinal = source.indexOf(anchor); return target[ordinal] ?? anchor; });

  const OriginalDate = globalThis.Date; let constructions = 0;
  globalThis.Date = class CountedDate extends OriginalDate {
    constructor(...args) { constructions++; super(...args); }
  };
  let rebased;
  try { rebased = rebasedCalendarExceptionDates(previous, next, selected); }
  finally { globalThis.Date = OriginalDate; }

  assert.deepEqual(rebased, expected);
  t.diagnostic(`date constructions for ${selected.length} exceptions: ${constructions}`);
  assert.ok(constructions < 100_000, 'rebasing should traverse the monthly history once rather than once per exception');
  assert.equal(rebasedCalendarExceptionDate(previous, next, selected[0]), expected[0]);
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
