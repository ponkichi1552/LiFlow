import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { nextLongCalendarRounds } = await import('../src/features/sharing/v2/next-calendar-rounds.ts');

test('audit50 sparse shared long cycle previews index round identities once rather than rescanning the common horizon per chore', () => {
  let reads = 0; const today = '2026-11-07';
  const chores = Array.from({ length: 80 }, (_, n) => ({ id: `chore-${n}`, enabled: true }));
  const tail = chores.map(chore => ({ id: `round-${chore.id}`, get choreId() { reads++; return chore.id; }, anchorDate: today, ruleVersion: 1, activeInPeriod: true,
    subjects: [{ subjectUserId: null, required: true, completed: false, suggestedDate: today, executionWindowEnd: today }] }));
  const before = Array.from({ length: 1000 }, (_, n) => ({ get choreId() { reads++; return `unrelated-${n}`; }, anchorDate: today, ruleVersion: 1 }));
  const result = nextLongCalendarRounds({ plan: { chores, occurrences: [...before, ...tail], range: { asOfDate: today }, timeZone: 'UTC' }, viewerUserId: 'owner',
    timeline: () => [{ configuration: { anchorDate: today, intervalDays: 365, ruleVersion: 1 }, from: today, through: null }],
    readAt() { throw new Error('all existing exact rounds must be reused'); } });
  assert.deepEqual(result, tail); assert.ok(reads < 4000, `round identity inspections: ${reads}`);
});
