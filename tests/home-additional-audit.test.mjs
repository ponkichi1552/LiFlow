import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeUpcomingTasks } from '../src/features/planner/home-presentation.ts';
import { selectDateTasks } from '../src/domain/scheduling/date-tasks.ts';
const chore = { id: 'chore', householdId: 'home', enabled: true };
test('completion-only calendar and upcoming cards retain their frozen recording day after region changes', () => {
  const completed = { id: 'done', choreId: chore.id, householdId: chore.householdId, outcome: 'completed',
    completedAt: '2026-11-07T03:30:00Z', completedLocalDate: '2026-11-06' };
  assert.equal(homeUpcomingTasks([], [completed], '2026-11-06', '2026-11-06', [chore])[0]?.suggestedDate, '2026-11-06');
  assert.equal(selectDateTasks([], [completed], '2026-11-06', 0, [chore])[0]?.suggestedDate, '2026-11-06');
});

test('upcoming exact completion matching is linear while preserving first-match and legacy precedence', () => {
  let reads = 0;
  const entries = Array.from({ length: 800 }, (_, n) => ({ id: `entry-${n}`, householdId: 'home', choreId: 'chore',
    suggestedDate: '2026-11-08', windowStart: '2026-11-08', windowEnd: '2026-11-08' }));
  const completions = entries.map((entry, n) => ({ id: `done-${n}`, householdId: 'home', choreId: 'chore', scheduleEntryId: entry.id,
    completedAt: '2026-11-08T09:00:00Z', get outcome() { reads++; return 'completed'; } }));
  const result = homeUpcomingTasks(entries, completions, '2026-11-08', '2026-11-08', [chore]);
  assert.equal(result.length, 800); assert.ok(result.every((row, n) => row.completion.id === `done-${n}`));
  assert.ok(reads < 5000, `completion reads: ${reads}`);
  const legacy = { id: 'legacy', householdId: 'home', choreId: 'chore', outcome: 'completed', completedAt: '2026-11-08T08:00Z' };
  assert.equal(homeUpcomingTasks(entries.slice(0, 1), [legacy, completions[0]], '2026-11-08', '2026-11-08', [chore])[0].completion.id, 'legacy');
});
