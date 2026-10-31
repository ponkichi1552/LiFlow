import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { calendarCountColor, calendarDotCount, DEFAULT_CALENDAR_COUNT_COLORS as colors } from '../src/domain/calendar/count-colors.ts';
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

test('calendar marker contract: zero hides the marker; bands are 1-5, 6-9, 10+ with at most five dots', () => {
  for (const [count, color, dots] of [[0, null, 0], [1, colors.low, 1], [5, colors.low, 5], [6, colors.medium, 1], [9, colors.medium, 4], [10, colors.high, 1], [14, colors.high, 5], [15, colors.high, 5], [30, colors.high, 5]]) {
    assert.equal(calendarCountColor(count, colors), color); assert.equal(calendarDotCount(count), dots);
    for (const legacyMode of ['bar', 'dots']) {
      const screen = screenHarness('src/components/calendar-task-count-indicator.tsx', { exportName: 'CalendarTaskCountIndicator', props: { count, mode: legacyMode, colors } });
      const shapes = screen.nodes().filter((node) => node.type === 'View').length - 1;
      assert.equal(shapes, count === 0 ? 0 : dots, `${legacyMode}/${count}: even a legacy caller cannot restore bars`);
      assert.equal(screen.text(), '', 'markers must not show a numeric label');
    }
  }
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
