import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createHomeDisplayStore, HOME_LOAD_ORDER_KEY } from '../src/features/planner/home-display-store.ts';
import { homeUpcomingTasks } from '../src/features/planner/home-presentation.ts';
import { createTaskMutations } from '../src/features/planner/task-mutations.ts';
import { dateTaskRevision, sameOccurrenceAfterCompletion } from '../src/domain/scheduling/date-task-reference.ts';
import { orderDateTasks } from '../src/domain/scheduling/date-tasks.ts';
import { isTaskUrgent } from '../src/domain/scheduling/task-priority.ts';
import { orderTaskRows } from '../src/features/sharing/v2-ui/task-order.ts';
import { addDays, localDateFromDate } from '../src/domain/scheduling/local-date.ts';
import { planSharedMutation } from '../src/features/sharing/mutations.ts';
const repository = await import('../src/platform/storage/repository.ts');
const today = localDateFromDate(new Date());
const row = (id, patch = {}) => ({ id, choreId: id, householdId: 'local-household', suggestedDate: today,
  cycleBaseDate: today, windowStart: today, windowEnd: addDays(today, 2), assignedMemberIds: [], status: 'inWindow', ...patch });
const done = entry => ({ id: `done-${entry.id}`, householdId: entry.householdId, choreId: entry.choreId,
  scheduleEntryId: entry.id, completedAt: new Date().toISOString(), source: 'inApp', outcome: 'completed', scheduledDate: entry.suggestedDate });

test('a multi-day final date is urgent even on its recommendation while daily work and completed work remain quiet', () => {
  const task = { completed: false, load: 'normal', recommendedDate: today, windowStart: addDays(today, -2), windowEnd: today };
  assert.equal(isTaskUrgent(task, today), true);
  assert.equal(isTaskUrgent({ ...task, completed: true }, today), false);
  assert.equal(isTaskUrgent({ ...task, windowStart: today }, today), false);
  assert.equal(isTaskUrgent({ ...task, windowEnd: addDays(today, -1) }, today), false);
  assert.equal(isTaskUrgent({ ...task, recommendedDate: addDays(today, -1), windowEnd: addDays(today, 2) }, today), true);
});

test('home load reversal retains urgent and completed tiers for personal and mixed shared rows', () => {
  const tasks = []; const chores = [];
  for (const tier of ['urgent', 'pending', 'done']) for (const load of ['heavy', 'normal', 'light']) {
    const id = `${tier}-${load}`; chores.push({ id, load }); const entry = row(id);
    if (tier === 'urgent') { entry.suggestedDate = addDays(today, -1); entry.windowEnd = today; }
    tasks.push({ id, choreId: id, suggestedDate: entry.suggestedDate, entry, completed: tier === 'done', key: id, source: load === 'heavy' ? 'shared' : 'personal' });
  }
  const original = JSON.stringify(tasks);
  for (const order of ['heavy', 'light']) {
    const loads = order === 'heavy' ? ['heavy', 'normal', 'light'] : ['light', 'normal', 'heavy'];
    const expected = ['urgent', 'pending', 'done'].flatMap(tier => loads.map(load => `${tier}-${load}`));
    assert.deepEqual(orderDateTasks(tasks, today, chores, today, order).map(item => item.id), expected);
    assert.deepEqual(orderTaskRows(tasks, today, item => ({ completed: item.completed, load: chores.find(c => c.id === item.choreId).load,
      recommendedDate: item.suggestedDate, windowEnd: item.entry.windowEnd }), order).map(item => item.id), expected);
  }
  assert.equal(JSON.stringify(tasks), original);
});

test('home duration ties follow the chosen direction without treating unknown times as quick work', () => {
  const chores = [{ id: 'short', load: 'normal', estimatedMinutes: 10 }, { id: 'long', load: 'normal', estimatedMinutes: 35 }, { id: 'unknown', load: 'normal' }];
  const tasks = chores.map(chore => ({ id: chore.id, choreId: chore.id, entry: row(chore.id), suggestedDate: today, completed: false }));
  assert.deepEqual(orderDateTasks(tasks, today, chores, today, 'heavy').map(item => item.id), ['long', 'short', 'unknown']);
  assert.deepEqual(orderDateTasks(tasks, today, chores, today, 'light').map(item => item.id), ['short', 'long', 'unknown']);
});

test('home load preference survives a cold store and never writes a household setting', () => {
  const saved = new Map(); const writes = [];
  const storage = { getItemSync: key => saved.get(key) ?? null, setItemSync: (key, value) => { writes.push(key); saved.set(key, value); } };
  const first = createHomeDisplayStore(storage); assert.equal(first.getSnapshot().order, 'heavy'); first.toggle();
  const cold = createHomeDisplayStore(storage); assert.equal(cold.getSnapshot().order, 'light'); cold.toggle();
  assert.deepEqual(writes, [HOME_LOAD_ORDER_KEY, HOME_LOAD_ORDER_KEY]); assert.equal(saved.size, 1);
  saved.set(HOME_LOAD_ORDER_KEY, 'invalid'); assert.equal(createHomeDisplayStore(storage).getSnapshot().order, 'heavy');
  const failing = createHomeDisplayStore({ getItemSync: () => null, setItemSync: () => { throw new Error('disk'); } });
  failing.toggle(); assert.equal(failing.getSnapshot().order, 'heavy'); assert.match(failing.getSnapshot().error, /保存/u);
});

test('upcoming home shows each occurrence once on its recommendation and preserves distinct cycles and recorded completion', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); const chore = { ...(await repository.loadPlannerSnapshot(h.database, today)).chores[0], enabled: true };
    const entries = [row('a', { choreId: chore.id, suggestedDate: addDays(today, 2), windowEnd: addDays(today, 5) }),
      row('b', { choreId: chore.id, suggestedDate: addDays(today, 5), windowEnd: addDays(today, 8) })];
    const record = done(entries[0]); const before = JSON.stringify(entries);
    const selected = homeUpcomingTasks([...entries, entries[0]], [record], addDays(today, 1), addDays(today, 6), [chore]);
    assert.deepEqual(selected.map(item => item.id), ['a', 'b']); assert.equal(selected[0].completed, true);
    assert.equal(selected[0].entry.windowEnd, addDays(today, 5)); assert.equal(JSON.stringify(entries), before);
    assert.equal(homeUpcomingTasks([], [record], addDays(today, 1), addDays(today, 6), [chore])[0].completion.id, record.id, 'recalculation cannot hide an already recorded future completion');
    assert.equal(homeUpcomingTasks(entries, [], today, addDays(today, 1), [chore]).length, 0, 'availability alone does not duplicate the same occurrence on another day');
    for (const patch of [{ enabled: false }, { archived: true }, { householdId: 'foreign' }])
      assert.equal(homeUpcomingTasks(entries, [], today, addDays(today, 8), [{ ...chore, ...patch }]).length, 0);
  } finally { h.connection.close(); }
});

test('private home Undo cannot capture a later selected cycle after completion', () => {
  const entry = row('original'); const before = { id: entry.id, choreId: entry.choreId, suggestedDate: today, completed: false, entry };
  const after = { ...before, completed: true, completion: done(entry) };
  assert.equal(sameOccurrenceAfterCompletion(dateTaskRevision(before), dateTaskRevision(after)), true);
  const next = { ...after, completion: { ...after.completion, scheduleEntryId: 'another-cycle' } };
  assert.equal(sameOccurrenceAfterCompletion(dateTaskRevision(before), dateTaskRevision(next)), false);
  assert.equal(sameOccurrenceAfterCompletion('invalid', dateTaskRevision(after)), false);
});

test('home Undo receipt is atomic idempotent and cannot undo a later replacement record', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); let snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const id = snapshot.chores[0].id;
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [id], previousDates: {}, weatherLocation: null });
    snapshot = await repository.loadPlannerSnapshot(h.database, today); const entry = snapshot.scheduleEntries.find(item => item.choreId === id);
    const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt?.id);
    assert.equal(await repository.completeChoreWithReceipt(h.database, entry), undefined);
    assert.equal(await repository.undoCompletionReceipt(h.database, { ...receipt, householdId: 'foreign' }), false);
    assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
    assert.equal(await repository.undoCompletionReceipt(h.database, receipt), false);
    await repository.completeChore(h.database, entry, undefined, 'widget');
    assert.equal(await repository.undoCompletionReceipt(h.database, receipt), false);
    assert.equal((await repository.loadPlannerSnapshot(h.database, today)).completions.find(item => item.id === receipt.id).outcome, 'completed');
  } finally { h.connection.close(); }
});

test('shared home Undo targets only its own captured fact after another member completes the same occurrence', () => {
  const receipt = { ...done(row('same')), id: 'mine', householdId: 'group-household' };
  const context = { userId: 'me', now: new Date(), makeId: () => 'undo-mine', snapshot: { household: { id: receipt.householdId } },
    replica: { operations: [{ operationId: 'mine', authorUserId: 'me', entityType: 'completion', operationType: 'complete', entityId: 'same' },
      { operationId: 'theirs', authorUserId: 'them', entityType: 'completion', operationType: 'complete', entityId: 'same' }],
      completions: [{ occurrenceId: 'same', activeOperationIds: ['mine', 'theirs'] }] } };
  const result = planSharedMutation(context, 'undoCompletionReceipt', [receipt]);
  assert.deepEqual(result.drafts.map(item => item.payload.targetOperationId), ['mine']);
  assert.equal(planSharedMutation(context, 'undoCompletionReceipt', [{ ...receipt, id: 'theirs' }]).drafts.length, 0);
  assert.equal(planSharedMutation(context, 'undoCompletionReceipt', [{ ...receipt, householdId: 'foreign' }]).drafts.length, 0);
});

test('completion Undo is one-shot and an old closure cannot run after a workspace deactivates', async () => {
  const entry = row('one'); const task = { id: entry.id, choreId: entry.choreId, entry, suggestedDate: today, completed: false }; let undos = 0;
  const controller = createTaskMutations({ isCurrent: () => true, refresh: async () => {}, write: async () => ({
    undoTask: { ...task, completed: true, completion: done(entry) }, undo: async () => { undos++; } }) });
  await controller.toggle(task); assert.equal(controller.getSnapshot().undoAvailable, true);
  await Promise.all([controller.undoLast(), controller.undoLast()]); assert.equal(undos, 1); assert.equal(controller.getSnapshot().undoAvailable, false);
  await controller.toggle(task); controller.deactivate(); await controller.undoLast(); assert.equal(undos, 1);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} home exposes the saved completion Undo without finding the moved card`, async t => {
    const h = createDatabase();
    try {
      await repository.initializeLocalDatabase(h.database); const base = await repository.loadPlannerSnapshot(h.database, today);
      await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [base.chores[0].id], previousDates: {}, weatherLocation: null });
      let snapshot = await repository.loadPlannerSnapshot(h.database, today);
      const visibleDay = snapshot.scheduleEntries.find(entry => entry.choreId === base.chores[0].id).suggestedDate;
      // The adaptive first round is allowed to start after setup day. Exercise its
      // real recommended day, rather than assuming the old placeholder was today.
      t.mock.timers.enable({ apis: ['Date'], now: new Date(`${visibleDay}T12:00:00`).getTime() });
      snapshot = await repository.loadPlannerSnapshot(h.database, visibleDay);
      const screen = screenHarness('src/app/(tabs)/index.tsx', { platform, database: h.database, snapshot: () => snapshot,
        refresh: async () => { snapshot = await repository.loadPlannerSnapshot(h.database, visibleDay); } });
      await screen.nodes().find(n => n.props.accessibilityRole === 'checkbox' && !n.props.accessibilityState.checked).props.onPress();
      await screen.flush();
      assert.equal((await repository.loadPlannerSnapshot(h.database, visibleDay)).completions.filter(item => item.outcome === 'completed').length, 1);
      await screen.press('直前の完了を元に戻す'); await screen.flush();
      assert.equal((await repository.loadPlannerSnapshot(h.database, visibleDay)).completions.filter(item => item.outcome === 'completed').length, 0);
      assert.equal(screen.text().includes('元に戻す'), false);
    } finally { h.connection.close(); }
  });
  test(`${platform} home has one heading a group icon duration and a persistent one-tap load control`, async () => {
    const h = createDatabase(); const saved = new Map(); const navigate = [];
    const kv = { getItemSync: key => saved.get(key) ?? null, setItemSync: (key, value) => saved.set(key, value) };
    try {
      await repository.initializeLocalDatabase(h.database); const base = await repository.loadPlannerSnapshot(h.database, today);
      const chores = ['heavy', 'normal', 'light'].map((load, i) => ({ ...base.chores[i], enabled: true, load, estimatedMinutes: (3 - i) * 10, category: 'repeated-category', name: `test-${load}` }));
      const snapshot = { ...base, today, chores, completions: [], scheduleEntries: chores.map(c => row(c.id)), settings: { ...base.settings, setupCompleted: true }, wasteSchedules: [], upcomingWasteDates: [] };
      const options = { platform, database: h.database, snapshot: () => snapshot, navigate: (...args) => navigate.push(args),
        mocks: { 'expo-sqlite/kv-store': { __esModule: true, default: kv } } };
      const screen = screenHarness('src/app/(tabs)/index.tsx', options);
      const labels = () => screen.nodes().filter(n => n.props.accessibilityRole === 'checkbox').map(n => n.props.accessibilityLabel);
      assert.deepEqual(labels(), ['test-heavyを完了', 'test-normalを完了', 'test-lightを完了']);
      assert.equal(screen.text().includes('今日のタスク'), false); assert.equal(screen.text().match(/今日の家事/gu).length, 1);
      assert.ok(screen.text().includes('約30分')); assert.equal(screen.text().includes('repeated-category'), false);
      await screen.press('負荷の並び順：重い順'); assert.deepEqual(labels(), ['test-lightを完了', 'test-normalを完了', 'test-heavyを完了']);
      const cold = screenHarness('src/app/(tabs)/index.tsx', options); cold.button('負荷の並び順：軽い順');
      await screen.press('グループを開く'); assert.deepEqual(navigate.at(-1), ['push', '/sharing']);
    } finally { h.connection.close(); }
  });
}
