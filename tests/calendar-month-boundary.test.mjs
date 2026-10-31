import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonthRows, calendarRowForDate } from '../src/features/calendar/month-rows.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { createCalendarDisplayStore, CALENDAR_DISPLAY_KEY } from '../src/features/calendar/display-store.ts';
import { groupHistoryByDay } from '../src/features/planner/history-groups.ts';

test('continuous month boundaries split the week without duplicating dates and put the month heading in day one weekday column', () => {
  const weeks = Array.from({ length: 530 }, (_, i) => addDays('2025-01-05', i * 7));
  const rows = calendarMonthRows(weeks, 100); const dates = rows.flatMap(row => row.days.filter(Boolean));
  assert.equal(new Set(dates).size, weeks.length * 7); assert.equal(dates.length, weeks.length * 7);
  assert.deepEqual(dates, Array.from({ length: weeks.length * 7 }, (_, i) => addDays(weeks[0], i)));
  let offset = 0;
  for (const row of rows) {
    assert.equal(row.offset, offset); offset += row.height;
    for (let column = 0; column < 7; column++) if (row.days[column]) {
      assert.equal(new Date(row.days[column] + 'T00:00:00Z').getUTCDay(), column);
      assert.equal(row.days[column].slice(0, 7), row.month.slice(0, 7));
    }
    if (row.monthStartColumn !== null) assert.equal(row.days[row.monthStartColumn], row.month);
  }
  const september = rows[calendarRowForDate(rows, '2026-09-30')]; const october = rows[calendarRowForDate(rows, '2026-10-01')];
  assert.deepEqual(september.days, ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', null, null, null]);
  assert.deepEqual(october.days, [null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03']); assert.equal(october.monthStartColumn, 4);
});
test('calendar remembers the actual view and retains the last day format through month year and app restart', () => {
  const values = new Map(); const storage = { getItemSync: key => values.get(key) ?? null, setItemSync: (key, value) => values.set(key, value) };
  for (const mode of ['day', 'two', 'list']) {
    const store = createCalendarDisplayStore(storage); store.select(mode);
    assert.equal(createCalendarDisplayStore(storage).getSnapshot().view, mode);
    store.select('month'); assert.equal(store.getSnapshot().detail, mode); store.select('year');
    assert.deepEqual(createCalendarDisplayStore(storage).getSnapshot(), { view: 'year', detail: mode, error: null });
  }
  values.set(CALENDAR_DISPLAY_KEY, JSON.stringify({ version: 1, view: 'invalid', detail: 'list' }));
  assert.equal(createCalendarDisplayStore(storage).getSnapshot().view, 'month');
});
test('calendar view save failure retains the selected format in this session and remains retryable', () => {
  let fail = true; const saved = []; const store = createCalendarDisplayStore({ getItemSync: () => null, setItemSync: (key, value) => { if (fail) throw new Error(); saved.push(value); } });
  store.select('list'); assert.equal(store.getSnapshot().view, 'list'); assert.ok(store.getSnapshot().error);
  fail = false; store.select('list'); assert.equal(store.getSnapshot().error, null); assert.equal(saved.length, 1);
});
test('history groups months and days after visibility filtering and keeps cancellation and identical timestamps', () => {
  const records = [{ id: 'a', date: '2026-10-31', timestamp: '2026-10-31T10:00Z', active: false }, { id: 'b', date: '2026-09-30', timestamp: '2026-09-30T10:00Z' }, { id: 'c', date: '2026-10-31', timestamp: '2026-10-31T10:00Z' }, { id: 'd', date: '2026-10-30', timestamp: '2026-10-30T10:00Z' }];
  const before = JSON.stringify(records); const groups = groupHistoryByDay(records, row => row);
  assert.deepEqual(groups.map(row => [row.date, row.showMonth]), [['2026-10-31', true], ['2026-10-30', false], ['2026-09-30', true]]);
  assert.deepEqual(groups[0].records.map(row => row.id), ['a', 'c']); assert.equal(groups[0].records[0].active, false); assert.equal(JSON.stringify(records), before);
});
