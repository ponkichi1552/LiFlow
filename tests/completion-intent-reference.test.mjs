import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTaskRevision, dateTaskOccurrenceReference, sameDateTaskOccurrence } from '../src/domain/scheduling/date-task-reference.ts';

const entry = { id: 'cycle-a', choreId: 'bath', householdId: 'local-household', cycleBaseDate: '2026-11-02',
  suggestedDate: '2026-11-02', windowStart: '2026-11-01', windowEnd: '2026-11-05' };
const before = { id: entry.id, choreId: entry.choreId, suggestedDate: entry.suggestedDate, completed: false, entry };
const completion = { id: 'completion-a', householdId: entry.householdId, choreId: entry.choreId, scheduleEntryId: entry.id,
  scheduledDate: entry.suggestedDate, scheduledWindowStart: entry.windowStart, scheduledWindowEnd: entry.windowEnd,
  completedAt: '2026-11-02T04:00:00Z', completedLocalDate: '2026-11-02' };
const after = { id: 'completed:completion-a', choreId: 'bath', suggestedDate: entry.suggestedDate, completed: true, completion };

test('queued personal completion identifies one cycle across completion, undo and a changed recommendation', () => {
  const original = dateTaskRevision(before), completed = dateTaskRevision(after);
  assert.equal(sameDateTaskOccurrence(original, completed), true); assert.equal(sameDateTaskOccurrence(completed, original), true);
  assert.equal(sameDateTaskOccurrence(original, dateTaskRevision({ ...before, suggestedDate: '2026-11-03' })), true);
  assert.equal(dateTaskOccurrenceReference(original), dateTaskOccurrenceReference(completed));
});
test('queued personal completion refuses another cycle, chore, edited execution window and malformed references', () => {
  const original = dateTaskRevision(before);
  for (const task of [{ ...before, id: 'cycle-b', entry: { ...entry, id: 'cycle-b' } }, { ...before, choreId: 'other' },
    { ...before, entry: { ...entry, windowEnd: '2026-11-06' } }, { ...after, completion: { ...completion, scheduleEntryId: 'cycle-b' } }]) {
    assert.equal(sameDateTaskOccurrence(original, dateTaskRevision(task)), false);
  }
  for (const value of ['', '{}', '[1]', 'invalid']) {
    assert.equal(dateTaskOccurrenceReference(value), null); assert.equal(sameDateTaskOccurrence(value, value), false);
  }
});
