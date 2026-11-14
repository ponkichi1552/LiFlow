import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonthRows, calendarRowForDate } from '../src/features/calendar/month-rows.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { createCalendarDisplayStore, CALENDAR_IDLE_RESET_MS } from '../src/features/calendar/display-store.ts';
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
test('calendar presentation survives short navigation but resets on a new process and after a minute away', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const store = createCalendarDisplayStore(); t.after(() => store.dispose());
  store.select('two'); store.leave(); t.mock.timers.tick(CALENDAR_IDLE_RESET_MS - 1); store.enter();
  assert.equal(store.getSnapshot().view, 'two');
  store.leave(); t.mock.timers.tick(30_000); store.leave(); t.mock.timers.tick(30_000); store.enter();
  assert.equal(store.getSnapshot().view, 'month'); assert.equal(store.getSnapshot().detail, 'two');
  store.select('list'); store.leave(); t.mock.timers.tick(100); store.enter(); t.mock.timers.tick(60_000);
  assert.equal(store.getSnapshot().view, 'list', 'a cancelled away timer must not reset an active calendar');
  const reopened = createCalendarDisplayStore(); t.after(() => reopened.dispose());
  assert.deepEqual(reopened.getSnapshot(), { view: 'month', detail: 'day', error: null });
});
test('calendar checks elapsed time on return when background timers were suspended', () => {
  let now = 0; const store = createCalendarDisplayStore(() => now);
  try { store.select('two'); store.leave(); now = 60_001; store.enter(); assert.equal(store.getSnapshot().view, 'month'); }
  finally { store.dispose(); }
});
test('history groups months and days after visibility filtering and keeps cancellation and identical timestamps', () => {
  const records = [{ id: 'a', date: '2026-10-31', timestamp: '2026-10-31T10:00Z', active: false }, { id: 'b', date: '2026-09-30', timestamp: '2026-09-30T10:00Z' }, { id: 'c', date: '2026-10-31', timestamp: '2026-10-31T10:00Z' }, { id: 'd', date: '2026-10-30', timestamp: '2026-10-30T10:00Z' }];
  const before = JSON.stringify(records); const groups = groupHistoryByDay(records, row => row);
  assert.deepEqual(groups.map(row => [row.date, row.showMonth]), [['2026-10-31', true], ['2026-10-30', false], ['2026-09-30', true]]);
  assert.deepEqual(groups[0].records.map(row => row.id), ['a', 'c']); assert.equal(groups[0].records[0].active, false); assert.equal(JSON.stringify(records), before);
});
