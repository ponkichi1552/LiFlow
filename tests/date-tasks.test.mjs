import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { selectDateTasks, orderDateTasks, recommendedChoreCounts } = await import('../src/domain/scheduling/date-tasks.ts');
const today = '2026-10-25';
function entry(date, overrides = {}) {
  return {
    id: `dishes:${date}`, householdId: 'home', choreId: 'dishes', cycleBaseDate: date,
    windowStart: date, windowEnd: date, suggestedDate: date,
    status: date < today ? 'overdue' : 'inWindow', assignedMemberIds: [], ...overrides,
  };
}
function completion(overrides = {}) {
  return { id: 'done', householdId: 'home', choreId: 'dishes', outcome: 'completed',
    completedAt: new Date(2026, 9, 25, 1).toISOString(), scheduleEntryId: `dishes:${today}`,
    scheduledDate: today, scheduledWindowStart: today, scheduledWindowEnd: today, ...overrides };
}

test('daily chores show a single current occurrence instead of three overdue cards', () => {
  const entries = ['2026-10-22', '2026-10-23', '2026-10-24', today, '2026-10-26'].map((date) => entry(date));
  const original = JSON.stringify(entries);
  assert.deepEqual(selectDateTasks(entries, [], today, 3).map((task) => task.id), [`dishes:${today}`]);
  assert.deepEqual(selectDateTasks(entries.filter((item) => item.suggestedDate < today), [], today, 3)
    .map((task) => task.id), ['dishes:2026-10-24']);
  assert.equal(JSON.stringify(entries), original);
  for (const date of ['2026-10-22', '2026-10-23', '2026-10-24']) {
    assert.deepEqual(selectDateTasks(entries, [], date).map((task) => task.id), [`dishes:${date}`]);
  }
});

test('the grace period includes its third day and excludes the fourth', () => {
  const entries = [entry('2026-10-22')];
  assert.equal(selectDateTasks(entries, [], today, 3).length, 1);
  assert.equal(selectDateTasks(entries, [], '2026-10-26', 3).length, 0);
  assert.equal(selectDateTasks(entries, [], '2026-10-23').length, 0);
});

test('overlapping cycles prefer the recommended date and otherwise the nearest active cycle', () => {
  const entries = [
    entry('2026-10-24', { windowStart: '2026-10-23', windowEnd: '2026-10-27' }),
    entry(today, { windowStart: '2026-10-24', windowEnd: '2026-10-27' }),
    entry('2026-10-27', { windowStart: today, windowEnd: '2026-10-29' }),
  ];
  assert.equal(selectDateTasks(entries, [], today)[0].id, `dishes:${today}`);
  assert.equal(selectDateTasks(entries, [], '2026-10-28')[0].id, 'dishes:2026-10-27');
});

test('today completion stays checked after regeneration, and undo reveals one pending task', () => {
  const entries = [entry('2026-10-23'), entry(today), entry('2026-10-26', { windowStart: today })];
  for (const remaining of [entries, entries.filter((item) => item.suggestedDate !== today)]) {
    const rows = selectDateTasks(remaining, [completion()], today, 3);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].completed, true);
    assert.equal(rows[0].completion.id, 'done');
  }
  const undone = selectDateTasks(entries, [completion({ outcome: 'incomplete' })], today, 3);
  assert.equal(undone.length, 1);
  assert.equal(undone[0].completed, false);
  assert.equal(undone[0].id, `dishes:${today}`);
  const tomorrow = selectDateTasks(entries, [completion()], '2026-10-26');
  assert.equal(tomorrow.length, 1);
  assert.equal(tomorrow[0].completed, false);
});

test('late completion is checked on its execution day without rewriting its original period', () => {
  const done = completion({ scheduleEntryId: 'dishes:2026-10-23', scheduledDate: '2026-10-23',
    scheduledWindowStart: '2026-10-23', scheduledWindowEnd: '2026-10-23' });
  assert.equal(selectDateTasks([], [done], today, 3)[0].completed, true);
  assert.equal(selectDateTasks([], [done], '2026-10-23')[0].completed, true);
  assert.deepEqual(selectDateTasks([], [done], '2026-10-24'), []);
});

test('grouping uses chore identity and orders pending tasks by load independently of their recommendation day', () => {
  const chores = ['light', 'normal', 'heavy'].flatMap((load) => [
    { id: `recommended-${load}`, load }, { id: `other-${load}`, load },
  ]);
  const rows = chores.map((chore) => ({ id: chore.id, choreId: chore.id,
    suggestedDate: chore.id.startsWith('recommended') ? today : '2026-10-26', completed: false }));
  assert.deepEqual(orderDateTasks(rows, today, chores).map((row) => row.id), [
    'other-heavy', 'recommended-heavy', 'other-normal', 'recommended-normal', 'other-light', 'recommended-light',
  ]);
  assert.equal(selectDateTasks([entry(today), entry(today, { id: 'other', choreId: 'other' })], [], today).length, 2);
  assert.equal(recommendedChoreCounts([entry(today), entry(today, { id: 'second-cycle' }),
    entry(today, { id: 'other', choreId: 'other' })]).get(today), 2);
});

test('audit100 date task ordering calculates each priority once rather than in every sorting comparison', () => {
  let reads = 0; const tasks = Array.from({ length: 500 }, (_, n) => ({ id: `row-${n}`, choreId: `chore-${n % 17}`, completed: false,
    get suggestedDate() { reads++; return '2026-10-24'; }, entry: entry(today, { windowStart: '2026-10-23', windowEnd: '2026-10-26' }) }));
  const chores = Array.from({ length: 17 }, (_, n) => ({ id: `chore-${n}`, load: ['light','normal','heavy'][n % 3] }));
  const result = orderDateTasks(tasks, today, chores); assert.equal(result.length, 500);
  assert.ok(reads <= 500, `priority reads: ${reads}`);
});
