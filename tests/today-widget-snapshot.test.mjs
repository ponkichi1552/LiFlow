import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { createTodayWidgetSnapshot } = await import('../src/features/widgets/today-widget-snapshot.ts');
const today = '2026-10-24';
const updatedAt = '2026-10-24T03:00:00.000Z';

function entry(choreId, overrides = {}) {
  return {
    id: `entry-${choreId}`,
    householdId: 'home',
    choreId,
    cycleBaseDate: today,
    windowStart: today,
    windowEnd: today,
    suggestedDate: today,
    status: 'inWindow',
    assignedMemberIds: [],
    ...overrides,
  };
}

function completion(id, choreId, overrides = {}) {
  return { id, householdId: 'home', choreId, completedAt: updatedAt, outcome: 'completed', ...overrides };
}

function snapshot(entries, chores, completions = [], date = today) {
  return createTodayWidgetSnapshot(entries, chores, completions, date, updatedAt);
}

test('widget displays at most three today chores in scheduler priority order', () => {
  const entries = [
    entry('future', { status: 'scheduled', windowStart: '2026-10-26', windowEnd: '2026-10-28', suggestedDate: '2026-10-27' }),
    entry('normal', { status: 'scheduled' }),
    entry('overdue', { status: 'overdue', windowStart: '2026-10-21', windowEnd: '2026-10-23', suggestedDate: '2026-10-22' }),
    entry('window'),
    entry('initial', { status: 'initialPending' }),
  ];
  const chores = [
    { id: 'future', name: '明後日の家事' },
    { id: 'normal', name: '洗濯' },
    { id: 'overdue', name: '期限超過の家事' },
    { id: 'window', name: '実施期間中の家事' },
    { id: 'initial', name: '初回の家事' },
  ];
  const result = snapshot(entries, chores);
  assert.deepEqual(result.chores, [
    { id: 'entry-overdue', name: '期限超過の家事', completed: false },
    { id: 'entry-window', name: '実施期間中の家事', completed: false },
    { id: 'entry-initial', name: '初回の家事', completed: false },
  ]);
  assert.equal(result.remainingCount, 1);
  assert.equal(result.updatedAt, updatedAt);
});

test('widget includes the whole execution window and only one day after its end', () => {
  const entries = [entry('windowed', { windowEnd: '2026-10-26', suggestedDate: '2026-10-26', status: 'scheduled' })];
  const chores = [{ id: 'windowed', name: '期間内の家事' }];
  for (const date of ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']) {
    assert.deepEqual(snapshot(entries, chores, [], date).chores, [
      { id: 'entry-windowed', name: '期間内の家事', completed: false },
    ], date);
  }
  for (const date of ['2026-10-23', '2026-10-28']) {
    assert.deepEqual(snapshot(entries, chores, [], date).chores, [], date);
  }
});

test('completed chores remain checked below pending chores and become unchecked after undo', () => {
  const entries = [entry('done'), entry('pending')];
  const chores = [{ id: 'done', name: '完了した家事' }, { id: 'pending', name: '未完了の家事' }];
  const completed = completion('done-record', 'done', { scheduleEntryId: 'entry-done' });
  assert.deepEqual(snapshot(entries, chores, [completed]).chores, [
    { id: 'entry-pending', name: '未完了の家事', completed: false },
    { id: 'entry-done', name: '完了した家事', completed: true },
  ]);
  assert.equal(snapshot(entries, chores).chores.find((row) => row.id === 'entry-done').completed, false);
});

test('a checked row stays visible when more than three chores remain pending', () => {
  const ids = ['done', 'one', 'two', 'three', 'four'];
  const entries = ids.map((id) => entry(id));
  const chores = ids.map((id) => ({ id, name: id }));
  const result = snapshot(entries, chores, [completion('done-record', 'done', { scheduleEntryId: 'entry-done' })]);
  assert.deepEqual(result.chores.map((row) => row.name), ['one', 'two', 'done']);
  assert.equal(result.chores[2].completed, true);
  assert.equal(result.remainingCount, 2);
});

test('regenerated schedules show one checked row today without completing the next occurrence', () => {
  const entries = [entry('repeat', { id: 'next-occurrence', windowEnd: '2026-10-25', suggestedDate: '2026-10-25' })];
  const chores = [{ id: 'repeat', name: '繰り返す家事' }, { id: 'yesterday', name: '昨日の家事' }];
  const completions = [
    completion('previous-occurrence', 'repeat', {
      scheduleEntryId: 'old-entry', scheduledDate: today, scheduledWindowStart: today, scheduledWindowEnd: today,
    }),
    completion('incomplete-record', 'repeat', { scheduleEntryId: 'next-occurrence', outcome: 'incomplete' }),
    completion('yesterday-record', 'yesterday', { completedAt: '2026-10-23T03:00:00.000Z' }),
  ];
  assert.deepEqual(snapshot(entries, chores, completions).chores, [
    { id: 'completed:previous-occurrence', name: '繰り返す家事', completed: true },
  ]);
  assert.deepEqual(snapshot(entries, chores, completions, '2026-10-25').chores, [
    { id: 'next-occurrence', name: '繰り返す家事', completed: false },
  ]);
});

test('several recent daily occurrences only consume one widget row', () => {
  const entries = ['2026-10-23', today].map((date) => entry('daily', {
    id: `daily:${date}`, suggestedDate: date, windowStart: date, windowEnd: date,
  }));
  const result = snapshot(entries, [{ id: 'daily', name: '食器を洗う' }]);
  assert.equal(result.chores.length, 1);
  assert.equal(result.chores[0].id, `daily:${today}`);
  assert.equal(result.remainingCount, 0);
});

test('missing chore definitions do not consume widget rows or inflate the remaining count', () => {
  const chores = ['one', 'two', 'three', 'four'].map((id) => ({ id, name: id }));
  const result = snapshot([entry('removed'), ...chores.map((chore) => entry(chore.id))], chores);
  assert.deepEqual(result.chores.map((row) => row.name), ['one', 'two', 'three']);
  assert.equal(result.remainingCount, 1);
  assert.deepEqual(snapshot([entry('removed')], []).chores, []);
  assert.equal(snapshot([entry('removed')], []).remainingCount, 0);
});
