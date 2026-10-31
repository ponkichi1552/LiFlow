import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { DEFAULT_CALENDAR_COUNT_COLORS as colors } from '../src/domain/calendar/count-colors.ts';
import { calendarPendingCountsByDate } from '../src/domain/calendar/day-entries.ts';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');

test('legacy bar preferences read as dots without changing saved colors or rewriting personal data', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    h.connection.prepare("UPDATE household_settings SET calendar_count_display_mode='bar', calendar_count_colors_json=?").run(JSON.stringify(colors));
    const before = h.connection.prepare('SELECT * FROM household_settings').get(); const snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.equal(snapshot.settings.calendarCountDisplayMode, 'dots'); assert.deepEqual(snapshot.settings.calendarCountColors, colors);
    assert.equal(h.connection.prepare('SELECT calendar_count_display_mode FROM household_settings').get().calendar_count_display_mode, before.calendar_count_display_mode);
  } finally { h.connection.close(); }
});

test('calendar count contract: numeric counts replace dots and bars even with legacy marker preferences', () => {
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', props: {
    today: '2026-11-01', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 12, total: 13 }), renderChores: () => null,
    countColors: colors, mode: 'bar',
  } });
  const list = screen.nodes().find(node => node.type === 'FlatList' && node.props.testID === 'calendar-weeks');
  assert.ok(list); assert.match(screen.text(), /家事 13件/u);
  assert.ok(!screen.nodes().some(node => node.type === 'View' && node.props.style?.width === 6), 'no pending-count dot remains');
});

test('calendar marker contract: completing a future occurrence changes only that date and retains periods', () => {
  const dates = ['2026-10-26', '2026-10-27'];
  const entries = dates.flatMap((date) => Array.from({ length: 12 }, (_, index) => ({ id: `chore-${index}:${date}`, choreId: `chore-${index}`,
    suggestedDate: date, cycleBaseDate: date, windowStart: date, windowEnd: date, householdId: 'home', assignedMemberIds: [], status: 'scheduled' })));
  const original = JSON.stringify(entries);
  const completions = [];
  for (let done = 0; done <= 12; done++) {
    const counts = calendarPendingCountsByDate(entries, completions);
    assert.equal(counts.get(dates[0]), 12);
    assert.equal(counts.get(dates[1]) ?? 0, 12 - done);
    if (done < 12) completions.push({ id: `complete-${done}`, choreId: `chore-${done}`, householdId: 'home', outcome: 'completed',
      scheduleEntryId: `chore-${done}:${dates[1]}`, completedAt: '2026-10-26T01:00:00.000Z', scheduledDate: dates[1] });
  }
  assert.equal(JSON.stringify(entries), original);
});
