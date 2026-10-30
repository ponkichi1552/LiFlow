import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskMutations } from '../src/features/planner/task-mutations.ts';
import { addDays, localDateFromDate } from '../src/domain/scheduling/local-date.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { openCalendarDay } from './helpers/calendar-ui.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const today = localDateFromDate(new Date());
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const entry = (id, patch = {}) => ({ id, choreId: id, householdId: 'local-household', cycleBaseDate: today,
  suggestedDate: today, windowStart: today, windowEnd: addDays(today, 2), assignedMemberIds: [], status: 'inWindow', ...patch });
const task = id => ({ id, choreId: id, completed: false, suggestedDate: today, entry: entry(id) });
const completed = (row, id = `completion-${row.id}`) => ({ id, householdId: 'local-household', choreId: row.choreId,
  scheduleEntryId: row.id, completedAt: new Date().toISOString(), completedLocalDate: today, outcome: 'completed',
  scheduledDate: row.suggestedDate, scheduledWindowStart: row.windowStart, scheduledWindowEnd: row.windowEnd, source: 'app' });

test('saved completion read failure keeps its warning and blocks another mutation until a successful read-only recovery', async () => {
  let writes = 0; let reads = 0; let failRead = true;
  const controller = createTaskMutations({ isCurrent: () => true, write: async () => { writes++; },
    refresh: async () => { reads++; if (failRead) throw new Error('read unavailable'); } });
  await controller.toggle(task('first')); const warning = controller.getSnapshot().error;
  assert.match(warning, /保存済み/u);
  await controller.toggle(task('second'));
  assert.equal(writes, 1, 'another action cannot clear the only recovery path while the displayed data is stale');
  assert.equal(controller.getSnapshot().error, warning); assert.equal(controller.getSnapshot().requiresReload, true);
  await controller.retryRead(); assert.equal(controller.getSnapshot().error, warning);
  failRead = false; await controller.retryRead(); assert.equal(writes, 1); assert.equal(reads, 3);
  assert.equal(controller.getSnapshot().requiresReload, false); assert.equal(controller.getSnapshot().overrides.size, 0);
  await controller.toggle(task('second')); assert.equal(writes, 2);
});

test('calendar pending markers follow an in-flight completion and undo without changing entries or completion history', async () => {
  const held = deferred(); const rows = [entry('one'), entry('two')]; const original = JSON.stringify(rows);
  const controller = createTaskMutations({ isCurrent: () => true, write: async () => held.promise, refresh: async () => {} });
  const operation = controller.toggle(task('one'));
  assert.equal(controller.calendarCounts(rows, []).get(today), 1);
  assert.equal(JSON.stringify(rows), original); held.resolve(); await operation;
  const history = [completed(rows[0])]; const recorded = JSON.stringify(history); const undoHeld = deferred();
  const undo = createTaskMutations({ isCurrent: () => true, write: async () => undoHeld.promise, refresh: async () => {} });
  const undoing = undo.toggle({ ...task('one'), completed: true, completion: history[0] });
  assert.equal(undo.calendarCounts(rows, history).get(today), 2); assert.equal(JSON.stringify(history), recorded);
  undoHeld.resolve(); await undoing;
});

test('a late failed write cannot hide another saved completion and one hundred recovery taps share one read', async () => {
  const firstRead = deferred(); const secondWrite = deferred(); const recovery = deferred(); let reads = 0; let writes = 0;
  const controller = createTaskMutations({ isCurrent: () => true, write: async row => { writes++; if (row.choreId === 'second') await secondWrite.promise; },
    refresh: async () => { reads++; if (reads === 1) await firstRead.promise; else await recovery.promise; } });
  const first = controller.toggle(task('first')); const second = controller.toggle(task('second'));
  firstRead.reject(new Error('read unavailable')); await first;
  secondWrite.reject(new Error('second write unavailable')); await second;
  assert.match(controller.getSnapshot().error, /保存済み/u); assert.equal(controller.project([task('first')])[0].completed, true);
  const retries = Array.from({ length: 100 }, () => controller.retryRead());
  await controller.toggle(task('third')); assert.equal(reads, 2); assert.equal(writes, 2); assert.equal(controller.getSnapshot().reading, true);
  recovery.resolve(); await Promise.all(retries);
  assert.equal(controller.getSnapshot().reading, false); assert.equal(controller.getSnapshot().requiresReload, false);
  assert.equal(controller.getSnapshot().overrides.size, 0); assert.equal(controller.getSnapshot().error, null);
});

test('calendar feedback keeps deduplicated chore counts and restores a recorded occurrence whose schedule row was regenerated', async () => {
  const held = deferred(); const row = entry('one'); const duplicate = { ...row, id: 'duplicate' };
  const controller = createTaskMutations({ isCurrent: () => true, write: async () => held.promise, refresh: async () => {} });
  const operation = controller.toggle(task('one'));
  assert.equal(controller.calendarCounts([row, duplicate], []).get(today), 1, 'another pending occurrence of the same chore still counts once');
  held.resolve(); await operation;
  const concurrent = [completed(row), completed(row, 'another-persons-completion')]; const undoOneHeld = deferred();
  const undoOne = createTaskMutations({ isCurrent: () => true, write: async () => undoOneHeld.promise, refresh: async () => {} });
  const checked = { ...task('one'), completed: true, completion: concurrent[0] };
  const undoingOne = undoOne.toggle(checked);
  assert.equal(undoOne.calendarCounts([row], concurrent).get(today) ?? 0, 0, 'undoing one record cannot undo another persons completion');
  assert.equal(undoOne.calendarCounts([], concurrent).get(today) ?? 0, 0, 'the same rule holds after the original schedule row was regenerated');
  assert.equal(undoOne.project([checked], concurrent)[0].completed, true);
  const differentRound = [concurrent[0], { ...concurrent[1], scheduleEntryId: 'another-round' }];
  assert.equal(undoOne.calendarCounts([row], differentRound).get(today), 1);
  assert.equal(undoOne.project([checked], differentRound)[0].completed, false, 'a different occurrence must not keep this occurrence checked');
  undoOneHeld.resolve(); await undoingOne;
  const record = completed(row); delete record.scheduleEntryId;
  const undoHeld = deferred(); const undo = createTaskMutations({ isCurrent: () => true, write: async () => undoHeld.promise, refresh: async () => {} });
  const undoing = undo.toggle({ id: `completed:${record.id}`, choreId: row.choreId, suggestedDate: today, completed: true, completion: record });
  assert.equal(undo.calendarCounts([], [record]).get(today), 1, 'undo feedback does not require an obsolete SQL schedule row');
  undoHeld.resolve(); await undoing;
});

async function calendarFixture(platform, binding) {
  const h = createDatabase(); await repository.initializeLocalDatabase(h.database);
  const base = await repository.loadPlannerSnapshot(h.database, today); const chores = []; const entries = []; const history = [];
  for (const tier of ['urgent', 'pending', 'done']) for (const load of ['heavy', 'normal', 'light']) {
    const id = `${tier}-${load}`; chores.push({ ...base.chores[0], id, name: id, load, enabled: true, archived: false });
    const row = entry(id, tier === 'urgent' ? { suggestedDate: addDays(today, -2), windowStart: addDays(today, -3), windowEnd: addDays(today, -1), status: 'overdue' } : {});
    entries.push(row); if (tier === 'done') history.push(completed(row));
  }
  const snapshot = { ...base, today, chores, scheduleEntries: entries, completions: history, settings: { ...base.settings, setupCompleted: true }, wasteSchedules: [], upcomingWasteDates: [] };
  const screen = screenHarness('src/app/(tabs)/explore.tsx', { platform, database: h.database, snapshot: () => snapshot,
    mocks: { '@/hooks/use-task-completion': { useTaskCompletion: () => ({ ...binding.getSnapshot(), ...binding }) } } });
  await openCalendarDay(screen, today);
  return { h, screen, snapshot };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} todays calendar puts all overdue tiers first and keeps a just-checked overdue card below pending work`, async () => {
    const held = deferred(); const binding = createTaskMutations({ isCurrent: () => true, write: async () => held.promise, refresh: async () => {} });
    const { h, screen } = await calendarFixture(platform, binding);
    try {
      const labels = () => screen.nodes().filter(n => n.props.accessibilityRole === 'checkbox').map(n => n.props.accessibilityLabel);
      assert.deepEqual(labels(), ['urgent-heavy', 'urgent-normal', 'urgent-light', 'pending-heavy', 'pending-normal', 'pending-light', 'done-heavy', 'done-normal', 'done-light']
        .map(id => `${id}を${id.startsWith('done') ? '未完了に戻す' : '完了'}`));
      assert.equal(screen.text().includes('期間を過ぎた家事'), false, 'today uses one priority-sorted collection');
      screen.nodes().find(n => n.props.accessibilityLabel === 'urgent-heavyを完了').props.onPress(); await screen.flush();
      const after = labels(); assert.equal(after.length, 9); assert.ok(after.indexOf('urgent-heavyを未完了に戻す') > after.indexOf('pending-lightを完了'));
      assert.equal(after[0], 'urgent-normalを完了'); held.resolve(); await screen.flush();
    } finally { held.resolve(); h.connection.close(); }
  });
  test(`${platform} calendar supplies a read-only recovery button and disables stale completion actions after a saved read failure`, async () => {
    let retries = 0; const state = { overrides: new Map(), pending: new Set(), requiresReload: true, error: '保存済みですが、表示を更新できませんでした。再読込してください。' };
    const binding = { getSnapshot: () => state, project: rows => rows, toggle: async () => assert.fail('stale actions must be disabled'),
      canToggle: () => false, calendarCounts: () => new Map(), retryRead: async () => { retries++; } };
    const { h, screen } = await calendarFixture(platform, binding);
    try {
      assert.ok(screen.nodes().filter(n => n.props.accessibilityRole === 'checkbox').every(n => n.props.disabled));
      await screen.press('表示を再読込'); assert.equal(retries, 1);
    } finally { h.connection.close(); }
  });
}
