import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { reconcileGoogleTasks } = await import('../src/features/google-sync/reconcile-google-tasks.ts');
const { personalGoogleOccurrenceNote } = await import('../src/features/google-sync/workspace-policy.ts');
const { personalLongCalendarPreviews } = await import('../src/features/calendar/long-cycle-preview.ts');
const { retainCalendarInputs } = await import('../src/features/calendar/observed-snapshot.ts');

test('audit50 duplicate Google occurrence markers do not copy an ever growing candidate bucket before reporting ambiguity', async () => {
  const marker = personalGoogleOccurrenceNote('owner', 'house', 'round'); let copies = 0;
  const original = Map.prototype.set;
  Map.prototype.set = function(key, value) { if (key === marker && Array.isArray(value) && this.has(key) && this.get(key) !== value) copies += value.length; return original.call(this, key, value); };
  try {
    await assert.rejects(reconcileGoogleTasks({ accessToken: 'test', state: { householdId: 'house', accountSubject: 'owner', taskListId: 'list' }, now: new Date('2026-11-07T00:00:00Z'), today: '2026-11-07',
      api: { listTaskLists: async () => [{ id: 'list', title: '家事Planner' }], listTasks: async () => Array.from({ length: 1000 }, (_, n) => ({ id: `task-${n}`, status: 'needsAction', notes: marker })) },
      repository: { readLocalStatusSnapshot: async () => ({ entries: [{ entry: { id: 'round', suggestedDate: '2026-11-07' } }], links: [] }) }
    }), /Google Tasks request failed/u);
    assert.ok(copies <= 1000, `copied duplicate task references: ${copies}`);
  } finally { Map.prototype.set = original; }
});

test('audit50 long cycle Calendar previews index exact completion identities rather than comparing every historical completion per round', () => {
  let reads = 0;
  const chore = { id: 'annual', householdId: 'local-household', enabled: true, frequencyDaysByMode: { frequent: 90, balanced: 90, relaxed: 90 }, windowRadiusDays: 2 };
  const scheduleEntries = Array.from({ length: 100 }, (_, n) => ({ id: `entry-${n}`, choreId: 'annual', cycleBaseDate: '2026-11-07', windowStart: '2026-11-07', windowEnd: '2026-11-09', suggestedDate: '2026-11-07' }));
  const completions = Array.from({ length: 1000 }, (_, n) => ({ id: `done-${n}`, choreId: 'annual', outcome: 'completed', get scheduleEntryId() { reads++; return `old-${n}`; } }));
  assert.equal(personalLongCalendarPreviews({ chores: [chore], scheduleEntries, completions, settings: { frequencyMode: 'balanced' } }, '2026-11-07').length, 1);
  assert.ok(reads <= 3000, `completion identity reads: ${reads}`);
});

test('audit50 Calendar input retention stops equality work at the first changed record without serializing unrelated descriptions', () => {
  let reads = 0;
  const tail = Array.from({ length: 1000 }, (_, n) => ({ id: `tail-${n}`, get notes() { reads++; return 'long unchanged notes'; } }));
  const before = { events: [{ id: 'changed', title: 'before' }, ...tail], exceptions: [], categories: [] };
  const after = { events: [{ id: 'changed', title: 'after' }, ...tail], exceptions: [], categories: [] };
  const result = retainCalendarInputs(before, after);
  assert.equal(result.events, after.events); assert.ok(reads <= 2, `unrelated descriptions serialized: ${reads}`);
  assert.equal(retainCalendarInputs(result, { ...after, events: after.events.map(row => ({ ...row })) }).events, after.events, 'equal contents still retain their prior reference');
});
