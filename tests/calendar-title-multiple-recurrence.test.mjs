import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitleDateTime, createTitleDateTimeInput } from '../src/features/calendar/title-datetime.ts';
import { newEventDraft, projectCalendarEvents, recurrenceLabel } from '../src/domain/calendar/events.ts';
import { validateCustomRecurrence } from '../src/domain/calendar/recurrence.ts';
import { calendarOccurrenceDraft, calendarSeriesMovedDraft } from '../src/features/calendar/direct-actions.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { googleImportedEvent, GoogleEventExpansionRequired } from '../src/features/calendar/google-event-import.ts';
import { validateSharedCalendarPayload } from '../src/features/sharing/v2/calendar-state.ts';
import { calendarFutureBase } from '../src/domain/calendar/future-series.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const storage = await import('../src/platform/storage/calendar-events.ts');
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const today = '2026-11-16', selected = '2026-11-20';
const week = weekdays => ({ unit: 'week', interval: 1, weekdays });
const month = days => ({ unit: 'month', interval: 1, on: 'dates', days });
const inferred = (title, at = today) => {
  const initial = newEventDraft(selected, 'Asia/Tokyo');
  return createTitleDateTimeInput(initial, at).change(initial, title, true);
};

test('title recurrence consumes all explicitly listed weekdays and monthly dates and deduplicates each occurrence', () => {
  for (const [title, date, rule] of [
    ['毎週火曜日、日曜日ランチ', '2026-11-17', week([0, 2])],
    ['毎週火曜・日曜12時からランチ', '2026-11-17', week([0, 2])],
    ['毎週火・日', '2026-11-17', week([0, 2])],
    ['毎週火曜と毎週日曜', '2026-11-17', week([0, 2])],
    ['毎週火曜と木曜', '2026-11-17', week([2, 4])],
    ['🧹毎週火曜日、日曜日、火曜日', '2026-11-17', week([0, 2])],
    ['毎月1日・21日に支払い', '2026-11-21', month([1, 21])],
    ['毎月1、21日', '2026-11-21', month([1, 21])],
    ['毎月一日と二十一日', '2026-11-21', month([1, 21])],
    ['毎月21日と毎月28日', '2026-11-21', month([21, 28])],
    ['毎月21日、1日、21日', '2026-11-21', month([1, 21])],
    ['来週火曜日から毎週火曜・日曜', '2026-11-24', week([0, 2])],
  ]) {
    const parsed = parseTitleDateTime(title, today, selected);
    assert.equal(parsed?.date, date, title); assert.equal(parsed?.recurrence, 'custom', title);
    assert.deepEqual(parsed.customRecurrence, rule, title);
    const value = inferred(title); assert.equal(value.title, title); assert.deepEqual(value.customRecurrence, rule);
    assert.equal(value.startMinute, title.includes('12時') ? 720 : 540, 'lunch is not an implicit noon clock');
  }
  assert.deepEqual(parseTitleDateTime('毎週火曜、火曜', today, selected), { date: '2026-11-17', recurrence: 'weekly' });
  assert.deepEqual(parseTitleDateTime('毎月21日と21日', today, selected), { date: '2026-11-21', recurrence: 'monthly' });
});

test('multiple recurrence never partially accepts alternatives negations invalid dates ranges or per-day clocks', () => {
  for (const title of ['毎週火曜か日曜', '毎週火曜または日曜', '毎週火曜・日曜以外', '毎週火曜ではなく日曜',
    '毎週火曜18時、日曜12時', '毎週火曜、毎月21日', '毎週火曜、', '毎月1日・0日', '毎月1日・32日',
    '毎月1日か21日', '毎月1日から21日', '毎月1日・21日24時', '毎週火・', '来週水曜から毎週火曜・日曜']) {
    assert.equal(parseTitleDateTime(title, today, selected), null, title);
  }
  const parsed = parseTitleDateTime('毎週火曜・日曜24時', today, selected);
  assert.equal(parsed?.date, '2026-11-18'); assert.equal(parsed.minute, 0);
  assert.deepEqual(parsed.customRecurrence, week([1, 3]));
});

test('monthly date sets validate bounded civil dates and expand month ends without clamping or duplicate occurrences', () => {
  assert.deepEqual(validateCustomRecurrence(month([31, 1, 1])), month([1, 31]));
  for (const days of [[], [0], [32], [1.5], ['1'], Array(32).fill(1)]) assert.throws(() => validateCustomRecurrence(month(days)));
  const value = inferred('毎月1日・31日23時から1時に点検', '2026-12-20');
  assert.equal(value.startDate, '2026-12-31'); assert.equal(value.endDate, '2027-01-01');
  const rows = projectCalendarEvents([{ ...value, id: 'monthly.dates', revision: 1 }], [], '2026-12-01', '2027-03-02');
  assert.deepEqual(rows.map(row => row.startDate), ['2026-12-31', '2027-01-01', '2027-01-31', '2027-02-01', '2027-03-01']);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.equal(recurrenceLabel(value), '毎月（1・31日）');
  const weekly = inferred('毎週火曜日、日曜日ランチ');
  assert.deepEqual(projectCalendarEvents([{ ...weekly, id: 'weekly.dates', revision: 1 }], [], today, '2026-11-30').map(row => row.startDate),
    ['2026-11-17', '2026-11-22', '2026-11-24', '2026-11-29']);
});

test('multiple inferred recurrence restores automatic rules and keeps manual choices through title changes', () => {
  const original = newEventDraft(selected, 'Asia/Tokyo'), input = createTitleDateTimeInput(original, today);
  const automatic = input.change(original, '毎週火曜・日曜', true);
  assert.deepEqual(automatic.customRecurrence, week([0, 2]));
  assert.deepEqual(input.change(automatic, 'ランチ', true), { ...original, title: 'ランチ' });
  let current = input.change(original, '毎月1日・21日', true);
  input.manual('recurrence'); current = { ...current, untilDate: '2027-04-01', customRecurrence: month([3, 25]) };
  const next = input.change(current, '毎週火曜・日曜18時', true);
  assert.deepEqual(next.customRecurrence, month([3, 25])); assert.equal(next.untilDate, current.untilDate);
});

test('multiple monthly rules roundtrip Google without a phantom DTSTART and reject incompatible source rules', () => {
  const value = { ...inferred('毎月1日・21日に点検'), startDate: '2026-11-16', endDate: '2026-11-16' };
  const body = googleEventBody(value);
  assert.ok(body.recurrence[0].includes('BYMONTHDAY=1,21'));
  assert.ok(body.start.dateTime.startsWith('2026-11-21T'));
  const imported = googleImportedEvent({ ...body, id: 'google.monthly.dates' }, value.categoryId, value.timeZone);
  assert.deepEqual(imported.customRecurrence, month([1, 21]));
  assert.equal(imported.startDate, '2026-11-21');
  for (const suffix of ['BYMONTHDAY=1,32', 'BYMONTHDAY=-1,21', 'BYMONTHDAY=1,21;BYDAY=TU', 'BYMONTHDAY=1,21;FREQ=WEEKLY']) {
    assert.throws(() => googleImportedEvent({ ...body, id: 'bad.rule', recurrence: [`RRULE:FREQ=MONTHLY;${suffix}`] }, value.categoryId), GoogleEventExpansionRequired);
  }
});

test('multiple monthly whole moves preserve every day or refuse an unrepresentable boundary instead of dropping the held occurrence', () => {
  const series = { ...inferred('毎月1日・21日'), id: 'series.monthdays', revision: 1 };
  const occurrence = projectCalendarEvents([series], [], '2026-12-21', '2026-12-21')[0];
  const moved = calendarSeriesMovedDraft(calendarOccurrenceDraft(occurrence, true), series, { day: '2026-12-22', minute: 540 }, 'Asia/Tokyo');
  assert.deepEqual(moved.value.customRecurrence, month([2, 22]));
  assert.ok(projectCalendarEvents([{ ...moved.value, id: series.id, revision: 2 }], [], '2026-12-22', '2026-12-22').length === 1);
  const endSeries = { ...series, startDate: '2026-11-30', endDate: '2026-11-30', customRecurrence: month([1, 30]) };
  const end = projectCalendarEvents([endSeries], [], '2026-11-30', '2026-11-30')[0];
  assert.throws(() => calendarSeriesMovedDraft(calendarOccurrenceDraft(end, true), endSeries, { day: '2026-12-01', minute: 540 }, 'Asia/Tokyo'), /日付|繰り返し/);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} multiple recurring title saves one validated series with every listed occurrence and no pre-save write`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T03:00:00Z') });
    const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    for (const [title, rule, dates] of [
      ['毎週火曜日、日曜日ランチ', week([0, 2]), ['2026-11-17', '2026-11-22', '2026-11-24', '2026-11-29']],
      ['毎月1日・21日に支払い', month([1, 21]), ['2026-11-21', '2026-12-01', '2026-12-21']],
    ]) {
      const before = await storage.readLocalCalendar(h.database), saved = [];
      const initial = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(selected, 'Asia/Tokyo') };
      const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
        props: { initial, local: { database: h.database, snapshot: before, refresh: async () => {} }, onClose() {}, onSaved: date => saved.push(date) } });
      try {
        await ui.change('予定名', title);
        assert.equal((await storage.readLocalCalendar(h.database)).events.length, before.events.length);
        ui.button('予定を保存').props.onPress(); ui.button('予定を保存').props.onPress(); for (let i = 0; i < 20; i++) await ui.flush();
        const state = await storage.readLocalCalendar(h.database), event = state.events.find(row => row.title === title);
        assert.ok(event); assert.equal(state.events.length, before.events.length + 1); assert.equal(saved.length, 1);
        assert.deepEqual(event.customRecurrence, rule);
        assert.deepEqual(projectCalendarEvents([event], [], today, title.includes('毎週') ? '2026-11-30' : '2026-12-31').map(row => row.startDate), dates);
        const { id, revision, ...value } = event; assert.ok(id); assert.equal(revision, 1);
        validateSharedCalendarPayload({ eventId: 'op.multidates', scope: 'series', anchorDate: null, basisOperationIds: [], value,
          category: { id: 'personal', name: '私用', color: '#3D906A' }, resetExceptionIds: [] }, 'op.multidates');
      } finally { ui.unmount(); }
    }
  });
  test(`${platform} custom monthly date selection preserves and edits all inferred dates and refuses an empty selection`, async () => {
    const saved = [], ui = screenHarness('src/features/calendar/custom-recurrence-screen.tsx', { exportName: 'CustomRecurrenceScreen', platform,
      props: { date: '2026-11-21', initial: month([1, 21]), onBack() {}, onSave: async rule => saved.push(rule) } });
    try {
      assert.equal(ui.button('1日に繰り返す').props.accessibilityState.selected, true);
      assert.equal(ui.button('21日に繰り返す').props.accessibilityState.selected, true);
      await ui.press('1日に繰り返す'); await ui.press('31日に繰り返す'); await ui.press('カスタム繰り返しを適用');
      assert.deepEqual(saved.at(-1), month([21, 31]));
      await ui.press('21日に繰り返す'); await ui.press('31日に繰り返す'); const count = saved.length;
      await ui.press('カスタム繰り返しを適用'); assert.equal(saved.length, count); assert.ok(ui.text().includes('1つ以上'));
    } finally { ui.unmount(); }
  });
}

test('monthly date cache copies do not let an editor mutate the next storage read', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  await storage.saveCalendarEvent(h.database, { expectedRevision: 0, value: inferred('毎月1日・21日') });
  const first = await storage.readLocalCalendar(h.database); first.events[0].customRecurrence.days.push(5);
  const second = await storage.readLocalCalendar(h.database); assert.deepEqual(second.events[0].customRecurrence, month([1, 21]));
});

test('monthly date sets retain explicit moves cancellations and past occurrences through a future split and undo', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const title = '毎月1日・21日に支払い', value = inferred(title);
  const id = await storage.saveCalendarEvent(h.database, { expectedRevision: 0, value });
  await storage.saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-12-01', expectedExceptionRevision: 0,
    value: { ...newEventDraft('2026-12-03', 'Asia/Tokyo'), title: '個別に移した支払い' } });
  await storage.deleteCalendarEvent(h.database, { id, expectedRevision: 1, anchorDate: '2026-12-21', expectedExceptionRevision: 0 });
  const before = await storage.readLocalCalendar(h.database), series = before.events.find(row => row.id === id);
  const rows = snapshot => projectCalendarEvents(snapshot.events, snapshot.exceptions, '2026-11-01', '2027-01-31')
    .map(row => ({ date: row.startDate, minute: row.startMinute, title: row.title }));
  const previous = rows(before);
  const receipt = await storage.saveCalendarFutureEvent(h.database, { eventId: id, revision: 1, exceptionRevision: 1, anchorDate: '2026-12-01', scope: 'future',
    value: { ...calendarFutureBase(series, '2026-12-01'), startMinute: 600, endMinute: 660 } });
  const after = rows(await storage.readLocalCalendar(h.database));
  assert.deepEqual(after, [
    { date: '2026-11-21', minute: 540, title },
    { date: '2026-12-03', minute: 540, title: '個別に移した支払い' },
    { date: '2027-01-01', minute: 600, title }, { date: '2027-01-21', minute: 600, title },
  ]);
  await receipt.undoFuture(); assert.deepEqual(rows(await storage.readLocalCalendar(h.database)), previous);
});
