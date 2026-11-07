import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createDateTaskSelector } = await import('../src/domain/scheduling/date-tasks.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');

test('audit50 a reusable day selector computes completion display dates once instead of reparsing old history for every calendar day', () => {
  let reads = 0;
  const history = Array.from({ length: 1000 }, (_, n) => ({ id: `done-${n}`, choreId: `chore-${n}`, outcome: 'completed',
    get completedAt() { reads++; return '2026-01-03T01:00:00Z'; }, scheduledDate: '2026-01-03' }));
  const select = createDateTaskSelector([], history);
  for (let i = 0; i < 60; i++) assert.deepEqual(select(addDays('2026-11-07', i)), []);
  assert.ok(reads <= 4000, `historical timestamp reads: ${reads}`);
  const early = { id: 'early', choreId: 'early', outcome: 'completed', completedLocalDate: '2026-11-07', completedAt: '2026-11-07T00:00:00Z',
    scheduledDate: '2026-11-12', scheduledWindowStart: '2026-11-10', scheduledWindowEnd: '2026-11-14' };
  const late = { id: 'late', choreId: 'late', outcome: 'completed', completedLocalDate: '2026-11-07', completedAt: '2026-11-07T00:00:00Z',
    scheduledDate: '2026-11-01', scheduledWindowStart: '2026-10-31', scheduledWindowEnd: '2026-11-02' };
  const query = createDateTaskSelector([], [early, late]);
  assert.deepEqual(query('2026-11-07').map(x => x.choreId), ['late']);
  assert.deepEqual(query('2026-11-12').map(x => x.choreId), ['early']);
  assert.deepEqual(query('2026-11-01').map(x => x.choreId), ['late']);
  assert.deepEqual(query('2026-11-08'), []);
});
